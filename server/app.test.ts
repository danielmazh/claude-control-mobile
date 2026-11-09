import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import type { PushPayload } from "../shared/types.ts";
import { loadToken } from "./auth.ts";
import { createDeck, hostAllowed, loadAllowedHosts, selfOrigins, type Deck } from "./app.ts";

const FIX = resolve(import.meta.dirname, "..", "test", "fixtures", "sessions");
let root: string;
let deck: Deck;
let base: string;
let token: string;
let origin: string;
const pushed: PushPayload[] = [];
const subs: unknown[] = [];

before(async () => {
  root = mkdtempSync(join(tmpdir(), "deck-app-"));
  const sessionsDir = join(root, "sessions");
  const dataDir = join(root, "data");
  const webDir = join(root, "web");
  cpSync(FIX, sessionsDir, { recursive: true });
  mkdirSync(join(webDir, "assets"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>deck</title>");
  writeFileSync(join(webDir, "sw.js"), "self.x=1");
  writeFileSync(join(webDir, "manifest.webmanifest"), "{}");
  writeFileSync(join(webDir, "assets", "app.js"), "console.log(1)");
  token = loadToken(dataDir);
  deck = createDeck({
    dataDir, sessionsDir, webDir, port: 0, token, pollMs: 100,
    allowedHosts: loadAllowedHosts("deck.example.ts.net", dataDir),
    push: {
      publicKey: "PUBKEY",
      async subscribe(sub) {
        if (!sub || typeof sub !== "object") throw new Error("invalid subscription");
        subs.push(sub);
      },
      async send(p) {
        pushed.push(p);
      },
    },
  });
  await new Promise<void>((r) => deck.server.listen(0, "127.0.0.1", () => r()));
  const port = (deck.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  origin = base;
});

after(async () => {
  await deck.close();
  rmSync(root, { recursive: true, force: true });
});

const auth = () => ({ Authorization: `Bearer ${token}` });
const write = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(base + path, {
    method,
    headers: { ...auth(), Origin: origin, "Content-Type": "application/json", ...extra },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

test("auth: 401 without token, 403 bad origin, cookie works", async () => {
  assert.equal((await fetch(base + "/api/snapshot")).status, 401);
  assert.equal((await fetch(base + "/api/snapshot", { headers: { Cookie: `deck_token=${token}` } })).status, 200);
  const r = await fetch(base + "/api/labels", { method: "POST", headers: { ...auth(), Origin: "http://evil.test" }, body: "{}" });
  assert.equal(r.status, 403);
  const status = await new Promise<number>((done, fail) => {
    const req = request(base + "/", { headers: { Host: "evil.test" } }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
  assert.equal(status, 403);
});

test("snapshot lists fixture sessions", async () => {
  const snap = await (await fetch(base + "/api/snapshot", { headers: auth() })).json();
  assert.equal(snap.sessions.length, 4);
  assert.deepEqual(snap.labels, []);
  assert.equal(typeof snap.generatedAt, "number");
});

test("PATCH session: validation, 404, success", async () => {
  assert.equal((await write("PATCH", "/api/sessions/local_nope", { pinned: true })).status, 404);
  const bad = await write("PATCH", "/api/sessions/local_fx-idle", { priority: "urgent" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /priority/);
  assert.equal((await write("PATCH", "/api/sessions/local_fx-idle", "{oops")).status, 400);
  const ok = await write("PATCH", "/api/sessions/local_fx-idle", { pinned: true, note: "n" });
  assert.equal(ok.status, 200);
  const s = await ok.json();
  assert.equal(s.pinned, true);
  assert.equal(s.note, "n");
  assert.equal(s.title, "Fake idle session");
});

test("labels: create, patch, delete cascade", async () => {
  const l = await (await write("POST", "/api/labels", { name: "Ops", color: "#00ff00" })).json();
  assert.match(l.id, /^lbl_/);
  assert.equal((await write("POST", "/api/labels", { name: "X", color: "green" })).status, 400);
  const p = await write("PATCH", `/api/labels/${l.id}`, { name: "Ops2" });
  assert.equal((await p.json()).name, "Ops2");
  assert.equal((await write("PATCH", "/api/labels/lbl_none", { name: "x" })).status, 404);
  await write("PATCH", "/api/sessions/local_fx-blocked", { labelIds: [l.id] });
  assert.equal((await write("DELETE", `/api/labels/${l.id}`)).status, 204);
  const snap = await (await fetch(base + "/api/snapshot", { headers: auth() })).json();
  assert.deepEqual(snap.sessions.find((s: { id: string }) => s.id === "local_fx-blocked").labelIds, []);
  assert.equal((await write("DELETE", `/api/labels/${l.id}`)).status, 404);
});

test("push endpoints", async () => {
  assert.deepEqual(await (await fetch(base + "/api/push/key", { headers: auth() })).json(), { publicKey: "PUBKEY" });
  assert.equal((await write("POST", "/api/push/subscribe", { endpoint: "https://x" })).status, 204);
  assert.equal((await write("POST", "/api/push/subscribe", "null")).status, 400);
  assert.equal((await write("POST", "/api/push/test")).status, 204);
  assert.equal(pushed.at(-1)?.sessionId, "test");
});

test("SSE sends a snapshot, then a new one on file change", async () => {
  const ctrl = new AbortController();
  const res = await fetch(base + "/api/events", { headers: auth(), signal: ctrl.signal });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const waitFor = async (pred: (b: string) => boolean) => {
    while (!pred(buf)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
  };
  await waitFor((b) => b.includes("event: snapshot"));
  buf = "";
  const file = join(root, "sessions", "acct-0001", "org-0001", "local_fx-new.json");
  writeFileSync(file, JSON.stringify({ sessionId: "local_fx-new", title: "Fake new", cwd: "/tmp/n", lastActivityAt: 1 }));
  await waitFor((b) => b.includes("local_fx-new"));
  assert.ok(buf.includes("event: snapshot"));
  ctrl.abort();
});

test("static: content types, cache, SPA fallback, traversal", async () => {
  const idx = await fetch(base + "/some/route");
  assert.equal(idx.status, 200);
  assert.equal(idx.headers.get("content-type"), "text/html; charset=utf-8");
  const sw = await fetch(base + "/sw.js");
  assert.equal(sw.headers.get("cache-control"), "no-cache");
  assert.equal(sw.headers.get("content-type"), "text/javascript; charset=utf-8");
  const man = await fetch(base + "/manifest.webmanifest");
  assert.equal(man.headers.get("content-type"), "application/manifest+json; charset=utf-8");
  const js = await fetch(base + "/assets/app.js");
  assert.match(js.headers.get("cache-control") ?? "", /immutable/);
  assert.equal((await fetch(base + "/missing.png")).status, 404);
  const trav = await new Promise<number>((done, fail) => {
    const req = request(base + "/x", { path: "/..%2f..%2f..%2fetc%2fpasswd" }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
  assert.equal(trav, 404);
  assert.equal((await fetch(base + "/api/unknown", { headers: auth() })).status, 404);
});

test("login sets the cookie", async () => {
  const r = await fetch(base + `/login?token=${token}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.match(r.headers.get("set-cookie") ?? "", /deck_token=/);
});

test("host helpers", () => {
  assert.ok(hostAllowed("localhost:7810", ["localhost"]));
  assert.ok(hostAllowed("a.ts.net", ["a.ts.net"]));
  assert.ok(!hostAllowed("a.ts.net:9", ["a.ts.net:7810"]));
  assert.ok(!hostAllowed(undefined, ["localhost"]));
  assert.ok(selfOrigins(["a.ts.net"], 7810).includes("https://a.ts.net"));
  assert.deepEqual(loadAllowedHosts("A.ts.net, 127.0.0.1:7810", "/nonexistent"), ["a.ts.net", "127.0.0.1:7810", "localhost", "127.0.0.1"]);
});
