import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session, Status } from "../shared/types.ts";
import { WaitingNotifier, PUSH_DEBOUNCE_MS } from "./notifier.ts";

const mk = (id: string, status: Status, pinned = true): Session => ({
  id, title: "T " + id, cwd: "/x", project: "proj", status, lastActivityAt: 0, completedTurns: 0,
  openUrl: id === "a" ? "https://claude.ai/code/session_01A" : null, pinned, priority: "normal", labelIds: [], note: "",
  parentId: null, childIds: [], depth: 0, summary: null, needsAction: null,
  subagents: { running: 0, done: 0, items: [] }, links: [], remoteSteered: false, replacedBy: null, replaces: [], source: "desktop", terminal: null, revive: null, kind: "code",
});

test("push once when a pinned session turns waiting, with debounce", async () => {
  const sent: unknown[] = [];
  const n = new WaitingNotifier(async (p) => void sent.push(p));
  const t = 1_000_000;
  assert.equal(n.update([mk("a", "waiting"), mk("b", "working")], t).length, 0, "no push on start");
  assert.equal(n.update([mk("a", "idle"), mk("b", "waiting")], t + 1).length, 1);
  assert.equal(n.update([mk("a", "waiting"), mk("b", "waiting")], t + 2).length, 1, "a flips to waiting");
  assert.equal(n.update([mk("a", "working"), mk("b", "waiting")], t + 3).length, 0);
  assert.equal(n.update([mk("a", "waiting"), mk("b", "waiting")], t + 4).length, 0, "debounced");
  n.update([mk("a", "working")], t + PUSH_DEBOUNCE_MS + 5);
  const out = n.update([mk("a", "waiting")], t + PUSH_DEBOUNCE_MS + 6);
  assert.deepEqual(out, [{ title: "T a", body: "proj", sessionId: "a", url: "https://claude.ai/code/session_01A" }]);
  assert.equal(sent.length, 3);
});

test("no push for unpinned sessions; fallback url", () => {
  const n = new WaitingNotifier(async () => {}, "/deck");
  n.update([mk("c", "idle", false), mk("d", "idle")]);
  const out = n.update([mk("c", "waiting", false), mk("d", "waiting")]);
  assert.deepEqual(out.map((p) => [p.sessionId, p.url]), [["d", "/deck?session=d"]]);
});

test("first update with no sessions still primes", () => {
  const n = new WaitingNotifier(async () => {});
  n.update([]);
  n.update([mk("e", "idle")]);
  assert.equal(n.update([mk("e", "waiting")]).length, 1);
});

test("no push when a waiting session goes stale and turns idle", () => {
  const n = new WaitingNotifier(async () => {});
  const t = 1_000_000_000;
  n.update([mk("f", "idle")], t);
  assert.equal(n.update([mk("f", "waiting")], t + 1).length, 1);
  assert.equal(n.update([mk("f", "idle")], t + 2 * PUSH_DEBOUNCE_MS).length, 0, "stale waiting to idle");
  assert.equal(n.update([mk("f", "idle")], t + 3 * PUSH_DEBOUNCE_MS).length, 0);
});

test("waiting child: title is parent › child, pushes when a parent is pinned", () => {
  const n = new WaitingNotifier(async () => {});
  const parent = { ...mk("p", "idle"), title: "Parent", childIds: ["k"] };
  const child = (st: Status) => ({ ...mk("k", st, false), title: "Kid", parentId: "p", depth: 1 });
  n.update([parent, child("idle")]);
  const out = n.update([parent, child("waiting")]);
  assert.deepEqual(out.map((p) => p.title), ["Parent › Kid"]);
  const free = new WaitingNotifier(async () => {});
  const lone = { ...parent, pinned: false };
  free.update([lone, child("idle")]);
  assert.equal(free.update([lone, child("waiting")]).length, 0, "no pinned parent, no push");
});

test("an old session of a restart chain never pushes", () => {
  const n = new WaitingNotifier(async () => {});
  const old = (st: Status) => ({ ...mk("o", st), replacedBy: "z" });
  n.update([old("idle")]);
  assert.equal(n.update([old("waiting")]).length, 0);
});
