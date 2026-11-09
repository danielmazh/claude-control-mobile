// Status rules for one desktop session file.
//
// Evidence (61 real files, 2026-11-05):
// - interruptedAwaitingPerson is null or missing in every file. We still treat a
//   non-null value as "waiting", because the name says so.
// - postTurnSummary {status_category, needs_action} exists in about 40 files.
//   status_category is "blocked", "review_ready" or "completed". needs_action is
//   non-empty only when status_category is "blocked". postTurnSummaryFor always
//   equals lastAssistantUuid, so the summary describes the last finished turn.
// - lastTurnEdgeAt is the end of the last turn. latestUserFrameAt is the last user
//   message. When latestUserFrameAt > lastTurnEdgeAt, a turn is running (seen on
//   sessions active in the last minutes). Older files have no lastTurnEdgeAt.
// - When a new turn starts, the old postTurnSummary stays in the file, so the
//   "working" check must run before the "waiting" check.
// - error/errorAt appears on a few files (all archived): a failed session.
//
// Spec 0002 (2026-11-08): "waiting" needs a fresh summary with a non-empty
// needs_action. The plain "blocked" category alone no longer counts. A summary is
// fresh only when postTurnSummaryFor === lastAssistantUuid (both present).

import type { Status } from "../shared/types.ts";

/** A turn with no file activity for this long is stale, not working. */
export const STALE_WORKING_MS = 60 * 60 * 1000;
/** Files without lastTurnEdgeAt: recent activity with no fresh summary is working. */
export const LEGACY_WORKING_MS = 2 * 60 * 1000;
/**
 * Operator decision 2026-11-05: a session that waits for more than 3 days is
 * forgotten, not waiting. It shows as "idle". The age comes from lastActivityAt
 * (the file mtime when the field is missing). The notifier pushes only on a change
 * to "waiting", so this change to "idle" never sends a push.
 */
export const STALE_WAITING_MS = 3 * 24 * 60 * 60 * 1000;

export interface StatusInput {
  isArchived?: unknown;
  lastActivityAt?: unknown;
  lastTurnEdgeAt?: unknown;
  latestUserFrameAt?: unknown;
  interruptedAwaitingPerson?: unknown;
  lastAssistantUuid?: unknown;
  postTurnSummaryFor?: unknown;
  postTurnSummary?: unknown;
  error?: unknown;
  errorAt?: unknown;
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Compute the status. `mtimeMs` is the file mtime, a second activity signal. */
export function computeStatus(s: StatusInput, now: number, mtimeMs = 0): Status {
  const status = rawStatus(s, now, mtimeMs);
  if (status === "waiting" && now - (num(s.lastActivityAt) ?? mtimeMs) > STALE_WAITING_MS) return "idle";
  return status;
}

function rawStatus(s: StatusInput, now: number, mtimeMs: number): Status {
  if (s.isArchived === true) return "archived";

  const activity = Math.max(num(s.lastActivityAt) ?? 0, mtimeMs);
  const edge = num(s.lastTurnEdgeAt);
  const user = num(s.latestUserFrameAt);
  const fresh = now - activity < STALE_WORKING_MS;

  // 1. Working: the last user message is newer than the last turn end.
  if (edge !== undefined && user !== undefined && user > edge && fresh) return "working";

  // 2. Waiting: the app says it needs the person.
  if (s.interruptedAwaitingPerson != null && s.interruptedAwaitingPerson !== false) return "waiting";

  const errorAt = num(s.errorAt);
  if (typeof s.error === "string" && s.error && errorAt !== undefined && errorAt >= (user ?? 0)) {
    return "waiting";
  }

  const summary = freshSummary(s);
  if (summary && freshText(summary.needs_action) !== null) return "waiting";

  // 3. Legacy files (no lastTurnEdgeAt): recent activity and no summary yet.
  if (edge === undefined && !summary && now - activity < LEGACY_WORKING_MS) return "working";

  return "idle";
}

/** The postTurnSummary when it describes the last assistant message, else undefined. */
export function freshSummary(s: StatusInput): Record<string, unknown> | undefined {
  const p = s.postTurnSummary;
  if (!p || typeof p !== "object") return undefined;
  if (typeof s.postTurnSummaryFor !== "string" || s.postTurnSummaryFor !== s.lastAssistantUuid) return undefined;
  return p as Record<string, unknown>;
}

/** A trimmed non-empty string, else null. */
export function freshText(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
