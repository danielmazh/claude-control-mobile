// Server messages in English and Hebrew (spec 0006). The client sends `lang`
// (query param, or Accept-Language); English when nothing is sent.

import type { IncomingMessage } from "node:http";

export type Lang = "en" | "he";
export const LANGS: readonly Lang[] = ["en", "he"];

const isLang = (v: unknown): v is Lang => v === "en" || v === "he";

/** The explicit `lang` query param, or null. */
export function queryLang(url: URL): Lang | null {
  const v = url.searchParams.get("lang");
  return isLang(v) ? v : null;
}

/** First supported language in an Accept-Language header, by order (q values ignored). */
export function headerLang(header: string | string[] | undefined): Lang | null {
  const text = Array.isArray(header) ? header.join(",") : (header ?? "");
  for (const part of text.split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase();
    if (tag === "he" || tag.startsWith("he-") || tag === "iw" || tag.startsWith("iw-")) return "he";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return null;
}

/** The language a request asks for: query param first, then Accept-Language, else English. */
export function requestLang(req: IncomingMessage, url: URL): Lang {
  return queryLang(url) ?? headerLang(req.headers["accept-language"]) ?? "en";
}

const en = {
  notRunning: "Claude Control is not running",
  refused: "Claude Control refused",
  unknownAction: "Unknown action",
  sessionNotFound: "Session not found",
  noConversation: "This session has no known conversation, so it can't be revived",
  fellOne: (title: string) => `Stopped: ${title}`,
  fellMany: (n: number) => `${n} sessions stopped`,
  fellBody: "Tap to revive",
};

const he: typeof en = {
  notRunning: "Claude Control לא רץ",
  refused: "Claude Control סירב",
  unknownAction: "פעולה לא מוכרת",
  sessionNotFound: "הסשן לא נמצא",
  noConversation: "לסשן הזה אין שיחה ידועה, אי אפשר להחיות אותו",
  fellOne: (title: string) => `נפל: ${title}`,
  fellMany: (n: number) => `נפלו ${n} סשנים`,
  fellBody: "לחץ כדי להחיות",
};

const TABLES: Record<Lang, typeof en> = { en, he };

export const msg = (lang: Lang) => TABLES[lang];
