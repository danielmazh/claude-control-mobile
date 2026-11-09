import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SubagentReader, LEGACY_RUNNING_MS, MAX_ITEMS, parseMeta } from "./subagents.ts";

const FIX = resolve(import.meta.dirname, "..", "test", "fixtures", "projects");
const CWD = "/tmp/fx/tree";

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-agents-"));
  cpSync(FIX, dir, { recursive: true });
  return dir;
}

test("finished field wins; legacy meta uses the mtime rule; partial meta is skipped", async () => {
  const dir = copy();
  try {
    const sub = join(dir, "-tmp-fx-tree", "cli-t-root", "subagents");
    const r = new SubagentReader({ projectsDir: dir, minPassMs: 0 });
    assert.deepEqual(r.get(CWD, "cli-t-root"), { running: 0, done: 0, items: [] }, "empty before the first pass");
    await r.flush();
    const now = Date.now();
    let s = r.get(CWD, "cli-t-root", now);
    const byId = Object.fromEntries(s.items.map((i) => [i.id, i]));
    assert.deepEqual(Object.keys(byId).sort(), ["a1", "a2", "a3"]);
    assert.equal(byId.a1.finished, true);
    assert.equal(byId.a2.finished, false);
    assert.equal(byId.a3.finished, false, "legacy, recent files: running");
    assert.equal(byId.a1.type, "general-purpose");
    assert.equal(byId.a1.description, "Fake task a1");
    assert.equal(typeof byId.a1.startedAt, "number");
    assert.deepEqual([s.running, s.done], [2, 1]);
    // Later, the legacy agent is older than the limit: finished. No rescan needed.
    s = r.get(CWD, "cli-t-root", now + LEGACY_RUNNING_MS + 60_000);
    assert.equal(s.items.find((i) => i.id === "a3")!.finished, true);
    // Old mtimes on disk give the same answer after a rescan.
    const old = new Date(now - LEGACY_RUNNING_MS - 60_000);
    utimesSync(join(sub, "agent-a3.meta.json"), old, old);
    utimesSync(join(sub, "agent-a3.jsonl"), old, old);
    const r2 = new SubagentReader({ projectsDir: dir, minPassMs: 0 });
    r2.get(CWD, "cli-t-root");
    await r2.flush();
    assert.equal(r2.get(CWD, "cli-t-root").items.find((i) => i.id === "a3")!.finished, true);
    // A fresh jsonl keeps a legacy agent running even with an old meta.
    utimesSync(join(sub, "agent-a3.jsonl"), new Date(), new Date());
    const r3 = new SubagentReader({ projectsDir: dir, minPassMs: 0 });
    r3.get(CWD, "cli-t-root");
    await r3.flush();
    assert.equal(r3.get(CWD, "cli-t-root").items.find((i) => i.id === "a3")!.finished, false);
    // An agent that finishes updates its meta in place.
    writeFileSync(join(sub, "agent-a2.meta.json"), JSON.stringify({ agentType: "x", description: "d", finished: true }));
    r.get(CWD, "cli-t-root");
    await r.flush();
    assert.equal(r.get(CWD, "cli-t-root").items.find((i) => i.id === "a2")!.finished, true);
    for (const x of [r, r2, r3]) x.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("items capped at the newest 30, counts cover all; bad input is safe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-agents-"));
  try {
    const sub = join(dir, "-tmp-fx-tree", "cli-many", "subagents");
    cpSync(join(FIX, "-tmp-fx-tree", "cli-t-root", "subagents"), sub, { recursive: true });
    for (let i = 0; i < 40; i++) {
      const f = join(sub, `agent-m${String(i).padStart(2, "0")}.meta.json`);
      writeFileSync(f, JSON.stringify({ agentType: "t", description: "m", finished: true }));
    }
    const r = new SubagentReader({ projectsDir: dir, minPassMs: 0 });
    r.get(CWD, "cli-many");
    await r.flush();
    const s = r.get(CWD, "cli-many");
    assert.equal(s.items.length, MAX_ITEMS);
    assert.equal(s.running + s.done, 43);
    assert.deepEqual(r.get(CWD, null), { running: 0, done: 0, items: [] });
    assert.deepEqual(r.get(CWD, "../evil"), { running: 0, done: 0, items: [] });
    assert.deepEqual(r.get("/no/such", "cli-x"), { running: 0, done: 0, items: [] });
    assert.equal(parseMeta("{bad"), undefined);
    assert.equal(parseMeta("{}")!.type, "agent");
    r.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
