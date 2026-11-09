import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EMPTY_STATE,
  TAIL_BYTES,
  TerminalReader,
  cutText,
  foldText,
  mergeTerminal,
  parseManifest,
  parsePanes,
  parsePs,
  terminalInfo,
  terminalStatus,
  type TerminalSession,
} from "./terminal.ts";
import { toBaseSession } from "./sessions.ts";
import { buildSnapshot } from "./snapshot.ts";
import { STALE_WAITING_MS, STALE_WORKING_MS } from "./status.ts";

const FIX = resolve(import.meta.dirname, "..", "test", "fixtures", "terminal");
const HOME = "/tmp/fx/home";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";
const T0 = Date.parse("2026-01-01T11:00:00.000Z");

const psText = readFileSync(join(FIX, "ps.txt"), "utf8");
const tmuxText = readFileSync(join(FIX, "tmux.txt"), "utf8");
const fakeExec = async (cmd: string) => (cmd.endsWith("ps") ? psText : tmuxText);
const readT = (dir: string, id: string) => readFileSync(join(FIX, "projects", dir, `${id}.jsonl`), "utf8");

function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-term-"));
  cpSync(FIX, dir, { recursive: true });
  return dir;
}

test("manifest: comments, bad lines and repeated ids skipped; empty folder is home; trailing slash trimmed", () => {
  const m = parseManifest(readFileSync(join(FIX, "sessions.conf"), "utf8"), HOME);
  assert.deepEqual(
    m.map((e) => [e.name, e.id, e.dir]),
    [
      ["alpha", A, "/tmp/fx/term"],
      ["beta", B, "/tmp/fx/term"],
      ["gamma", C, "/tmp/fx/other.dir"],
      ["delta", D, HOME],
      ["missing", "eeeeeeee-0000-4000-8000-000000000005", "/tmp/fx/term"],
    ],
  );
  assert.deepEqual(parseManifest("", HOME), []);
  assert.deepEqual(parseManifest("x|bad id with spaces|/a\n", HOME), []);
});

test("transcript fold: title, remote id, last kind, summary; sidechain and meta lines ignored", () => {
  const a = foldText(EMPTY_STATE, readT("-tmp-fx-term", A));
  assert.equal(a.customTitle, "Fake alpha title");
  assert.equal(a.remoteId, "session_FAKEalpha01");
  assert.equal(a.last, "turn-end");
  assert.equal(a.lastAt, Date.parse("2026-01-01T10:00:12.000Z"));
  assert.equal(a.lastText, "Fake final answer with two lines.");
  assert.equal(a.cwd, "/tmp/fx/term");
  assert.equal(a.turns, 1);
  const b = foldText(EMPTY_STATE, readT("-tmp-fx-term", B));
  assert.equal(b.remoteId, "session_FAKEbeta02", "bridge_status url alone gives the link");
  assert.equal(b.last, "tool");
  assert.equal(b.lastText, "Fake step text");
  assert.equal(b.customTitle, null);
  const c = foldText(EMPTY_STATE, readT("-tmp-fx-elsewhere", C));
  assert.equal(c.last, "interrupt");
  assert.equal(c.lastText, null);
  // A partial last line is skipped, not fatal.
  assert.equal(foldText(a, '{"type":"user","timest').last, "turn-end");
  assert.equal(cutText("x".repeat(400)).length, 303);
});

test("status: working needs a running process and recent activity; waiting after end_turn; 3-day rule", () => {
  const a = foldText(EMPTY_STATE, readT("-tmp-fx-term", A));
  const b = foldText(EMPTY_STATE, readT("-tmp-fx-term", B));
  const c = foldText(EMPTY_STATE, readT("-tmp-fx-elsewhere", C));
  assert.equal(terminalStatus(a, true, T0), "waiting");
  assert.equal(terminalStatus(a, false, T0), "waiting", "a finished turn waits even when stopped");
  assert.equal(terminalStatus(a, true, a.lastAt! + STALE_WAITING_MS + 1), "idle");
  assert.equal(terminalStatus(b, true, b.lastAt! + 60_000), "working");
  assert.equal(terminalStatus(b, false, b.lastAt! + 60_000), "idle", "stopped process: idle");
  assert.equal(terminalStatus(b, true, b.lastAt! + STALE_WORKING_MS + 1), "idle", "stale turn: idle");
  assert.equal(terminalStatus(c, true, T0), "idle", "interrupted: idle");
  assert.equal(terminalStatus(EMPTY_STATE, true, T0), "idle");
});

test("processes and tmux: running in a pane, stopped with a window, stopped without one, running outside tmux", () => {
  const ps = parsePs(psText);
  assert.deepEqual([...ps.byId.keys()].sort(), [A, D], "grep lines are not claude processes");
  const panes = parsePanes(tmuxText);
  assert.equal(panes.length, 4);
  assert.equal(panes.find((p) => p.session === "work")!.name, "a|b", "a | inside a window name is kept");
  const entry = (name: string, id: string, dir = "/tmp/fx/term") => ({ name, id, dir });
  assert.deepEqual(terminalInfo(entry("alpha", A), ps, panes), {
    tmuxTarget: "rc-resume:1",
    running: true,
    attachCmd: "tmux attach -t rc-resume:1",
    name: "alpha",
  });
  assert.deepEqual(terminalInfo(entry("beta", B), ps, panes), {
    tmuxTarget: "rc-resume:2",
    running: false,
    attachCmd: "tmux attach -t rc-resume:2",
    name: "beta",
  });
  assert.deepEqual(terminalInfo(entry("gamma", C, "/tmp/fx/other dir"), ps, panes), {
    tmuxTarget: null,
    running: false,
    attachCmd: `cd '/tmp/fx/other dir' && claude --resume ${C}`,
    name: "gamma",
  });
  assert.deepEqual(terminalInfo(entry("delta", D), ps, panes), { tmuxTarget: null, running: true, attachCmd: null, name: "delta" });
  assert.deepEqual(terminalInfo(entry("alpha", A), parsePs(""), []), {
    tmuxTarget: null,
    running: false,
    attachCmd: `cd /tmp/fx/term && claude --resume ${A}`,
    name: "alpha",
  });
});

test("reader: manifest sessions with a transcript, searched folder, appends, tail of a big file", async () => {
  const dir = copy();
  try {
    const r = new TerminalReader({
      manifestFile: join(dir, "sessions.conf"),
      projectsDir: join(dir, "projects"),
      home: HOME,
      exec: fakeExec,
    });
    assert.equal(r.scan(T0), true);
    assert.equal(r.scan(T0), false, "nothing changed");
    assert.equal(await r.refreshProcs(), true);
    assert.equal(await r.refreshProcs(), false);
    const list = r.sessions(T0);
    const by = Object.fromEntries(list.map((s) => [s.id, s]));
    assert.deepEqual(Object.keys(by).sort(), [`cli_${A}`, `cli_${B}`, `cli_${C}`, `cli_${D}`], "missing transcript is skipped");
    const a = by[`cli_${A}`];
    assert.equal(a.title, "Fake alpha title");
    assert.equal(a.source, "terminal");
    assert.equal(a.status, "waiting");
    assert.equal(a.openUrl, "https://claude.ai/code/session_FAKEalpha01");
    assert.deepEqual(a.links, [{ kind: "remote-control", remoteId: "session_FAKEalpha01", url: "https://claude.ai/code/session_FAKEalpha01" }]);
    assert.equal(a.summary, "Fake final answer with two lines.");
    assert.equal(a.needsAction, null);
    assert.deepEqual(a.terminal, { tmuxTarget: "rc-resume:1", running: true, attachCmd: "tmux attach -t rc-resume:1", name: "alpha" });
    assert.equal(a.cliSessionId, A);
    const c = by[`cli_${C}`];
    assert.equal(c.title, "gamma", "no custom title: the manifest name");
    assert.equal(c.cwd, "/tmp/fx/elsewhere", "found in another project folder; cwd from the transcript");
    assert.equal(by[`cli_${B}`].status, "idle");
    assert.equal(by[`cli_${D}`].cwd, HOME);

    // An append is read without a full re-read: beta becomes waiting.
    const bf = join(dir, "projects", "-tmp-fx-term", `${B}.jsonl`);
    appendFileSync(
      bf,
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T09:00:09.000Z",
        message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Fake beta done" }] },
      }) + "\n" + '{"type":"user","timest',
    );
    assert.equal(r.scan(T0), true);
    let b = r.sessions(T0).find((s) => s.id === `cli_${B}`)!;
    assert.equal(b.status, "waiting");
    assert.equal(b.summary, "Fake beta done");
    // The partial line completes later.
    appendFileSync(bf, 'amp":"2026-01-01T09:00:10.000Z","message":{"role":"user","content":"Fake next"}}\n');
    r.scan(T0);
    b = r.sessions(T0).find((s) => s.id === `cli_${B}`)!;
    assert.equal(b.status, "idle", "a new prompt with no process is idle");

    // A big file: only the tail is read, and it still gives the right state.
    const big = join(dir, "projects", "-tmp-fx-term", `${A}.jsonl`);
    const filler = JSON.stringify({ type: "progress", data: "f".repeat(1000) }) + "\n";
    writeFileSync(big, filler.repeat(Math.ceil((TAIL_BYTES * 1.5) / filler.length)) + readT("-tmp-fx-term", A));
    r.scan(T0);
    const a2 = r.sessions(T0).find((s) => s.id === `cli_${A}`)!;
    assert.equal(a2.title, "Fake alpha title");
    assert.equal(a2.status, "waiting");

    // Removed from the manifest: gone.
    writeFileSync(join(dir, "sessions.conf"), `alpha|${A}|/tmp/fx/term\n`);
    assert.equal(r.scan(T0), true);
    assert.deepEqual(r.sessions(T0).map((s) => s.id), [`cli_${A}`]);
    r.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge: a manifest session that is a desktop conversation is not duplicated", async () => {
  const dir = copy();
  try {
    const r = new TerminalReader({ manifestFile: join(dir, "sessions.conf"), projectsDir: join(dir, "projects"), home: HOME, exec: fakeExec });
    r.scan(T0);
    await r.refreshProcs();
    const term: TerminalSession[] = r.sessions(T0);
    const desk = toBaseSession(
      {
        file: "x",
        mtimeMs: T0,
        size: 1,
        raw: { sessionId: "local_fake_d", title: "Desktop delta", cwd: "/tmp/fx/home", cliSessionId: "other", priorCliSessionIds: [D], lastActivityAt: T0 },
      },
      T0,
    );
    const merged = mergeTerminal([desk], term);
    assert.equal(merged.length, 4);
    const d = merged.find((s) => s.id === "local_fake_d")!;
    assert.equal(d.source, "desktop");
    assert.equal(d.title, "Desktop delta");
    assert.deepEqual(d.terminal, { tmuxTarget: null, running: true, attachCmd: null, name: "delta" });
    assert.equal(merged.some((s) => s.id === `cli_${D}`), false);
    const snap = buildSnapshot(merged, () => ({}), [], T0);
    const a = snap.sessions.find((s) => s.id === `cli_${A}`)!;
    assert.equal(a.source, "terminal");
    assert.equal(a.parentId, null);
    assert.equal("terminalSessionId" in a, false);
    assert.equal("cliSessionId" in a, false);
    assert.equal(snap.sessions.find((s) => s.id === "local_fake_d")!.terminal?.running, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app: terminal sessions in the snapshot, and the user layer works on a cli_ id", async () => {
  const dir = copy();
  const { createDeck, loadAllowedHosts } = await import("./app.ts");
  const { loadToken } = await import("./auth.ts");
  const dataDir = join(dir, "data");
  const token = loadToken(dataDir);
  // Fresh timestamps so the alpha session is waiting, not stale.
  const af = join(dir, "projects", "-tmp-fx-term", `${A}.jsonl`);
  const stamp = new Date().toISOString();
  writeFileSync(af, readFileSync(af, "utf8").replace(/2026-01-01T1\d:\d\d:\d\d\.\d{3}Z/g, stamp));
  const deck = createDeck({
    dataDir, sessionsDir: join(dir, "no-sessions"), webDir: join(dir, "web"), port: 0, token, push: null,
    allowedHosts: loadAllowedHosts("", dataDir), projectsDir: join(dir, "projects"),
    rcManifest: join(dir, "sessions.conf"), terminalExec: fakeExec,
  });
  try {
    await new Promise<void>((r) => deck.server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(deck.server.address() as { port: number }).port}`;
    await new Promise((r) => setTimeout(r, 50)); // first ps/tmux poll
    const ids = deck.snapshot().sessions.filter((s) => s.source === "terminal").map((s) => s.id).sort();
    assert.equal(ids.length, 4);
    const res = await fetch(`${base}/api/sessions/cli_${A}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.pinned, true);
    assert.equal(s.status, "waiting");
    assert.equal(s.terminal.running, true);
  } finally {
    await deck.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
