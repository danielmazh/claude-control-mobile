// Client for Claude Control (spec 0004). Claude Control is a local Python server:
// Claude Control (https://github.com/danielmazh/claude-control), on http://127.0.0.1:7799,
// no auth, localhost only. Only the hub server talks to it; the phone never does.
//
// Shapes checked on 2026-11-09 against the real server (GET and dry runs only):
// - GET /api/rc/status?lang=he -> {ts, overall, issues[], checks[], sessions[{name, uuid,
//   running, state, rc, ...}], daemon{running, status, ...}, network_up, running_action}.
//   running_action: null, or {action, name, started (epoch s), done, ok, results[], finished?, message?}.
// - POST /api/rc/action {action, name?, dry?, lang} -> always HTTP 200.
//   dry: {ok, message, results[{step, ok, detail}], dry: true} (the plan, inline).
//   non-dry: {ok: true, started: true, message, results: []}, the work runs in a thread.
//   refused (validation, another action runs): {ok: false, message, error?, results: []}.
// - POST /api/sessions/resume {uuid, name?, dry?, lang} -> HTTP 200, runs inline (not
//   in the background): {ok, name, message, results[], dry} or {ok: false, message, error, results: []}.

import type { ControlAction, ControlResult, ControlStatus, ControlStep } from "../shared/types.ts";
import type { Lang } from "./i18n.ts";

export const DEFAULT_CONTROL_URL = "http://127.0.0.1:7799";
export const CONTROL_TIMEOUT_MS = 10_000;
// sessions/resume runs the resume script inline (Claude Control gives it up to 180s).
export const RESUME_TIMEOUT_MS = 120_000;

/** Claude Control did not answer (not running, timeout, or not JSON). */
export class ControlUnreachable extends Error {}

type Raw = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const secs = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1000) : null);

export function steps(v: unknown): ControlStep[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is Raw => !!r && typeof r === "object")
    .map((r) => ({ step: String(r.step ?? ""), ok: r.ok === true, detail: String(r.detail ?? "").slice(0, 600) }));
}

export function toAction(v: unknown): ControlAction | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Raw;
  if (typeof a.action !== "string") return null;
  return {
    action: a.action,
    name: str(a.name),
    done: a.done === true,
    ok: typeof a.ok === "boolean" ? a.ok : null,
    message: str(a.message),
    results: steps(a.results),
    startedAt: secs(a.started),
    finishedAt: secs(a.finished),
  };
}

export const UNREACHABLE: ControlStatus = Object.freeze({
  reachable: false,
  overall: null,
  networkUp: null,
  daemon: null,
  sessions: { total: 0, running: 0 },
  issues: 0,
  action: null,
}) as ControlStatus;

/** The small health summary the hub sends to the phone. */
export function summarize(raw: Raw): ControlStatus {
  const sessions = Array.isArray(raw.sessions) ? (raw.sessions as Raw[]) : [];
  const d = raw.daemon && typeof raw.daemon === "object" ? (raw.daemon as Raw) : null;
  const overall = raw.overall === "ok" || raw.overall === "warn" || raw.overall === "bad" ? raw.overall : null;
  return {
    reachable: true,
    overall,
    networkUp: typeof raw.network_up === "boolean" ? raw.network_up : null,
    daemon: d ? { running: d.running === true, status: String(d.status ?? "") } : null,
    sessions: { total: sessions.length, running: sessions.filter((s) => s && s.running === true).length },
    issues: Array.isArray(raw.issues) ? raw.issues.length : 0,
    action: toAction(raw.running_action),
  };
}

export function toResult(raw: Raw, action: string, name: string | null): ControlResult {
  return {
    ok: raw.ok === true,
    started: raw.started === true,
    dry: raw.dry === true,
    action,
    name: str(raw.name) ?? name,
    message: str(raw.message) ?? str(raw.error) ?? "",
    results: steps(raw.results),
  };
}

export interface ControlClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  resumeTimeoutMs?: number;
}

export class ControlClient {
  private base: string;
  private timeoutMs: number;
  private resumeTimeoutMs: number;

  constructor(opts: ControlClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? CONTROL_TIMEOUT_MS;
    this.resumeTimeoutMs = opts.resumeTimeoutMs ?? RESUME_TIMEOUT_MS;
  }

  private async call(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number): Promise<Raw> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (err) {
      throw new ControlUnreachable((err as Error).message);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ControlUnreachable(`bad answer (HTTP ${res.status})`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ControlUnreachable("bad answer");
    return data as Raw;
  }

  /** `lang` is the language Claude Control writes its messages in (the phone's language). */
  async status(lang: Lang = "en"): Promise<ControlStatus> {
    return summarize(await this.call("GET", `/api/rc/status?lang=${lang}`, undefined, this.timeoutMs));
  }

  /** restart_session (by manifest name), resume_missing, fix_all, restart_daemon. */
  async action(action: string, opts: { name?: string; dry?: boolean; lang?: Lang } = {}): Promise<ControlResult> {
    const body: Raw = { action, dry: !!opts.dry, lang: opts.lang ?? "en" };
    if (opts.name) body.name = opts.name;
    const raw = await this.call("POST", "/api/rc/action", body, this.timeoutMs);
    return toResult(raw, action, opts.name ?? null);
  }

  /** Start a CLI conversation in tmux with Remote Control and add it to auto-restore. */
  async resume(uuid: string, opts: { name?: string; dry?: boolean; lang?: Lang } = {}): Promise<ControlResult> {
    const body: Raw = { uuid, dry: !!opts.dry, lang: opts.lang ?? "en" };
    if (opts.name) body.name = opts.name;
    const raw = await this.call("POST", "/api/sessions/resume", body, opts.dry ? this.timeoutMs : this.resumeTimeoutMs);
    return toResult(raw, "resume", null);
  }
}
