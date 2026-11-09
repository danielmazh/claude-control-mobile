import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { Icon, type IconName } from "../components/Icon";
import { BackBar, Card, Chevron, IconTile, useApp } from "../components/ui";
import { controlLine, fixAllSpec, restartDaemonSpec, RunSheet, useControlStatus, type RunSpec } from "../components/Revive";
import { dir, lang, setLang, T, type Lang } from "../i18n";
import { useTheme, type ThemeChoice } from "../theme";
import type { Label } from "../types";
import qrcode from "qrcode-generator";
import { cx, LABEL_COLORS } from "../util";

type PushState = "unsupported" | "ios-install" | "denied" | "off" | "on" | "busy";

const isIOS = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

function keyToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function currentState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS() && !isStandalone() ? "ios-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "on" : "off";
}

const THEMES: { id: ThemeChoice; icon: IconName }[] = [
  { id: "system", icon: "phone" },
  { id: "light", icon: "sun" },
  { id: "dark", icon: "moon" },
];

/** Each language is named in itself, so it can be found in either UI. */
const LANGS: { id: Lang; name: string }[] = [
  { id: "en", name: "English" },
  { id: "he", name: "עברית" },
];

export function SettingsScreen() {
  const { toast, deck } = useApp();
  const [push, setPush] = useState<PushState>("busy");
  const [theme, setTheme] = useTheme();
  const mock = api.isMock();

  useEffect(() => {
    currentState().then(setPush, () => setPush("unsupported"));
  }, []);

  const enable = async () => {
    setPush("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setPush(perm === "denied" ? "denied" : "off");
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.pushKey();
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) }));
      await api.pushSubscribe(sub.toJSON());
      setPush("on");
      toast(T.pushOn);
    } catch (err) {
      setPush(await currentState().catch(() => "off" as PushState));
      toast(T.pushOnFailed(err instanceof Error ? err.message : ""));
    }
  };

  const disable = async () => {
    setPush("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      await (await reg?.pushManager.getSubscription())?.unsubscribe();
      toast(T.pushOff);
    } catch {
      toast(T.pushOffFailed);
    }
    setPush(await currentState().catch(() => "off" as PushState));
  };

  const test = async () => {
    try {
      await api.pushTest();
      toast(T.testSent);
    } catch {
      toast(T.testFailed);
    }
  };

  const canToggle = !mock && (push === "on" || push === "off");
  const hint = mock
    ? T.hintMock
    : push === "ios-install"
      ? T.hintIos
      : push === "unsupported"
        ? T.hintUnsupported
        : push === "denied"
          ? T.hintDenied
          : "";

  return (
    <div class="screen inner">
      <BackBar title={T.settings} />
      <div class="section-head">
        <h2>{T.notifications}</h2>
      </div>
      <Card>
        <div class="rows">
          <div class="row static">
            <IconTile icon="bell" tone="plain" />
            <span class="row-text">
              <span class="row-title">{T.push}</span>
              <span class="row-sub">{T.pushSub}</span>
            </span>
            <button
              type="button"
              role="switch"
              class={cx("switch", push === "on" && "on")}
              aria-checked={push === "on"}
              aria-label={T.push}
              disabled={!canToggle}
              onClick={() => (push === "on" ? disable() : enable())}
            >
              <span class="knob" />
            </button>
          </div>
          <div class="row static">
            <IconTile icon="send" tone="plain" />
            <span class="row-text">
              <span class="row-title">{T.testPush}</span>
              <span class="row-sub">{T.testPushSub}</span>
            </span>
            <button type="button" class="btn-outline small" disabled={mock || push !== "on"} onClick={test}>
              {T.sendTest}
            </button>
          </div>
        </div>
        {hint && (
          <p class="card-hint" dir={dir()}>
            {hint}
          </p>
        )}
      </Card>

      <div class="section-head">
        <h2>
          <bdi>Claude Control</bdi>
        </h2>
      </div>
      <ControlCard />

      <div class="section-head">
        <h2>{T.addDevice}</h2>
      </div>
      <AddDeviceCard />

      <div class="section-head">
        <h2>{T.theme}</h2>
      </div>
      <div class="segmented" role="radiogroup" aria-label={T.theme}>
        {THEMES.map((t) => (
          <button
            type="button"
            key={t.id}
            role="radio"
            aria-checked={theme === t.id}
            class={cx("seg", theme === t.id && "on")}
            onClick={() => setTheme(t.id)}
          >
            <Icon name={t.icon} size={22} />
            {T.themes[t.id]}
          </button>
        ))}
      </div>

      <div class="section-head">
        <h2>{T.language}</h2>
      </div>
      <div class="segmented" role="radiogroup" aria-label={T.language}>
        {LANGS.map((l) => (
          <button
            type="button"
            key={l.id}
            role="radio"
            lang={l.id}
            aria-checked={lang === l.id}
            class={cx("seg", lang === l.id && "on")}
            onClick={() => setLang(l.id)}
          >
            {l.name}
          </button>
        ))}
      </div>

      <div class="section-head">
        <h2>{T.labels}</h2>
        <span>{deck.labels.length}</span>
      </div>
      <LabelsCard />

      <p class="version-line">
        <bdi>Claude Control Mobile</bdi> &bull; {T.version}
      </p>
    </div>
  );
}

/** Spec 0004: the two Claude Control actions that are not about one session. */
function AddDeviceCard() {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const show = () =>
    api.getLoginLink().then(setUrl, (e) => setErr(e instanceof Error ? e.message : String(e)));
  const svg = (() => {
    if (!url) return "";
    const q = qrcode(0, "M");
    q.addData(url);
    q.make();
    return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  })();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url!);
    } catch {
      const t = document.createElement("textarea");
      t.value = url!;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const close = () => {
    setUrl(null);
    setCopied(false);
  };
  return (
    <Card>
      <div class="rows">
        <div class="row static">
          <IconTile icon="phone" tone="plain" />
          <span class="row-text">
            <span class="row-title">{T.addDevice}</span>
            <span class="row-sub">{err || T.addDeviceSub}</span>
          </span>
          <button type="button" class="btn-outline small" onClick={show}>
            {T.addDeviceShow}
          </button>
        </div>
      </div>
      {url && (
        <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
          <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="qr-title">
            <span class="sheet-grip" aria-hidden="true" />
            <h2 id="qr-title" class="sheet-title">
              {T.addDevice}
            </h2>
            <p class="sheet-text">{T.addDeviceText}</p>
            <div class="qr-box" dangerouslySetInnerHTML={{ __html: svg }} />
            <p class="card-hint">{T.addDeviceWarn}</p>
            <div class="sheet-actions">
              <button type="button" class="btn-outline wide" onClick={copy}>
                {copied ? T.addDeviceCopied : T.addDeviceCopy}
              </button>
              <button type="button" class="btn-primary" onClick={close}>
                {T.close}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function ControlCard() {
  const st = useControlStatus(5000);
  const [sheet, setSheet] = useState<RunSpec | null>(null);
  const off = st?.reachable === false;
  const busy = !!st?.action && !st.action.done;
  return (
    <Card>
      <div class="rows">
        <div class="row static">
          <IconTile icon="sparkles" tone="plain" />
          <span class="row-text">
            <span class="row-title">{T.fixAll}</span>
            <span class="row-sub">{T.fixAllSub}</span>
          </span>
          <button type="button" class="btn-outline small" disabled={off || busy} onClick={() => setSheet(fixAllSpec())}>
            {T.fix}
          </button>
        </div>
        <div class="row static">
          <IconTile icon="cast" tone="plain" />
          <span class="row-text">
            <span class="row-title">
              {T.restartServer[0]}
              <bdi>Remote Control</bdi>
              {T.restartServer[1]}
            </span>
            <span class="row-sub">
              {st?.daemon ? (st.daemon.running ? T.daemonRunning(st.daemon.status) : T.daemonDown) : T.daemonUnknown}
            </span>
          </span>
          <button type="button" class="btn-outline small" disabled={off || busy} onClick={() => setSheet(restartDaemonSpec())}>
            {T.restartShort}
          </button>
        </div>
      </div>
      <p class="card-hint" dir={dir()}>
        <span dir={dir()}>{controlLine(st)}</span>
        {off && (
          <>
            <br />
            {T.controlOptional}
          </>
        )}
      </p>
      {sheet && <RunSheet spec={sheet} onClose={() => setSheet(null)} />}
    </Card>
  );
}

function LabelsCard() {
  const { deck } = useApp();
  const [open, setOpen] = useState<string | null>(null); // label id, "new", or null
  return (
    <Card>
      <div class="rows">
        {deck.labels.map((l) =>
          open === l.id ? (
            <LabelForm key={l.id} label={l} onDone={() => setOpen(null)} />
          ) : (
            <button type="button" key={l.id} class="row label-row" onClick={() => setOpen(l.id)}>
              <span class="label-dot" style={{ background: l.color }} aria-hidden="true" />
              <span class="row-text">
                <span class="row-title" dir="auto">
                  {l.name}
                </span>
              </span>
              <Chevron />
            </button>
          ),
        )}
        {open === "new" ? (
          <LabelForm onDone={() => setOpen(null)} />
        ) : (
          <button type="button" class="row add-row" onClick={() => setOpen("new")}>
            <Icon name="plus" size={22} />
            <span class="row-title">{T.newLabel}</span>
          </button>
        )}
      </div>
    </Card>
  );
}

function LabelForm({ label, onDone }: { label?: Label; onDone: () => void }) {
  const { deck } = useApp();
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState(label?.color ?? LABEL_COLORS[0]);
  const [busy, setBusy] = useState(false);

  const save = async (e: Event) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    const ok = label ? await deck.updateLabel(label.id, { name: n, color }) : !!(await deck.createLabel(n, color));
    setBusy(false);
    if (ok) onDone();
  };

  const remove = async () => {
    if (!label || !confirm(T.confirmDelete(label.name))) return;
    setBusy(true);
    const ok = await deck.deleteLabel(label.id);
    setBusy(false);
    if (ok) onDone();
  };

  return (
    <form class="label-form" onSubmit={save}>
      <input
        class="field"
        dir="auto"
        value={name}
        maxLength={40}
        placeholder={T.labelName}
        aria-label={T.labelName}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        autoFocus
      />
      <div class="swatches" role="radiogroup" aria-label={T.color}>
        {LABEL_COLORS.map((c) => (
          <button
            type="button"
            key={c}
            role="radio"
            aria-checked={color === c}
            aria-label={c}
            class={cx("swatch", color === c && "on")}
            style={{ background: c }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div class="form-actions">
        <button type="submit" class="btn-primary small" disabled={busy || !name.trim()}>
          {T.save}
        </button>
        <button type="button" class="btn-outline small" onClick={onDone}>
          {T.cancel}
        </button>
        {label && (
          <button type="button" class="btn-ghost small danger" onClick={remove} disabled={busy}>
            <Icon name="trash" size={18} />
            {T.delete}
          </button>
        )}
      </div>
    </form>
  );
}
