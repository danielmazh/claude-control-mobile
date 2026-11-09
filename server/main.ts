// Claude Control Mobile server. Run: node --experimental-strip-types server/main.ts
// Env: DECK_PORT (7810), DECK_DATA_DIR (./data), DECK_ALLOWED_HOSTS (comma list),
// DECK_SESSIONS_DIR (default: the Claude desktop session folder, read only),
// DECK_PROJECTS_DIR (default: ~/.claude/projects, transcripts, read only),
// DECK_WORKSPACE_ROOTS (comma list of folders whose subfolders are the projects),
// DECK_REMOTE_STATE (default: the Claude remote-control-state.json, read only),
// DECK_RC_MANIFEST (default: ~/.config/claude-rc/sessions.conf, claude-control terminal sessions, read only),
// DECK_CONTROL_URL (default: http://127.0.0.1:7799, Claude Control, used to revive sessions, spec 0004),
// DECK_COWORK_DIR (default: the Claude Cowork session folder, general chats, read only, spec 0005).

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadToken } from "./auth.ts";
import { createPush } from "./push.ts";
import { createDeck, loadAllowedHosts, type PushLike } from "./app.ts";
import { parseRoots } from "./projects.ts";
import { DEFAULT_CONTROL_URL } from "./control.ts";

const port = Number(process.env.DECK_PORT ?? 7810);
const dataDir = resolve(process.env.DECK_DATA_DIR ?? "./data");
const sessionsDir =
  process.env.DECK_SESSIONS_DIR ?? join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
const projectsDir = process.env.DECK_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
const workspaceRoots = parseRoots(process.env.DECK_WORKSPACE_ROOTS);
const remoteStateFile =
  process.env.DECK_REMOTE_STATE ?? join(homedir(), "Library", "Application Support", "Claude", "remote-control-state.json");
const rcManifest = process.env.DECK_RC_MANIFEST ?? join(homedir(), ".config", "claude-rc", "sessions.conf");
const controlUrl = process.env.DECK_CONTROL_URL || DEFAULT_CONTROL_URL;
const coworkDir =
  process.env.DECK_COWORK_DIR ?? join(homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions");
const webDir = resolve(import.meta.dirname, "..", "web", "dist");
const allowedHosts = loadAllowedHosts(process.env.DECK_ALLOWED_HOSTS, dataDir);

const token = loadToken(dataDir);
let push: PushLike | null = null;
try {
  push = await createPush(dataDir);
} catch (err) {
  console.error("push disabled:", (err as Error).message);
}

const deck = createDeck({ dataDir, sessionsDir, webDir, port, allowedHosts, token, push, projectsDir, workspaceRoots, remoteStateFile, rcManifest, controlUrl, coworkDir });
deck.server.listen(port, "127.0.0.1", () => {
  console.log(`Claude Control Mobile on http://127.0.0.1:${port} (${deck.snapshot().sessions.length} sessions)`);
  console.log(`allowed hosts: ${allowedHosts.join(", ")}`);
});

const shutdown = () => {
  deck.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
