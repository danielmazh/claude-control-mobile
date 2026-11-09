// API contract v2.4 (docs/api.md, specs 0002 to 0005). Owned by lane A, read by lane B.

export type Status = "waiting" | "working" | "idle" | "archived";
export type Priority = "high" | "normal" | "low";
export type Source = "desktop" | "terminal" | "cowork";
/** v2.4 (spec 0005): "code" for desktop Code and terminal sessions, "general" for Cowork chats. */
export type Kind = "code" | "general";

export interface Label {
  id: string;
  name: string;
  color: string; // hex "#rrggbb"
}

export interface Session {
  id: string; // desktop sessionId (local_...), cli_<CLI session id> for a terminal session, cowork_<sessionId> for a Cowork chat
  title: string; // exactly as the Claude app shows it
  cwd: string;
  project: string; // user override, else detected subfolder of a workspace root, else last folder name of cwd
  status: Status;
  lastActivityAt: number; // epoch ms
  completedTurns: number;
  openUrl: string | null; // opens the session in the Claude app, null if none known
  // user layer
  pinned: boolean;
  priority: Priority;
  labelIds: string[];
  note: string;
  // v2 (spec 0002)
  parentId: string | null; // spawnedFrom.sessionId when that parent exists, else null (root)
  childIds: string[]; // direct children, newest activity first
  depth: number; // 0 for a root
  summary: string | null; // postTurnSummary.status_detail when fresh, else null
  needsAction: string | null; // postTurnSummary.needs_action when fresh and non-empty
  subagents: SubagentSummary;
  links: Link[]; // remote connections of this session
  remoteSteered: boolean; // the last turn came from a remote client
  // v2.1: restarts create a new session with the same conversation
  replacedBy: string | null; // newer session that continues this one; this one shows as disconnected
  replaces: string[]; // older sessions this one continues (oldest first)
  // v2.2 (spec 0003): terminal sessions that claude-control restores in tmux
  source: Source; // "terminal" only for a session that exists only in the CLI
  terminal: TerminalInfo | null; // set for a manifest session, also when merged into a desktop session
  // v2.3 (spec 0004): how POST /api/sessions/:id/revive works for this session
  revive: ReviveMode | null; // null: cannot be revived from the hub
  // v2.4 (spec 0005): general (non-code) chats, kept apart from code in the UI
  kind: Kind;
}

/** "restart": a manifest session, Claude Control restarts it by name. "resume": a desktop session with a known CLI conversation, Claude Control starts a terminal copy and adds it to auto-restore. */
export type ReviveMode = "restart" | "resume";

export interface TerminalInfo {
  tmuxTarget: string | null; // "session:windowIndex" of the tmux pane, null when none is known
  running: boolean; // a claude --resume <id> process runs
  attachCmd: string | null; // tmux attach command; when stopped and no window: the resume command; null when it runs outside tmux
  name: string; // v2.3: the manifest name (sessions.conf), used by Claude Control
}

export interface Subagent {
  id: string;
  type: string;
  description: string;
  finished: boolean;
  startedAt: number | null;
}

export interface SubagentSummary {
  running: number;
  done: number;
  items: Subagent[]; // newest first, at most 30
}

export interface Link {
  kind: "remote-control" | "bridge";
  remoteId: string; // session_... form
  url: string; // https://claude.ai/code/<remoteId>
}

export interface DeviceSession {
  sessionId: string;
  links: Link[];
  remoteSteered: boolean;
  lastActivityAt: number;
}

export interface Devices {
  sharedFolders: { path: string; serving: boolean }[]; // from remote-control-state.json
  sessions: DeviceSession[];
}

export interface Snapshot {
  sessions: Session[];
  labels: Label[];
  generatedAt: number;
}

export interface SessionPatch {
  pinned?: boolean;
  priority?: Priority;
  labelIds?: string[];
  note?: string;
  project?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
  url: string;
}

// ---------- v2.3 (spec 0004): Claude Control ----------

export type ControlActionName = "resume_missing" | "fix_all" | "restart_daemon";

export interface ControlStep {
  step: string; // e.g. "exit alpha", "resume alpha", "verify alpha"
  ok: boolean;
  detail: string;
}

/** The running or last background action of Claude Control (kept there for 5 minutes after it ends). */
export interface ControlAction {
  action: string; // fix_all | restart_session | resume_missing | restart_daemon
  name: string | null; // manifest name for restart_session
  done: boolean;
  ok: boolean | null; // null while running
  message: string | null; // Hebrew, set when done
  results: ControlStep[];
  startedAt: number | null; // epoch ms
  finishedAt: number | null; // epoch ms
}

export interface ControlStatus {
  reachable: boolean;
  overall: "ok" | "warn" | "bad" | null; // null when not reachable
  networkUp: boolean | null;
  daemon: { running: boolean; status: string } | null; // the Remote Control server
  sessions: { total: number; running: number }; // manifest sessions as Claude Control sees them
  issues: number;
  action: ControlAction | null;
}

/** Answer of the revive and action endpoints. */
export interface ControlResult {
  ok: boolean;
  started: boolean; // true: runs in the background, poll GET /api/control until action.done
  dry: boolean; // true: a plan only, nothing changed
  action: string; // restart_session | resume | resume_missing | fix_all | restart_daemon
  name: string | null; // manifest name (restart_session), or the name Claude Control gave a resumed session
  message: string; // Hebrew
  results: ControlStep[]; // the plan (dry), the steps (resume), or [] when started
}

export interface ReviveRequest {
  dry?: boolean;
}

export interface ControlActionRequest {
  action: ControlActionName;
  dry?: boolean;
}
