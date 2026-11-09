// Push trigger: a pinned session that changes to "waiting" sends one push.
// At most one push per session per 2 minutes, so flapping does not spam.

import type { PushPayload, Session, Status } from "../shared/types.ts";

export const PUSH_DEBOUNCE_MS = 2 * 60 * 1000;

export class WaitingNotifier {
  private prev = new Map<string, Status>();
  private lastSent = new Map<string, number>();
  private send: (p: PushPayload) => Promise<void>;
  private fallbackUrl: string;
  private primed = false;

  constructor(send: (p: PushPayload) => Promise<void>, fallbackUrl = "/") {
    this.send = send;
    this.fallbackUrl = fallbackUrl;
  }

  /** Call with every new snapshot. Returns the payloads it sent (for tests). */
  update(sessions: Session[], now = Date.now()): PushPayload[] {
    const first = !this.primed;
    this.primed = true;
    const sent: PushPayload[] = [];
    const next = new Map<string, Status>();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    // A child counts as pinned when it or one of its parents is pinned (it shows
    // under that parent on the home screen).
    const pinned = (s: Session): boolean => {
      const seen = new Set<string>();
      for (let c: Session | undefined = s; c && !seen.has(c.id); c = c.parentId ? byId.get(c.parentId) : undefined) {
        if (c.pinned) return true;
        seen.add(c.id);
      }
      return false;
    };
    for (const s of sessions) {
      next.set(s.id, s.status);
      const before = this.prev.get(s.id);
      // No push on server start: only a real change counts.
      if (first || before === undefined) continue;
      if (s.replacedBy) continue; // an old session of a restart chain never pushes
      if (s.status !== "waiting" || before === "waiting" || !pinned(s)) continue;
      const last = this.lastSent.get(s.id) ?? 0;
      if (now - last < PUSH_DEBOUNCE_MS) continue;
      this.lastSent.set(s.id, now);
      const parent = s.parentId ? byId.get(s.parentId) : undefined;
      const payload: PushPayload = {
        title: parent ? `${parent.title} › ${s.title}` : s.title,
        body: s.project,
        sessionId: s.id,
        url: s.openUrl ?? `${this.fallbackUrl}?session=${encodeURIComponent(s.id)}`,
      };
      sent.push(payload);
      this.send(payload).catch((err) => console.error("push send failed:", (err as Error).message));
    }
    this.prev = next;
    return sent;
  }
}
