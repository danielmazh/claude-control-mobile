import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addLine, encodeProjectDir, HALF_LIFE_LINES, newFileState, parseRoots, pickTop,
  ProjectDetector, segmentsIn, updateFile,
} from "./projects.ts";

const tool = (input: unknown, cwd = "/w") =>
  JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "tool_use", name: "X", input }] } }) + "\n";

function workspace(): { dir: string; root: string; projects: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "deck-proj-"));
  const root = join(dir, "ws.root");
  for (const p of ["alpha", "beta", "gamma"]) mkdirSync(join(root, p, ".git"), { recursive: true });
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, "notes.md"), "x");
  const projects = join(dir, "projects");
  mkdirSync(join(projects, encodeProjectDir(root)), { recursive: true });
  return { dir, root, projects, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("encodeProjectDir turns / and . into -", () => {
  assert.equal(encodeProjectDir("/Users/a.b/c-projects"), "-Users-a-b-c-projects");
});

test("parseRoots trims and drops empty entries", () => {
  assert.deepEqual(parseRoots(" /a/b/ , ,/c"), ["/a/b", "/c"]);
  assert.deepEqual(parseRoots(undefined), []);
});

test("segmentsIn finds first-level folders and skips hidden ones", () => {
  const text = 'cd /w/alpha && cat "/w/beta/x.ts" /w/.claude/a /w-other/zzz /w/gamma';
  assert.deepEqual(segmentsIn(text, "/w/"), ["alpha", "beta", "gamma"]);
});

test("addLine counts tool inputs and cwd, not tool results", () => {
  const st = newFileState();
  addLine(st, tool({ file_path: "/w/alpha/a.ts" }).trim(), "/w/");
  addLine(st, tool({ command: "ls /w/beta" }, "/w/beta").trim(), "/w/");
  const result = { type: "user", message: { content: [{ type: "tool_result", content: "/w/gamma/a /w/gamma/b" }] } };
  addLine(st, JSON.stringify(result), "/w/");
  addLine(st, "not json /w/gamma", "/w/");
  assert.deepEqual([...st.counts.keys()].sort(), ["alpha", "beta"]);
  assert.equal(st.lineNo, 4);
});

test("recent lines weigh more", () => {
  const st = newFileState();
  for (let i = 0; i < 3; i++) addLine(st, tool({ path: "/w/alpha" }).trim(), "/w/");
  for (let i = 0; i < 2 * HALF_LIFE_LINES; i++) addLine(st, "{}", "/w/");
  addLine(st, tool({ path: "/w/beta" }).trim(), "/w/");
  assert.equal(pickTop(st.counts, () => false), "beta");
});

test("pickTop skips plain files", () => {
  const m = new Map([["notes.md", 9], ["alpha", 2]]);
  assert.equal(pickTop(m, (n) => n === "notes.md"), "alpha");
  assert.equal(pickTop(new Map(), () => false), undefined);
});

test("updateFile reads only appended bytes and resets when the file shrinks", async () => {
  const w = workspace();
  try {
    const file = join(w.dir, "t.jsonl");
    const p = w.root + "/";
    writeFileSync(file, tool({ path: p + "alpha/x" }) + tool({ path: p + "alpha/y" }).slice(0, 20));
    const st = newFileState();
    assert.equal(await updateFile(file, st, p), true);
    assert.equal(st.lineNo, 1, "the partial line waits");
    assert.equal(await updateFile(file, st, p), false, "no change, no read");
    appendFileSync(file, tool({ path: p + "alpha/y" }).slice(20) + tool({ path: p + "beta/z" }));
    await updateFile(file, st, p);
    assert.equal(st.lineNo, 3);
    assert.equal(Math.round(st.counts.get("alpha") ?? 0) >= 2, true);
    writeFileSync(file, tool({ path: p + "gamma/q" }));
    await updateFile(file, st, p);
    assert.deepEqual([...st.counts.keys()], ["gamma"]);
  } finally {
    w.cleanup();
  }
});

test("detector: workspace root gets the top subfolder, in the background", async () => {
  const w = workspace();
  try {
    const file = join(w.projects, encodeProjectDir(w.root), "cli-1.jsonl");
    const p = w.root + "/";
    writeFileSync(file, tool({ file_path: p + "beta/a" }, w.root) + tool({ command: `cat ${p}.claude/x ${p}notes.md ${p}notes.md ${p}notes.md` }, w.root));
    let changes = 0;
    const d = new ProjectDetector({ projectsDir: w.projects, onChange: () => changes++ });
    assert.equal(d.project(w.root, "cli-1"), undefined, "unknown at first: caller uses the old rule");
    await d.flush();
    assert.equal(d.project(w.root, "cli-1"), "beta");
    assert.equal(changes, 1);
    appendFileSync(file, tool({ path: p + "gamma/a" }, w.root) + tool({ path: p + "gamma/b" }, w.root));
    d.project(w.root, "cli-1");
    await d.flush();
    assert.equal(d.project(w.root + "/", "cli-1"), "gamma");
    assert.equal(d.project(w.root, null), undefined);
    assert.equal(d.project(w.root, "../evil"), undefined);
  } finally {
    w.cleanup();
  }
});

test("detector: a git repo or a folder with few git subfolders is not a root, env roots are", async () => {
  const w = workspace();
  try {
    const repo = join(w.root, "alpha");
    mkdirSync(join(w.projects, encodeProjectDir(repo)), { recursive: true });
    writeFileSync(join(w.projects, encodeProjectDir(repo), "c2.jsonl"), tool({ path: repo + "/src/a" }, repo));
    const plain = join(w.dir, "plain");
    mkdirSync(join(plain, "one", ".git"), { recursive: true });
    mkdirSync(join(plain, "two"));
    mkdirSync(join(w.projects, encodeProjectDir(plain)), { recursive: true });
    writeFileSync(join(w.projects, encodeProjectDir(plain), "c3.jsonl"), tool({ path: plain + "/two/a" }, plain));

    const d = new ProjectDetector({ projectsDir: w.projects });
    d.project(repo, "c2");
    d.project(plain, "c3");
    await d.flush();
    assert.equal(d.project(repo, "c2"), undefined);
    assert.equal(d.project(plain, "c3"), undefined);

    const d2 = new ProjectDetector({ projectsDir: w.projects, roots: [plain + "/"] });
    d2.project(plain, "c3");
    await d2.flush();
    assert.equal(d2.project(plain, "c3"), "two");
  } finally {
    w.cleanup();
  }
});

test("detector: missing transcript gives no result", async () => {
  const w = workspace();
  try {
    const d = new ProjectDetector({ projectsDir: w.projects });
    d.project(w.root, "nope");
    await d.flush();
    assert.equal(d.project(w.root, "nope"), undefined);
  } finally {
    w.cleanup();
  }
});

test("mergeSession: override wins, then detected, then cwd name; cliSessionId stays private", async () => {
  const { mergeSession } = await import("./snapshot.ts");
  const base = { id: "local_1", title: "t", cwd: "/w/root", status: "idle" as const, lastActivityAt: 1, completedTurns: 0, openUrl: null, cliSessionId: "c",
    spawnedFromId: null, summary: null, needsAction: null, links: [], remoteSteered: false, createdAt: 1, conversationIds: ["c"], source: "desktop" as const, terminal: null };
  assert.equal(mergeSession(base, {}).project, "root");
  assert.equal(mergeSession(base, {}, "alpha").project, "alpha");
  assert.equal(mergeSession(base, { project: "Mine" }, "alpha").project, "Mine");
  for (const k of ["cliSessionId", "spawnedFromId", "createdAt", "conversationIds"]) assert.equal(k in mergeSession(base, {}), false, k);
});
