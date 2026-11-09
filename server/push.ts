// Web Push for Claude Control Mobile: VAPID keys and subscriptions in data/push.json.
// Keys are never logged.
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import type { PushSubscription, RequestOptions, SendResult } from "web-push";

export interface PushPayload {
  title: string;
  body: string;
  sessionId: string;
  url: string;
}

export interface Push {
  publicKey: string;
  subscribe(sub: unknown): Promise<void>;
  send(payload: PushPayload): Promise<void>;
}

type Sender = (sub: PushSubscription, payload: string, options: RequestOptions) => Promise<SendResult>;

export interface PushDeps {
  /** Test hook. Defaults to web-push sendNotification. */
  sendNotification?: Sender;
}

interface PushFile {
  publicKey: string;
  privateKey: string;
  subscriptions: PushSubscription[];
}

const DEFAULT_SUBJECT = "mailto:admin@example.com";
const MAX_SUBSCRIPTIONS = 50;

function subject(): string {
  const raw = process.env.DECK_VAPID_SUBJECT?.trim();
  if (raw && /^(mailto:|https:\/\/)/.test(raw)) return raw;
  return DEFAULT_SUBJECT;
}

function isNonEmptyString(v: unknown, max = 2048): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

/** Return a clean subscription, or throw when the shape is wrong. */
export function validateSubscription(sub: unknown): PushSubscription {
  if (typeof sub !== "object" || sub === null) throw new Error("subscription must be an object");
  const s = sub as Record<string, unknown>;
  if (!isNonEmptyString(s.endpoint)) throw new Error("subscription.endpoint missing");
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    throw new Error("subscription.endpoint is not a URL");
  }
  if (url.protocol !== "https:") throw new Error("subscription.endpoint must be https");
  const keys = s.keys as Record<string, unknown> | undefined;
  if (typeof keys !== "object" || keys === null) throw new Error("subscription.keys missing");
  const b64url = /^[A-Za-z0-9_-]+={0,2}$/;
  if (!isNonEmptyString(keys.p256dh, 256) || !b64url.test(keys.p256dh)) {
    throw new Error("subscription.keys.p256dh invalid");
  }
  if (!isNonEmptyString(keys.auth, 256) || !b64url.test(keys.auth)) {
    throw new Error("subscription.keys.auth invalid");
  }
  return { endpoint: s.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function readStore(file: string): PushFile | null {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<PushFile>;
    if (!isNonEmptyString(data.publicKey) || !isNonEmptyString(data.privateKey)) return null;
    const subs: PushSubscription[] = [];
    for (const s of Array.isArray(data.subscriptions) ? data.subscriptions : []) {
      try {
        subs.push(validateSubscription(s));
      } catch {
        // Drop broken entries quietly.
      }
    }
    return { publicKey: data.publicKey, privateKey: data.privateKey, subscriptions: subs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("data/push.json is not valid JSON");
  }
}

function writeStore(file: string, data: PushFile): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export async function createPush(dataDir: string, deps: PushDeps = {}): Promise<Push> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, "push.json");
  const sender: Sender = deps.sendNotification ?? webpush.sendNotification;

  let store = readStore(file);
  if (!store) {
    const keys = webpush.generateVAPIDKeys();
    store = { publicKey: keys.publicKey, privateKey: keys.privateKey, subscriptions: [] };
    writeStore(file, store);
  }
  const state: PushFile = store;

  // Serialize writes so parallel calls do not lose updates.
  let queue: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    publicKey: state.publicKey,

    async subscribe(sub: unknown): Promise<void> {
      const clean = validateSubscription(sub);
      await locked(() => {
        const rest = state.subscriptions.filter((s) => s.endpoint !== clean.endpoint);
        rest.push(clean);
        state.subscriptions = rest.slice(-MAX_SUBSCRIPTIONS);
        writeStore(file, state);
      });
    },

    async send(payload: PushPayload): Promise<void> {
      const body = JSON.stringify({
        title: payload.title,
        body: payload.body,
        sessionId: payload.sessionId,
        url: payload.url,
      });
      const options: RequestOptions = {
        TTL: 60 * 60,
        urgency: "high",
        vapidDetails: { subject: subject(), publicKey: state.publicKey, privateKey: state.privateKey },
      };
      const targets = [...state.subscriptions];
      const gone = new Set<string>();
      await Promise.all(
        targets.map(async (sub) => {
          try {
            await sender(sub, body, options);
          } catch (err) {
            const code = (err as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) {
              gone.add(sub.endpoint);
            } else {
              // Log only the push service host and status. No keys, no endpoint path.
              let host = "unknown";
              try {
                host = new URL(sub.endpoint).host;
              } catch {}
              console.warn(`push: send failed (host=${host}, status=${code ?? "none"})`);
            }
          }
        }),
      );
      if (gone.size > 0) {
        await locked(() => {
          state.subscriptions = state.subscriptions.filter((s) => !gone.has(s.endpoint));
          writeStore(file, state);
        });
      }
    },
  };
}
