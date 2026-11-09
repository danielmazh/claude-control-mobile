// Push when a terminal session falls (spec 0004). A manifest session that was seen
// running and then is not running on 2 scheduled process polls in a row sends one
// push "Stopped: <title>" (in the phone's language). Two polls (20s apart) skip the
// short gap of a restart.
// No push on server start: a session must be seen running first. While the hub runs
// a Claude Control action the push waits (it is not dropped): it goes out on the
// first poll after the action, if the session is still down.

import type { PushPayload, Session } from "../shared/types.ts";
import { msg, type Lang } from "./i18n.ts";
import { PUSH_DEBOUNCE_MS } from "./notifier.ts";

export const FALL_POLLS = 2;

interface Track {
  seenRunning: boolean;
  downPolls: number;
  fired: boolean;
}

export class FallNotifier {
  private track = new Map<string, Track>();
  private lastSent = new Map<string, number>();
  private send: (p: PushPayload) => Promise<void>;
  private baseUrl: string;
  private quietUntil = 0;
  private lang: () => Lang;

  /** `lang` gives the push language at send time (default English). */
  constructor(send: (p: PushPayload) => Promise<void>, baseUrl = "/", lang: () => Lang = () => "en") {
    this.send = send;
    this.baseUrl = baseUrl;
    this.lang = lang;
  }

  /** Hold pushes until this time (a hub action is restarting sessions). Replaces an earlier hold. */
  quietUntilTime(untilMs: number): void {
    this.quietUntil = untilMs;
  }

  /** Hold pushes for at least this long from now (keeps a longer hold). */
  hold(ms: number, now = Date.now()): void {
    this.quietUntil = Math.max(this.quietUntil, now + ms);
  }

  /** Call after every scheduled process poll. Returns the payloads it sent (for tests). */
  poll(sessions: Session[], now = Date.now()): PushPayload[] {
    const fell: Session[] = [];
    const seen = new Set<string>();
    for (const s of sessions) {
      if (!s.terminal || s.replacedBy) continue;
      seen.add(s.id);
      const t = this.track.get(s.id) ?? { seenRunning: false, downPolls: 0, fired: false };
      this.track.set(s.id, t);
      if (s.terminal.running) {
        t.seenRunning = true;
        t.downPolls = 0;
        t.fired = false;
        continue;
      }
      if (!t.seenRunning || t.fired) continue;
      t.downPolls++;
      if (t.downPolls < FALL_POLLS || now < this.quietUntil) continue;
      t.fired = true;
      if (now - (this.lastSent.get(s.id) ?? 0) < PUSH_DEBOUNCE_MS) continue;
      this.lastSent.set(s.id, now);
      fell.push(s);
    }
    for (const id of [...this.track.keys()]) if (!seen.has(id)) this.track.delete(id);
    if (!fell.length) return [];
    // Many at once (tmux server died, machine slept): one push, not a burst.
    const t = msg(this.lang());
    const payload: PushPayload =
      fell.length === 1
        ? { title: t.fellOne(fell[0].title), body: t.fellBody, sessionId: fell[0].id, url: `${this.baseUrl}?session=${encodeURIComponent(fell[0].id)}` }
        : { title: t.fellMany(fell.length), body: t.fellBody, sessionId: "falls", url: this.baseUrl };
    this.send(payload).catch((err) => console.error("push send failed:", (err as Error).message));
    return [payload];
  }
}
