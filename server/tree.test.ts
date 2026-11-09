import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { SessionReader, buildLinks } from "./sessions.ts";
import { buildSnapshot } from "./snapshot.ts";
import { findChains } from "./chains.ts";
import type { Session } from "../shared/types.ts";

const FIX = resolve(import.meta.dirname, "..", "test", "fixtures", "tree");
const T = 1_800_000_000_000;

function snap(): Record<string, Session> {
  const r = new SessionReader(FIX);
  r.scan();
  const s = buildSnapshot(r.sessions(T), () => ({}), [], T);
  return Object.fromEntries(s.sessions.map((x) => [x.id.replace(/^local_/, ""), x]));
}

test("tree: parents, children newest first, depth up to 3, missing parent is a root", () => {
  const s = snap();
  assert.equal(s["t-root"].parentId, null);
  assert.equal(s["t-root"].depth, 0);
  assert.deepEqual(s["t-root"].childIds, ["local_t-child2", "local_t-child1", "local_t-fork"]);
  assert.equal(s["t-child1"].parentId, "local_t-root");
  assert.deepEqual(s["t-child1"].childIds, ["local_t-grand"]);
  assert.equal(s["t-grand"].depth, 2);
  assert.equal(s["t-great"].depth, 3);
  assert.equal(s["t-great"].parentId, "local_t-grand");
  assert.deepEqual(s["t-great"].childIds, []);
  assert.equal(s["t-orphan"].parentId, null, "deleted parent: root");
  assert.equal(s["t-orphan"].depth, 0);
});

test("summary and needsAction only from a fresh summary; waiting follows needs_action", () => {
  const s = snap();
  assert.equal(s["t-root"].summary, "All done");
  assert.equal(s["t-root"].needsAction, null, "empty needs_action");
  assert.equal(s["t-root"].status, "idle");
  assert.equal(s["t-child1"].summary, "Need a choice");
  assert.equal(s["t-child1"].needsAction, "Pick A or B");
  assert.equal(s["t-child1"].status, "waiting");
  assert.equal(s["t-grand"].summary, null, "stale summary");
  assert.equal(s["t-grand"].needsAction, null);
  assert.equal(s["t-grand"].status, "idle");
});

test("links: remote-control first, cse_ normalised, deduped, bad ids dropped; remoteSteered", () => {
  const s = snap();
  assert.deepEqual(s["t-root"].links, [
    { kind: "remote-control", remoteId: "session_01FakeRc", url: "https://claude.ai/code/session_01FakeRc" },
    { kind: "bridge", remoteId: "session_01FakeBr", url: "https://claude.ai/code/session_01FakeBr" },
  ]);
  assert.equal(s["t-root"].remoteSteered, true);
  assert.deepEqual(s["t-child1"].links, []);
  assert.equal(s["t-child1"].remoteSteered, false);
  assert.deepEqual(buildLinks({}), []);
  for (const k of ["cliSessionId", "spawnedFromId", "conversationIds", "createdAt"]) assert.equal(k in s["t-root"], false, k);
});

test("restart chain of 3: replacedBy points to the newest, replaces oldest first, kids move", () => {
  const s = snap();
  assert.equal(s["t-r1"].replacedBy, "local_t-r3");
  assert.equal(s["t-r2"].replacedBy, "local_t-r3");
  assert.equal(s["t-r3"].replacedBy, null);
  assert.deepEqual(s["t-r3"].replaces, ["local_t-r1", "local_t-r2"]);
  assert.deepEqual(s["t-r2"].replaces, ["local_t-r1"]);
  assert.deepEqual(s["t-r1"].replaces, []);
  assert.equal(s["t-r2"].status, "waiting", "the old session keeps its status");
  assert.equal(s["t-rkid"].parentId, "local_t-r3", "child of an old session moves to the newest");
  assert.deepEqual(s["t-r3"].childIds, ["local_t-rkid"]);
  assert.deepEqual(s["t-r1"].childIds, []);
  // A fork that shares the parent's conversation id is not a restart.
  assert.equal(s["t-fork"].replacedBy, null);
  assert.equal(s["t-root"].replacedBy, null);
  assert.deepEqual(s["t-root"].replaces, []);
});

test("chains: no shared id gives no chain; loops in spawnedFrom end as a root", () => {
  const base = (id: string, cids: string[], parent: string | null = null) => ({
    id, createdAt: 1, lastActivityAt: 1, conversationIds: cids, spawnedFromId: parent,
  });
  assert.equal(findChains([base("a", ["x"]), base("b", ["y"])]).replacedBy.size, 0);
  const r = new SessionReader(FIX);
  r.scan();
  const bases = r.sessions(T).filter((b) => b.id === "local_t-root" || b.id === "local_t-child1");
  bases[bases.findIndex((b) => b.id === "local_t-root")] = { ...bases.find((b) => b.id === "local_t-root")!, spawnedFromId: "local_t-child1" };
  const out = buildSnapshot(bases, () => ({}), [], T).sessions;
  assert.equal(out.filter((x) => x.parentId === null).length, 1, "the loop is cut once");
});
