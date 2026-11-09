// Screen stack on top of the browser history. Every inner screen is one history
// entry, so the browser back button and the iOS back swipe work. Tabs replace the
// current entry. `/?session=<id>` opens a chat screen (push taps use it).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { reducedMotion } from "./util";

export type Tab = "home" | "chats" | "devices";
export type Screen =
  | { kind: "chat"; id: string }
  | { kind: "device"; sessionId: string; remoteId: string }
  | { kind: "settings" }
  | { kind: "edit"; id: string };

export interface NavState {
  tab: Tab;
  stack: Screen[];
}

interface Entry {
  nav: NavState;
  scroll?: number;
}

const HOME: NavState = { tab: "home", stack: [] };

function isNav(v: unknown): v is NavState {
  const n = v as NavState | null;
  return !!n && typeof n.tab === "string" && Array.isArray(n.stack);
}

/** Keeps unrelated params (like mock=1) and sets `session` for a chat screen. */
function urlFor(nav: NavState): string {
  const params = new URLSearchParams(location.search);
  params.delete("session");
  const top = nav.stack[nav.stack.length - 1];
  if (top?.kind === "chat") params.set("session", top.id);
  const q = params.toString();
  return `${location.pathname}${q ? `?${q}` : ""}`;
}

function readInitial(): NavState {
  const st = history.state as Entry | null;
  if (st && isNav(st.nav)) return st.nav;
  const id = new URLSearchParams(location.search).get("session");
  if (id) {
    // Deep link: put a home entry under the chat, so back lands on home.
    const chat: NavState = { tab: "home", stack: [{ kind: "chat", id }] };
    history.replaceState({ nav: HOME } satisfies Entry, "", urlFor(HOME));
    history.pushState({ nav: chat } satisfies Entry, "", urlFor(chat));
    return chat;
  }
  history.replaceState({ nav: HOME } satisfies Entry, "", urlFor(HOME));
  return HOME;
}

const scrollTop = (smooth: boolean) =>
  window.scrollTo({ top: 0, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });

export interface Nav {
  state: NavState;
  push: (s: Screen) => void;
  replaceTop: (s: Screen) => void;
  back: () => void;
  setTab: (t: Tab) => void;
}

export function useNav(): Nav {
  const [state, setState] = useState<NavState>(() => {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    return readInitial();
  });
  const pendingScroll = useRef<number | null>(null);
  const tabScroll = useRef<Record<Tab, number>>({ home: 0, chats: 0, devices: 0 });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const entry = e.state as Entry | null;
      const nav = entry && isNav(entry.nav) ? entry.nav : HOME;
      pendingScroll.current = entry?.scroll ?? 0;
      setState(nav);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useLayoutEffect(() => {
    if (pendingScroll.current === null) return;
    const y = pendingScroll.current;
    pendingScroll.current = null;
    window.scrollTo(0, y);
  }, [state]);

  const saveScroll = () => {
    const entry = (history.state as Entry | null) ?? { nav: stateRef.current };
    history.replaceState({ ...entry, scroll: window.scrollY } satisfies Entry, "");
  };

  const push = useCallback((s: Screen) => {
    saveScroll();
    const next: NavState = { ...stateRef.current, stack: [...stateRef.current.stack, s] };
    history.pushState({ nav: next } satisfies Entry, "", urlFor(next));
    pendingScroll.current = 0;
    setState(next);
  }, []);

  const replaceTop = useCallback((s: Screen) => {
    const cur = stateRef.current;
    const next: NavState = { ...cur, stack: [...cur.stack.slice(0, -1), s] };
    history.replaceState({ nav: next } satisfies Entry, "", urlFor(next));
    pendingScroll.current = 0;
    setState(next);
  }, []);

  const back = useCallback(() => {
    if (stateRef.current.stack.length) history.back();
  }, []);

  const setTab = useCallback((t: Tab) => {
    const cur = stateRef.current;
    if (cur.tab === t && cur.stack.length === 0) {
      scrollTop(true);
      return;
    }
    tabScroll.current[cur.tab] = window.scrollY;
    const next: NavState = { tab: t, stack: [] };
    history.replaceState({ nav: next, scroll: tabScroll.current[t] } satisfies Entry, "", urlFor(next));
    pendingScroll.current = tabScroll.current[t];
    setState(next);
  }, []);

  return { state, push, replaceTop, back, setTab };
}
