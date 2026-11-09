import { render } from "preact";
import { App } from "./app";
import { applyLang } from "./i18n";
import { applyTheme, readTheme } from "./theme";
import "./styles.css";

applyTheme(readTheme());
applyLang(); // <html lang dir> before the first paint
render(<App />, document.getElementById("app")!);

// Service worker only in production builds, so dev reloads stay simple.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
