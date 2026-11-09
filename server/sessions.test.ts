import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionReader, buildOpenUrl } from "./sessions.ts";
import { buildSnapshot, projectFromCwd } from "./snapshot.ts";

const FIX = resolve(import.meta.dirname, "..", "test", "fixtures", "sessions");
const T = 1_800_000_000_000;

function copyFixtures(): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-sessions-"));
  cpSync(FIX, dir, { recursive: true });
  return dir;
}

test("reader parses fixtures, skips the partial file, computes status", () => {
  const r = new SessionReader(FIX);
  assert.equal(r.scan(), true);
  const byId = Object.fromEntries(r.sessions(T).map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ["local_fx-archived", "local_fx-blocked", "local_fx-idle", "local_fx-working"]);
  assert.equal(byId["local_fx-working"].status, "working");
  assert.equal(byId["local_fx-blocked"].status, "waiting");
  assert.equal(byId["local_fx-idle"].status, "idle");
  assert.equal(byId["local_fx-archived"].status, "archived");
  assert.equal(byId["local_fx-archived"].completedTurns, 1);
  assert.equal(r.scan(), false, "no change on second scan");
});

test("partial write keeps the last good value", () => {
  const dir = copyFixtures();
  try {
    const r = new SessionReader(dir);
    r.scan();
    const file = join(dir, "acct-0001", "org-0001", "local_fx-idle.json");
    writeFileSync(file, '{"sessionId":"local_fx-idle","title":"half');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    assert.equal(r.scan(), false);
    const s = r.sessions(T).find((x) => x.id === "local_fx-idle");
    assert.equal(s?.title, "Fake idle session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removed file disappears, changed file re-reads", () => {
  const dir = copyFixtures();
  try {
    const r = new SessionReader(dir);
    r.scan();
    rmSync(join(dir, "acct-0001", "org-0001", "local_fx-archived.json"));
    const file = join(dir, "acct-0001", "org-0001", "local_fx-idle.json");
    writeFileSync(file, JSON.stringify({ sessionId: "local_fx-idle", title: "Renamed", cwd: "/x", lastActivityAt: T }));
    assert.equal(r.scan(), true);
    const ids = r.sessions(T).map((s) => s.id);
    assert.ok(!ids.includes("local_fx-archived"));
    assert.equal(r.sessions(T).find((s) => s.id === "local_fx-idle")?.title, "Renamed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing root gives no sessions", () => {
  const r = new SessionReader("/nonexistent/deck/path");
  assert.equal(r.scan(), false);
  assert.deepEqual(r.sessions(), []);
});

test("openUrl: cse_ maps to session_, falls back to last bridge id, else null", () => {
  assert.equal(buildOpenUrl({ remoteControlSpawn: { ccrSessionId: "cse_01Abc" } }), "https://claude.ai/code/session_01Abc");
  assert.equal(buildOpenUrl({ bridgeSessionIds: ["session_01P", "session_01Own"] }), "https://claude.ai/code/session_01Own");
  assert.equal(buildOpenUrl({ bridgeSessionIds: ["bad id/../x"] }), null);
  assert.equal(buildOpenUrl({}), null);
});

test("snapshot merges the user layer and sorts by activity", () => {
  const r = new SessionReader(FIX);
  r.scan();
  const users: Record<string, object> = {
    "local_fx-idle": { pinned: true, priority: "high", labelIds: ["l1"], note: "n", project: "Mine" },
  };
  const snap = buildSnapshot(r.sessions(T), (id) => users[id] ?? {}, [{ id: "l1", name: "L", color: "#ff0000" }], T);
  assert.deepEqual(snap.sessions.map((s) => s.id), ["local_fx-working", "local_fx-blocked", "local_fx-idle", "local_fx-archived"]);
  const idle = snap.sessions.find((s) => s.id === "local_fx-idle")!;
  assert.equal(idle.project, "Mine");
  assert.equal(idle.pinned, true);
  assert.equal(idle.priority, "high");
  const blocked = snap.sessions.find((s) => s.id === "local_fx-blocked")!;
  assert.equal(blocked.project, "beta");
  assert.equal(blocked.pinned, false);
  assert.equal(blocked.priority, "normal");
  assert.deepEqual(blocked.labelIds, []);
  assert.equal(blocked.note, "");
  assert.equal(blocked.openUrl, "https://claude.ai/code/session_01FakeBBB");
  assert.equal(snap.generatedAt, T);
  assert.equal(projectFromCwd(""), "(no folder)");
});
