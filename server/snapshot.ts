// Merge the desktop sessions with the user layer into the API Snapshot.

import { basename } from "node:path";
import type { Label, ReviveMode, Session, Snapshot, SubagentSummary } from "../shared/types.ts";
import type { BaseSession } from "./sessions.ts";
import type { UserSession } from "./store.ts";
import { findChains, type Chains } from "./chains.ts";

export function projectFromCwd(cwd: string): string {
  const name = basename(cwd.replace(/[\\/]+$/, ""));
  return name || "(no folder)";
}

const NO_AGENTS: SubagentSummary = { running: 0, done: 0, items: [] };

/** Tree and chain fields that need the whole session list. */
export interface Related {
  parentId: string | null;
  childIds: string[];
  depth: number;
  replacedBy: string | null;
  replaces: string[];
}

const LONE: Related = { parentId: null, childIds: [], depth: 0, replacedBy: null, replaces: [] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Spec 0004: a manifest session restarts by name; a desktop session with a known CLI conversation can start in the terminal. */
export function reviveMode(base: BaseSession): ReviveMode | null {
  if (base.terminal?.name) return "restart";
  if (base.source === "desktop" && base.cliSessionId && UUID.test(base.cliSessionId)) return "resume";
  return null;
}

/** Project: user override, else the detected subfolder, else the last folder name of cwd. */
export function mergeSession(
  base: BaseSession,
  user: UserSession,
  detected?: string,
  related: Related = LONE,
  subagents: SubagentSummary = NO_AGENTS,
): Session {
  const { cliSessionId: _cli, spawnedFromId: _p, createdAt: _c, conversationIds: _ids, projectHint: _h, kind: _k, ...rest } = base;
  return {
    ...rest,
    links: base.links.map((l) => ({ ...l })),
    terminal: base.terminal ? { ...base.terminal } : null,
    revive: reviveMode(base),
    kind: base.kind ?? "code",
    project: user.project || detected || base.projectHint || projectFromCwd(base.cwd),
    pinned: user.pinned ?? false,
    priority: user.priority ?? "normal",
    labelIds: user.labelIds ?? [],
    note: user.note ?? "",
    ...related,
    childIds: [...related.childIds],
    replaces: [...related.replaces],
    subagents,
  };
}

/**
 * Parent links and depth. The parent is spawnedFrom.sessionId; when that parent
 * was restarted, the child moves to the newest session of the chain. A parent
 * that is gone (deleted) makes the child a root. A loop also ends as a root.
 */
export function buildTree(bases: BaseSession[], chains: Chains): Map<string, Related> {
  const byId = new Map(bases.map((b) => [b.id, b]));
  const parentOf = new Map<string, string | null>();
  for (const b of bases) {
    let p = b.spawnedFromId;
    if (p) p = chains.replacedBy.get(p) ?? p;
    parentOf.set(b.id, p && p !== b.id && byId.has(p) ? p : null);
  }
  // Break loops: walk up, and cut the link that closes a loop.
  for (const b of bases) {
    const seen = new Set<string>([b.id]);
    let cur = b.id;
    for (;;) {
      const p = parentOf.get(cur) ?? null;
      if (!p) break;
      if (seen.has(p)) {
        parentOf.set(cur, null);
        break;
      }
      seen.add(p);
      cur = p;
    }
  }
  const depthOf = (id: string): number => {
    let d = 0;
    let p = parentOf.get(id) ?? null;
    while (p) {
      d++;
      p = parentOf.get(p) ?? null;
    }
    return d;
  };
  const children = new Map<string, BaseSession[]>();
  for (const b of bases) {
    const p = parentOf.get(b.id);
    if (!p) continue;
    const list = children.get(p);
    if (list) list.push(b);
    else children.set(p, [b]);
  }
  const out = new Map<string, Related>();
  for (const b of bases) {
    const kids = (children.get(b.id) ?? []).sort((x, y) => y.lastActivityAt - x.lastActivityAt || x.id.localeCompare(y.id));
    out.set(b.id, {
      parentId: parentOf.get(b.id) ?? null,
      childIds: kids.map((k) => k.id),
      depth: depthOf(b.id),
      replacedBy: chains.replacedBy.get(b.id) ?? null,
      replaces: chains.replaces.get(b.id) ?? [],
    });
  }
  return out;
}

export interface SnapshotExtras {
  subagentsOf?: (b: BaseSession) => SubagentSummary;
  chains?: Chains;
}

/** Sessions sorted by last activity, newest first. The UI does its own filters. */
export function buildSnapshot(
  bases: BaseSession[],
  userOf: (id: string) => UserSession,
  labels: Label[],
  now = Date.now(),
  detect: (b: BaseSession) => string | undefined = () => undefined,
  extras: SnapshotExtras = {},
): Snapshot {
  const tree = buildTree(bases, extras.chains ?? findChains(bases));
  const sessions = bases.map((b) =>
    mergeSession(b, userOf(b.id), detect(b), tree.get(b.id), extras.subagentsOf?.(b) ?? NO_AGENTS),
  );
  sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return { sessions, labels: labels.map((l) => ({ ...l })), generatedAt: now };
}
