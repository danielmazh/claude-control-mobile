import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadToken, checkRequest, handleLogin } from "./auth.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "deck-auth-"));
}

function fakeReq(method: string, url: string, headers: Record<string, string>): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage;
}

function fakeRes() {
  const out = { status: 0, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      out.status = status;
      out.headers = headers;
      return res;
    },
    end(chunk?: string) {
      if (chunk) out.body += chunk;
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

const TOKEN = "test-token-abc";
const opts = {
  token: TOKEN,
  allowedHosts: ["deck.example.ts.net", "127.0.0.1:7810"],
  selfOrigins: ["https://deck.example.ts.net"],
};

test("loadToken creates a token with mode 0600 and reuses it", () => {
  const dir = join(tmp(), "nested", "data");
  try {
    const t1 = loadToken(dir);
    assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(join(dir, "token")).mode & 0o777, 0o600);
    assert.equal(loadToken(dir), t1);
    assert.equal(readFileSync(join(dir, "token"), "utf8").trim(), t1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkRequest: GET with bearer token on allowed host passes", () => {
  const r = checkRequest(fakeReq("GET", "/api/snapshot", { host: "deck.example.ts.net", authorization: `Bearer ${TOKEN}` }), opts);
  assert.deepEqual(r, { ok: true });
});

test("checkRequest: host with port matches a host-only entry", () => {
  const r = checkRequest(fakeReq("GET", "/", { host: "deck.example.ts.net:443", cookie: `deck_token=${TOKEN}` }), opts);
  assert.deepEqual(r, { ok: true });
});

test("checkRequest: exact host:port entry", () => {
  assert.equal(checkRequest(fakeReq("GET", "/", { host: "127.0.0.1:7810", cookie: `deck_token=${TOKEN}` }), opts).ok, true);
  const wrongPort = checkRequest(fakeReq("GET", "/", { host: "127.0.0.1:9999", cookie: `deck_token=${TOKEN}` }), opts);
  assert.deepEqual(wrongPort, { ok: false, status: 403, error: "host not allowed" });
});

test("checkRequest: unknown or missing host is 403", () => {
  const r = checkRequest(fakeReq("GET", "/", { host: "evil.com", authorization: `Bearer ${TOKEN}` }), opts);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 403);
  const m = checkRequest(fakeReq("GET", "/", { authorization: `Bearer ${TOKEN}` }), opts);
  if (!m.ok) assert.equal(m.status, 403);
  else assert.fail("missing host must fail");
});

test("checkRequest: write needs a matching Origin", () => {
  const base = { host: "deck.example.ts.net", authorization: `Bearer ${TOKEN}` };
  const missing = checkRequest(fakeReq("POST", "/api/labels", base), opts);
  assert.deepEqual(missing, { ok: false, status: 403, error: "origin not allowed" });
  const wrong = checkRequest(fakeReq("PATCH", "/api/labels/x", { ...base, origin: "https://evil.com" }), opts);
  assert.equal(wrong.ok, false);
  const good = checkRequest(fakeReq("DELETE", "/api/labels/x", { ...base, origin: "https://deck.example.ts.net" }), opts);
  assert.deepEqual(good, { ok: true });
});

test("checkRequest: HEAD does not need Origin", () => {
  const r = checkRequest(fakeReq("HEAD", "/", { host: "deck.example.ts.net", authorization: `Bearer ${TOKEN}` }), opts);
  assert.deepEqual(r, { ok: true });
});

test("checkRequest: missing or wrong token is 401", () => {
  const none = checkRequest(fakeReq("GET", "/", { host: "deck.example.ts.net" }), opts);
  assert.deepEqual(none, { ok: false, status: 401, error: "unauthorized" });
  const wrong = checkRequest(fakeReq("GET", "/", { host: "deck.example.ts.net", authorization: "Bearer nope" }), opts);
  assert.equal(wrong.ok, false);
  const wrongCookie = checkRequest(fakeReq("GET", "/", { host: "deck.example.ts.net", cookie: "a=1; deck_token=bad" }), opts);
  assert.equal(wrongCookie.ok, false);
  const otherScheme = checkRequest(fakeReq("GET", "/", { host: "deck.example.ts.net", authorization: `Basic ${TOKEN}` }), opts);
  assert.equal(otherScheme.ok, false);
});

test("checkRequest: cookie among others", () => {
  const r = checkRequest(fakeReq("GET", "/", { host: "deck.example.ts.net", cookie: `x=1; deck_token=${TOKEN}; y=2` }), opts);
  assert.deepEqual(r, { ok: true });
});

test("handleLogin: other paths return false", () => {
  const { res, out } = fakeRes();
  assert.equal(handleLogin(fakeReq("GET", "/api/snapshot", {}), res, TOKEN), false);
  assert.equal(handleLogin(fakeReq("POST", "/login?token=x", {}), res, TOKEN), false);
  assert.equal(out.status, 0);
});

test("handleLogin: valid token sets cookie and redirects", () => {
  const { res, out } = fakeRes();
  assert.equal(handleLogin(fakeReq("GET", `/login?token=${TOKEN}`, { host: "deck.example.ts.net" }), res, TOKEN), true);
  assert.equal(out.status, 302);
  assert.equal(out.headers.Location, "/");
  const cookie = out.headers["Set-Cookie"];
  assert.match(cookie, new RegExp(`^deck_token=${TOKEN};`));
  for (const part of ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=31536000", "Secure"]) {
    assert.ok(cookie.includes(part), `missing ${part}`);
  }
});

test("handleLogin: Secure only behind https", () => {
  const plain = fakeRes();
  handleLogin(fakeReq("GET", `/login?token=${TOKEN}`, { host: "127.0.0.1:7810" }), plain.res, TOKEN);
  assert.ok(!plain.out.headers["Set-Cookie"].includes("Secure"));
  const proxied = fakeRes();
  handleLogin(fakeReq("GET", `/login?token=${TOKEN}`, { host: "127.0.0.1:7810", "x-forwarded-proto": "https" }), proxied.res, TOKEN);
  assert.ok(proxied.out.headers["Set-Cookie"].includes("Secure"));
});

test("handleLogin: invalid token is 401 plain text", () => {
  const { res, out } = fakeRes();
  assert.equal(handleLogin(fakeReq("GET", "/login?token=wrong", {}), res, TOKEN), true);
  assert.equal(out.status, 401);
  assert.match(out.headers["Content-Type"], /text\/plain/);
  assert.ok(!out.body.includes(TOKEN));
  const missing = fakeRes();
  handleLogin(fakeReq("GET", "/login", {}), missing.res, TOKEN);
  assert.equal(missing.out.status, 401);
});
