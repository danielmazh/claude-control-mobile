import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../shared/types.ts";
import { FallNotifier } from "./falls.ts";
import { PUSH_DEBOUNCE_MS } from "./notifier.ts";

const mk = (id: string, running: boolean | null, extra: Partial<Session> = {}): Session => ({
  id, title: "T " + id, cwd: "/x", project: "proj", status: "idle", lastActivityAt: 0, completedTurns: 0,
  openUrl: null, pinned: false, priority: "normal", labelIds: [], note: "",
  parentId: null, childIds: [], depth: 0, summary: null, needsAction: null,
  subagents: { running: 0, done: 0, items: [] }, links: [], remoteSteered: false, replacedBy: null, replaces: [],
  source: "terminal",
  terminal: running === null ? null : { tmuxTarget: null, running, attachCmd: null, name: id },
  revive: running === null ? null : "restart",
  kind: "code",
  ...extra,
});

test("falls: no push on start; push after 2 down polls; once per fall", () => {
  const sent: unknown[] = [];
  const f = new FallNotifier(async (p) => void sent.push(p), "/", () => "he");
  const t = 1_000_000;
  assert.equal(f.poll([mk("a", true), mk("b", false), mk("d", null)], t).length, 0, "b was never seen running");
  assert.equal(f.poll([mk("a", false), mk("b", false)], t + 1).length, 0, "first down poll waits");
  const out = f.poll([mk("a", false), mk("b", false)], t + 2);
  assert.deepEqual(out, [{ title: "נפל: T a", body: "לחץ כדי להחיות", sessionId: "a", url: "/?session=a" }]);
  assert.equal(f.poll([mk("a", false)], t + 3).length, 0, "only once while it stays down");
  assert.equal(sent.length, 1);
});

test("falls: a restart (down for one poll) does not push; debounce on a quick second fall", () => {
  const f = new FallNotifier(async () => {});
  const t = 2_000_000;
  f.poll([mk("a", true)], t);
  f.poll([mk("a", false)], t + 1);
  f.poll([mk("a", true)], t + 2);
  assert.equal(f.poll([mk("a", false)], t + 3).length, 0);
  assert.equal(f.poll([mk("a", false)], t + 4).length, 1, "a real fall");
  f.poll([mk("a", true)], t + 5);
  f.poll([mk("a", false)], t + 6);
  assert.equal(f.poll([mk("a", false)], t + 7).length, 0, "debounced");
  f.poll([mk("a", true)], t + PUSH_DEBOUNCE_MS + 10);
  f.poll([mk("a", false)], t + PUSH_DEBOUNCE_MS + 11);
  assert.equal(f.poll([mk("a", false)], t + PUSH_DEBOUNCE_MS + 12).length, 1);
});

test("falls: held during a hub action, sent after it if still down; many at once is one push", () => {
  const f = new FallNotifier(async () => {}, "/deck"); // English by default
  const t = 3_000_000;
  f.poll([mk("a", true), mk("b", true), mk("c", true)], t);
  f.hold(100, t);
  f.poll([mk("a", false), mk("b", false), mk("c", true)], t + 1);
  assert.equal(f.poll([mk("a", false), mk("b", false), mk("c", true)], t + 2).length, 0, "held");
  const out = f.poll([mk("a", false), mk("b", false), mk("c", true)], t + 200);
  assert.deepEqual(out, [{ title: "2 sessions stopped", body: "Tap to revive", sessionId: "falls", url: "/deck" }]);
});

test("falls: a replaced session never pushes", () => {
  const f = new FallNotifier(async () => {});
  f.poll([mk("a", true, { replacedBy: "z" })], 1);
  f.poll([mk("a", false, { replacedBy: "z" })], 2);
  assert.equal(f.poll([mk("a", false, { replacedBy: "z" })], 3).length, 0);
});
