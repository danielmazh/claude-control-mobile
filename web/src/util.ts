import { locale, T } from "./i18n";
import type { Label, Priority, Session, Status } from "./types";

export const priorityText = (p: Priority) => T.priority[p];
export const PRIORITIES: Priority[] = ["high", "normal", "low"];
const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

export const LABEL_COLORS = ["#3B7BC8", "#B8801C", "#4A8A3F", "#B42318", "#8B5CF6", "#0E8A8A", "#C2410C", "#DB2777"];

const DAY = 86_400_000;
/** A child counts as finished when archived or idle for more than 3 days. */
export const FINISHED_AFTER = 3 * DAY;

export type Tone = "waiting" | "working" | "idle" | "replaced";

/** Derived data for the whole snapshot, computed once per change. */
export interface Index {
  byId: Map<string, Session>;
  /** The session or one of its live descendants waits for me. */
  waitsDeep: Set<string>;
  /** Newest activity in the live subtree. */
  lastDeep: Map<string, number>;
}

export function buildIndex(sessions: Session[]): Index {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const waitsDeep = new Set<string>();
  const lastDeep = new Map<string, number>();
  const seen = new Set<string>();
  const visit = (s: Session): void => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    let wait = !s.replacedBy && s.status === "waiting";
    let last = s.lastActivityAt;
    for (const c of liveChildren(s, byId)) {
      visit(c);
      if (waitsDeep.has(c.id)) wait = true;
      last = Math.max(last, lastDeep.get(c.id) ?? 0);
    }
    if (wait) waitsDeep.add(s.id);
    lastDeep.set(s.id, last);
  };
  sessions.forEach(visit);
  return { byId, waitsDeep, lastDeep };
}

export const isLive = (s: Session) => !s.replacedBy;

export function liveChildren(s: Session, byId: Map<string, Session>): Session[] {
  const out: Session[] = [];
  for (const id of s.childIds) {
    const c = byId.get(id);
    if (c && isLive(c)) out.push(c);
  }
  return out;
}

export const isFinished = (s: Session, now: number) =>
  s.status === "archived" || (s.status === "idle" && now - s.lastActivityAt > FINISHED_AFTER);

/** Waiting (self or child) first, then priority, then newest activity. */
export function compare(idx: Index) {
  return (a: Session, b: Session) =>
    Number(idx.waitsDeep.has(b.id)) - Number(idx.waitsDeep.has(a.id)) ||
    Number(a.status === "archived") - Number(b.status === "archived") ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    (idx.lastDeep.get(b.id) ?? 0) - (idx.lastDeep.get(a.id) ?? 0) ||
    a.id.localeCompare(b.id);
}

/** Children order: waiting first, then newest activity. */
export function compareChildren(idx: Index) {
  return (a: Session, b: Session) =>
    Number(idx.waitsDeep.has(b.id)) - Number(idx.waitsDeep.has(a.id)) ||
    (idx.lastDeep.get(b.id) ?? 0) - (idx.lastDeep.get(a.id) ?? 0);
}

/** Follows replacedBy to the newest live session in the chain. */
export function newestInChain(s: Session, byId: Map<string, Session>): Session {
  let cur = s;
  for (let i = 0; i < 50 && cur.replacedBy; i++) {
    const next = byId.get(cur.replacedBy);
    if (!next) break;
    cur = next;
  }
  return cur;
}

export function tone(s: Session, idx: Index): Tone {
  if (s.replacedBy) return "replaced";
  if (idx.waitsDeep.has(s.id)) return "waiting";
  if (s.status === "working") return "working";
  return "idle";
}

export const statusText = (s: Status) => T.status[s];

/** "5 min. ago", in the active language. */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const w = T.relative;
  if (w) {
    if (m < 1) return w.now;
    if (m < 60) return w.minutes(m);
    if (h < 24) return h === 1 ? w.hour1 : w.hours(h);
    if (d === 1) return w.yesterday;
    if (d < 7) return w.days(d);
    if (d < 14) return w.week;
  } else {
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
    if (m < 1) return rtf.format(0, "second");
    if (m < 60) return rtf.format(-m, "minute");
    if (h < 24) return rtf.format(-h, "hour");
    if (d < 7) return rtf.format(-d, "day");
    if (d < 14) return new Intl.RelativeTimeFormat(locale(), { numeric: "auto" }).format(-1, "week");
  }
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long" }).format(ts);
}

/** "Running 3 min" style duration. */
export function duration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 2) return T.durMin1;
  if (m < 60) return T.durMin(m);
  const h = Math.round(m / 60);
  return h === 1 ? T.durHour1 : T.durHour(h);
}

/** "November 7, 22:10" */
export function dateTime(ts: number): string {
  const day = new Intl.DateTimeFormat(locale(), { day: "numeric", month: "long" }).format(ts);
  const time = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(ts);
  return `${day}, ${time}`;
}

export function todayLine(now: number): string {
  return new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" }).format(now);
}

/** session_01HxQ...4fQ */
export const shortId = (id: string) => (id.length > 18 ? `${id.slice(0, 13)}…${id.slice(-3)}` : id);

/** /Users/name/x -> ~/x */
export const tildePath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");


export function editSummary(s: Session, labels: Label[]): string {
  const parts = [T.prioritySummary(priorityText(s.priority))];
  const names = s.labelIds.map((id) => labels.find((l) => l.id === id)?.name).filter(Boolean);
  if (names.length === 1) parts.push(T.labelOne(names[0]!));
  else if (names.length > 1) parts.push(T.labelMany(names.length));
  if (s.note.trim()) parts.push(T.hasNote);
  return parts.join(" • ");
}

export const DOT = " • ";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

export const reducedMotion = () => {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};
