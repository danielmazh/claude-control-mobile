// Data layer. Two modes: "live" talks to the server, "mock" uses fake data in memory.
// The auth token is never read or stored here. The server sets an HttpOnly cookie.
import { lang, T } from "./i18n";
import type { ControlActionName, ControlResult, ControlStatus, Devices, Label, Session, SessionPatch, Snapshot } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type ConnState = "connecting" | "online" | "offline";

type Mode = "live" | "mock";
let mode: Mode = "live";
let unauthorizedHandler: () => void = () => {};

export const isMock = () => mode === "mock";
export const onUnauthorized = (fn: () => void) => {
  unauthorizedHandler = fn;
};

/** Adds the UI language, so server messages come back in it (spec 0006). */
const withLang = (path: string) => `${path}${path.includes("?") ? "&" : "?"}lang=${lang}`;

async function request<R>(method: string, path: string, body?: unknown): Promise<R> {
  const res = await fetch(withLang(path), {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    unauthorizedHandler();
    throw new ApiError(401, "unauthorized");
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* body is not JSON */
    }
    throw new ApiError(res.status, msg);
  }
  if (res.status === 204) return undefined as R;
  return (await res.json()) as R;
}

// ---------- mock backend ----------

let mockSnap: Snapshot | null = null;
const mockListeners = new Set<(s: Snapshot) => void>();
const clone = (s: Snapshot): Snapshot => structuredClone(s);
const mockEmit = () => {
  if (!mockSnap) return;
  mockSnap.generatedAt = Date.now();
  for (const fn of mockListeners) fn(clone(mockSnap));
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadMock(): Promise<Snapshot> {
  const { makeMockSnapshot } = await import("./mock");
  mockSnap = makeMockSnapshot();
  mode = "mock";
  return clone(mockSnap);
}

/** Demo mode: swap the demo texts to the active language, keep the user's changes. */
export async function relocalizeMock(): Promise<void> {
  if (mode !== "mock" || !mockSnap) return;
  const { makeMockSnapshot } = await import("./mock");
  const fresh = makeMockSnapshot();
  const byId = new Map(fresh.sessions.map((s) => [s.id, s]));
  for (const s of mockSnap.sessions) {
    const f = byId.get(s.id);
    if (!f) continue;
    Object.assign(s, { title: f.title, summary: f.summary, needsAction: f.needsAction, note: f.note, project: f.project, cwd: f.cwd, terminal: s.terminal && f.terminal ? { ...f.terminal, running: s.terminal.running } : s.terminal });
    const items = new Map(f.subagents.items.map((a) => [a.id, a.description]));
    for (const a of s.subagents.items) a.description = items.get(a.id) ?? a.description;
  }
  const names = new Map(fresh.labels.map((l) => [l.id, l.name]));
  for (const l of mockSnap.labels) l.name = names.get(l.id) ?? l.name;
  mockEmit();
}

// ---------- public API ----------

/** Loads the first snapshot and picks the mode. */
export async function init(): Promise<Snapshot> {
  const params = new URLSearchParams(location.search);
  if (params.get("mock") === "1") return loadMock();
  try {
    return await request<Snapshot>("GET", "/api/snapshot");
  } catch (err) {
    // In dev, fall back to mock data when the server is not running.
    const unreachable = !(err instanceof ApiError) || err.status >= 500;
    if (import.meta.env.DEV && unreachable) return loadMock();
    throw err;
  }
}

export const getSnapshot = () =>
  mode === "mock" ? Promise.resolve(clone(mockSnap!)) : request<Snapshot>("GET", "/api/snapshot");

export async function patchSession(id: string, patch: SessionPatch): Promise<Session> {
  if (mode === "mock") {
    await delay(250);
    const s = mockSnap!.sessions.find((x) => x.id === id);
    if (!s) throw new ApiError(404, "not found");
    Object.assign(s, patch);
    mockEmit();
    return { ...s };
  }
  return request<Session>("PATCH", `/api/sessions/${encodeURIComponent(id)}`, patch);
}

export async function createLabel(name: string, color: string): Promise<Label> {
  if (mode === "mock") {
    await delay(150);
    const label = { id: `l-${Date.now().toString(36)}`, name, color };
    mockSnap!.labels.push(label);
    mockEmit();
    return { ...label };
  }
  return request<Label>("POST", "/api/labels", { name, color });
}

export async function updateLabel(id: string, patch: Partial<Pick<Label, "name" | "color">>): Promise<Label> {
  if (mode === "mock") {
    await delay(150);
    const label = mockSnap!.labels.find((l) => l.id === id);
    if (!label) throw new ApiError(404, "not found");
    Object.assign(label, patch);
    mockEmit();
    return { ...label };
  }
  return request<Label>("PATCH", `/api/labels/${encodeURIComponent(id)}`, patch);
}

export async function deleteLabel(id: string): Promise<void> {
  if (mode === "mock") {
    await delay(150);
    mockSnap!.labels = mockSnap!.labels.filter((l) => l.id !== id);
    for (const s of mockSnap!.sessions) s.labelIds = s.labelIds.filter((x) => x !== id);
    mockEmit();
    return;
  }
  return request<void>("DELETE", `/api/labels/${encodeURIComponent(id)}`);
}

export async function getDevices(): Promise<Devices> {
  if (mode === "mock") {
    const { mockDevices } = await import("./mock");
    return mockDevices(mockSnap!);
  }
  return request<Devices>("GET", "/api/devices");
}

// ---------- Claude Control (spec 0004) ----------

let mockAction: ControlStatus["action"] = null;

export async function getControl(): Promise<ControlStatus> {
  if (mode === "mock") {
    const terms = mockSnap!.sessions.filter((s) => s.terminal);
    return {
      reachable: true,
      overall: terms.every((s) => s.terminal!.running) ? "ok" : "warn",
      networkUp: true,
      daemon: { running: true, status: "Connected" },
      sessions: { total: terms.length, running: terms.filter((s) => s.terminal!.running).length },
      issues: terms.filter((s) => !s.terminal!.running).length,
      action: mockAction,
    };
  }
  return request<ControlStatus>("GET", "/api/control");
}

/** Mock: the action "runs" for a few seconds, then the stopped terminal sessions run again. */
async function mockRun(action: string, name: string | null, dry: boolean, ids: string[]): Promise<ControlResult> {
  await delay(400);
  if (dry) return { ok: true, started: false, dry: true, action, name, message: T.mockPlan, results: [{ step: `${action} (dry)`, ok: true, detail: "would run" }] };
  const startedAt = Date.now();
  mockAction = { action, name, done: false, ok: null, message: null, results: [], startedAt, finishedAt: null };
  setTimeout(() => {
    for (const s of mockSnap!.sessions) if (s.terminal && ids.includes(s.id)) s.terminal.running = true;
    mockAction = {
      ...mockAction!,
      done: true,
      ok: true,
      message: T.mockDone,
      results: ids.map((id) => ({ step: `resume ${mockSnap!.sessions.find((s) => s.id === id)?.terminal?.name ?? id}`, ok: true, detail: T.mockRunsAgain })),
      finishedAt: Date.now(),
    };
    mockEmit();
  }, 4000);
  return { ok: true, started: true, dry: false, action, name, message: T.mockStarted, results: [] };
}

export async function revive(id: string, dry = false): Promise<ControlResult> {
  if (mode === "mock") {
    const s = mockSnap!.sessions.find((x) => x.id === id);
    if (!s?.revive) throw new ApiError(400, T.mockNoConversation);
    if (s.revive === "resume") {
      await delay(800);
      return { ok: true, started: false, dry, action: "resume", name: "demo-copy", message: dry ? T.mockPlanName("demo-copy") : T.mockResumed("demo-copy"), results: [{ step: "keep", ok: true, detail: "" }, { step: "resume_missing", ok: true, detail: "" }] };
    }
    return mockRun("restart_session", s.terminal!.name, dry, [s.id]);
  }
  return request<ControlResult>("POST", `/api/sessions/${encodeURIComponent(id)}/revive`, { dry });
}

export async function controlAction(action: ControlActionName, dry = false): Promise<ControlResult> {
  if (mode === "mock") {
    const ids = action === "restart_daemon" ? [] : mockSnap!.sessions.filter((s) => s.terminal && !s.terminal.running).map((s) => s.id);
    return mockRun(action, null, dry, ids);
  }
  return request<ControlResult>("POST", "/api/control/action", { action, dry });
}

export const pushKey = () => request<{ publicKey: string }>("GET", "/api/push/key");
export const pushSubscribe = (sub: PushSubscriptionJSON) =>
  request<void>("POST", "/api/push/subscribe", sub);
export const pushTest = () => request<void>("POST", "/api/push/test");

/**
 * Live updates. Uses SSE `/api/events`, reconnects with backoff, and pulls
 * GET /api/snapshot on each reconnect so nothing is missed (and 401 is seen).
 */
export function subscribe(onSnap: (s: Snapshot) => void, onConn: (c: ConnState) => void): () => void {
  if (mode === "mock") return subscribeMock(onSnap, onConn);

  let es: EventSource | null = null;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const connect = () => {
    if (stopped) return;
    clearTimeout(timer);
    es?.close();
    onConn("connecting");
    es = new EventSource(withLang("/api/events"), { withCredentials: true });
    es.addEventListener("open", () => {
      retry = 0;
      onConn("online");
    });
    es.addEventListener("snapshot", (ev) => {
      try {
        onSnap(JSON.parse((ev as MessageEvent<string>).data) as Snapshot);
        onConn("online");
      } catch {
        /* ignore a bad frame */
      }
    });
    es.addEventListener("error", () => {
      es?.close();
      es = null;
      onConn("offline");
      scheduleReconnect();
    });
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    const wait = Math.min(30_000, 1000 * 2 ** retry++);
    timer = setTimeout(async () => {
      try {
        onSnap(await getSnapshot()); // fallback and 401 check
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return; // auth screen takes over
      }
      connect();
    }, wait);
  };

  const onVisible = () => {
    if (document.visibilityState === "visible" && !es) {
      retry = 0;
      connect();
    }
  };
  const onOnline = () => {
    retry = 0;
    connect();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", onOnline);
  connect();

  return () => {
    stopped = true;
    clearTimeout(timer);
    es?.close();
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", onOnline);
  };
}

function subscribeMock(onSnap: (s: Snapshot) => void, onConn: (c: ConnState) => void): () => void {
  mockListeners.add(onSnap);
  onConn("online");
  // Every 20s one working session shows new activity, so live updates can be seen.
  const id = setInterval(() => {
    const list = mockSnap!.sessions.filter((s) => s.status === "working" && !s.replacedBy);
    const s = list[Math.floor(Math.random() * list.length)];
    if (!s) return;
    s.lastActivityAt = Date.now();
    mockEmit();
  }, 20_000);
  return () => {
    mockListeners.delete(onSnap);
    clearInterval(id);
  };
}
