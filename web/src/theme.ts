// Theme choice: system, light or dark. Stored per device in localStorage.
import { useCallback, useState } from "preact/hooks";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "hub.theme";

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: ThemeChoice) {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
  // Each meta keeps its media query; for a fixed choice both get the same color.
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const dark = t === "system" ? m.media.includes("dark") : t === "dark";
    m.content = dark ? "#171411" : "#F5F0E8";
  }
}

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme);
  const setTheme = useCallback((t: ThemeChoice) => {
    setThemeState(t);
    applyTheme(t);
    try {
      if (t === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* storage blocked */
    }
  }, []);
  return [theme, setTheme];
}
