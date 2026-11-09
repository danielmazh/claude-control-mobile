// Spec 0004 tests. A FAKE Claude Control HTTP server stands in for the real one
// (http://127.0.0.1:7799 is never called here). Fake fixtures only.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PushPayload } from "../shared/types.ts";
import { ControlClient, ControlUnreachable, summarize } from "./control.ts";
import { createDeck, loadAllowedHosts, type Deck } from "./app.ts";
import { loadToken } from "./auth.ts";

const FIX = resolve(import.meta.dirname, "..", "test", "fixtures", "terminal");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const DESK_UUID = "f0f0f0f0-0000-4000-8000-0000000000aa";

// ---------- fake Claude Control ----------

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

class FakeControl {
  calls: Call[] = [];
  server: Server;
  url = "";
  action: Record<string, unknown> | null = null;
  refuse: string | null = null; // next action answers ok:false with this message
  statusPolls = 0;

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        const path = req.url ?? "/";
        this.calls.push({ method: req.method ?? "GET", path, body });
        const send = (o: unknown) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(o));
        };
        if (req.method === "GET" && path.startsWith("/api/rc/status")) {
          this.statusPolls++;
          // A running action ends on the second status poll after it started.
          if (this.action && !this.action.done && this.statusPolls >= 2) {
            Object.assign(this.action, { done: true, ok: true, finished: 1_800_000_010, message: "הפעלה מחדש של סשן: הסתיים" });
            (this.action.results as unknown[]).push({ step: "verify alpha", ok: true, detail: "רץ שוב" });
          }
          return send({
            ts: 1, overall: "warn", network_up: true, lang: "he", rc_session: "rc-resume",
            issues: [{ id: "stopped:beta", level: "warn", title: "beta לא רץ", detail: "", fix: { kind: "auto", action: "resume_missing" } }],
            checks: [],
            sessions: [
              { name: "alpha", uuid: A, running: true, state: "active", rc: "connected" },
              { name: "beta", uuid: B, running: false, state: "", rc: "" },
            ],
            daemon: { running: true, pid: 1, started: 1, status: "Connected", env_link: null, last_events: [] },
            features: { restore: true },
            running_action: this.action,
          });
        }
        if (req.method === "POST" && path === "/api/rc/action") {
          if (this.refuse) {
            const m = this.refuse;
            this.refuse = null;
            return send({ ok: false, message: m, error: m, results: [] });
          }
          if (body?.dry) {
            return send({ ok: true, message: "תוכנית בלבד", dry: true, results: [{ step: `exit ${body.name ?? "x"}`, ok: true, detail: "would send /exit" }] });
          }
          this.statusPolls = 0;
          this.action = { action: body?.action, name: body?.name ?? null, started: 1_800_000_000, done: false, ok: null, results: [{ step: "exit alpha", ok: true, detail: "pid 1 יצא" }] };
          return send({ ok: true, started: true, message: "התחיל", results: [] });
        }
        if (req.method === "POST" && path === "/api/sessions/resume") {
          return send({ ok: true, name: "desk-copy", message: body?.dry ? "תוכנית בלבד: desk-copy" : "desk-copy הופעל ונוסף לשחזור האוטומטי", dry: !!body?.dry, results: [{ step: "keep", ok: true, detail: "line" }, { step: "resume_missing", ok: true, detail: "done" }] });
        }
        res.writeHead(404);
        res.end("{}");
      });
    });
  }

  start(): Promise<void> {
    return new Promise((r) =>
      this.server.listen(0, "127.0.0.1", () => {
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
        r();
      }),
    );
  }

  posts(): Call[] {
    return this.calls.filter((c) => c.method === "POST");
  }

  close(): Promise<void> {
    return new Promise((r) => {
      this.server.closeAllConnections();
      this.server.close(() => r());
    });
  }
}

/** A port with nothing listening. */
async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

// ---------- client ----------

test("control client: status summary, dry action body, unreachable and timeout", async () => {
  const fake = new FakeControl();
  await fake.start();
  try {
    const c = new ControlClient({ baseUrl: fake.url });
    const st = await c.status();
    assert.deepEqual(st, {
      reachable: true, overall: "warn", networkUp: true, daemon: { running: true, status: "Connected" },
      sessions: { total: 2, running: 1 }, issues: 1, action: null,
    });
    assert.equal(fake.calls[0].path, "/api/rc/status?lang=en", "English by default");
    const r = await c.action("restart_session", { name: "alpha", dry: true });
    assert.equal(r.dry, true);
    assert.equal(r.started, false);
    assert.equal(r.name, "alpha");
    assert.deepEqual(fake.calls[1].body, { action: "restart_session", dry: true, lang: "en", name: "alpha" });
    await c.status("he");
    assert.equal(fake.calls[2].path, "/api/rc/status?lang=he");
    await c.resume(DESK_UUID, { dry: true, lang: "he" });
    assert.deepEqual(fake.calls[3].body, { uuid: DESK_UUID, dry: true, lang: "he" });
  } finally {
    await fake.close();
  }
  await assert.rejects(new ControlClient({ baseUrl: await deadUrl() }).status(), ControlUnreachable);
  const hang = createServer(() => {}); // never answers
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
  try {
    const url = `http://127.0.0.1:${(hang.address() as AddressInfo).port}`;
    await assert.rejects(new ControlClient({ baseUrl: url, timeoutMs: 100 }).status(), ControlUnreachable);
  } finally {
    hang.closeAllConnections();
    await new Promise<void>((r) => hang.close(() => r()));
  }
});

test("control summary: running action times become epoch ms", () => {
  const st = summarize({ overall: "ok", sessions: [], running_action: { action: "fix_all", name: null, started: 1.5, done: false, results: [{ step: "s", ok: 1 }] } });
  assert.deepEqual(st.action, { action: "fix_all", name: null, done: false, ok: null, message: null, results: [{ step: "s", ok: false, detail: "" }], startedAt: 1500, finishedAt: null });
});

// ---------- hub endpoints ----------

let root: string;
let fake: FakeControl;
let deck: Deck;
let base: string;
let token: string;
let psCalls = 0;
const pushed: PushPayload[] = [];
const logs: string[] = [];
const realLog = console.log;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "deck-control-"));
  cpSync(FIX, root, { recursive: true });
  // Fresh timestamps so terminal sessions are not stale.
  const af = join(root, "projects", "-tmp-fx-term", `${A}.jsonl`);
  writeFileSync(af, readFileSync(af, "utf8").replace(/2026-01-01T1\d:\d\d:\d\d\.\d{3}Z/g, new Date().toISOString()));
  // Two desktop sessions: one with a CLI conversation uuid, one without a usable id.
  const org = join(root, "sessions", "acct", "org");
  mkdirSync(org, { recursive: true });
  const now = Date.now();
  writeFileSync(join(org, "local_desk.json"), JSON.stringify({ sessionId: "local_desk", cliSessionId: DESK_UUID, cwd: "/tmp/fx/desk", title: "Desk chat", lastActivityAt: now - 3_600_000 }));
  writeFileSync(join(org, "local_nocli.json"), JSON.stringify({ sessionId: "local_nocli", cliSessionId: "cli-1", cwd: "/tmp/fx/desk", title: "No cli", lastActivityAt: now - 3_600_000 }));
  const psText = readFileSync(join(FIX, "ps.txt"), "utf8");
  const tmuxText = readFileSync(join(FIX, "tmux.txt"), "utf8");
  const exec = async (cmd: string) => {
    if (!cmd.endsWith("ps")) return tmuxText;
    psCalls++;
    return psText;
  };
  fake = new FakeControl();
  await fake.start();
  const dataDir = join(root, "data");
  token = loadToken(dataDir);
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  deck = createDeck({
    dataDir, sessionsDir: join(root, "sessions"), webDir: join(root, "web"), port: 0, token,
    allowedHosts: loadAllowedHosts("", dataDir), projectsDir: join(root, "projects"),
    rcManifest: join(root, "sessions.conf"), terminalExec: exec, terminalProcPollMs: 40,
    controlUrl: fake.url, controlPollMs: 20,
    push: { publicKey: "K", async subscribe() {}, async send(p) { pushed.push(p); } },
  });
  await new Promise<void>((r) => deck.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(deck.server.address() as AddressInfo).port}`;
  await new Promise((r) => setTimeout(r, 60)); // first ps/tmux poll
});

after(async () => {
  console.log = realLog;
  await deck.close();
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body?: unknown, origin = base) =>
  fetch(base + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: origin, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path: string) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
const until = async (fn: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 15));
  return fn();
};

test("hub: snapshot carries the revive mode and the manifest name", () => {
  const s = deck.snapshot().sessions;
  const a = s.find((x) => x.id === `cli_${A}`)!;
  assert.equal(a.revive, "restart");
  assert.equal(a.terminal?.name, "alpha");
  assert.equal(s.find((x) => x.id === "local_desk")!.revive, "resume");
  assert.equal(s.find((x) => x.id === "local_nocli")!.revive, null);
});

test("hub: GET /api/control; auth and Origin checks apply", async () => {
  assert.equal((await fetch(base + "/api/control")).status, 401);
  const r = await get("/api/control");
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.equal(st.reachable, true);
  assert.deepEqual(st.sessions, { total: 2, running: 1 });
  assert.equal((await post(`/api/sessions/cli_${A}/revive`, { dry: true }, "http://evil.test")).status, 403);
  assert.equal((await post("/api/control/action", { action: "fix_all" }, "http://evil.test")).status, 403);
});

test("hub: revive a manifest session (dry) maps to restart_session by name, in the asked language", async () => {
  const before = fake.posts().length;
  const r = await post(`/api/sessions/cli_${A}/revive?lang=he`, { dry: true });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.dry, true);
  assert.equal(out.action, "restart_session");
  assert.deepEqual(out.results.map((x: { step: string }) => x.step), ["exit alpha"]);
  const call = fake.posts()[before];
  assert.equal(call.path, "/api/rc/action");
  assert.deepEqual(call.body, { action: "restart_session", dry: true, lang: "he", name: "alpha" });
  assert.equal(logs.some((l) => l.startsWith("control:")), false, "dry runs are not logged");
});

test("hub: revive a desktop session not in the manifest maps to sessions/resume with its uuid", async () => {
  const r = await post("/api/sessions/local_desk/revive", { dry: true });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.action, "resume");
  assert.equal(out.name, "desk-copy");
  const call = fake.posts().at(-1)!;
  assert.equal(call.path, "/api/sessions/resume");
  assert.deepEqual(call.body, { uuid: DESK_UUID, dry: true, lang: "en", name: "Desk chat" });
});

test("hub: revive errors: unknown 404, no conversation 400, bad action 400, refused 409", async () => {
  const n = fake.posts().length;
  const a = await post("/api/sessions/local_missing/revive", {});
  assert.equal(a.status, 404);
  assert.equal((await a.json()).error, "Session not found", "English by default");
  const aHe = await post("/api/sessions/local_missing/revive?lang=he", {});
  assert.equal((await aHe.json()).error, "הסשן לא נמצא");
  const b = await post("/api/sessions/local_nocli/revive", {});
  assert.equal(b.status, 400);
  assert.match((await b.json()).error, /can't be revived/);
  const bHe = await fetch(base + "/api/sessions/local_nocli/revive", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: base, "Content-Type": "application/json", "Accept-Language": "he-IL,he;q=0.9,en;q=0.8" },
    body: "{}",
  });
  assert.match((await bHe.json()).error, /אי אפשר להחיות/, "Accept-Language works too");
  assert.equal((await post("/api/control/action", { action: "restart_session" })).status, 400);
  assert.equal((await post("/api/control/action", { action: "drop" })).status, 400);
  assert.equal(fake.posts().length, n, "nothing reached Claude Control");
  fake.refuse = "פעולה אחרת רצה: תיקון הכול";
  const c = await post("/api/control/action", { action: "resume_missing" });
  assert.equal(c.status, 409);
  assert.equal((await c.json()).error, "פעולה אחרת רצה: תיקון הכול");
});

test("hub: a real revive starts, is followed until done, logged without content, then rescans", async () => {
  logs.length = 0;
  const r = await post(`/api/sessions/cli_${A}/revive`, {});
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.started, true);
  assert.deepEqual(fake.posts().at(-1)!.body, { action: "restart_session", dry: false, lang: "en", name: "alpha" });
  const ps0 = psCalls;
  assert.ok(await until(() => logs.some((l) => l.startsWith("control: done"))), "follow ends");
  assert.deepEqual(logs, ["control: start restart_session name=alpha", "control: done restart_session name=alpha result=ok"]);
  assert.ok(await until(() => psCalls > ps0), "rescan polled ps");
  const st = await (await get("/api/control")).json();
  assert.equal(st.action.done, true);
  assert.equal(st.action.ok, true);
  assert.deepEqual(st.action.results.map((x: { step: string }) => x.step), ["exit alpha", "verify alpha"]);
});

test("hub: control actions pass through; resume_missing dry", async () => {
  const r = await post("/api/control/action", { action: "resume_missing", dry: true });
  assert.equal(r.status, 200);
  assert.deepEqual(fake.posts().at(-1)!.body, { action: "resume_missing", dry: true, lang: "en" });
});

test("hub: push when a manifest session falls (2 polls), with a deep link", async () => {
  // The main deck ran a real action above, which holds fall pushes for a minute. Use a fresh deck.
  const d2root = mkdtempSync(join(tmpdir(), "deck-fall-"));
  cpSync(root, d2root, { recursive: true });
  let up = true;
  const psText = readFileSync(join(FIX, "ps.txt"), "utf8");
  const tmuxText = readFileSync(join(FIX, "tmux.txt"), "utf8");
  const sent: PushPayload[] = [];
  const d2 = createDeck({
    dataDir: join(d2root, "data2"), sessionsDir: join(d2root, "sessions"), webDir: join(d2root, "web"), port: 0, token,
    allowedHosts: ["localhost"], projectsDir: join(d2root, "projects"), rcManifest: join(d2root, "sessions.conf"),
    terminalExec: async (cmd) => (!cmd.endsWith("ps") ? tmuxText : up ? psText : psText.split("\n").filter((l) => !l.includes(A)).join("\n")),
    terminalProcPollMs: 30,
    push: { publicKey: "K", async subscribe() {}, async send(p) { sent.push(p); } },
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(sent.length, 0, "no push on start");
    up = false;
    assert.ok(await until(() => sent.length > 0, 1500));
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(sent, [{ title: "Stopped: Fake alpha title", body: "Tap to revive", sessionId: `cli_${A}`, url: `/?session=cli_${A}` }]);
  } finally {
    await d2.close();
    rmSync(d2root, { recursive: true, force: true });
  }
  assert.equal(pushed.length, 0, "the main deck pushed nothing (alpha never fell there)");
});

test("hub: Claude Control not running: GET says reachable false, actions 503", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deck-dead-"));
  const d = createDeck({
    dataDir: join(dir, "data"), sessionsDir: join(root, "sessions"), webDir: join(dir, "web"), port: 0, token,
    allowedHosts: loadAllowedHosts("", join(dir, "data")), push: null, controlUrl: await deadUrl(),
  });
  try {
    await new Promise<void>((r) => d.server.listen(0, "127.0.0.1", () => r()));
    const b = `http://127.0.0.1:${(d.server.address() as AddressInfo).port}`;
    const h = { Authorization: `Bearer ${token}`, Origin: b, "Content-Type": "application/json" };
    const st = await (await fetch(b + "/api/control", { headers: h })).json();
    assert.equal(st.reachable, false);
    const r1 = await fetch(b + "/api/control/action", { method: "POST", headers: h, body: JSON.stringify({ action: "fix_all" }) });
    assert.equal(r1.status, 503);
    assert.deepEqual(await r1.json(), { error: "Claude Control is not running" });
    const r2 = await fetch(b + "/api/sessions/local_desk/revive?lang=he", { method: "POST", headers: h, body: "{}" });
    assert.equal(r2.status, 503);
    assert.deepEqual(await r2.json(), { error: "Claude Control לא רץ" });
  } finally {
    await d.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
