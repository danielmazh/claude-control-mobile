// v2.5: rename a session for the hub only. Fake fixtures, no real titles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserStore, ValidationError } from "./store.ts";
import { buildSnapshot } from "./snapshot.ts";
import { findChains } from "./chains.ts";
import { WaitingNotifier } from "./notifier.ts";
import { FallNotifier } from "./falls.ts";
import type { BaseSession } from "./sessions.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "deck-rename-"));
}

const base = (id: string, title: string, extra: Partial<BaseSession> = {}): BaseSession => ({
  id, title, cwd: "/fake/proj", status: "idle", lastActivityAt: 1000, completedTurns: 0, openUrl: null,
  cliSessionId: null, spawnedFromId: null, summary: null, needsAction: null, links: [], remoteSteered: false,
  createdAt: 1000, conversationIds: [], source: "desktop", terminal: null, ...extra,
});

test("rename: title is trimmed, persisted, and empty or null clears it", () => {
  const dir = tmp();
  try {
    const s = new UserStore(dir);
    s.patchSession("id1", { title: "  Fake hub name  " });
    assert.equal(new UserStore(dir).session("id1").title, "Fake hub name");
    assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).sessions.id1.title, "Fake hub name");
    s.patchSession("id1", { title: "" });
    assert.equal(new UserStore(dir).session("id1").title, undefined);
    s.patchSession("id1", { title: "Again" });
    s.patchSession("id1", { title: "   " });
    assert.equal(s.session("id1").title, undefined, "only spaces clears");
    s.patchSession("id1", { title: "Again" });
    s.patchSession("id1", { title: null });
    assert.equal(s.session("id1").title, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename: validation, 120 chars max, bad type", () => {
  const dir = tmp();
  try {
    const s = new UserStore(dir);
    assert.throws(() => s.patchSession("id1", { title: 5 }), ValidationError);
    assert.throws(() => s.patchSession("id1", { title: "x".repeat(121) }), ValidationError);
    assert.deepEqual(s.session("id1"), {});
    s.patchSession("id1", { title: "y".repeat(120) });
    assert.equal(s.session("id1").title?.length, 120);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename: the hub name follows a restart chain, a name on the new session wins", () => {
  const dir = tmp();
  try {
    const s = new UserStore(dir);
    const old = base("local_old", "App name", { conversationIds: ["c1"], createdAt: 1 });
    const neu = base("local_new", "App name", { conversationIds: ["c1"], createdAt: 2 });
    const chains = findChains([old, neu]);
    assert.equal(chains.replacedBy.get("local_old"), "local_new");
    s.patchSession("local_old", { title: "Old hub name" });
    for (const [from, to] of chains.replacedBy) s.moveSession(from, to);
    assert.equal(s.session("local_new").title, "Old hub name");
    assert.equal(new UserStore(dir).session("local_old").title, undefined);

    s.patchSession("local_a", { title: "From A" });
    s.patchSession("local_b", { title: "Kept on B" });
    s.moveSession("local_a", "local_b");
    assert.equal(s.session("local_b").title, "Kept on B");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename: snapshot gives title, appTitle and renamed", () => {
  const users: Record<string, { title?: string }> = { local_r: { title: "Hub name" } };
  const snap = buildSnapshot([base("local_r", "App name"), base("local_p", "Plain")], (id) => users[id] ?? {}, [], 1);
  const by = Object.fromEntries(snap.sessions.map((x) => [x.id, x]));
  assert.equal(by.local_r.title, "Hub name");
  assert.equal(by.local_r.appTitle, "App name");
  assert.equal(by.local_r.renamed, true);
  assert.equal(by.local_p.title, "Plain");
  assert.equal(by.local_p.appTitle, "Plain");
  assert.equal(by.local_p.renamed, false);
});

test("rename: waiting and fall pushes use the hub name, also as parent", () => {
  const users: Record<string, { title?: string; pinned?: boolean }> = {
    local_p: { title: "Parent hub", pinned: true },
    local_k: { title: "Kid hub" },
  };
  const mk = (kidStatus: "idle" | "waiting") =>
    buildSnapshot(
      [base("local_p", "Parent app"), base("local_k", "Kid app", { spawnedFromId: "local_p", status: kidStatus })],
      (id) => users[id] ?? {},
      [],
      1,
    ).sessions;
  const n = new WaitingNotifier(async () => {});
  const t = 1_000_000_000;
  n.update(mk("idle"), t);
  const out = n.update(mk("waiting"), t + 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Parent hub › Kid hub");

  const term = (running: boolean) =>
    buildSnapshot(
      [base("cli_t", "Term app", { source: "terminal", terminal: { tmuxTarget: null, running, attachCmd: null, name: "t" } })],
      () => ({ title: "Term hub" }),
      [],
      1,
    ).sessions;
  const f = new FallNotifier(async () => {});
  f.poll(term(true), t);
  f.poll(term(false), t + 1);
  const fell = f.poll(term(false), t + 2);
  assert.equal(fell.length, 1);
  assert.match(fell[0].title, /Term hub/);
  assert.doesNotMatch(fell[0].title, /Term app/);
});
