// Reads the Claude desktop session files. READ ONLY: never write or move them.
// Layout: <root>/<account>/<org>/local_*.json, one file per session.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Kind, Link, Source, Status, TerminalInfo } from "../shared/types.ts";
import { computeStatus, freshSummary, freshText, type StatusInput } from "./status.ts";

export interface RawSession extends StatusInput {
  sessionId: string;
  cliSessionId?: unknown;
  title?: unknown;
  cwd?: unknown;
  completedTurns?: unknown;
  remoteControlSpawn?: unknown;
  bridgeSessionIds?: unknown;
  spawnedFrom?: unknown;
  steeredByRemoteClient?: unknown;
  priorCliSessionIds?: unknown;
  createdAt?: unknown;
}

export interface FileEntry {
  file: string;
  mtimeMs: number;
  size: number;
  raw: RawSession;
}

export interface BaseSession {
  id: string;
  title: string;
  cwd: string;
  status: Status;
  lastActivityAt: number;
  completedTurns: number;
  openUrl: string | null;
  cliSessionId: string | null; // names the transcript file, not sent to the UI
  spawnedFromId: string | null; // raw parent id, may point to a deleted session; not sent
  summary: string | null;
  needsAction: string | null;
  links: Link[];
  remoteSteered: boolean;
  createdAt: number; // not sent
  conversationIds: string[]; // cliSessionId and priorCliSessionIds, for restart chains; not sent
  source: Source;
  terminal: TerminalInfo | null;
  kind?: Kind; // spec 0005: missing means "code"
  projectHint?: string | null; // spec 0005: project when there is no override or detection (Cowork); not sent
}

const REMOTE_ID = /^(?:session_|cse_)(?:staging_)?[A-Za-z0-9]{1,64}$/;

/**
 * Build the claude.ai link. Evidence: the desktop app maps a remote id with
 * `id.replace(/^cse_/, "session_")` and builds cloud links as `<base>/code/<id>`.
 * Each session has its own unique bridge id (the last bridgeSessionIds entry), and
 * remoteControlSpawn.ccrSessionId equals it when Remote Control spawned the session.
 */
export function buildOpenUrl(raw: { remoteControlSpawn?: unknown; bridgeSessionIds?: unknown }): string | null {
  let id: unknown;
  const rc = raw.remoteControlSpawn;
  if (rc && typeof rc === "object") id = (rc as { ccrSessionId?: unknown }).ccrSessionId;
  if (typeof id !== "string" || !REMOTE_ID.test(id)) {
    const list = Array.isArray(raw.bridgeSessionIds) ? raw.bridgeSessionIds : [];
    id = [...list].reverse().find((x) => typeof x === "string" && REMOTE_ID.test(x));
  }
  if (typeof id !== "string" || !REMOTE_ID.test(id)) return null;
  return `https://claude.ai/code/${id.replace(/^cse_/, "session_")}`;
}

const MAX_TEXT = 2000;
const clip = (v: string | null): string | null => (v && v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + "..." : v);

/**
 * Remote links of a session: remoteControlSpawn.ccrSessionId (remote-control) and
 * every bridgeSessionIds entry (bridge). cse_ becomes session_. Same id once only,
 * remote-control wins.
 */
export function buildLinks(raw: { remoteControlSpawn?: unknown; bridgeSessionIds?: unknown }): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  const add = (kind: Link["kind"], id: unknown) => {
    if (typeof id !== "string" || !REMOTE_ID.test(id)) return;
    const remoteId = id.replace(/^cse_/, "session_");
    if (seen.has(remoteId)) return;
    seen.add(remoteId);
    out.push({ kind, remoteId, url: `https://claude.ai/code/${remoteId}` });
  };
  const rc = raw.remoteControlSpawn;
  if (rc && typeof rc === "object") add("remote-control", (rc as { ccrSessionId?: unknown }).ccrSessionId);
  if (Array.isArray(raw.bridgeSessionIds)) for (const id of raw.bridgeSessionIds) add("bridge", id);
  return out;
}

function parentRef(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const id = (v as { sessionId?: unknown }).sessionId;
  return typeof id === "string" && id ? id : null;
}

function conversationIds(r: RawSession): string[] {
  const ids = new Set<string>();
  if (typeof r.cliSessionId === "string" && r.cliSessionId) ids.add(r.cliSessionId);
  if (Array.isArray(r.priorCliSessionIds)) {
    for (const x of r.priorCliSessionIds) if (typeof x === "string" && x) ids.add(x);
  }
  return [...ids];
}

export function toBaseSession(e: FileEntry, now: number): BaseSession {
  const r = e.raw;
  const last = typeof r.lastActivityAt === "number" ? r.lastActivityAt : e.mtimeMs;
  const sum = freshSummary(r);
  return {
    id: r.sessionId,
    title: typeof r.title === "string" && r.title.trim() ? r.title : "Untitled session",
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    status: computeStatus(r, now, e.mtimeMs),
    lastActivityAt: last,
    completedTurns: typeof r.completedTurns === "number" ? r.completedTurns : 0,
    openUrl: buildOpenUrl(r),
    cliSessionId: typeof r.cliSessionId === "string" && r.cliSessionId ? r.cliSessionId : null,
    spawnedFromId: parentRef(r.spawnedFrom),
    summary: clip(freshText(sum?.status_detail)),
    needsAction: clip(freshText(sum?.needs_action)),
    links: buildLinks(r),
    remoteSteered: r.steeredByRemoteClient === true,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : last,
    conversationIds: conversationIds(r),
    source: "desktop",
    terminal: null,
  };
}

/** List session files two levels below root. Missing folders give an empty list. */
export function listSessionFiles(root: string, skip: string[] = []): string[] {
  const out: string[] = [];
  for (const a of safeDir(root)) {
    if (skip.includes(a)) continue;
    for (const b of safeDir(join(root, a))) {
      for (const f of safeDir(join(root, a, b))) {
        if (f.startsWith("local_") && f.endsWith(".json")) out.push(join(root, a, b, f));
      }
    }
  }
  return out;
}

function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Cache of parsed files. scan() re-reads only files whose mtime or size changed.
 * A file that fails to parse (partial write) keeps its last good value.
 */
export class SessionReader {
  readonly root: string;
  private entries = new Map<string, FileEntry>();

  constructor(root: string) {
    this.root = root;
  }

  /** Returns true when anything changed since the last scan. */
  scan(): boolean {
    let changed = false;
    const seen = new Set<string>();
    for (const file of listSessionFiles(this.root)) {
      seen.add(file);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue; // removed between list and stat
      }
      const old = this.entries.get(file);
      if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
      const raw = parseFile(file);
      if (!raw) {
        // Partial file: keep the last good value, and retry on the next scan.
        continue;
      }
      this.entries.set(file, { file, mtimeMs: st.mtimeMs, size: st.size, raw });
      changed = true;
    }
    for (const file of [...this.entries.keys()]) {
      if (!seen.has(file)) {
        this.entries.delete(file);
        changed = true;
      }
    }
    return changed;
  }

  sessions(now = Date.now()): BaseSession[] {
    const byId = new Map<string, BaseSession>();
    for (const e of this.entries.values()) {
      const s = toBaseSession(e, now);
      const prev = byId.get(s.id);
      if (!prev || s.lastActivityAt > prev.lastActivityAt) byId.set(s.id, s);
    }
    return [...byId.values()];
  }
}

function parseFile(file: string): RawSession | undefined {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || typeof j.sessionId !== "string" || !j.sessionId) return undefined;
    return j as RawSession;
  } catch {
    return undefined;
  }
}
