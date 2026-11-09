// Auto project detection for sessions that run from a workspace root.
//
// A workspace root is a folder whose direct subfolders are the projects, for
// example ~/code. A session started there shows the root name for every
// session, which says nothing. So we read the session transcript and find the
// subfolder the session really works in.
//
// Transcript: ~/.claude/projects/<encoded cwd>/<cliSessionId>.jsonl. The folder
// name is the cwd with every char that is not a letter, digit or "-" changed to
// "-" (checked on disk 2026-11-05: "/" and "." both become "-").
//
// Rules:
// - We count absolute paths under cwd in tool_use inputs and in the "cwd" field of
//   each line, per first-level subfolder. Hidden folders and plain files are skipped.
// - Recent lines weigh more: the weight doubles every HALF_LIFE_LINES lines.
// - Files can be tens of MB, so we read only the appended bytes and keep the counts.
//   A file that shrank is read again from the start.
// - All work runs in the background. project() only reads the cache, so the
//   snapshot never waits. Until a result is known, the caller uses the old rule.
// - We never log or print transcript content.

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const HALF_LIFE_LINES = 1000;
/** A cwd with this many git subfolders (and no .git of its own) is a workspace root. */
export const MIN_GIT_SUBFOLDERS = 3;
const CHUNK = 4 * 1024 * 1024;
const ROOT_RECHECK_MS = 10 * 60 * 1000;

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

export function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, "") : p;
}

/** Parse DECK_WORKSPACE_ROOTS (comma list). */
export function parseRoots(s: string | undefined): string[] {
  return (s ?? "").split(",").map((x) => trimSlash(x.trim())).filter(Boolean);
}

const SEGMENT = /^[^/\\\s"'`:;,()[\]{}<>|&*?$=]+/;

/** First-level subfolder names for each path under `prefix` ("<cwd>/") in text. */
export function segmentsIn(text: string, prefix: string): string[] {
  const out: string[] = [];
  let i = text.indexOf(prefix);
  while (i !== -1) {
    const m = SEGMENT.exec(text.slice(i + prefix.length, i + prefix.length + 256));
    if (m && !m[0].startsWith(".")) out.push(m[0]);
    i = text.indexOf(prefix, i + prefix.length);
  }
  return out;
}

function collectStrings(v: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
}

/** The strings of one transcript line that we count: tool_use inputs and cwd. */
export function lineStrings(line: string): string[] {
  let j: unknown;
  try {
    j = JSON.parse(line);
  } catch {
    return [];
  }
  if (!j || typeof j !== "object") return [];
  const e = j as { cwd?: unknown; message?: { content?: unknown } };
  const out: string[] = [];
  if (typeof e.cwd === "string") out.push(e.cwd + "/");
  const content = e.message && typeof e.message === "object" ? e.message.content : undefined;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && typeof c === "object" && (c as { type?: unknown }).type === "tool_use") {
        collectStrings((c as { input?: unknown }).input, out);
      }
    }
  }
  return out;
}

/** Scan state of one transcript file. Counts survive between reads. */
export interface FileState {
  size: number;
  mtimeMs: number;
  offset: number; // bytes read (complete lines only)
  lineNo: number;
  scaleLine: number; // counts are stored relative to this line
  counts: Map<string, number>;
}

export function newFileState(): FileState {
  return { size: 0, mtimeMs: 0, offset: 0, lineNo: 0, scaleLine: 0, counts: new Map() };
}

/** Add one line to the counts. */
export function addLine(st: FileState, line: string, prefix: string): void {
  st.lineNo++;
  if (!line.includes(prefix)) return; // cheap filter before JSON.parse
  let exp = (st.lineNo - st.scaleLine) / HALF_LIFE_LINES;
  if (exp > 500) {
    const f = 2 ** -exp;
    for (const [k, v] of st.counts) st.counts.set(k, v * f);
    st.scaleLine = st.lineNo;
    exp = 0;
  }
  const w = 2 ** exp;
  for (const s of lineStrings(line)) {
    for (const seg of segmentsIn(s, prefix)) st.counts.set(seg, (st.counts.get(seg) ?? 0) + w);
  }
}

/** The top subfolder, skipping names that are files. */
export function pickTop(counts: Map<string, number>, isFile: (name: string) => boolean): string | undefined {
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [name, n] of sorted) if (n > 0 && !isFile(name)) return name;
  return undefined;
}

/** Read the bytes appended since the last read. Resets when the file shrank. */
export async function updateFile(file: string, st: FileState, prefix: string, yieldFn = defaultYield): Promise<boolean> {
  const info = await stat(file);
  if (info.size === st.size && info.mtimeMs === st.mtimeMs) return false;
  if (info.size < st.offset) Object.assign(st, newFileState());
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry: Buffer = Buffer.alloc(0);
    let pos = st.offset;
    while (pos < info.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, info.size - pos), pos);
      if (bytesRead <= 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let start = 0;
      let nl = data.indexOf(10, start);
      while (nl !== -1) {
        addLine(st, data.toString("utf8", start, nl), prefix);
        start = nl + 1;
        nl = data.indexOf(10, start);
      }
      // A line without its newline stays in carry and is read again next time.
      st.offset = pos - (data.length - start);
      carry = Buffer.from(data.subarray(start));
      await yieldFn();
    }
  } finally {
    await fh.close();
  }
  st.size = info.size;
  st.mtimeMs = info.mtimeMs;
  return true;
}

const defaultYield = () => new Promise<void>((r) => setImmediate(r));

export interface DetectorOptions {
  projectsDir: string; // ~/.claude/projects
  roots?: string[]; // DECK_WORKSPACE_ROOTS
  onChange?: () => void;
}

interface RootInfo {
  isRoot: boolean;
  checkedAt: number;
  files: Set<string>; // direct children that are files
}

/** Background detector. project() reads the cache and queues a refresh. */
export class ProjectDetector {
  private opts: DetectorOptions;
  private roots: Set<string>;
  private rootInfo = new Map<string, RootInfo>();
  private files = new Map<string, FileState>();
  private results = new Map<string, string>(); // transcript path -> project
  private wanted = new Map<string, string>(); // transcript path -> cwd
  private running = false;
  private stopped = false;

  constructor(opts: DetectorOptions) {
    this.opts = opts;
    this.roots = new Set((opts.roots ?? []).map(trimSlash));
  }

  transcriptPath(cwd: string, cliSessionId: string): string {
    return join(this.opts.projectsDir, encodeProjectDir(trimSlash(cwd)), `${cliSessionId}.jsonl`);
  }

  /** Cached project for a session, or undefined. Never blocks. */
  project(cwd: string, cliSessionId: string | null): string | undefined {
    if (!cwd || !cliSessionId || !/^[A-Za-z0-9-]{1,80}$/.test(cliSessionId)) return undefined;
    const c = trimSlash(cwd);
    const file = this.transcriptPath(c, cliSessionId);
    this.wanted.set(file, c);
    this.kick();
    const info = this.rootInfo.get(c);
    if (!info?.isRoot) return undefined;
    return this.results.get(file);
  }

  stop(): void {
    this.stopped = true;
  }

  /** Run one full pass now (tests). */
  async flush(): Promise<void> {
    while (this.running) await defaultYield();
    await this.pass();
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.pass()
      .catch(() => {})
      .finally(() => {
        this.running = false;
      });
  }

  private async pass(): Promise<void> {
    let changed = false;
    const jobs = [...this.wanted];
    this.wanted.clear();
    for (const [file, cwd] of jobs) {
      if (this.stopped) return;
      const info = await this.checkRoot(cwd);
      if (!info.isRoot) continue;
      const st = this.files.get(file) ?? newFileState();
      this.files.set(file, st);
      try {
        await updateFile(file, st, cwd + "/");
      } catch {
        continue; // no transcript yet, or not readable
      }
      const top = pickTop(st.counts, (n) => info.files.has(n));
      if (top && this.results.get(file) !== top) {
        this.results.set(file, top);
        changed = true;
      }
    }
    if (changed) this.opts.onChange?.();
  }

  private async checkRoot(cwd: string): Promise<RootInfo> {
    const old = this.rootInfo.get(cwd);
    if (old && Date.now() - old.checkedAt < ROOT_RECHECK_MS) return old;
    const info: RootInfo = { isRoot: false, checkedAt: Date.now(), files: new Set() };
    try {
      const entries = await readdir(cwd, { withFileTypes: true });
      for (const e of entries) if (e.isFile()) info.files.add(e.name);
      if (this.roots.has(cwd)) {
        info.isRoot = true;
      } else if (!entries.some((e) => e.name === ".git")) {
        let git = 0;
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          if (await exists(join(cwd, e.name, ".git"))) git++;
          if (git >= MIN_GIT_SUBFOLDERS) break;
        }
        info.isRoot = git >= MIN_GIT_SUBFOLDERS;
      }
    } catch {
      info.isRoot = this.roots.has(cwd);
    }
    this.rootInfo.set(cwd, info);
    return info;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
