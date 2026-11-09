// Restart chains: a newer desktop session that continues the same conversation.
//
// Evidence (read only, 2026-11-08, 65 desktop files, 192 recent transcripts):
// - The signal we use: two desktop sessions share a CLI conversation id. Each file
//   has cliSessionId, and a few have priorCliSessionIds (the CLI ids it used
//   before a restart inside the app). When session B lists A's cliSessionId in
//   its own cliSessionId or priorCliSessionIds, B continues A. No such pair exists
//   today, so there are 0 chains on real data, but this is the only id that
//   names the conversation itself.
// - `claude --resume <id>` (claude-control rc-resume) keeps the same CLI id: its
//   13 transcripts in sessions.conf are appended in place for weeks. 12 of the 13
//   ids are not desktop sessions at all, so they never reach this server.
// - forkedFromSessionId (2 files) and copied transcript lines with a foreign
//   sessionId (the same 2 files) are forks that also have spawnedFrom. A fork is
//   a branch, not a restart, so we ignore both signals here.
// - remoteControlDescendant is only a boolean, it names no session.
// - A pair where one session was spawned from the other is never a chain.

import type { BaseSession } from "./sessions.ts";

export interface Chains {
  replacedBy: Map<string, string>; // old id -> newest id in its chain
  replaces: Map<string, string[]>; // id -> older ids, oldest first
}

type ChainInput = Pick<BaseSession, "id" | "createdAt" | "lastActivityAt" | "conversationIds" | "spawnedFromId">;

export function findChains(bases: ChainInput[]): Chains {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const byId = new Map(bases.map((b) => [b.id, b]));
  for (const b of bases) parent.set(b.id, b.id);

  const owner = new Map<string, string>(); // conversation id -> first session that has it
  for (const b of bases) {
    for (const cid of b.conversationIds) {
      const other = owner.get(cid);
      if (!other) {
        owner.set(cid, b.id);
        continue;
      }
      const o = byId.get(other)!;
      if (b.spawnedFromId === other || o.spawnedFromId === b.id) continue; // fork or child
      parent.set(find(b.id), find(other));
    }
  }

  const groups = new Map<string, ChainInput[]>();
  for (const b of bases) {
    const r = find(b.id);
    const g = groups.get(r);
    if (g) g.push(b);
    else groups.set(r, [b]);
  }

  const out: Chains = { replacedBy: new Map(), replaces: new Map() };
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.createdAt - b.createdAt || a.lastActivityAt - b.lastActivityAt || a.id.localeCompare(b.id));
    const newest = g[g.length - 1].id;
    g.forEach((s, i) => {
      if (i < g.length - 1) out.replacedBy.set(s.id, newest);
      if (i > 0) out.replaces.set(s.id, g.slice(0, i).map((x) => x.id));
    });
  }
  return out;
}
