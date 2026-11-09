// Claude Control Mobile service worker: app shell cache, web push, notification click.
// Bump VERSION when the shell list changes.
const VERSION = "hub-v2";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API calls, SSE or the login redirect.
  if (url.pathname.startsWith("/api/") || url.pathname === "/login") return;

  // Pages: network first, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Hashed build assets never change: cache first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Other static files: cache, then update in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});

// Payload from the server: {title, body, sessionId, url}
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Claude Control Mobile";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.sessionId || "claude-control-mobile",
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      lang: "he",
      dir: "auto",
      data: { url: data.url || "", sessionId: data.sessionId || "" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url, sessionId } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const target = url ? new URL(url, self.location.origin) : null;
      const sameOrigin = !target || target.origin === self.location.origin;
      // An outside link (for example the Claude app session link) opens directly.
      if (target && !sameOrigin) return self.clients.openWindow(target.href);

      const deckUrl = target
        ? target.href
        : new URL(sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/", self.location.origin).href;
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          if ("navigate" in w) return w.navigate(deckUrl);
          return;
        }
      }
      return self.clients.openWindow(deckUrl);
    })(),
  );
});
