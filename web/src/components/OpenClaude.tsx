import { useState } from "preact/hooks";
import { Icon } from "./Icon";
import { RoundButton } from "./ui";
import { dir, T } from "../i18n";

/** A Mac with a mouse (an iPad also reports "Mac", but with touch). */
export const onMac = () => /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;

const WEB = "https://claude.ai";
// Android opens the installed app, else falls back to the web.
const ANDROID =
  "intent://claude.ai/#Intent;scheme=https;package=com.anthropic.claude;S.browser_fallback_url=https%3A%2F%2Fclaude.ai;end";

/** Where the plain "open Claude" link goes on this device. null on a Mac, which asks. */
function launchUrl(): string | null {
  if (onMac()) return null;
  if (/Android/i.test(navigator.userAgent)) return ANDROID;
  return WEB; // iPhone and iPad: the web link opens the app when it is installed
}

/** Header button: just opens the Claude app, no session. A Mac asks app or browser. */
export function LaunchClaude() {
  const [ask, setAsk] = useState(false);
  return (
    <>
      <RoundButton
        icon="external"
        label={T.openClaude}
        onClick={() => {
          const url = launchUrl();
          if (!url) return setAsk(true);
          if (url === ANDROID) location.href = url;
          else window.open(url, "_blank", "noopener");
        }}
      />
      {ask && <OpenSheet app="claude://" web={WEB} text={T.openClaudeText} onClose={() => setAsk(false)} />}
    </>
  );
}

export function OpenSheet({ app, web, text, onClose }: { app: string; web: string; text?: string; onClose: () => void }) {
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="open-title">
        <span class="sheet-grip" aria-hidden="true" />
        <h2 id="open-title" class="sheet-title">{T.whereToOpen}</h2>
        <p class="sheet-text">{text ?? T.whereToOpenText}</p>
        <div class="sheet-actions">
          <a class="btn-primary" href={app} onClick={onClose}>
            <span dir={dir()}>
              {T.inApp[0]}
              <bdi>Claude</bdi>
              {T.inApp[1]}
            </span>
            <Icon name="devices" size={22} />
          </a>
          <a class="btn-outline wide" href={web} target="_blank" rel="noopener" onClick={onClose}>
            <span dir={dir()}>
              {T.inBrowser[0]}
              <bdi>claude.ai</bdi>
              {T.inBrowser[1]}
            </span>
            <Icon name="external" size={20} />
          </a>
          <button type="button" class="btn-outline wide" onClick={onClose}>
            {T.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
