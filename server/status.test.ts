import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatus, STALE_WAITING_MS, STALE_WORKING_MS } from "./status.ts";

const T = 1_800_000_000_000;
const summary = (cat: string, action = "") => ({
  lastAssistantUuid: "a",
  postTurnSummaryFor: "a",
  postTurnSummary: { status_category: cat, needs_action: action },
});

test("archived wins over everything", () => {
  assert.equal(computeStatus({ isArchived: true, ...summary("blocked", "x") }, T), "archived");
});

test("working when the user message is newer than the turn end", () => {
  const s = { lastActivityAt: T - 1000, lastTurnEdgeAt: T - 60_000, latestUserFrameAt: T - 30_000 };
  assert.equal(computeStatus(s, T), "working");
});

test("working beats an old blocked summary", () => {
  const s = { lastActivityAt: T, lastTurnEdgeAt: T - 60_000, latestUserFrameAt: T - 30_000, ...summary("blocked", "x") };
  assert.equal(computeStatus(s, T), "working");
});

test("a stale running turn is idle", () => {
  const s = { lastActivityAt: T - STALE_WORKING_MS - 1, lastTurnEdgeAt: T - 2 * STALE_WORKING_MS, latestUserFrameAt: T - STALE_WORKING_MS - 5 };
  assert.equal(computeStatus(s, T), "idle");
});

test("waiting only on a fresh non-empty needs_action", () => {
  const base = { lastActivityAt: T - 1000, lastTurnEdgeAt: T - 1000, latestUserFrameAt: T - 5000 };
  assert.equal(computeStatus({ ...base, ...summary("blocked") }, T), "idle", "blocked alone is not waiting");
  assert.equal(computeStatus({ ...base, ...summary("blocked", "  ") }, T), "idle");
  assert.equal(computeStatus({ ...base, ...summary("blocked", "pick one") }, T), "waiting");
  assert.equal(computeStatus({ ...base, ...summary("review_ready", "approve") }, T), "waiting");
  const { postTurnSummaryFor: _f, ...noFor } = summary("blocked", "x");
  assert.equal(computeStatus({ ...base, ...noFor }, T), "idle", "summary without postTurnSummaryFor is not fresh");
});

test("waiting when interruptedAwaitingPerson is set", () => {
  assert.equal(computeStatus({ lastActivityAt: T, interruptedAwaitingPerson: { kind: "x" } }, T + 10 * 60_000), "waiting");
  assert.equal(computeStatus({ lastActivityAt: T, interruptedAwaitingPerson: null }, T + 10 * 60_000), "idle");
});

test("waiting on a fresh error", () => {
  assert.equal(computeStatus({ lastActivityAt: T, latestUserFrameAt: T - 10, error: "boom", errorAt: T }, T + 1e6), "waiting");
});

test("idle on completed or review_ready summary", () => {
  const base = { lastActivityAt: T - 1000, lastTurnEdgeAt: T - 1000, latestUserFrameAt: T - 5000 };
  assert.equal(computeStatus({ ...base, ...summary("completed") }, T), "idle");
  assert.equal(computeStatus({ ...base, ...summary("review_ready") }, T), "idle");
});

test("a summary for an older assistant message is ignored", () => {
  const s = {
    lastActivityAt: T - 1e6, lastTurnEdgeAt: T - 1e6, latestUserFrameAt: T - 2e6,
    lastAssistantUuid: "new", postTurnSummaryFor: "old",
    postTurnSummary: { status_category: "blocked", needs_action: "x" },
  };
  assert.equal(computeStatus(s, T), "idle");
});

test("legacy file without lastTurnEdgeAt: recent activity is working, old is idle", () => {
  assert.equal(computeStatus({ lastActivityAt: T - 30_000 }, T), "working");
  assert.equal(computeStatus({ lastActivityAt: T - 30 * 60_000 }, T), "idle");
  assert.equal(computeStatus({ lastActivityAt: T - 30_000, ...summary("completed") }, T), "idle");
});

test("waiting older than 3 days is idle", () => {
  const blocked = { lastTurnEdgeAt: T - 1000, latestUserFrameAt: T - 5000, ...summary("blocked", "x") };
  assert.equal(computeStatus({ ...blocked, lastActivityAt: T - STALE_WAITING_MS + 1000 }, T), "waiting");
  assert.equal(computeStatus({ ...blocked, lastActivityAt: T - STALE_WAITING_MS - 1 }, T), "idle");
  // No lastActivityAt: the file mtime is the age.
  assert.equal(computeStatus({ interruptedAwaitingPerson: { kind: "x" } }, T, T - STALE_WAITING_MS - 1), "idle");
  assert.equal(computeStatus({ interruptedAwaitingPerson: { kind: "x" } }, T, T - 1000), "waiting");
});
