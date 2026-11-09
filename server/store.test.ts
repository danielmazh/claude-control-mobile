import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserStore, ValidationError, writeJsonAtomic } from "./store.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "deck-store-"));
}

test("PATCH validation rejects bad input and changes nothing", () => {
  const dir = tmp();
  try {
    const s = new UserStore(dir);
    const bad: unknown[] = [
      null, [], "x", { pinned: "yes" }, { priority: "urgent" }, { labelIds: "a" }, { labelIds: [1] },
      { labelIds: ["missing"] }, { note: 5 }, { note: "x".repeat(2001) }, { project: 3 }, { other: 1 },
    ];
    for (const b of bad) assert.throws(() => s.patchSession("id1", b), ValidationError, JSON.stringify(b));
    assert.deepEqual(s.session("id1"), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PATCH applies fields, persists, and empty project clears the override", () => {
  const dir = tmp();
  try {
    const s = new UserStore(dir);
    const l = s.createLabel({ name: " Work ", color: "#AABBCC" });
    assert.equal(l.name, "Work");
    assert.equal(l.color, "#aabbcc");
    s.patchSession("id1", { pinned: true, priority: "low", labelIds: [l.id, l.id], note: "hi", project: "P" });
    assert.deepEqual(new UserStore(dir).session("id1"), { pinned: true, priority: "low", labelIds: [l.id], note: "hi", project: "P" });
    s.patchSession("id1", { project: "" });
    assert.equal(s.session("id1").project, undefined);
    s.patchSession("id1", { project: null });
    assert.equal(s.session("id1").pinned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("label create, patch validation, delete cascades to sessions", () => {
  const dir = tmp();
  try {
    const s = new UserStore(dir);
    const a = s.createLabel({ name: "A", color: "#000000" });
    const b = s.createLabel({ name: "B", color: "#111111" });
    assert.throws(() => s.createLabel({ name: "", color: "#000000" }), ValidationError);
    assert.throws(() => s.createLabel({ name: "C", color: "red" }), ValidationError);
    assert.throws(() => s.patchLabel(a.id, { color: "#12" }), ValidationError);
    assert.equal(s.patchLabel("nope", { name: "x" }), undefined);
    assert.equal(s.patchLabel(a.id, { name: "A2" })?.name, "A2");
    s.patchSession("s1", { labelIds: [a.id, b.id] });
    s.patchSession("s2", { labelIds: [a.id] });
    assert.equal(s.deleteLabel(a.id), true);
    assert.equal(s.deleteLabel(a.id), false);
    const re = new UserStore(dir);
    assert.deepEqual(re.session("s1").labelIds, [b.id]);
    assert.deepEqual(re.session("s2").labelIds, []);
    assert.deepEqual(re.labels.map((l) => l.id), [b.id]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic write leaves no temp file and a valid JSON file", () => {
  const dir = tmp();
  try {
    const file = join(dir, "x.json");
    writeFileSync(file, "old");
    writeJsonAtomic(file, { a: 1 });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1 });
    assert.deepEqual(readdirSync(dir), ["x.json"]);
    const s = new UserStore(dir);
    s.createLabel({ name: "L", color: "#123456" });
    assert.deepEqual(readdirSync(dir).sort(), ["state.json", "x.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt state.json is kept aside and the store starts empty", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "state.json"), "{ not json");
    const s = new UserStore(dir);
    assert.deepEqual(s.labels, []);
    assert.ok(readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
