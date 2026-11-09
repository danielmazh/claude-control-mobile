import { LaunchClaude } from "./OpenClaude";
import { createContext } from "preact";
import type { ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import { T } from "../i18n";
import type { Nav } from "../nav";
import type { Deck } from "../store";
import type { Tone } from "../util";
import { cx } from "../util";
import { Icon, PhoneGlyph, type IconName } from "./Icon";
import type { Index } from "../util";
import type { Session } from "../types";

export interface Ctx {
  deck: Deck;
  idx: Index;
  nav: Nav;
  now: number;
  toast: (msg: string) => void;
}

export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

export function Dot({ tone, small = false }: { tone: Tone; small?: boolean }) {
  return <span class={cx("dot", `t-${tone}`, small && "small")} aria-hidden="true" />;
}

export function ProjectChip({ project }: { project: string }) {
  return (
    <span class="chip">
      <Icon name="folder" size={15} />
      <bdi>{project}</bdi>
    </span>
  );
}

/** Small tag for a session that lives only in the terminal (spec 0003). */
export function TerminalTag() {
  return (
    <span class="chip chip-sm">
      <Icon name="terminal" size={13} />
      {T.tagTerminal}
    </span>
  );
}

/** Small tag for a general (non-code) chat, a Cowork session (spec 0005). */
export function GeneralTag() {
  return (
    <span class="chip chip-sm chip-general">
      <Icon name="chat" size={13} />
      {T.tagGeneral}
    </span>
  );
}

/** The tag that tells where a session lives: terminal or general. Desktop Code sessions have none. */
export function SourceTag({ s }: { s: Session }) {
  if (s.kind === "general") return <GeneralTag />;
  if (s.source === "terminal") return <TerminalTag />;
  return null;
}

export function RoundButton({
  icon,
  label,
  onClick,
  active = false,
  flip = false,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  flip?: boolean;
}) {
  return (
    <button type="button" class={cx("round-btn", active && "active")} aria-label={label} aria-pressed={active ? true : undefined} onClick={onClick}>
      <Icon name={icon} size={22} flip={flip} />
    </button>
  );
}

/** Top bar of an inner screen: back arrow at the start, optional action at the end. */
export function BackBar({ title, end }: { title?: string; end?: ComponentChildren }) {
  const { nav } = useApp();
  return (
    <header class="back-bar">
      <RoundButton icon="arrow-right" label={T.back} onClick={nav.back} flip />
      {title && <h1 class="back-title">{title}</h1>}
      <div class="back-end">{end}</div>
    </header>
  );
}

/** Header of a tab screen: title block at the start, gear at the end. */
export function TabHeader({ title, sub, logo = false }: { title: string; sub: string; logo?: boolean }) {
  const { nav } = useApp();
  return (
    <header class="tab-header">
      {logo && <LogoTile />}
      <div class="tab-title">
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      <span class="spacer" />
      <LaunchClaude />
      <RoundButton icon="settings" label={T.settings} onClick={() => nav.push({ kind: "settings" })} />
    </header>
  );
}

function LogoTile() {
  return (
    <span class="logo-tile" aria-hidden="true">
      <PhoneGlyph size={26} />
    </span>
  );
}

export function Card({ children, class: c }: { children: ComponentChildren; class?: string }) {
  return <section class={cx("card", c)}>{children}</section>;
}

export function CardHead({ icon, title, meta }: { icon?: IconName; title: string; meta?: ComponentChildren }) {
  return (
    <div class="card-head">
      <h2>
        {icon && <Icon name={icon} size={20} />}
        {title}
      </h2>
      {meta !== undefined && <span class="card-meta">{meta}</span>}
    </div>
  );
}

export function IconTile({ icon, tone = "brand" }: { icon: IconName; tone?: "brand" | "plain" | "ok" }) {
  return (
    <span class={cx("icon-tile", `it-${tone}`)} aria-hidden="true">
      <Icon name={icon} size={22} />
    </span>
  );
}

export const Chevron = () => (
  <span class="chev" aria-hidden="true">
    <Icon name="chevron-left" size={20} flip />
  </span>
);

export function Empty({ icon, title, text, children }: { icon: IconName; title: string; text: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <span class="empty-icon">
        <Icon name={icon} size={28} />
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
      {children}
    </div>
  );
}
