// Watches the session folder: fs.watch for speed, a poll as a fallback.
// The reader re-parses only files whose mtime or size changed.

import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
/** A reader with a root folder and a scan that says whether anything changed (SessionReader, CoworkReader). */
export interface Scanner {
  readonly root: string;
  scan(): boolean;
}

export interface WatcherOptions {
  pollMs?: number; // default 3000
  debounceMs?: number; // default 150
}

/** Emits "change" after a scan that found a changed, new or removed file. */
export class SessionWatcher extends EventEmitter {
  private reader: Scanner;
  private fsw: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private opts: Required<WatcherOptions>;

  constructor(reader: Scanner, opts: WatcherOptions = {}) {
    super();
    this.reader = reader;
    this.opts = { pollMs: opts.pollMs ?? 3000, debounceMs: opts.debounceMs ?? 150 };
  }

  start(): void {
    this.reader.scan();
    try {
      this.fsw = watch(this.reader.root, { recursive: true, persistent: false }, () => this.schedule());
      this.fsw.on("error", () => {
        // The poll keeps working without fs.watch.
        this.fsw?.close();
        this.fsw = null;
      });
    } catch {
      this.fsw = null; // folder missing or watch not supported: poll only
    }
    this.poll = setInterval(() => this.check(), this.opts.pollMs);
    this.poll.unref();
  }

  stop(): void {
    this.fsw?.close();
    this.fsw = null;
    if (this.poll) clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
    this.poll = this.debounce = null;
  }

  private schedule(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.check();
    }, this.opts.debounceMs);
    this.debounce.unref();
  }

  /** Scan now. Also emits "tick" on every poll so time-based status can refresh. */
  check(): void {
    if (this.reader.scan()) this.emit("change");
    else this.emit("tick");
  }
}
