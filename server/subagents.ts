// Sub-agents of a session, read from the CLI transcript folder. READ ONLY.
//
// Layout (checked 2026-11-08):
//   <projectsDir>/<encoded cwd>/<cliSessionId>/subagents/agent-<id>.meta.json
//   <projectsDir>/<encoded cwd>/<cliSessionId>/subagents/agent-<id>.jsonl
// meta: {agentType, description, toolUseId, spawnDepth, finished?}.
// Old metas have no "finished". Then an agent is finished when both the meta and
// the jsonl file are older than LEGACY_RUNNING_MS, else it is running.
//
// Rules:
// - All file work runs in the background. get() only reads the cache, so the
//   snapshot never waits. Until the first pass, a session shows no sub-agents.
// - A folder is listed again only when its mtime changes. A meta file is parsed
//   again only when its mtime or size changes. Agents that may still run are
//   checked on every pass, finished ones are not.
// - We read only the small meta files, never the transcript content.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Subagent, SubagentSummary } from "../shared/types.ts";
import { encodeProjectDir, trimSlash } from "./projects.ts";

export const LEGACY_RUNNING_MS = 10 * 60 * 1000;
export const MAX_ITEMS = 30;
const MIN_PASS_MS = 2000;
const MAX_DESC = 300;
const META = /^agent-([A-Za-z0-9_-]{1,80})\.meta\.json$/;
const CLI_ID = /^[A-Za-z0-9-]{1,80}$/;

export interface AgentState {
  id: string;
  type: string;
  description: string;
  finishedField: boolean | undefined; // the meta "finished" value, if present
  startedAt: number | null; // meta birth time
  metaMtime: number;
  metaSize: number;
  jsonlMtime: number; // 0 when unknown or missing
}

interface DirState {
  dirMtime: number;
  agents: Map<string, AgentState>;
}

export const EMPTY: SubagentSummary = Object.freeze({ running: 0, done: 0, items: [] }) as SubagentSummary;

export function isFinished(a: AgentState, now: number): boolean {
  if (typeof a.finishedField === "boolean") return a.finishedField;
  return now - Math.max(a.metaMtime, a.jsonlMtime) > LEGACY_RUNNING_MS;
}

/** Counts over all agents, items capped at the MAX_ITEMS newest. */
export function summarize(agents: Iterable<AgentState>, now: number): SubagentSummary {
  let running = 0;
  let done = 0;
  const all: Subagent[] = [];
  for (const a of agents) {
    const finished = isFinished(a, now);
    if (finished) done++;
    else running++;
    all.push({ id: a.id, type: a.type, description: a.description, finished, startedAt: a.startedAt });
  }
  all.sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0) || x.id.localeCompare(y.id));
  return { running, done, items: all.slice(0, MAX_ITEMS) };
}

/** Parse one meta file. Unknown or bad fields get safe defaults. */
export function parseMeta(text: string): Pick<AgentState, "type" | "description" | "finishedField"> | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined; // partial write: try again next pass
  }
  if (!j || typeof j !== "object") return undefined;
  const m = j as Record<string, unknown>;
  const desc = typeof m.description === "string" ? m.description.trim() : "";
  return {
    type: typeof m.agentType === "string" && m.agentType ? m.agentType.slice(0, 80) : "agent",
    description: desc.length > MAX_DESC ? desc.slice(0, MAX_DESC) + "..." : desc,
    finishedField: typeof m.finished === "boolean" ? m.finished : undefined,
  };
}

export interface SubagentReaderOptions {
  projectsDir: string; // ~/.claude/projects
  onChange?: () => void;
  minPassMs?: number;
}

export class SubagentReader {
  private opts: SubagentReaderOptions;
  private dirs = new Map<string, DirState>();
  private wanted = new Set<string>();
  private running = false;
  private stopped = false;
  private lastPass = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: SubagentReaderOptions) {
    this.opts = opts;
  }

  dirFor(cwd: string, cliSessionId: string): string {
    return join(this.opts.projectsDir, encodeProjectDir(trimSlash(cwd)), cliSessionId, "subagents");
  }

  /** Cached sub-agents of one session. Never blocks; queues a refresh. */
  get(cwd: string, cliSessionId: string | null, now = Date.now()): SubagentSummary {
    if (!cwd || !cliSessionId || !CLI_ID.test(cliSessionId)) return EMPTY;
    const dir = this.dirFor(cwd, cliSessionId);
    this.wanted.add(dir);
    this.kick();
    const st = this.dirs.get(dir);
    return st && st.agents.size ? summarize(st.agents.values(), now) : EMPTY;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run one full pass now (tests). */
  async flush(): Promise<void> {
    while (this.running) await tick();
    this.running = true;
    try {
      await this.pass();
    } finally {
      this.running = false;
    }
  }

  private kick(): void {
    if (this.running || this.stopped || this.timer) return;
    const wait = Math.max(0, this.lastPass + (this.opts.minPassMs ?? MIN_PASS_MS) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.running || this.stopped) return;
      this.running = true;
      this.pass()
        .catch(() => {})
        .finally(() => {
          this.running = false;
          this.lastPass = Date.now();
        });
    }, wait);
    this.timer.unref();
  }

  private async pass(): Promise<void> {
    let changed = false;
    const jobs = [...this.wanted];
    this.wanted.clear();
    for (const dir of jobs) {
      if (this.stopped) return;
      try {
        if (await this.scanDir(dir)) changed = true;
      } catch {
        // unreadable folder: keep the last value
      }
      await tick();
    }
    if (changed) this.opts.onChange?.();
  }

  /** Returns true when the agents of this folder changed. */
  private async scanDir(dir: string): Promise<boolean> {
    let info;
    try {
      info = await stat(dir);
    } catch {
      const had = this.dirs.get(dir)?.agents.size ?? 0;
      this.dirs.set(dir, { dirMtime: -1, agents: new Map() });
      return had > 0;
    }
    let st = this.dirs.get(dir);
    if (!st) {
      st = { dirMtime: -1, agents: new Map() };
      this.dirs.set(dir, st);
    }
    let changed = false;
    const now = Date.now();
    const relist = st.dirMtime !== info.mtimeMs;
    let ids: string[];
    if (relist) {
      ids = [];
      for (const name of await readdir(dir)) {
        const m = META.exec(name);
        if (m) ids.push(m[1]);
      }
      const keep = new Set(ids);
      for (const id of [...st.agents.keys()]) {
        if (!keep.has(id)) {
          st.agents.delete(id);
          changed = true;
        }
      }
      st.dirMtime = info.mtimeMs;
    } else {
      ids = [...st.agents.keys()];
    }
    for (const id of ids) {
      const old = st.agents.get(id);
      if (old && isFinished(old, now) && typeof old.finishedField === "boolean") continue;
      if (old && old.finishedField === undefined && isFinished(old, now)) continue;
      const next = await this.readAgent(dir, id, old);
      if (!next) continue;
      if (!old || JSON.stringify(old) !== JSON.stringify(next)) {
        st.agents.set(id, next);
        changed = true;
      }
    }
    return changed;
  }

  private async readAgent(dir: string, id: string, old: AgentState | undefined): Promise<AgentState | undefined> {
    const metaFile = join(dir, `agent-${id}.meta.json`);
    let ms;
    try {
      ms = await stat(metaFile);
    } catch {
      return undefined;
    }
    let base: Pick<AgentState, "type" | "description" | "finishedField"> | undefined = old;
    if (!old || old.metaMtime !== ms.mtimeMs || old.metaSize !== ms.size) {
      base = parseMeta(await readFile(metaFile, "utf8")) ?? old;
    }
    if (!base) return undefined;
    let jsonlMtime = 0;
    if (base.finishedField === undefined) {
      try {
        jsonlMtime = (await stat(join(dir, `agent-${id}.jsonl`))).mtimeMs;
      } catch {
        jsonlMtime = 0;
      }
    }
    const born = ms.birthtimeMs > 0 ? ms.birthtimeMs : ms.mtimeMs;
    return {
      id,
      type: base.type,
      description: base.description,
      finishedField: base.finishedField,
      startedAt: Math.round(born),
      metaMtime: ms.mtimeMs,
      metaSize: ms.size,
      jsonlMtime,
    };
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));
