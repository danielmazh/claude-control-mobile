// User layer: pins, priority, labels, notes, project overrides.
// Saved in <dataDir>/state.json with an atomic write (temp file + rename).

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Label, Priority, SessionPatch } from "../shared/types.ts";

export interface UserSession {
  pinned?: boolean;
  priority?: Priority;
  labelIds?: string[];
  note?: string;
  project?: string; // override; missing means "use the cwd folder name"
}

export interface UserState {
  version: 1;
  sessions: Record<string, UserSession>;
  labels: Label[];
}

export class ValidationError extends Error {}

const PRIORITIES: readonly Priority[] = ["high", "normal", "low"];
const COLOR = /^#[0-9a-fA-F]{6}$/;
export const LIMITS = { note: 2000, project: 100, labelName: 40, labels: 200, labelIds: 50 };

export function emptyState(): UserState {
  return { version: 1, sessions: {}, labels: [] };
}

/** Write JSON atomically: a crash leaves the old file or the new one, never half. */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export class UserStore {
  readonly file: string;
  private state: UserState;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, "state.json");
    this.state = this.load();
  }

  private load(): UserState {
    if (!existsSync(this.file)) return emptyState();
    try {
      return normalize(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      // Keep the broken file for the operator, start clean.
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return emptyState();
    }
  }

  private save(): void {
    writeJsonAtomic(this.file, this.state);
  }

  get labels(): Label[] {
    return this.state.labels;
  }

  session(id: string): UserSession {
    return this.state.sessions[id] ?? {};
  }

  /** Validate and apply a PATCH body. Throws ValidationError on bad input. */
  patchSession(id: string, body: unknown): UserSession {
    const patch = validateSessionPatch(body, new Set(this.state.labels.map((l) => l.id)));
    const cur: UserSession = { ...this.session(id) };
    if (patch.pinned !== undefined) cur.pinned = patch.pinned;
    if (patch.priority !== undefined) cur.priority = patch.priority;
    if (patch.labelIds !== undefined) cur.labelIds = patch.labelIds;
    if (patch.note !== undefined) cur.note = patch.note;
    if (patch.project !== undefined) {
      if (patch.project === "") delete cur.project;
      else cur.project = patch.project;
    }
    this.state.sessions[id] = cur;
    this.save();
    return cur;
  }

  /**
   * Move the user layer of a restarted session to its newest session and save.
   * Values already set on the new session win; pinned is kept when either has it;
   * labels are joined. Returns false when there was nothing to move.
   */
  moveSession(from: string, to: string): boolean {
    const old = this.state.sessions[from];
    if (!old || from === to) return false;
    const cur: UserSession = { ...(this.state.sessions[to] ?? {}) };
    if (old.pinned || cur.pinned) cur.pinned = true;
    else if (old.pinned === false && cur.pinned === undefined) cur.pinned = false;
    if ((cur.priority === undefined || cur.priority === "normal") && old.priority) cur.priority = old.priority;
    if (old.labelIds?.length) cur.labelIds = [...new Set([...(cur.labelIds ?? []), ...old.labelIds])].slice(0, LIMITS.labelIds);
    if (!cur.note && old.note) cur.note = old.note;
    if (!cur.project && old.project) cur.project = old.project;
    this.state.sessions[to] = cur;
    delete this.state.sessions[from];
    this.save();
    return true;
  }

  createLabel(body: unknown): Label {
    const b = asObject(body, ["name", "color"]);
    if (this.state.labels.length >= LIMITS.labels) throw new ValidationError("too many labels");
    const label: Label = {
      id: `lbl_${randomBytes(6).toString("hex")}`,
      name: checkName(b.name),
      color: checkColor(b.color),
    };
    this.state.labels.push(label);
    this.save();
    return label;
  }

  /** Returns undefined when the label does not exist. */
  patchLabel(id: string, body: unknown): Label | undefined {
    const label = this.state.labels.find((l) => l.id === id);
    if (!label) return undefined;
    const b = asObject(body, ["name", "color"]);
    const name = b.name === undefined ? label.name : checkName(b.name);
    const color = b.color === undefined ? label.color : checkColor(b.color);
    label.name = name;
    label.color = color;
    this.save();
    return label;
  }

  /** Delete a label and remove it from every session. False when not found. */
  deleteLabel(id: string): boolean {
    const before = this.state.labels.length;
    this.state.labels = this.state.labels.filter((l) => l.id !== id);
    if (this.state.labels.length === before) return false;
    for (const s of Object.values(this.state.sessions)) {
      if (s.labelIds) s.labelIds = s.labelIds.filter((x) => x !== id);
    }
    this.save();
    return true;
  }
}

function asObject(body: unknown, allowed: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("body must be an object");
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new ValidationError(`unknown field: ${k}`);
  }
  return body as Record<string, unknown>;
}

function checkName(v: unknown): string {
  if (typeof v !== "string") throw new ValidationError("name must be a string");
  const name = v.trim();
  if (!name || name.length > LIMITS.labelName) throw new ValidationError(`name must be 1-${LIMITS.labelName} chars`);
  return name;
}

function checkColor(v: unknown): string {
  if (typeof v !== "string" || !COLOR.test(v)) throw new ValidationError("color must be #rrggbb");
  return v.toLowerCase();
}

export function validateSessionPatch(body: unknown, labelIds: Set<string>): SessionPatch {
  const b = asObject(body, ["pinned", "priority", "labelIds", "note", "project"]);
  const out: SessionPatch = {};
  if (b.pinned !== undefined) {
    if (typeof b.pinned !== "boolean") throw new ValidationError("pinned must be a boolean");
    out.pinned = b.pinned;
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority as Priority)) throw new ValidationError("priority must be high, normal or low");
    out.priority = b.priority as Priority;
  }
  if (b.labelIds !== undefined) {
    if (!Array.isArray(b.labelIds) || !b.labelIds.every((x) => typeof x === "string")) {
      throw new ValidationError("labelIds must be an array of strings");
    }
    const ids = [...new Set(b.labelIds as string[])];
    if (ids.length > LIMITS.labelIds) throw new ValidationError("too many labels");
    const unknown = ids.find((x) => !labelIds.has(x));
    if (unknown) throw new ValidationError(`unknown label: ${unknown}`);
    out.labelIds = ids;
  }
  if (b.note !== undefined) {
    if (typeof b.note !== "string") throw new ValidationError("note must be a string");
    if (b.note.length > LIMITS.note) throw new ValidationError(`note max ${LIMITS.note} chars`);
    out.note = b.note;
  }
  if (b.project !== undefined) {
    // null or "" clears the override.
    if (b.project === null) out.project = "";
    else if (typeof b.project !== "string") throw new ValidationError("project must be a string");
    else {
      const p = b.project.trim();
      if (p.length > LIMITS.project) throw new ValidationError(`project max ${LIMITS.project} chars`);
      out.project = p;
    }
  }
  return out;
}

/** Accept a loaded file defensively: drop anything that does not fit. */
function normalize(j: unknown): UserState {
  const st = emptyState();
  if (!j || typeof j !== "object") return st;
  const o = j as Record<string, unknown>;
  if (Array.isArray(o.labels)) {
    for (const l of o.labels) {
      if (l && typeof l.id === "string" && typeof l.name === "string" && typeof l.color === "string" && COLOR.test(l.color)) {
        st.labels.push({ id: l.id, name: l.name, color: l.color });
      }
    }
  }
  const known = new Set(st.labels.map((l) => l.id));
  if (o.sessions && typeof o.sessions === "object") {
    for (const [id, v] of Object.entries(o.sessions as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const s = v as Record<string, unknown>;
      const u: UserSession = {};
      if (typeof s.pinned === "boolean") u.pinned = s.pinned;
      if (PRIORITIES.includes(s.priority as Priority)) u.priority = s.priority as Priority;
      if (Array.isArray(s.labelIds)) u.labelIds = s.labelIds.filter((x): x is string => typeof x === "string" && known.has(x));
      if (typeof s.note === "string") u.note = s.note;
      if (typeof s.project === "string" && s.project) u.project = s.project;
      st.sessions[id] = u;
    }
  }
  return st;
}
