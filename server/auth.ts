// Auth for Claude Control Mobile: personal token, Host and Origin checks, login cookie.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "deck_token";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export type CheckResult = { ok: true } | { ok: false; status: 401 | 403; error: string };

export interface CheckOptions {
  token: string;
  allowedHosts: string[];
  selfOrigins: string[];
}

/** Read data/token. Create a new random token (mode 0600) when it is missing. */
export function loadToken(dataDir: string): string {
  const file = join(dataDir, "token");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

/** Remove the port from a Host value. Handles "[::1]:7810" style too. */
function stripPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

function hostAllowed(hostHeader: string | undefined, allowedHosts: string[]): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const bare = stripPort(host);
  for (const entry of allowedHosts) {
    const allowed = entry.trim().toLowerCase();
    if (!allowed) continue;
    if (host === allowed) return true;
    // An entry without a port matches the host on any port.
    if (stripPort(allowed) === allowed && bare === allowed) return true;
  }
  return false;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Constant-time compare. Hashing first gives equal lengths for timingSafeEqual. */
function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (!candidate || !token) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

function requestToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(auth);
    if (m) return m[1];
  }
  return parseCookies(req.headers.cookie)[COOKIE_NAME];
}

/** Check Host, Origin (for writes) and token on one request. */
export function checkRequest(req: IncomingMessage, opts: CheckOptions): CheckResult {
  if (!hostAllowed(req.headers.host, opts.allowedHosts)) {
    return { ok: false, status: 403, error: "host not allowed" };
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const origin = req.headers.origin;
    if (!origin || !opts.selfOrigins.includes(origin)) {
      return { ok: false, status: 403, error: "origin not allowed" };
    }
  }
  if (!tokenMatches(requestToken(req), opts.token)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  return { ok: true };
}

function isHttps(req: IncomingMessage): boolean {
  const proto = req.headers["x-forwarded-proto"];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim().toLowerCase();
  if (first === "https") return true;
  const host = stripPort((req.headers.host ?? "").trim().toLowerCase());
  return host.endsWith(".ts.net");
}

/**
 * Handle GET /login?token=... . Returns false for any other path.
 * Valid token: set the deck_token cookie and redirect to "/". Invalid: 401.
 */
export function handleLogin(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET") return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/login") return false;

  const candidate = url.searchParams.get("token") ?? undefined;
  if (!tokenMatches(candidate, token)) {
    res.writeHead(401, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end("Invalid or missing token.\n");
    return true;
  }

  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${ONE_YEAR_SECONDS}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  res.writeHead(302, {
    "Set-Cookie": parts.join("; "),
    Location: "/",
    "Cache-Control": "no-store",
    // The login URL holds the token, so never send it on as a referrer.
    "Referrer-Policy": "no-referrer",
  });
  res.end();
  return true;
}
