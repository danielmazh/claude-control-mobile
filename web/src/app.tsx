import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AuthScreen, ErrorScreen, LoadingScreen } from "./components/StatusScreens";
import { TabBar } from "./components/TabBar";
import { AppCtx, type Ctx } from "./components/ui";
import * as api from "./api";
import { T, useLang } from "./i18n";
import { useNav, type Screen } from "./nav";
import { ChatScreen } from "./screens/Chat";
import { ChatsTab } from "./screens/Chats";
import { DeviceScreen } from "./screens/Device";
import { DevicesTab } from "./screens/Devices";
import { EditScreen } from "./screens/Edit";
import { Home } from "./screens/Home";
import { SettingsScreen } from "./screens/Settings";
import { useDeck, useNow } from "./store";
import { buildIndex } from "./util";

function useToast() {
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(""), 3200);
  }, []);
  return [msg, show] as const;
}

function Inner({ screen }: { screen: Screen }) {
  switch (screen.kind) {
    case "chat":
      return <ChatScreen key={screen.id} id={screen.id} />;
    case "device":
      return <DeviceScreen sessionId={screen.sessionId} remoteId={screen.remoteId} />;
    case "settings":
      return <SettingsScreen />;
    case "edit":
      return <EditScreen key={screen.id} id={screen.id} />;
  }
}

export function App() {
  const [toastMsg, toast] = useToast();
  const deck = useDeck(toast);
  const nav = useNav();
  const now = useNow();
  // A language change re-renders the whole tree (no memo below), and swaps the demo texts.
  const lang = useLang();
  const firstLang = useRef(lang);
  useEffect(() => {
    if (lang === firstLang.current) return;
    firstLang.current = lang;
    void api.relocalizeMock();
  }, [lang]);
  const idx = useMemo(() => buildIndex(deck.sessions), [deck.sessions]);
  const ctx: Ctx = { deck, idx, nav, now, toast };

  // Offline line for live mode; mock mode is always "online".
  const offline = deck.phase === "ready" && deck.conn === "offline";
  const top = nav.state.stack[nav.state.stack.length - 1];

  useEffect(() => {
    document.title = "Claude Control Mobile";
  }, []);

  if (deck.phase === "auth") return <AuthScreen onRetry={deck.retry} />;
  if (deck.phase === "error") return <ErrorScreen message={deck.error} onRetry={deck.retry} />;

  return (
    <AppCtx.Provider value={ctx}>
      {offline && (
        <div class="offline-bar" role="status">
          {T.offline}
        </div>
      )}
      <main class={top ? "app inner-app" : "app"}>
        {deck.phase === "loading" ? (
          <LoadingScreen />
        ) : top ? (
          <Inner screen={top} />
        ) : nav.state.tab === "home" ? (
          <Home />
        ) : nav.state.tab === "chats" ? (
          <ChatsTab />
        ) : (
          <DevicesTab />
        )}
      </main>
      {!top && <TabBar tab={nav.state.tab} onTab={nav.setTab} />}
      <div class="toast-wrap" aria-live="polite">
        {toastMsg && <div class="toast">{toastMsg}</div>}
      </div>
    </AppCtx.Provider>
  );
}
