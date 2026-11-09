// GET /api/devices. READ ONLY.
// Shared folders come from ~/Library/Application Support/Claude/remote-control-state.json:
//   {version, telemetrySalt, identities: {<id>: {serve: "on"|..., folders: {<path>: {environmentId, keys}}}}}
// We return only the folder paths and whether the identity serves them. The salt,
// identity ids, environment ids and keys never leave this file.

import { readFileSync, statSync } from "node:fs";
import type { Devices, Session } from "../shared/types.ts";

export function parseSharedFolders(text: string): Devices["sharedFolders"] {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return [];
  }
  const ids = j && typeof j === "object" ? (j as { identities?: unknown }).identities : undefined;
  if (!ids || typeof ids !== "object") return [];
  const out = new Map<string, boolean>();
  for (const ident of Object.values(ids as Record<string, unknown>)) {
    if (!ident || typeof ident !== "object") continue;
    const serving = (ident as { serve?: unknown }).serve === "on";
    const folders = (ident as { folders?: unknown }).folders;
    if (!folders || typeof folders !== "object" || Array.isArray(folders)) continue;
    for (const path of Object.keys(folders)) {
      if (!path.startsWith("/")) continue;
      out.set(path, (out.get(path) ?? false) || serving);
    }
  }
  return [...out].map(([path, serving]) => ({ path, serving })).sort((a, b) => a.path.localeCompare(b.path));
}

/** Reads the state file again only when its mtime or size changes. */
export class SharedFolderReader {
  private file: string | undefined;
  private key = "";
  private value: Devices["sharedFolders"] = [];

  constructor(file: string | undefined) {
    this.file = file;
  }

  folders(): Devices["sharedFolders"] {
    if (!this.file) return [];
    try {
      const st = statSync(this.file);
      const key = `${st.mtimeMs}:${st.size}`;
      if (key !== this.key) {
        this.value = parseSharedFolders(readFileSync(this.file, "utf8"));
        this.key = key;
      }
    } catch {
      this.key = "";
      this.value = [];
    }
    return this.value.map((f) => ({ ...f }));
  }
}

/** Sessions with a remote link or a remote last turn, newest activity first. */
export function buildDevices(sessions: Session[], sharedFolders: Devices["sharedFolders"]): Devices {
  const list = sessions
    .filter((s) => s.links.length > 0 || s.remoteSteered)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((s) => ({
      sessionId: s.id,
      links: s.links.map((l) => ({ ...l })),
      remoteSteered: s.remoteSteered,
      lastActivityAt: s.lastActivityAt,
    }));
  return { sharedFolders, sessions: list };
}
