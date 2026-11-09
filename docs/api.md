# API contract v2.4 (specs 0002 to 0005, extends v1)

The server and the web UI are built in parallel against this file. Change it only with the orchestrator.
Shared types live in `shared/types.ts` (owned by lane A, read by lane B).

## Auth
- Every `/api/*` request needs header `Authorization: Bearer <token>` or cookie `deck_token=<token>`.
- `GET /login?token=<token>` sets the cookie (HttpOnly, SameSite=Strict, 1 year) and redirects to `/`.
- Every non-GET request: `Origin` must equal the server's own origin, and `Host` must be in the allow list. Else 403.

## Language (spec 0006)
- Every `/api/*` request may carry `?lang=en|he`. Without it the server reads `Accept-Language`; with neither it answers in English.
- Error messages from the server, the Claude Control calls, and the fall push use that language. A fall push has no request, so it uses the last `lang` query param the server saw (English after a restart until the phone asks again).
- The web UI always sends `lang` (its own setting), also on `/api/events`.

## Types
```ts
type Status = "waiting" | "working" | "idle" | "archived";
type Priority = "high" | "normal" | "low";
type Source = "desktop" | "terminal" | "cowork";
type Kind = "code" | "general";   // v2.4

interface Label { id: string; name: string; color: string }   // color = hex "#rrggbb"

interface Session {
  id: string;              // desktop sessionId (local_...), cli_<CLI session id> for a terminal session, cowork_<sessionId> for a Cowork chat
  title: string;           // exactly as the Claude app shows it
  cwd: string;
  project: string;         // group name: user override, else detected subfolder when cwd is a workspace root, else last folder name of cwd
  status: Status;
  lastActivityAt: number;  // epoch ms
  completedTurns: number;
  openUrl: string | null;  // link that opens the session in the Claude app, null if none known
  // user layer
  pinned: boolean;         // "selected": shown in the default view
  priority: Priority;
  labelIds: string[];
  note: string;
  // v2 (spec 0002)
  parentId: string | null;    // spawnedFrom.sessionId when that parent exists, else null (root)
  childIds: string[];         // direct children, newest activity first
  depth: number;              // 0 for a root
  summary: string | null;     // postTurnSummary.status_detail when fresh, else null
  needsAction: string | null; // postTurnSummary.needs_action when fresh and non-empty
  subagents: { running: number; done: number; items: Subagent[] };
  links: Link[];              // remote connections of this session
  remoteSteered: boolean;     // the last turn came from a remote client
  // v2.1: restarts (claude-control rc-resume, app restore) create a new session with the same conversation
  replacedBy: string | null;  // newer session that continues this one; this one shows as disconnected
  replaces: string[];         // older sessions this one continues (oldest first)
  // v2.2 (spec 0003): terminal sessions that claude-control restores in tmux
  source: Source;             // "terminal" only for a session that exists only in the CLI
  terminal: TerminalInfo | null; // set for a manifest session, also when merged into a desktop session
  // v2.3 (spec 0004)
  revive: "restart" | "resume" | null; // how POST /api/sessions/:id/revive works; null = cannot revive
  // v2.4 (spec 0005)
  kind: Kind;                 // "code": desktop and terminal; "general": Cowork chats. The UI keeps them apart
}

interface TerminalInfo {
  tmuxTarget: string | null;  // "session:windowIndex", null when no tmux pane is known
  running: boolean;           // a `claude --resume <id>` process runs
  attachCmd: string | null;   // `tmux attach -t <target>`; stopped with no window: the resume command; runs outside tmux: null
  name: string;               // v2.3: manifest name (sessions.conf), Claude Control uses it
}

// v2.3 (spec 0004)
interface ControlStep { step: string; ok: boolean; detail: string }
interface ControlAction {
  action: string;             // fix_all | restart_session | resume_missing | restart_daemon
  name: string | null;        // manifest name for restart_session
  done: boolean; ok: boolean | null; message: string | null;   // message in Hebrew, set when done
  results: ControlStep[]; startedAt: number | null; finishedAt: number | null;   // epoch ms
}
interface ControlStatus {
  reachable: boolean;
  overall: "ok" | "warn" | "bad" | null;
  networkUp: boolean | null;
  daemon: { running: boolean; status: string } | null;   // the Remote Control server
  sessions: { total: number; running: number };          // manifest sessions as Claude Control sees them
  issues: number;
  action: ControlAction | null;   // running or last action (Claude Control keeps it 5 minutes)
}
interface ControlResult {
  ok: boolean;
  started: boolean;   // runs in the background: poll GET /api/control until action.done
  dry: boolean;       // a plan only, nothing changed
  action: string;     // restart_session | resume | resume_missing | fix_all | restart_daemon
  name: string | null;
  message: string;    // Hebrew
  results: ControlStep[];
}

interface Subagent { id: string; type: string; description: string; finished: boolean; startedAt: number | null }

interface Link {
  kind: "remote-control" | "bridge";
  remoteId: string;           // session_... form
  url: string;                // https://claude.ai/code/<remoteId>
}

interface Devices {
  sharedFolders: { path: string; serving: boolean }[];   // from remote-control-state.json
  sessions: { sessionId: string; links: Link[]; remoteSteered: boolean; lastActivityAt: number }[];
}

interface Snapshot { sessions: Session[]; labels: Label[]; generatedAt: number }
```

## Endpoints
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/snapshot` | - | `Snapshot` (all sessions, UI filters) |
| GET | `/api/devices` | - | `Devices` |
| GET | `/api/events` | - | SSE stream. Event `snapshot` with full `Snapshot` on every change, `ping` every 25s |
| PATCH | `/api/sessions/:id` | `Partial<{pinned, priority, labelIds, note, project}>` | updated `Session` |
| POST | `/api/labels` | `{name, color}` | `Label` |
| PATCH | `/api/labels/:id` | `Partial<{name, color}>` | `Label` |
| DELETE | `/api/labels/:id` | - | `204` (also removed from sessions) |
| GET | `/api/push/key` | - | `{publicKey}` (VAPID) |
| POST | `/api/push/subscribe` | browser `PushSubscription` JSON | `204` |
| POST | `/api/push/test` | - | `204` (sends a test push) |
| GET | `/api/control` | - | `ControlStatus` (v2.3). Claude Control down: `200` with `reachable: false` |
| POST | `/api/sessions/:id/revive` | `{dry?: boolean}` | `ControlResult` (v2.3) |
| POST | `/api/control/action` | `{action: "resume_missing" \| "fix_all" \| "restart_daemon", dry?: boolean}` | `ControlResult` (v2.3) |

Errors: `{error: string}` with 400 / 401 / 403 / 404, and for the v2.3 endpoints 409 (Claude Control refused) and 503 (`{error: "Claude Control לא רץ"}`).

## Restarts (v2.1)
When a session is replaced, the user layer (pinned, priority, labels, note, project override) moves to the newest session in the chain, so nothing is lost. The old session stays in the snapshot with `replacedBy` set. Its children follow the newest parent.

## Terminal sessions (v2.2, spec 0003)
Source: the claude-control manifest `~/.config/claude-rc/sessions.conf` (`name|session-id|folder`), read only. A manifest line shows only when its transcript `~/.claude/projects/<encoded cwd>/<id>.jsonl` exists (searched in every project folder when it is not under the manifest folder).
- `title`: the last `custom-title` in the transcript, else the manifest name.
- `status`: `working` when the last entry is a prompt, tool result or unfinished assistant step, the process runs and the entry is under 1 hour old. `waiting` when the last assistant turn ended (`end_turn`) and nothing newer; older than 3 days it is `idle`. Else `idle`.
- `summary`: the last assistant text, one line, up to 300 chars. `needsAction` is always null.
- `openUrl` and `links`: the Remote Control session from the transcript (`bridge-session` id, `cse_` becomes `session_`, or the `bridge_status` url). Null when none.
- `completedTurns`: turn ends seen in the read part of the transcript (the last 2 MB and later appends), not the whole history.
- Running and tmux: `ps` and `tmux list-panes` every 20s. The transcript is checked every 5s; only the last 2 MB and then the appended bytes are read.
- A manifest id that is a desktop session's conversation (`cliSessionId` or `priorCliSessionIds`) is not added again: that desktop session gets `terminal` and keeps `source: "desktop"`.
- PATCH works on `cli_` ids like any session.

## Revive through Claude Control (v2.3, spec 0004)
[Claude Control](https://github.com/danielmazh/claude-control) (`http://127.0.0.1:7799`, no auth, localhost only) does the work. Only the hub server calls it (env `DECK_CONTROL_URL`, timeout 10s, 120s for a real resume because it runs inline). The phone never talks to it. Every call sends the `lang` of the phone request (see Language).
- `revive` on a session with `terminal` (manifest): `POST /api/rc/action {action: "restart_session", name: terminal.name}`. Running: Claude Control sends `/exit`, waits up to 25s, starts it again and checks it runs. Stopped: it skips the exit. It refuses to stop a session with background work (a failed step with `needs_user`). Runs in the background: `started: true`.
- `revive` on a desktop session with a CLI conversation uuid and no `terminal`: `POST /api/sessions/resume {uuid, name: title}`. Claude Control adds it to the manifest (auto-restore) and starts a terminal copy in tmux with Remote Control. The desktop session itself does not change. Runs inline: the steps come back in `results`.
- Any other session: 400. Unknown id: 404.
- `/api/control/action`: the same `POST /api/rc/action` without a name. Claude Control runs one action at a time.
- `dry: true` returns the plan and changes nothing. Not logged.
- Refused before any step (bad name, another action runs): 409 with Claude Control's message.
- Every non-dry call is logged (`control: start|ok|fail <action> name=<manifest name>`, then `control: done ... result=ok|failed`), no content. The hub follows a background action every 2s (at most 5 minutes), then polls ps and tmux again so the snapshot updates fast.

## General chats (v2.4, spec 0005)
Source: Cowork sessions `~/Library/Application Support/Claude/local-agent-mode-sessions/<account>/<org>/local_<id>.json` (env `DECK_COWORK_DIR`), read only. The folder `skills-plugin` is skipped. Regular claude.ai chats are not on the Mac (server side only), so they are out of scope.
- `id`: `cowork_<sessionId>`. `source: "cowork"`, `kind: "general"`. Desktop and terminal sessions have `kind: "code"`.
- Only `sessionId`, `title`, `cliSessionId`, `createdAt`, `lastActivityAt`, `isArchived`, `userSelectedFolders` are read. Private fields (`emailAddress`, `accountName`, `systemPrompt` and the rest) never reach the API or a log.
- Transcript: `local_<id>/.claude/projects/<dir>/<cliSessionId>.jsonl` inside the session folder. Last 2 MB, then appends.
- `status`: `archived` from `isArchived`. `working` when the last entry is a prompt, tool result or unfinished assistant step and the transcript moved less than 10 minutes ago (no process to check). `waiting` when the last assistant turn ended (`end_turn`); older than 3 days it is `idle`. Else `idle` (also `interruptedByShutdown`).
- `summary`: the last assistant text, one line, up to 300 chars. `needsAction` null. `completedTurns`: finished assistant turns in the read part.
- `openUrl` null and `links` empty: Cowork files and transcripts hold no remote id.
- `cwd`: the first `userSelectedFolders` entry, else `""`. `project`: user override, else that folder's name, else `"Cowork"`.
- `revive` null, `terminal` null, no sub-agents, never part of a restart chain.
- Watched like the desktop folder (fs.watch plus a 3s poll). Push and PATCH work the same (push only for a starred chat that turns `waiting`).

## Push
A child session that waits sends a push titled `<parent title> › <child title>`. A waiting child also counts as waiting for its parent in the UI (not in `status`).

Fall (v2.3): a session with `terminal` that was seen running and is not running on 2 process polls in a row (20s apart, so a restart does not count) sends one push: title `נפל: <title>`, body `לחץ כדי להחיות`, url `/?session=<id>`. Several in the same poll: one push `נפלו <n> סשנים`, url `/`. No push on server start (a session must be seen running first), at most one per session per 2 minutes. While a hub action runs, and 60s after it, the push waits and goes out after that if the session is still down.

Sent when a pinned session changes to `waiting`. A `waiting` session with `lastActivityAt` older than 3 days shows as `idle`, and that change never sends a push. Payload: `{title, body, sessionId, url}`. Body = project name. Tap opens `openUrl` or the deck.

## Files
- Env `DECK_RC_MANIFEST` overrides the manifest path.
- Env `DECK_CONTROL_URL` overrides the Claude Control URL (default `http://127.0.0.1:7799`).
- Env `DECK_COWORK_DIR` overrides the Cowork session folder (v2.4).
- `data/state.json` - user layer (pins, priority, labels, notes, project overrides). Atomic write.
- `data/push.json` - VAPID keys + subscriptions.
- `data/token` - auth token (generated on first run, mode 600).
- Static UI served from `web/dist/`.
