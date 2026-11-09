// HTTP app: API (docs/api.md), SSE, static UI. main.ts wires env and listens.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { ControlActionName, ControlResult, ControlStatus, PushPayload, Snapshot } from "../shared/types.ts";
import { checkRequest, handleLogin } from "./auth.ts";
import { SessionReader, type BaseSession } from "./sessions.ts";
import { SessionWatcher } from "./watcher.ts";
import { UserStore, ValidationError } from "./store.ts";
import { buildSnapshot } from "./snapshot.ts";
import { WaitingNotifier } from "./notifier.ts";
import { ProjectDetector } from "./projects.ts";
import { SubagentReader } from "./subagents.ts";
import { SharedFolderReader, buildDevices } from "./devices.ts";
import { findChains } from "./chains.ts";
import { TerminalReader, mergeTerminal } from "./terminal.ts";
import { CoworkReader } from "./cowork.ts";
import { ControlClient, ControlUnreachable, UNREACHABLE } from "./control.ts";
import { FallNotifier } from "./falls.ts";
import { msg, queryLang, requestLang, type Lang } from "./i18n.ts";
import { reviveMode } from "./snapshot.ts";

export interface PushLike {
  publicKey: string;
  subscribe(sub: unknown): Promise<void>;
  send(payload: PushPayload): Promise<void>;
}

export interface DeckOptions {
  dataDir: string;
  sessionsDir: string;
  webDir: string;
  port: number; // used to build the allowed origins
  allowedHosts: string[]; // already includes localhost and 127.0.0.1
  token: string;
  push: PushLike | null;
  pollMs?: number;
  projectsDir?: string; // ~/.claude/projects; no auto project detection when missing
  workspaceRoots?: string[]; // extra workspace roots (DECK_WORKSPACE_ROOTS)
  remoteStateFile?: string; // remote-control-state.json; no shared folders when missing
  rcManifest?: string; // claude-control sessions.conf; no terminal sessions when missing (spec 0003)
  terminalExec?: (cmd: string, args: string[]) => Promise<string>; // tests: fake ps and tmux
  controlUrl?: string; // Claude Control base URL (spec 0004); no control endpoints when missing (503)
  controlPollMs?: number; // how often the hub follows a running action (default 2000)
  terminalProcPollMs?: number; // tests: faster ps/tmux polls
  coworkDir?: string; // Cowork sessions (general chats, spec 0005); none when missing
}

export interface Deck {
  server: Server;
  snapshot(): Snapshot;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;
const CONTROL_ACTIONS: ControlActionName[] = ["resume_missing", "fix_all", "restart_daemon"];
const CONTROL_CACHE_MS = 1000;
const FOLLOW_MAX_MS = 5 * 60 * 1000;
const QUIET_AFTER_MS = 60 * 1000;
const PING_MS = 25_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/** Parse a comma or whitespace list of hosts. */
export function parseHostList(s: string | undefined): string[] {
  return (s ?? "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

/** Same rule as auth.ts: an entry without a port matches any port. */
export function hostAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const bare = stripPort(host);
  return allowed.some((e) => e === host || (stripPort(e) === e && bare === e));
}

export function selfOrigins(allowed: string[], port: number): string[] {
  const out = new Set<string>();
  for (const e of allowed) {
    out.add(`http://${e}`);
    out.add(`https://${e}`);
    if (stripPort(e) === e) {
      out.add(`http://${e}:${port}`);
      out.add(`https://${e}:${port}`);
    }
  }
  return [...out];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { error });
}

function noContent(res: ServerResponse): void {
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(400, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolveBody(undefined);
      try {
        resolveBody(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createDeck(opts: DeckOptions): Deck {
  const reader = new SessionReader(opts.sessionsDir);
  const watcher = new SessionWatcher(reader, { pollMs: opts.pollMs ?? 3000 });
  const cowork = opts.coworkDir ? new CoworkReader(opts.coworkDir) : null;
  const coworkWatcher = cowork ? new SessionWatcher(cowork, { pollMs: opts.pollMs ?? 3000 }) : null;
  const store = new UserStore(opts.dataDir);
  // Origins use the real port, so port 0 (tests) works too.
  let origins: string[] = [];
  let originsPort = -1;
  const currentOrigins = (): string[] => {
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : opts.port;
    if (port !== originsPort) {
      originsPort = port;
      origins = selfOrigins(opts.allowedHosts, opts.port || port);
    }
    return origins;
  };
  const clients = new Set<ServerResponse>();
  const notifier = new WaitingNotifier(async (p) => {
    if (opts.push) await opts.push.send(p);
  });
  const webRoot = resolve(opts.webDir);

  // Detection runs in the background and calls broadcast() when a result changes.
  const detector = opts.projectsDir
    ? new ProjectDetector({ projectsDir: opts.projectsDir, roots: opts.workspaceRoots, onChange: () => broadcast() })
    : null;
  const detect = (b: BaseSession): string | undefined => detector?.project(b.cwd, b.cliSessionId);

  const agents = opts.projectsDir
    ? new SubagentReader({ projectsDir: opts.projectsDir, onChange: () => broadcast() })
    : null;
  const folders = new SharedFolderReader(opts.remoteStateFile);
  const terminal =
    opts.rcManifest && opts.projectsDir
      ? new TerminalReader({
          manifestFile: opts.rcManifest,
          projectsDir: opts.projectsDir,
          exec: opts.terminalExec,
          onChange: () => broadcast(),
          onProcPoll: () => falls.poll(snapshot().sessions),
          procPollMs: opts.terminalProcPollMs,
        })
      : null;
  // Fall pushes have no request: they use the last language a client asked for explicitly.
  let pushLang: Lang = "en";
  const falls = new FallNotifier(
    async (p) => {
      if (opts.push) await opts.push.send(p);
    },
    "/",
    () => pushLang,
  );
  const control = opts.controlUrl ? new ControlClient({ baseUrl: opts.controlUrl }) : null;
  const controlPollMs = opts.controlPollMs ?? 2000;
  let statusCache: { at: number; lang: Lang; value: Promise<ControlStatus> } | null = null;
  const controlStatus = (lang: Lang = "en"): Promise<ControlStatus> => {
    if (!control) return Promise.resolve(UNREACHABLE);
    const now = Date.now();
    if (statusCache && statusCache.lang === lang && now - statusCache.at < CONTROL_CACHE_MS) return statusCache.value;
    const value = control.status(lang).catch((err) => {
      if (err instanceof ControlUnreachable) return UNREACHABLE;
      throw err;
    });
    statusCache = { at: now, lang, value };
    return value;
  };
  let following = 0; // background actions the hub follows
  const followTimers = new Set<NodeJS.Timeout>();
  /** Log, quiet the fall push, and rescan when a background action ends. */
  const follow = (action: string, name: string | null, lang: Lang): void => {
    following++;
    const until = Date.now() + FOLLOW_MAX_MS;
    falls.hold(FOLLOW_MAX_MS);
    const step = async (): Promise<void> => {
      let st: ControlStatus = UNREACHABLE;
      try {
        statusCache = null;
        st = await controlStatus(lang);
      } catch {
        st = UNREACHABLE;
      }
      const a = st.action;
      const ended = !st.reachable || !a || a.action !== action || a.done;
      if (!ended && Date.now() < until) {
        const t = setTimeout(() => {
          followTimers.delete(t);
          void step();
        }, controlPollMs);
        t.unref();
        followTimers.add(t);
        return;
      }
      following--;
      const result = !st.reachable ? "unknown (Claude Control not reachable)" : a && a.done ? (a.ok ? "ok" : "failed") : "unknown";
      console.log(`control: done ${action}${name ? ` name=${name}` : ""} result=${result}`);
      if (following === 0) {
        falls.quietUntilTime(Date.now() + QUIET_AFTER_MS);
      }
      await terminal?.rescan();
    };
    void step();
  };
  /** Run a Claude Control call: 503 when not reachable, 409 when refused, log non-dry actions. */
  const runControl = async (call: (c: ControlClient) => Promise<ControlResult>, dry: boolean, label: string, lang: Lang): Promise<ControlResult> => {
    if (!control) throw new HttpError(503, msg(lang).notRunning);
    let r: ControlResult;
    try {
      r = await call(control);
    } catch (err) {
      if (err instanceof ControlUnreachable) throw new HttpError(503, msg(lang).notRunning);
      throw err;
    }
    statusCache = null;
    if (!dry) {
      console.log(`control: ${r.started ? "start" : r.ok ? "ok" : "fail"} ${label}${r.name ? ` name=${r.name}` : ""}${r.ok || r.started ? "" : " (refused or failed)"}`);
      if (r.started) follow(r.action, r.name, lang);
      else if (r.ok || r.results.length) {
        falls.hold(QUIET_AFTER_MS);
        void terminal?.rescan();
      }
    }
    // Refused before any step ran (bad name, another action runs): an error for the UI.
    if (!r.ok && !r.started && r.results.length === 0) throw new HttpError(409, r.message || msg(lang).refused);
    return r;
  };
  /** Desktop sessions, the terminal sessions of the claude-control manifest, and the Cowork chats (spec 0005). */
  const allBases = (now = Date.now()): BaseSession[] => {
    const desk = reader.sessions(now);
    const code = terminal ? mergeTerminal(desk, terminal.sessions(now)) : desk;
    return cowork ? [...code, ...cowork.sessions(now)] : code;
  };

  const snapshot = (): Snapshot => {
    const now = Date.now();
    const bases = allBases(now);
    const chains = findChains(bases);
    // The user layer follows a restart: move it from the old id to the newest one.
    for (const [oldId, newId] of chains.replacedBy) store.moveSession(oldId, newId);
    return buildSnapshot(bases, (id) => store.session(id), store.labels, now, detect, {
      chains,
      subagentsOf: (b) => agents?.get(b.cwd, b.cliSessionId, now) ?? { running: 0, done: 0, items: [] },
    });
  };

  let lastKey = "";
  const broadcast = (force = false): void => {
    const snap = snapshot();
    const key = JSON.stringify({ s: snap.sessions, l: snap.labels });
    if (!force && key === lastKey) return;
    lastKey = key;
    notifier.update(snap.sessions, snap.generatedAt);
    const frame = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
    for (const c of clients) c.write(frame);
  };

  watcher.on("change", () => broadcast());
  watcher.on("tick", () => broadcast()); // time-based status (stale working) can change
  watcher.start();
  // Only "change": the desktop watcher's tick already refreshes time-based status every poll.
  coworkWatcher?.on("change", () => broadcast());
  coworkWatcher?.start();
  terminal?.start();
  broadcast(true);

  const ping = setInterval(() => {
    for (const c of clients) c.write(`event: ping\ndata: {}\n\n`);
  }, PING_MS);
  ping.unref();

  async function api(req: IncomingMessage, res: ServerResponse, path: string, lang: Lang): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const parts = path.split("/").filter(Boolean).slice(1); // drop "api"
    const id = parts[1] !== undefined ? decodeURIComponent(parts[1]) : undefined;

    if (method === "GET" && path === "/api/snapshot") return sendJson(res, 200, snapshot());
    // The sign-in link for one more device. Only a signed-in device can ask, and it
    // already holds the token, so this shows nothing new. Never logged.
    if (method === "GET" && path === "/api/login-link") {
      const local = (h: string) => /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(h);
      const asked = req.headers.host ?? "";
      const host = asked && !local(asked) ? asked : opts.allowedHosts.find((h) => !local(h));
      const base = host ? `https://${host}` : `http://${asked || "127.0.0.1"}`;
      return sendJson(res, 200, { url: `${base}/login?token=${encodeURIComponent(opts.token)}` });
    }
    if (method === "GET" && path === "/api/devices") return sendJson(res, 200, buildDevices(snapshot().sessions, folders.folders()));

    if (method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`retry: 3000\n\n`);
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (parts[0] === "sessions" && id && parts.length === 2 && method === "PATCH") {
      const base = allBases().find((s) => s.id === id);
      if (!base) return sendError(res, 404, "session not found");
      store.patchSession(id, await readJson(req));
      broadcast();
      const updated = snapshot().sessions.find((s) => s.id === id);
      return updated ? sendJson(res, 200, updated) : sendError(res, 404, "session not found");
    }

    if (path === "/api/labels" && method === "POST") {
      const label = store.createLabel(await readJson(req));
      broadcast();
      return sendJson(res, 200, label);
    }

    if (parts[0] === "labels" && id && parts.length === 2) {
      if (method === "PATCH") {
        const label = store.patchLabel(id, await readJson(req));
        if (!label) return sendError(res, 404, "label not found");
        broadcast();
        return sendJson(res, 200, label);
      }
      if (method === "DELETE") {
        if (!store.deleteLabel(id)) return sendError(res, 404, "label not found");
        broadcast();
        return noContent(res);
      }
    }

    if (method === "GET" && path === "/api/control") return sendJson(res, 200, await controlStatus(lang));

    if (method === "POST" && path === "/api/control/action") {
      const body = (await readJson(req)) as { action?: unknown; dry?: unknown } | undefined;
      const action = body?.action as ControlActionName;
      if (!CONTROL_ACTIONS.includes(action)) throw new HttpError(400, msg(lang).unknownAction);
      const dry = body?.dry === true;
      return sendJson(res, 200, await runControl((c) => c.action(action, { dry, lang }), dry, action, lang));
    }

    if (parts[0] === "sessions" && id && parts.length === 3 && parts[2] === "revive" && method === "POST") {
      const body = (await readJson(req)) as { dry?: unknown } | undefined;
      const dry = body?.dry === true;
      const base = allBases().find((s) => s.id === id);
      if (!base) throw new HttpError(404, msg(lang).sessionNotFound);
      const mode = reviveMode(base);
      if (mode === "restart") {
        const name = base.terminal!.name;
        return sendJson(res, 200, await runControl((c) => c.action("restart_session", { name, dry, lang }), dry, "restart_session", lang));
      }
      if (mode === "resume") {
        const uuid = base.cliSessionId!;
        return sendJson(res, 200, await runControl((c) => c.resume(uuid, { name: base.title, dry, lang }), dry, "resume", lang));
      }
      throw new HttpError(400, msg(lang).noConversation);
    }

    if (parts[0] === "push") {
      if (!opts.push) return sendError(res, 404, "push not available");
      if (method === "GET" && path === "/api/push/key") return sendJson(res, 200, { publicKey: opts.push.publicKey });
      if (method === "POST" && path === "/api/push/subscribe") {
        const body = await readJson(req);
        try {
          await opts.push.subscribe(body);
        } catch (err) {
          throw new HttpError(400, (err as Error).message || "invalid subscription");
        }
        return noContent(res);
      }
      if (method === "POST" && path === "/api/push/test") {
        await opts.push.send({ title: "Claude Control Mobile", body: "Test push", sessionId: "test", url: "/" });
        return noContent(res);
      }
    }

    return sendError(res, 404, "not found");
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return sendError(res, 404, "not found");
    let rel: string;
    try {
      rel = decodeURIComponent(path);
    } catch {
      return sendError(res, 400, "bad path");
    }
    let file = resolve(join(webRoot, rel));
    if (file !== webRoot && !file.startsWith(webRoot + sep)) return sendError(res, 404, "not found");
    let st = statSafe(file);
    if (st?.isDirectory()) {
      file = join(file, "index.html");
      st = statSafe(file);
    }
    if (!st?.isFile()) {
      // SPA fallback: unknown paths without a file extension get index.html.
      if (extname(rel) && extname(rel) !== ".html") return sendError(res, 404, "not found");
      file = join(webRoot, "index.html");
      st = statSafe(file);
      if (!st?.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("UI not built. Run npm run web:build.\n");
        return;
      }
    }
    const ext = extname(file).toLowerCase();
    const name = file.slice(webRoot.length + 1);
    const noCache = ext === ".html" || ext === ".webmanifest" || name === "sw.js";
    res.writeHead(200, {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": noCache
        ? "no-cache"
        : name.startsWith("assets" + sep)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      ...(name === "sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
    });
    if (method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    // Host check on every request, also /login and static files (DNS rebinding).
    if (!hostAllowed(req.headers.host, opts.allowedHosts)) return sendError(res, 403, "host not allowed");

    if (path === "/api" || path.startsWith("/api/")) {
      const auth = checkRequest(req, { token: opts.token, allowedHosts: opts.allowedHosts, selfOrigins: currentOrigins() });
      if (!auth.ok) return sendError(res, auth.status, auth.error);
      // An explicit ?lang= also sets the language of fall pushes.
      pushLang = queryLang(url) ?? pushLang;
      api(req, res, path, requestLang(req, url)).catch((err) => {
        if (res.headersSent) return void res.end();
        if (err instanceof ValidationError) return sendError(res, 400, err.message);
        if (err instanceof HttpError) return sendError(res, err.status, err.message);
        console.error("api error:", (err as Error).message);
        sendJson(res, 500, { error: "internal error" });
      });
      return;
    }
    if (handleLogin(req, res, opts.token)) return;
    serveStatic(req, res, path);
  });

  return {
    server,
    snapshot,
    close: () =>
      new Promise<void>((done) => {
        watcher.stop();
        coworkWatcher?.stop();
        detector?.stop();
        agents?.stop();
        terminal?.stop();
        for (const t of followTimers) clearTimeout(t);
        followTimers.clear();
        clearInterval(ping);
        for (const c of clients) c.end();
        clients.clear();
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

function statSafe(file: string) {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

/** Read the allowed hosts: env first, else <dataDir>/allowed-hosts, plus localhost. */
export function loadAllowedHosts(env: string | undefined, dataDir: string): string[] {
  let list = parseHostList(env);
  if (!env) {
    try {
      list = parseHostList(readFileSync(join(dataDir, "allowed-hosts"), "utf8"));
    } catch {
      list = [];
    }
  }
  return [...new Set([...list, "localhost", "127.0.0.1"])];
}
