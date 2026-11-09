import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { parseSharedFolders, SharedFolderReader } from "./devices.ts";
import { loadToken } from "./auth.ts";
import { createDeck, loadAllowedHosts, type Deck } from "./app.ts";

const FIXROOT = resolve(import.meta.dirname, "..", "test", "fixtures");
const STATE = join(FIXROOT, "remote-control-state.json");

test("shared folders: paths and serving only, secrets never returned", () => {
  const text = readFileSync(STATE, "utf8");
  const out = parseSharedFolders(text);
  assert.deepEqual(out, [
    { path: "/tmp/fx/both", serving: true },
    { path: "/tmp/fx/idle", serving: false },
    { path: "/tmp/fx/shared", serving: true },
  ]);
  const json = JSON.stringify(out);
  for (const bad of ["FAKE-SALT", "FAKEKEY", "env_FAKE", "ident-"]) assert.ok(!json.includes(bad), bad);
  assert.deepEqual(parseSharedFolders("{bad"), []);
  assert.deepEqual(new SharedFolderReader("/no/such/file").folders(), []);
  assert.deepEqual(new SharedFolderReader(undefined).folders(), []);
});

let root: string;
let deck: Deck;
let base: string;
let token: string;
let dataDir: string;

before(async () => {
  root = mkdtempSync(join(tmpdir(), "deck-dev-"));
  const sessionsDir = join(root, "sessions");
  dataDir = join(root, "data");
  cpSync(join(FIXROOT, "tree"), sessionsDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  // The user layer sits on the oldest session of the restart chain.
  writeFileSync(join(dataDir, "state.json"), JSON.stringify({
    version: 1,
    labels: [{ id: "lbl_a", name: "A", color: "#ff0000" }, { id: "lbl_b", name: "B", color: "#00ff00" }],
    sessions: {
      "local_t-r1": { pinned: true, priority: "high", labelIds: ["lbl_a"], note: "keep me", project: "Mine" },
      "local_t-r3": { labelIds: ["lbl_b"] },
    },
  }));
  token = loadToken(dataDir);
  deck = createDeck({
    dataDir, sessionsDir, webDir: join(root, "web"), port: 0, token, pollMs: 100, push: null,
    allowedHosts: loadAllowedHosts("", dataDir), remoteStateFile: STATE,
    projectsDir: join(FIXROOT, "projects"),
  });
  await new Promise<void>((r) => deck.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(deck.server.address() as AddressInfo).port}`;
});

after(async () => {
  await deck.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

test("GET /api/devices: linked or remote sessions, folders, no secrets", async () => {
  const res = await get("/api/devices");
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const bad of ["FAKE-SALT", "FAKEKEY", "env_FAKE", "ident-"]) assert.ok(!text.includes(bad), bad);
  const d = JSON.parse(text);
  assert.equal(d.sharedFolders.length, 3);
  assert.deepEqual(d.sessions.map((s: { sessionId: string }) => s.sessionId), ["local_t-root"]);
  assert.equal(d.sessions[0].links.length, 2);
  assert.equal(d.sessions[0].remoteSteered, true);
  assert.equal((await fetch(base + "/api/devices")).status, 401);
});

test("user layer moves from the old session to the newest and is saved", async () => {
  const snap = await (await get("/api/snapshot")).json();
  const by = Object.fromEntries(snap.sessions.map((s: { id: string }) => [s.id, s]));
  const r3 = by["local_t-r3"];
  assert.equal(r3.pinned, true);
  assert.equal(r3.priority, "high");
  assert.deepEqual(r3.labelIds.sort(), ["lbl_a", "lbl_b"]);
  assert.equal(r3.note, "keep me");
  assert.equal(r3.project, "Mine");
  assert.equal(by["local_t-r1"].pinned, false);
  assert.equal(by["local_t-r1"].replacedBy, "local_t-r3");
  const saved = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
  assert.equal(saved.sessions["local_t-r1"], undefined);
  assert.equal(saved.sessions["local_t-r3"].note, "keep me");
});

test("snapshot carries sub-agents once the background pass ran", async () => {
  for (let i = 0; i < 50; i++) {
    const snap = await (await get("/api/snapshot")).json();
    const s = snap.sessions.find((x: { id: string }) => x.id === "local_t-root");
    if (s.subagents.items.length) {
      assert.equal(s.subagents.running + s.subagents.done, 3);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("sub-agents never arrived");
});
