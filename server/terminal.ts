// Terminal (CLI) sessions that claude-control restores in tmux (spec 0003). READ ONLY.
//
// Sources (checked 2026-11-08):
// - Manifest ~/.config/claude-rc/sessions.conf: `name|session-id|folder` per line,
//   `#` lines ignored, an empty folder means $HOME. claude-rc-resume.sh starts each
//   one in tmux session `rc-resume`, window = name, as
//   `claude --resume <id> --remote-control <name>`.
// - Transcript ~/.claude/projects/<encoded cwd>/<id>.jsonl, appended in place.
//   Files reach 100 MB, so we read only the last TAIL_BYTES once, then only the
//   bytes that were appended. One manifest transcript lives in another folder than
//   its manifest folder, so a missing file is searched in every project folder.
// - Remote Control: `{"type":"bridge-session","bridgeSessionId":"cse_..."}` lines
//   and `{"type":"system","subtype":"bridge_status","url":"https://claude.ai/code/session_..."}`.
//   cse_X maps to session_X, the same rule as the desktop app.
// - Title: `{"type":"custom-title","customTitle":"..."}` (last one wins).
// - Running: a `claude ... --resume <id>` process (ps). Its parent is the shell of
//   a tmux pane (tmux list-panes -a), which gives the attach target.

import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Link, Status, TerminalInfo } from "../shared/types.ts";
import type { BaseSession } from "./sessions.ts";
import { STALE_WAITING_MS, STALE_WORKING_MS } from "./status.ts";
import { encodeProjectDir, trimSlash } from "./projects.ts";

export const TAIL_BYTES = 2 * 1024 * 1024;
export const MAX_APPEND_BYTES = 8 * 1024 * 1024;
export const SUMMARY_CHARS = 300;
export const PROC_POLL_MS = 20_000;
export const FILE_POLL_MS = 5_000;
const SEARCH_EVERY_MS = 5 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9-]{1,80}$/;
const REMOTE_ID = /^(?:session_|cse_)(?:staging_)?[A-Za-z0-9]{1,64}$/;
const RC_URL = /^https:\/\/claude\.ai\/code\/((?:session_|cse_)(?:staging_)?[A-Za-z0-9]{1,64})$/;

export interface ManifestEntry {
  name: string;
  id: string;
  dir: string;
}

/** Parse sessions.conf. Bad lines are skipped; the first line wins for a repeated id. */
export function parseManifest(text: string, home = homedir()): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const [name = "", id = "", ...rest] = line.split("|");
    const dir = rest.join("|").trim();
    if (!name.trim() || !SESSION_ID.test(id.trim()) || seen.has(id.trim())) continue;
    seen.add(id.trim());
    out.push({ name: name.trim(), id: id.trim(), dir: trimSlash(dir || home) });
  }
  return out;
}

/** What we keep from a transcript. Folded line by line, so appends are cheap. */
export interface TranscriptState {
  customTitle: string | null;
  remoteId: string | null; // session_... form
  cwd: string | null;
  last: "prompt" | "tool" | "interrupt" | "assistant-mid" | "assistant-end" | "turn-end" | null;
  lastAt: number | null; // epoch ms of the last user/assistant/turn-end entry
  firstAt: number | null;
  lastText: string | null; // last assistant text, trimmed and cut
  turns: number; // turn ends seen in the part we read (not the whole history)
}

export const EMPTY_STATE: TranscriptState = Object.freeze({
  customTitle: null,
  remoteId: null,
  cwd: null,
  last: null,
  lastAt: null,
  firstAt: null,
  lastText: null,
  turns: 0,
}) as TranscriptState;

const time = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

export function cutText(s: string, max = SUMMARY_CHARS): string {
  // The summary is plain text: drop markdown bold, heading and code marks.
  const t = s.replace(/\*\*|__|`|^#+\s*/gm, "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).trimEnd() + "..." : t;
}

/** Fold one parsed transcript line into the state (returns a new object). */
export function foldLine(st: TranscriptState, j: unknown): TranscriptState {
  if (!j || typeof j !== "object") return st;
  const e = j as Record<string, unknown>;
  const type = e.type;
  if (type === "custom-title" && typeof e.customTitle === "string" && e.customTitle.trim()) {
    return { ...st, customTitle: e.customTitle.trim().slice(0, 200) };
  }
  if (type === "bridge-session" && typeof e.bridgeSessionId === "string" && REMOTE_ID.test(e.bridgeSessionId)) {
    return { ...st, remoteId: e.bridgeSessionId.replace(/^cse_/, "session_") };
  }
  if (type === "system") {
    if (e.subtype === "bridge_status" && typeof e.url === "string") {
      const m = RC_URL.exec(e.url);
      if (m) return { ...st, remoteId: m[1].replace(/^cse_/, "session_") };
      return st;
    }
    if (e.subtype === "turn_duration") {
      const at = time(e.timestamp) ?? st.lastAt;
      return { ...st, last: "turn-end", lastAt: at, turns: st.turns + 1 };
    }
    return st;
  }
  if (type !== "user" && type !== "assistant") return st;
  if (e.isSidechain === true || e.isMeta === true) return st;
  const at = time(e.timestamp);
  const msg = e.message && typeof e.message === "object" ? (e.message as Record<string, unknown>) : {};
  const content = msg.content;
  const blocks = Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
  const next: TranscriptState = {
    ...st,
    lastAt: at ?? st.lastAt,
    firstAt: st.firstAt ?? at,
    cwd: typeof e.cwd === "string" && e.cwd.startsWith("/") ? e.cwd : st.cwd,
  };
  if (type === "user") {
    const text = typeof content === "string" ? content : blocks.find((b) => b?.type === "text")?.text;
    if (blocks.some((b) => b?.type === "tool_result")) next.last = "tool";
    else if (typeof text === "string" && text.startsWith("[Request interrupted")) next.last = "interrupt";
    else next.last = "prompt";
    return next;
  }
  const stop = msg.stop_reason;
  next.last = stop === "end_turn" || stop === "stop_sequence" || e.isApiErrorMessage === true ? "assistant-end" : "assistant-mid";
  const text = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  if (text.trim()) next.lastText = cutText(text);
  return next;
}

/** Fold complete lines of text. Bad lines (a partial write) are skipped. */
export function foldText(st: TranscriptState, text: string): TranscriptState {
  let s = st;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // Cheap filter: skip lines that cannot change the state before JSON.parse.
    if (!/"type":"(?:user|assistant|system|custom-title|bridge-session)"/.test(line)) continue;
    try {
      s = foldLine(s, JSON.parse(line));
    } catch {
      // partial line
    }
  }
  return s;
}

/**
 * Status rules (spec 0003):
 * - working: the last entry is a prompt, a tool result or an assistant step that
 *   did not end the turn, the process runs, and the entry is less than 1 hour old.
 * - waiting: the last assistant turn ended (end_turn) and nothing newer. Older
 *   than 3 days: idle (same rule as desktop, and no push).
 * - idle: anything else.
 */
export function terminalStatus(st: TranscriptState, running: boolean, now: number, mtimeMs = 0): Status {
  const at = st.lastAt ?? mtimeMs;
  if ((st.last === "prompt" || st.last === "tool" || st.last === "assistant-mid") && running && now - at < STALE_WORKING_MS) {
    return "working";
  }
  if (st.last === "assistant-end" || st.last === "turn-end") return now - at > STALE_WAITING_MS ? "idle" : "waiting";
  return "idle";
}

// ---------- processes ----------

export interface Proc {
  pid: number;
  ppid: number;
}

/** `ps -axo pid=,ppid=,args=` output: claude processes by resumed session id. */
export function parsePs(text: string): { byId: Map<string, Proc>; parentOf: Map<number, number> } {
  const byId = new Map<string, Proc>();
  const parentOf = new Map<number, number>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    parentOf.set(pid, ppid);
    const args = m[3];
    const bin = args.split(/\s+/)[0] ?? "";
    if (!/(?:^|\/)claude(?:\.exe)?$/.test(bin)) continue;
    const r = /(?:^|\s)--resume[=\s]+([A-Za-z0-9-]{1,80})(?:\s|$)/.exec(args);
    if (r && !byId.has(r[1])) byId.set(r[1], { pid, ppid });
  }
  return { byId, parentOf };
}

export interface Pane {
  session: string;
  index: string;
  name: string;
  panePid: number;
}

/**
 * `tmux list-panes -a -F '#{session_name}|#{window_index}|#{window_name}|#{pane_pid}'`.
 * Not a tab: tmux 3.4+ prints control characters as "_". The pane pid is the last
 * field and the index the second, so a "|" inside a window name stays safe.
 */
export const PANE_FORMAT = "#{session_name}|#{window_index}|#{window_name}|#{pane_pid}";

export function parsePanes(text: string): Pane[] {
  const out: Pane[] = [];
  for (const line of text.split("\n")) {
    const p = line.split("|");
    if (p.length < 4) continue;
    const panePid = Number(p[p.length - 1]);
    const name = p.slice(2, -1).join("|");
    if (!p[0] || !/^\d+$/.test(p[1]) || !Number.isInteger(panePid) || panePid <= 0) continue;
    out.push({ session: p[0], index: p[1], name, panePid });
  }
  return out;
}

/** Shell quote for the attach and resume commands. */
export function shq(s: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Terminal info for one manifest entry. The target is `session:index`, because a
 * window name with a dot would read as a pane in tmux target syntax.
 */
export function terminalInfo(
  e: ManifestEntry,
  ps: ReturnType<typeof parsePs>,
  panes: Pane[],
  rcSession = "rc-resume",
): TerminalInfo {
  const proc = ps.byId.get(e.id);
  const byPid = new Map(panes.map((p) => [p.panePid, p]));
  let pane: Pane | undefined;
  if (proc) {
    // Walk up a few parents: the pane shell may start claude through a wrapper.
    let p: number | undefined = proc.ppid;
    for (let i = 0; i < 4 && p && !pane; i++) {
      pane = byPid.get(p);
      p = ps.parentOf.get(p);
    }
  } else {
    pane = panes.find((x) => x.session === rcSession && x.name === e.name);
  }
  const tmuxTarget = pane ? `${pane.session}:${pane.index}` : null;
  let attachCmd: string | null = null;
  if (tmuxTarget) attachCmd = `tmux attach -t ${shq(tmuxTarget)}`;
  else if (!proc) attachCmd = `cd ${shq(e.dir)} && claude --resume ${e.id}`;
  return { tmuxTarget, running: !!proc, attachCmd, name: e.name };
}

// ---------- reader ----------

interface FileState {
  file: string;
  size: number;
  mtimeMs: number;
  offset: number; // bytes folded so far (always at a line end)
  state: TranscriptState;
}

export type Exec = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)));
  });

function firstExisting(list: string[], fallback: string): string {
  return list.find((p) => existsSync(p)) ?? fallback;
}

export interface TerminalReaderOptions {
  manifestFile: string;
  projectsDir: string;
  home?: string;
  rcSession?: string; // tmux session of claude-rc-resume.sh (default rc-resume)
  exec?: Exec; // tests inject a fake
  onChange?: () => void;
  onProcPoll?: () => void; // after each scheduled ps/tmux poll (not after rescan), for the fall push (spec 0004)
  procPollMs?: number;
  filePollMs?: number;
}

export class TerminalReader {
  private opts: TerminalReaderOptions;
  private manifestKey = "";
  private entries: ManifestEntry[] = [];
  private files = new Map<string, FileState>(); // by session id
  private lastSearch = new Map<string, number>();
  private ps: ReturnType<typeof parsePs> = { byId: new Map(), parentOf: new Map() };
  private panes: Pane[] = [];
  private infoKey = "";
  private timers: NodeJS.Timeout[] = [];
  private exec: Exec;
  private tmuxBin: string;

  constructor(opts: TerminalReaderOptions) {
    this.opts = opts;
    this.exec = opts.exec ?? defaultExec;
    this.tmuxBin = opts.exec ? "tmux" : firstExisting(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"], "tmux");
  }

  /** Start the polls: files every 5s, processes every 20s. */
  start(): void {
    this.scan();
    const poll = () =>
      void this.refreshProcs().then((c) => {
        if (c) this.opts.onChange?.();
        this.opts.onProcPoll?.();
      });
    poll();
    const f = setInterval(() => this.scan() && this.opts.onChange?.(), this.opts.filePollMs ?? FILE_POLL_MS);
    const p = setInterval(poll, this.opts.procPollMs ?? PROC_POLL_MS);
    f.unref();
    p.unref();
    this.timers.push(f, p);
  }

  /** Extra poll right after a Claude Control action, so the snapshot updates fast. Does not count as a scheduled poll. */
  async rescan(): Promise<void> {
    const a = this.scan();
    const b = await this.refreshProcs();
    if (a || b) this.opts.onChange?.();
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Re-read the manifest and the transcript tails. Returns true on a change. */
  scan(now = Date.now()): boolean {
    let changed = this.readManifest();
    const ids = new Set(this.entries.map((e) => e.id));
    for (const id of [...this.files.keys()]) if (!ids.has(id)) this.files.delete(id);
    for (const e of this.entries) if (this.scanFile(e, now)) changed = true;
    return changed;
  }

  private readManifest(): boolean {
    let key = "";
    let text = "";
    try {
      const st = statSync(this.opts.manifestFile);
      key = `${st.mtimeMs}:${st.size}`;
      if (key === this.manifestKey) return false;
      text = readFileSync(this.opts.manifestFile, "utf8");
    } catch {
      key = "missing";
      if (key === this.manifestKey) return false;
    }
    this.manifestKey = key;
    this.entries = parseManifest(text, this.opts.home ?? homedir());
    return true;
  }

  /** Transcript path: the manifest folder (both encodings), else a search in every project folder. */
  private locate(e: ManifestEntry, now: number): string | null {
    const known = this.files.get(e.id)?.file;
    if (known && existsSync(known)) return known;
    const name = `${e.id}.jsonl`;
    for (const enc of [encodeProjectDir(e.dir), e.dir.replace(/[/.]/g, "-")]) {
      const f = join(this.opts.projectsDir, enc, name);
      if (existsSync(f)) return f;
    }
    const last = this.lastSearch.get(e.id) ?? 0;
    if (now - last < SEARCH_EVERY_MS) return null;
    this.lastSearch.set(e.id, now);
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.opts.projectsDir);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const f = join(this.opts.projectsDir, d, name);
      if (existsSync(f)) return f;
    }
    return null;
  }

  private scanFile(e: ManifestEntry, now: number): boolean {
    const file = this.locate(e, now);
    const old = this.files.get(e.id);
    if (!file) {
      if (old) this.files.delete(e.id);
      return !!old;
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      return false;
    }
    if (old && old.file === file && old.size === st.size && old.mtimeMs === st.mtimeMs) return false;
    let base: FileState;
    let from: number;
    if (!old || old.file !== file || st.size < old.offset || st.size - old.offset > MAX_APPEND_BYTES) {
      from = Math.max(0, st.size - TAIL_BYTES);
      base = { file, size: 0, mtimeMs: 0, offset: from, state: EMPTY_STATE };
    } else {
      from = old.offset;
      base = old;
    }
    const buf = readRange(file, from, st.size);
    if (buf === null) return false;
    let start = 0;
    // A tail read starts in the middle of a line: drop that first piece.
    if (from > 0 && base.state === EMPTY_STATE) {
      const nl = buf.indexOf(10);
      start = nl === -1 ? buf.length : nl + 1;
    }
    const end = buf.lastIndexOf(10) + 1; // keep a partial last line for later
    const state = end > start ? foldText(base.state, buf.toString("utf8", start, end)) : base.state;
    const consumed = Math.max(end, start);
    const next: FileState = { file, size: st.size, mtimeMs: st.mtimeMs, offset: from + consumed, state };
    this.files.set(e.id, next);
    return !old || JSON.stringify(old.state) !== JSON.stringify(state) || old.file !== file;
  }

  /** Poll ps and tmux. Returns true when the running or tmux info changed. */
  async refreshProcs(): Promise<boolean> {
    let psText = "";
    let tmuxText = "";
    try {
      psText = await this.exec("/bin/ps", ["-axo", "pid=,ppid=,args="]);
    } catch {
      psText = "";
    }
    try {
      tmuxText = await this.exec(this.tmuxBin, ["list-panes", "-a", "-F", PANE_FORMAT]);
    } catch {
      tmuxText = ""; // no tmux server
    }
    this.ps = parsePs(psText);
    this.panes = parsePanes(tmuxText);
    const key = JSON.stringify(this.entries.map((e) => this.info(e)));
    if (key === this.infoKey) return false;
    this.infoKey = key;
    return true;
  }

  private info(e: ManifestEntry): TerminalInfo {
    return terminalInfo(e, this.ps, this.panes, this.opts.rcSession);
  }

  /** Manifest sessions with a transcript, as BaseSession (id cli_<sessionId>). */
  sessions(now = Date.now()): TerminalSession[] {
    const out: TerminalSession[] = [];
    for (const e of this.entries) {
      const f = this.files.get(e.id);
      if (!f) continue;
      const info = this.info(e);
      out.push(toTerminalSession(e, f.state, info, now, f.mtimeMs));
    }
    return out;
  }
}

export function readRange(file: string, from: number, to: number): Buffer | null {
  if (to <= from) return Buffer.alloc(0);
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(to - from);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface TerminalSession extends BaseSession {
  terminalSessionId: string; // CLI session id, used to merge with a desktop session
}

export function toTerminalSession(
  e: ManifestEntry,
  st: TranscriptState,
  info: TerminalInfo,
  now: number,
  mtimeMs: number,
): TerminalSession {
  const links: Link[] = st.remoteId
    ? [{ kind: "remote-control", remoteId: st.remoteId, url: `https://claude.ai/code/${st.remoteId}` }]
    : [];
  const last = st.lastAt ?? mtimeMs;
  return {
    id: `cli_${e.id}`,
    title: st.customTitle ?? e.name,
    cwd: st.cwd ?? e.dir,
    status: terminalStatus(st, info.running, now, mtimeMs),
    lastActivityAt: last,
    completedTurns: st.turns,
    openUrl: links[0]?.url ?? null,
    cliSessionId: e.id,
    spawnedFromId: null,
    summary: st.lastText,
    needsAction: null,
    links,
    remoteSteered: false,
    createdAt: st.firstAt ?? last,
    conversationIds: [e.id],
    source: "terminal",
    terminal: info,
    terminalSessionId: e.id,
  };
}

/**
 * Join terminal sessions into the desktop list. A terminal session whose CLI id is
 * a desktop session's conversation (cliSessionId or priorCliSessionIds) is the same
 * chat: the desktop session keeps its data and gets the terminal info.
 */
export function mergeTerminal(desktop: BaseSession[], terminal: TerminalSession[]): BaseSession[] {
  const owner = new Map<string, number>();
  desktop.forEach((d, i) => {
    for (const c of d.conversationIds) if (!owner.has(c)) owner.set(c, i);
  });
  const out = desktop.slice();
  for (const t of terminal) {
    const i = owner.get(t.terminalSessionId);
    if (i !== undefined) {
      out[i] = { ...out[i], terminal: { ...t.terminal! } };
      continue;
    }
    const { terminalSessionId: _t, ...base } = t;
    out.push(base);
  }
  return out;
}
