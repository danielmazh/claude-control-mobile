// Spec 0005: Cowork (general) chats. Fake fixtures only, built in a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { PushPayload, Snapshot } from "../shared/types.ts";
import { CoworkReader, COWORK_WORKING_MS, coworkStatus, foldCowork, pickMeta, type CoworkMeta } from "./cowork.ts";
import { EMPTY_STATE } from "./terminal.ts";
import { STALE_WAITING_MS } from "./status.ts";
import { buildSnapshot } from "./snapshot.ts";
import { loadToken } from "./auth.ts";
import { createDeck, loadAllowedHosts } from "./app.ts";

const T = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SECRET_MAIL = "fake.person@example.invalid";
const SECRET_NAME = "Fake Account Name";
const SECRET_PROMPT = "FAKE-SYSTEM-PROMPT-DO-NOT-LEAK";

const user = (at: number, text = "fake question", extra: object = {}) =>
  JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "text", text }] }, ...extra });
const assistant = (at: number, stop: string | null, text = "fake answer") =>
  JSON.stringify({ type: "assistant", timestamp: iso(at), message: { role: "assistant", stop_reason: stop, content: [{ type: "text", text }] } });
const toolResult = (at: number) =>
  JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "tool_result", content: "x" }] } });

interface FakeSession {
  id: string;
  cli: string;
  title?: string;
  archived?: boolean;
  lastActivityAt?: number;
  folders?: string[];
  lines?: string[];
}

/** Build <root>/acct/org/local_<id>.json and its transcript inside local_<id>/.claude/projects/<dir>/. */
function makeRoot(list: FakeSession[]): string {
  const root = mkdtempSync(join(tmpdir(), "deck-cowork-"));
  const org = join(root, "acct-fake", "org-fake");
  mkdirSync(org, { recursive: true });
  mkdirSync(join(root, "skills-plugin", "a", "b"), { recursive: true });
  writeFileSync(join(root, "skills-plugin", "a", "b", "local_not-a-session.json"), JSON.stringify({ sessionId: "local_not-a-session" }));
  for (const s of list) writeSession(org, s);
  return root;
}

function writeSession(org: string, s: FakeSession): void {
  writeFileSync(
    join(org, `local_${s.id}.json`),
    JSON.stringify({
      sessionId: `local_${s.id}`,
      title: s.title ?? `Fake chat ${s.id}`,
      cliSessionId: s.cli,
      createdAt: T - 60_000,
      lastActivityAt: s.lastActivityAt ?? T - 1000,
      isArchived: s.archived ?? false,
      cwd: join(org, `local_${s.id}`, "outputs"),
      userSelectedFolders: s.folders ?? [],
      emailAddress: SECRET_MAIL,
      accountName: SECRET_NAME,
      systemPrompt: SECRET_PROMPT,
      initialMessage: "fake first message",
      model: "fake-model",
      processName: "fake-proc",
    }),
  );
  if (s.lines) {
    const dir = join(org, `local_${s.id}`, ".claude", "projects", "-fake-outputs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${s.cli}.jsonl`), s.lines.join("\n") + "\n");
  }
}

const meta = (extra: Partial<CoworkMeta> = {}): CoworkMeta => ({
  sessionId: "local_m",
  title: "t",
  cliSessionId: "c",
  createdAt: null,
  lastActivityAt: T - 1000,
  isArchived: false,
  folders: [],
  ...extra,
});

test("cowork: pickMeta keeps only the named fields", () => {
  const m = pickMeta({ sessionId: "local_x", title: " T ", cliSessionId: "abc-1", emailAddress: SECRET_MAIL, systemPrompt: SECRET_PROMPT, userSelectedFolders: ["/a/b", 3, "rel"] });
  assert.deepEqual(m, { sessionId: "local_x", title: "T", cliSessionId: "abc-1", createdAt: null, lastActivityAt: null, isArchived: false, folders: ["/a/b"] });
  assert.equal(pickMeta({ title: "no id" }), null);
  assert.equal(pickMeta({ sessionId: "local_y", cliSessionId: "../bad" })!.cliSessionId, null);
});

test("cowork: status rules", () => {
  const fold = (...lines: string[]) => foldCowork(EMPTY_STATE, lines.join("\n") + "\n");
  // waiting: the last turn ended
  assert.equal(coworkStatus(meta(), fold(user(T - 5000), assistant(T - 4000, "end_turn")), T), "waiting");
  // waiting older than 3 days is idle
  const old = T - STALE_WAITING_MS - 1000;
  assert.equal(coworkStatus(meta({ lastActivityAt: old }), fold(user(old - 10), assistant(old, "end_turn")), T), "idle");
  // working: a prompt or tool result, transcript moved recently
  assert.equal(coworkStatus(meta(), fold(user(T - 5000)), T, T - 5000), "working");
  assert.equal(coworkStatus(meta(), fold(user(T - 9000), assistant(T - 8000, "tool_use"), toolResult(T - 7000)), T, T - 7000), "working");
  // the same, but quiet for longer than the window: idle
  const quiet = T - COWORK_WORKING_MS - 1000;
  assert.equal(coworkStatus(meta(), fold(user(quiet)), T, quiet), "idle");
  // stopped by shutdown: idle, even when fresh
  assert.equal(coworkStatus(meta(), fold(assistant(T - 3000, "tool_use"), user(T - 2000, "x", { interruptedByShutdown: true })), T, T - 2000), "idle");
  // archived wins; no transcript is idle
  assert.equal(coworkStatus(meta({ isArchived: true }), fold(user(T - 5000)), T, T), "archived");
  assert.equal(coworkStatus(meta(), EMPTY_STATE, T), "idle");
});

test("cowork: fold counts finished turns and keeps the last text", () => {
  const st = foldCowork(
    EMPTY_STATE,
    [user(T - 50), assistant(T - 40, "tool_use", "step"), toolResult(T - 30), assistant(T - 20, "end_turn", "**done** one"), assistant(T - 19, "end_turn", "done two"), user(T - 10), assistant(T - 5, "end_turn", "second")].join("\n") + "\n",
  );
  assert.equal(st.turns, 2);
  assert.equal(st.lastText, "second");
  assert.equal(st.last, "assistant-end");
});

test("cowork: reader lists sessions, skips skills-plugin, strips private fields, follows appends", () => {
  const root = makeRoot([
    { id: "wait", cli: "11111111-aaaa-bbbb-cccc-000000000001", folders: ["/fake/home/Docs/Taxes"], lines: [user(T - 9000), assistant(T - 8000, "end_turn", "fake summary")] },
    { id: "arch", cli: "11111111-aaaa-bbbb-cccc-000000000002", archived: true, lines: [user(T - 9000)] },
    { id: "none", cli: "11111111-aaaa-bbbb-cccc-000000000003" },
  ]);
  try {
    const r = new CoworkReader(root);
    assert.equal(r.scan(), true);
    assert.equal(r.scan(), false, "no change on second scan");
    const byId = Object.fromEntries(r.sessions(T).map((s) => [s.id, s]));
    assert.deepEqual(Object.keys(byId).sort(), ["cowork_local_arch", "cowork_local_none", "cowork_local_wait"]);
    const w = byId["cowork_local_wait"];
    assert.equal(w.status, "waiting");
    assert.equal(w.source, "cowork");
    assert.equal(w.kind, "general");
    assert.equal(w.summary, "fake summary");
    assert.equal(w.openUrl, null);
    assert.equal(w.cwd, "/fake/home/Docs/Taxes");
    assert.equal(w.completedTurns, 1);
    assert.equal(byId["cowork_local_arch"].status, "archived");
    assert.equal(byId["cowork_local_none"].status, "idle");

    const snap = buildSnapshot(r.sessions(T), () => ({}), [], T);
    const s = snap.sessions.find((x) => x.id === "cowork_local_wait")!;
    assert.equal(s.project, "Taxes", "project from the first selected folder");
    assert.equal(snap.sessions.find((x) => x.id === "cowork_local_none")!.project, "Cowork");
    assert.equal(s.kind, "general");
    assert.equal(s.revive, null);
    assert.equal(s.terminal, null);
    const json = JSON.stringify(snap);
    for (const secret of [SECRET_MAIL, SECRET_NAME, SECRET_PROMPT, "fake first message", "fake-model", "fake-proc", "projectHint"]) {
      assert.equal(json.includes(secret), false, `no ${secret} in the snapshot`);
    }

    // A new prompt is appended: the chat now works.
    const tf = join(root, "acct-fake", "org-fake", "local_wait", ".claude", "projects", "-fake-outputs", "11111111-aaaa-bbbb-cccc-000000000001.jsonl");
    appendFileSync(tf, user(Date.now() - 1000) + "\n");
    assert.equal(r.scan(), true);
    assert.equal(r.sessions().find((x) => x.id === "cowork_local_wait")!.status, "working");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cowork: code sessions get kind code in the snapshot", () => {
  const snap = buildSnapshot(
    [{ id: "local_d", title: "d", cwd: "/x/proj", status: "idle", lastActivityAt: T, completedTurns: 0, openUrl: null, cliSessionId: null, spawnedFromId: null, summary: null, needsAction: null, links: [], remoteSteered: false, createdAt: T, conversationIds: [], source: "desktop", terminal: null }],
    () => ({}),
    [],
    T,
  );
  assert.equal(snap.sessions[0].kind, "code");
  assert.equal(snap.sessions[0].project, "proj");
});

test("cowork: deck serves general chats, pins them and pushes when a starred one waits", async () => {
  const now = Date.now();
  const root = makeRoot([{ id: "app", cli: "22222222-aaaa-bbbb-cccc-000000000001", lastActivityAt: now - 2000, lines: [user(now - 2000)] }]);
  const tmp = mkdtempSync(join(tmpdir(), "deck-cowork-app-"));
  const dataDir = join(tmp, "data");
  const webDir = join(tmp, "web");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<!doctype html>");
  const token = loadToken(dataDir);
  const pushed: PushPayload[] = [];
  const deck = createDeck({
    dataDir, sessionsDir: join(tmp, "no-desktop"), webDir, port: 0, token, pollMs: 50, coworkDir: root,
    allowedHosts: loadAllowedHosts("deck.example.ts.net", dataDir),
    push: { publicKey: "K", async subscribe() {}, async send(p) { pushed.push(p); } },
  });
  try {
    await new Promise<void>((r) => deck.server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(deck.server.address() as AddressInfo).port}`;
    const auth = { Authorization: `Bearer ${token}` };
    const snap = (await (await fetch(base + "/api/snapshot", { headers: auth })).json()) as Snapshot;
    const s = snap.sessions.find((x) => x.id === "cowork_local_app")!;
    assert.equal(s.kind, "general");
    assert.equal(s.status, "working");
    assert.equal(JSON.stringify(snap).includes(SECRET_MAIL), false);

    const res = await fetch(base + "/api/sessions/cowork_local_app", {
      method: "PATCH",
      headers: { ...auth, Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { pinned: boolean }).pinned, true);

    // Claude answers: the starred general chat waits and sends one push.
    const tf = join(root, "acct-fake", "org-fake", "local_app", ".claude", "projects", "-fake-outputs", "22222222-aaaa-bbbb-cccc-000000000001.jsonl");
    appendFileSync(tf, assistant(Date.now(), "end_turn", "fake reply") + "\n");
    for (let i = 0; i < 60 && pushed.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].sessionId, "cowork_local_app");
    assert.equal(pushed[0].url, "/?session=cowork_local_app");
  } finally {
    await deck.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
