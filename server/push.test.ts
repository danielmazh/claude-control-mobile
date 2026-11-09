import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushSubscription, RequestOptions, SendResult } from "web-push";
import { createPush } from "./push.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "deck-push-"));
}

function sub(n: number) {
  return { endpoint: `https://push.example.com/send/${n}`, expirationTime: null, keys: { p256dh: `p256dh${n}`, auth: `auth${n}` } };
}

function readFile(dir: string) {
  return JSON.parse(readFileSync(join(dir, "push.json"), "utf8"));
}

const payload = { title: "Waiting", body: "project-x", sessionId: "local_1", url: "/" };

test("keys are created once with mode 0600 and reused", async () => {
  const dir = tmp();
  try {
    const p1 = await createPush(dir);
    assert.ok(p1.publicKey.length > 40);
    assert.equal(statSync(join(dir, "push.json")).mode & 0o777, 0o600);
    const p2 = await createPush(dir);
    assert.equal(p2.publicKey, p1.publicKey);
    assert.deepEqual(readFile(dir).subscriptions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subscribe validates shape", async () => {
  const dir = tmp();
  try {
    const p = await createPush(dir);
    for (const bad of [null, "x", {}, { endpoint: "http://insecure.example/x", keys: { p256dh: "a", auth: "b" } },
      { endpoint: "https://ok.example/x" }, { endpoint: "https://ok.example/x", keys: { p256dh: "a b", auth: "c" } },
      { endpoint: "not a url", keys: { p256dh: "a", auth: "b" } }]) {
      await assert.rejects(p.subscribe(bad));
    }
    assert.deepEqual(readFile(dir).subscriptions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("subscribe dedupes by endpoint and keeps only clean fields", async () => {
  const dir = tmp();
  try {
    const p = await createPush(dir);
    await p.subscribe(sub(1));
    await p.subscribe({ ...sub(1), keys: { p256dh: "newkey", auth: "newauth" }, extra: "drop me" });
    await p.subscribe(sub(2));
    const subs = readFile(dir).subscriptions;
    assert.equal(subs.length, 2);
    assert.deepEqual(subs[0], { endpoint: sub(1).endpoint, keys: { p256dh: "newkey", auth: "newauth" } });
    const again = await createPush(dir);
    assert.equal(again.publicKey, p.publicKey);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send delivers payload and removes 404/410 subscriptions", async () => {
  const dir = tmp();
  const calls: { endpoint: string; body: string; options: RequestOptions }[] = [];
  const sendNotification = async (s: PushSubscription, body: string, options: RequestOptions): Promise<SendResult> => {
    calls.push({ endpoint: s.endpoint, body, options });
    if (s.endpoint.endsWith("/2")) throw Object.assign(new Error("gone"), { statusCode: 410 });
    if (s.endpoint.endsWith("/3")) throw Object.assign(new Error("not found"), { statusCode: 404 });
    if (s.endpoint.endsWith("/4")) throw Object.assign(new Error("server error"), { statusCode: 500 });
    return { statusCode: 201, body: "", headers: {} };
  };
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (msg: string) => warnings.push(msg);
  try {
    const p = await createPush(dir, { sendNotification });
    for (const n of [1, 2, 3, 4]) await p.subscribe(sub(n));
    await p.send(payload);
    assert.equal(calls.length, 4);
    assert.deepEqual(JSON.parse(calls[0].body), payload);
    assert.equal(calls[0].options.vapidDetails?.publicKey, p.publicKey);
    assert.match(calls[0].options.vapidDetails?.subject ?? "", /^mailto:/);
    const left = readFile(dir).subscriptions.map((s: { endpoint: string }) => s.endpoint);
    assert.deepEqual(left, [sub(1).endpoint, sub(4).endpoint]);
    // The warning must not leak keys.
    const privateKey = readFile(dir).privateKey;
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes(privateKey));
    assert.ok(!warnings[0].includes("/send/"));
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send uses DECK_VAPID_SUBJECT when set", async () => {
  const dir = tmp();
  const old = process.env.DECK_VAPID_SUBJECT;
  process.env.DECK_VAPID_SUBJECT = "mailto:owner@example.org";
  let seen = "";
  try {
    const p = await createPush(dir, {
      sendNotification: async (_s, _b, o) => {
        seen = o.vapidDetails?.subject ?? "";
        return { statusCode: 201, body: "", headers: {} };
      },
    });
    await p.subscribe(sub(1));
    await p.send(payload);
    assert.equal(seen, "mailto:owner@example.org");
  } finally {
    if (old === undefined) delete process.env.DECK_VAPID_SUBJECT;
    else process.env.DECK_VAPID_SUBJECT = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send with no subscriptions is a no-op", async () => {
  const dir = tmp();
  try {
    let n = 0;
    const p = await createPush(dir, { sendNotification: async () => { n++; return { statusCode: 201, body: "", headers: {} }; } });
    await p.send(payload);
    assert.equal(n, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
