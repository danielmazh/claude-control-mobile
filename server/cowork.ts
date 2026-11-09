// Cowork sessions: the general (non-code) chats of the Claude app (spec 0005). READ ONLY.
//
// Sources (checked 2026-11-09):
// - <root>/<account>/<org>/local_<id>.json, one file per session. root is
//   ~/Library/Application Support/Claude/local-agent-mode-sessions. The folder
//   "skills-plugin" holds no sessions.
// - The file also holds private fields (emailAddress, accountName, systemPrompt,
//   tool and folder settings). We copy only the named fields below right after
//   JSON.parse, so nothing else can reach the UI or a log.
// - Transcript: <root>/<account>/<org>/local_<id>/.claude/projects/<encoded cwd>/<cliSessionId>.jsonl,
//   inside the session folder. Same line format as a CLI transcript.
// - No postTurnSummary and no remote link (no bridge or cse_ id), so openUrl is null.
//
// Regular claude.ai chats are not on this Mac (server side only), so they are out of scope.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Status } from "../shared/types.ts";
import { listSessionFiles, type BaseSession } from "./sessions.ts";
import { STALE_WAITING_MS } from "./status.ts";
import { EMPTY_STATE, foldLine, MAX_APPEND_BYTES, readRange, TAIL_BYTES, type TranscriptState } from "./terminal.ts";

/** No process to check, so a turn counts as working only while the transcript moved in the last 10 minutes. */
export const COWORK_WORKING_MS = 10 * 60 * 1000;
export const COWORK_PROJECT = "Cowork";
const SKIP_DIRS = ["skills-plugin"];
const CLI_ID = /^[A-Za-z0-9-]{1,80}$/;

/** The only fields we keep from a Cowork session file. */
export interface CoworkMeta {
  sessionId: string;
  title: string | null;
  cliSessionId: string | null;
  createdAt: number | null;
  lastActivityAt: number | null;
  isArchived: boolean;
  folders: string[]; // userSelectedFolders
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Pick the safe fields of a parsed session file. Returns null when it is not a session. */
export function pickMeta(j: unknown): CoworkMeta | null {
  if (!j || typeof j !== "object") return null;
  const r = j as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || !r.sessionId) return null;
  const folders = Array.isArray(r.userSelectedFolders)
    ? r.userSelectedFolders.filter((x): x is string => typeof x === "string" && x.startsWith("/"))
    : [];
  return {
    sessionId: r.sessionId,
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim().slice(0, 200) : null,
    cliSessionId: typeof r.cliSessionId === "string" && CLI_ID.test(r.cliSessionId) ? r.cliSessionId : null,
    createdAt: num(r.createdAt),
    lastActivityAt: num(r.lastActivityAt),
    isArchived: r.isArchived === true,
    folders,
  };
}

/**
 * Fold transcript text. Same rules as a terminal transcript, plus:
 * - a user line with interruptedByShutdown ends as "interrupt" (not working);
 * - a turn counts when the state changes to a finished assistant turn (Cowork
 *   transcripts have no turn_duration lines).
 */
export function foldCowork(st: TranscriptState, text: string): TranscriptState {
  let s = st;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!/"type":"(?:user|assistant|system|custom-title)"/.test(line)) continue;
    let j: unknown;
    try {
      j = JSON.parse(line);
    } catch {
      continue; // partial line
    }
    const before = s.last;
    s = foldLine(s, j);
    const e = j as Record<string, unknown>;
    if (e && e.type === "user" && e.interruptedByShutdown === true && e.isSidechain !== true) s = { ...s, last: "interrupt" };
    if (s.last === "assistant-end" && before !== "assistant-end" && e?.type === "assistant") s = { ...s, turns: s.turns + 1 };
  }
  return s;
}

/**
 * Status (spec 0005):
 * - archived: isArchived.
 * - working: the last entry is a prompt, a tool result or an unfinished assistant
 *   step, and the transcript moved less than 10 minutes ago.
 * - waiting: the last assistant turn ended and nothing newer; older than 3 days: idle.
 * - idle: anything else (also a stop by shutdown, or no transcript).
 */
export function coworkStatus(meta: CoworkMeta, st: TranscriptState, now: number, transcriptMtimeMs = 0): Status {
  if (meta.isArchived) return "archived";
  const at = st.lastAt ?? meta.lastActivityAt ?? transcriptMtimeMs;
  const moved = Math.max(st.lastAt ?? 0, transcriptMtimeMs);
  if ((st.last === "prompt" || st.last === "tool" || st.last === "assistant-mid") && now - moved < COWORK_WORKING_MS) return "working";
  if (st.last === "assistant-end" || st.last === "turn-end") return now - at > STALE_WAITING_MS ? "idle" : "waiting";
  return "idle";
}

export function toCoworkSession(meta: CoworkMeta, st: TranscriptState, now: number, fileMtimeMs: number, transcriptMtimeMs = 0): BaseSession {
  const last = Math.max(meta.lastActivityAt ?? 0, st.lastAt ?? 0) || fileMtimeMs;
  const folder = meta.folders[0] ?? "";
  return {
    id: `cowork_${meta.sessionId}`,
    title: meta.title ?? st.customTitle ?? "Untitled session",
    cwd: folder,
    status: coworkStatus(meta, st, now, transcriptMtimeMs),
    lastActivityAt: last,
    completedTurns: st.turns,
    openUrl: null,
    cliSessionId: null, // no project detection, sub-agents or revive for a general chat
    spawnedFromId: null,
    summary: st.lastText,
    needsAction: null,
    links: [],
    remoteSteered: false,
    createdAt: meta.createdAt ?? st.firstAt ?? last,
    conversationIds: [], // never joins a restart chain with a code session
    source: "cowork",
    terminal: null,
    kind: "general",
    projectHint: folder ? basename(folder) || COWORK_PROJECT : COWORK_PROJECT,
  };
}

interface Transcript {
  file: string;
  size: number;
  mtimeMs: number;
  offset: number;
  state: TranscriptState;
}

interface Entry {
  file: string;
  mtimeMs: number;
  size: number;
  meta: CoworkMeta;
  transcript: Transcript | null;
}

/** Cache of Cowork sessions. scan() re-reads only what changed; transcripts are read from the tail, then only appends. */
export class CoworkReader {
  readonly root: string;
  private entries = new Map<string, Entry>();

  constructor(root: string) {
    this.root = root;
  }

  /** Returns true when anything changed since the last scan. */
  scan(): boolean {
    let changed = false;
    const seen = new Set<string>();
    for (const file of listSessionFiles(this.root, SKIP_DIRS)) {
      seen.add(file);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      let e = this.entries.get(file);
      if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) {
        const meta = readMeta(file);
        if (meta) {
          const sameConv = e && e.meta.cliSessionId === meta.cliSessionId;
          const next: Entry = { file, mtimeMs: st.mtimeMs, size: st.size, meta, transcript: sameConv ? e!.transcript : null };
          if (!e || JSON.stringify(e.meta) !== JSON.stringify(meta)) changed = true;
          this.entries.set(file, next);
          e = next;
        }
      }
      if (e && this.scanTranscript(e)) changed = true;
    }
    for (const file of [...this.entries.keys()]) {
      if (!seen.has(file)) {
        this.entries.delete(file);
        changed = true;
      }
    }
    return changed;
  }

  private locate(e: Entry): string | null {
    const cli = e.meta.cliSessionId;
    if (!cli) return null;
    if (e.transcript && exists(e.transcript.file)) return e.transcript.file;
    const projects = join(e.file.replace(/\.json$/, ""), ".claude", "projects");
    let dirs: string[] = [];
    try {
      dirs = readdirSync(projects);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const f = join(projects, d, `${cli}.jsonl`);
      if (exists(f)) return f;
    }
    return null;
  }

  private scanTranscript(e: Entry): boolean {
    const file = this.locate(e);
    const old = e.transcript;
    if (!file) {
      e.transcript = null;
      return !!old;
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      return false;
    }
    if (old && old.file === file && old.size === st.size && old.mtimeMs === st.mtimeMs) return false;
    let from: number;
    let state: TranscriptState;
    if (!old || old.file !== file || st.size < old.offset || st.size - old.offset > MAX_APPEND_BYTES) {
      from = Math.max(0, st.size - TAIL_BYTES);
      state = EMPTY_STATE;
    } else {
      from = old.offset;
      state = old.state;
    }
    const buf = readRange(file, from, st.size);
    if (buf === null) return false;
    let start = 0;
    if (from > 0 && state === EMPTY_STATE) {
      const nl = buf.indexOf(10);
      start = nl === -1 ? buf.length : nl + 1;
    }
    const end = buf.lastIndexOf(10) + 1;
    const next = end > start ? foldCowork(state, buf.toString("utf8", start, end)) : state;
    e.transcript = { file, size: st.size, mtimeMs: st.mtimeMs, offset: from + Math.max(end, start), state: next };
    return !old || old.file !== file || JSON.stringify(old.state) !== JSON.stringify(next) || old.mtimeMs !== st.mtimeMs;
  }

  sessions(now = Date.now()): BaseSession[] {
    const byId = new Map<string, BaseSession>();
    for (const e of this.entries.values()) {
      const t = e.transcript;
      const s = toCoworkSession(e.meta, t?.state ?? EMPTY_STATE, now, e.mtimeMs, t?.mtimeMs ?? 0);
      const prev = byId.get(s.id);
      if (!prev || s.lastActivityAt > prev.lastActivityAt) byId.set(s.id, s);
    }
    return [...byId.values()];
  }
}

function exists(f: string): boolean {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
}

function readMeta(file: string): CoworkMeta | null {
  try {
    return pickMeta(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null; // partial write: keep the last good value, retry next scan
  }
}
