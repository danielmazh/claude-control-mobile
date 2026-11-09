import { useState } from "preact/hooks";
import { Icon } from "../components/Icon";
import { BackBar, Card, CardHead, Chevron, Dot, Empty, IconTile, ProjectChip, RoundButton, SourceTag, useApp } from "../components/ui";
import { reviveSpec, RunSheet } from "../components/Revive";
import { dir, T } from "../i18n";
import type { Link, Session } from "../types";
import {
  compareChildren,
  cx,
  dateTime,
  DOT,
  duration,
  editSummary,
  isFinished,
  liveChildren,
  newestInChain,
  relativeTime,
  statusText as statusName,
  tone,
} from "../util";

export const linkName = (l: Link) => (l.kind === "remote-control" ? "Remote Control" : T.bridge);

/** "Open in Claude" with the Latin word isolated, so the order stays right in RTL. */
function OpenLabel({ prefix }: { prefix: string }) {
  return (
    <span dir={dir()}>
      {prefix}
      <bdi>Claude</bdi>
    </span>
  );
}

/** Desktop Code sessions open in the Claude app through its own link scheme. */
export const appUrl = (s: Session) =>
  s.source === "desktop" && s.id.startsWith("local_") ? `claude://code/continue?session=${encodeURIComponent(s.id)}` : null;

/** A Mac with a mouse (an iPad also reports "Mac", but with touch). */
const onMac = () => /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2;

/** On a Mac it asks: the Claude app or the browser. Elsewhere it opens the web link. */
function OpenButton({ s }: { s: Session }) {
  const [ask, setAsk] = useState(false);
  const app = onMac() ? appUrl(s) : null;
  const href = s.openUrl ?? app;
  return (
    <>
      <a
        class={cx("btn-primary", !href && "disabled")}
        href={href ?? undefined}
        target={href === app ? undefined : "_blank"}
        rel="noopener"
        aria-disabled={!href}
        onClick={(e) => {
          if (!href) return e.preventDefault();
          if (app && s.openUrl) {
            e.preventDefault();
            setAsk(true);
          }
        }}
      >
        <OpenLabel prefix={T.openIn} />
        <Icon name="external" size={22} />
      </a>
      {ask && app && s.openUrl && <OpenSheet app={app} web={s.openUrl} onClose={() => setAsk(false)} />}
    </>
  );
}

function OpenSheet({ app, web, onClose }: { app: string; web: string; onClose: () => void }) {
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="open-title">
        <span class="sheet-grip" aria-hidden="true" />
        <h2 id="open-title" class="sheet-title">{T.whereToOpen}</h2>
        <p class="sheet-text">{T.whereToOpenText}</p>
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

export function ChatScreen({ id }: { id: string }) {
  const { idx, deck, nav } = useApp();
  const s = idx.byId.get(id);
  if (!s) {
    return (
      <div class="screen inner">
        <BackBar />
        <Empty icon="messages" title={T.chatNotFound} text={T.chatNotFoundText} />
      </div>
    );
  }
  if (s.replacedBy) return <ReplacedChat s={s} />;

  const isRoot = !s.parentId;
  return (
    <div class="screen inner">
      <BackBar
        end={
          isRoot && (
            <RoundButton
              icon="star"
              label={s.pinned ? T.pinOff : T.pinOn}
              active={s.pinned}
              onClick={() => deck.patch(s.id, { pinned: !s.pinned })}
            />
          )
        }
      />
      <TitleBlock s={s} />
      <OpenButton s={s} />
      {!s.openUrl && !(onMac() && appUrl(s)) && (
        <p class="hint-line">
          {s.kind === "general"
            ? T.noLinkGeneral
            : s.terminal?.attachCmd
              ? T.noLinkTerminal
              : T.noLink}
        </p>
      )}
      {s.kind === "code" && <TerminalCard s={s} />}
      {s.kind === "code" && <ResumeInTerminal s={s} />}
      <SummaryCard s={s} />
      <ChildrenCard s={s} />
      {s.kind === "code" && <AgentsCard s={s} />}
      {s.kind === "code" && <LinksCard s={s} />}
      <VersionsCard s={s} />
      <Card class="tap-card">
        <button type="button" class="row" onClick={() => nav.push({ kind: "edit", id: s.id })}>
          <IconTile icon="pencil" tone="plain" />
          <span class="row-text">
            <span class="row-title">{T.edit}</span>
            <span class="row-sub">{editSummary(s, deck.labels)}</span>
          </span>
          <Chevron />
        </button>
      </Card>
    </div>
  );
}

function TitleBlock({ s, replaced = false }: { s: Session; replaced?: boolean }) {
  const { idx, now } = useApp();
  const t = tone(s, idx);
  const statusText = replaced ? T.disconnected : t === "waiting" ? T.status.waiting : statusName(s.status);
  return (
    <div class="title-block">
      <h1 class="chat-title">
        <bdi>{s.title}</bdi>
      </h1>
      <div class="meta-row">
        <span class={cx("chip", t === "waiting" && "chip-red")}>
          <Dot tone={t} small />
          {statusText}
        </span>
        <ProjectChip project={s.project} />
        <SourceTag s={s} />
        <span class="meta-time">{replaced ? dateTime(s.lastActivityAt) : relativeTime(s.lastActivityAt, now)}</span>
      </div>
    </div>
  );
}

/** Copy text: the clipboard API needs a secure context, so fall back to a hidden textarea. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back below
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Terminal session (spec 0003): running or stopped, the tmux window, and the command to copy. */
function TerminalCard({ s }: { s: Session }) {
  const { toast } = useApp();
  const [sheet, setSheet] = useState(false);
  const t = s.terminal;
  if (!t) return null;
  const state = t.running ? (t.tmuxTarget ? T.runInTmux : T.runOutsideTmux) : T.stopped;
  const cmdLabel = t.attachCmd?.startsWith("tmux ") ? T.attachWindow : T.restart;
  return (
    <Card>
      <CardHead icon="terminal" title={T.terminal} />
      <div class="rows">
        <div class="row static">
          <Dot tone={t.running ? "working" : "idle"} />
          <span class="row-text">
            <span class="row-title">{state}</span>
            {t.tmuxTarget && (
              <span class="row-sub">
                {T.window}
                <bdi>{t.tmuxTarget}</bdi>
              </span>
            )}
          </span>
        </div>
      </div>
      {t.attachCmd && (
        <div class="cmd-box">
          <span class="row-sub">{cmdLabel}</span>
          <div class="cmd-line">
            <code dir="ltr">{t.attachCmd}</code>
            <button
              type="button"
              class="btn-outline small"
              aria-label={T.copyCommand}
              onClick={async () => toast((await copyText(t.attachCmd!)) ? T.copied : T.copyFailed)}
            >
              <Icon name="copy" size={18} />
              {T.copy}
            </button>
          </div>
        </div>
      )}
      {s.revive === "restart" && (
        <div class="card-actions">
          <button type="button" class={t.running ? "btn-outline wide" : "btn-primary"} onClick={() => setSheet(true)}>
            <Icon name="history" size={20} />
            {t.running ? T.restart : T.revive}
          </button>
        </div>
      )}
      {sheet && <RunSheet spec={reviveSpec(s)} onClose={() => setSheet(false)} />}
    </Card>
  );
}

/** A desktop session that is not in the Claude Control list: start a terminal copy (spec 0004). */
function ResumeInTerminal({ s }: { s: Session }) {
  const [sheet, setSheet] = useState(false);
  if (s.revive !== "resume" || s.terminal || s.status === "working") return null;
  return (
    <div class="resume-terminal">
      <button type="button" class="link-btn" onClick={() => setSheet(true)}>
        <Icon name="terminal" size={18} />
        {T.reviveInTerminal}
      </button>
      <p class="hint-line">{T.reviveInTerminalHint}</p>
      {sheet && <RunSheet spec={reviveSpec(s)} onClose={() => setSheet(false)} />}
    </div>
  );
}

function SummaryCard({ s, before = false }: { s: Session; before?: boolean }) {
  const { now } = useApp();
  if (!s.summary && !s.needsAction) return null;
  return (
    <Card>
      <CardHead icon={before ? undefined : "sparkles"} title={T.whatHappened} meta={before ? T.beforeReplace : relativeTime(s.lastActivityAt, now)} />
      {s.summary && (
        <p class="body-text" dir="auto">
          {s.summary}
        </p>
      )}
      {s.needsAction && !before && (
        <div class="need-box">
          <span class="need-head">
            <Icon name="alert" size={18} />
            {T.needsYou}
          </span>
          <p dir="auto">{s.needsAction}</p>
        </div>
      )}
    </Card>
  );
}

function ChildrenCard({ s }: { s: Session }) {
  const { idx, now, nav } = useApp();
  const [all, setAll] = useState(false);
  const kids = liveChildren(s, idx.byId).sort(compareChildren(idx));
  if (!kids.length) return null;
  const active = kids.filter((k) => idx.waitsDeep.has(k.id) || !isFinished(k, now));
  const hidden = kids.length - active.length;
  const list = all ? kids : active;
  return (
    <Card>
      <CardHead title={T.childChats} meta={all ? kids.length : active.length} />
      <div class="rows">
        {list.map((k) => {
          const w = idx.waitsDeep.has(k.id);
          const deep = liveChildren(k, idx.byId).length;
          return (
            <button type="button" key={k.id} class={cx("row child-row", w && "waiting")} onClick={() => nav.push({ kind: "chat", id: k.id })}>
              <Dot tone={tone(k, idx)} />
              <span class="row-text">
                <span class="row-title">
                  <bdi>{k.title}</bdi>
                </span>
                {deep > 0 && <span class="row-sub">{deep === 1 ? T.childOne : T.childMany(deep)}</span>}
              </span>
              <span class="row-meta">{w ? T.waiting : k.status === "archived" ? T.status.archived : relativeTime(k.lastActivityAt, now)}</span>
              <Chevron />
            </button>
          );
        })}
      </div>
      {hidden > 0 && (
        <button type="button" class="link-btn" onClick={() => setAll(!all)}>
          {all ? T.hideFinished : T.showAllFinished(hidden)}
        </button>
      )}
    </Card>
  );
}

function AgentsCard({ s }: { s: Session }) {
  const { now } = useApp();
  const { items, running, done } = s.subagents;
  const [all, setAll] = useState(false);
  if (!items.length) return null;
  // Running agents always show; finished ones are capped so a long run stays one screen.
  const runningItems = items.filter((a) => !a.finished);
  const doneItems = items.filter((a) => a.finished);
  const shown = all ? items : [...runningItems, ...doneItems.slice(0, 3)];
  const hidden = items.length - shown.length;
  const meta = [running ? T.agentsRunning(running) : "", done ? T.agentsDone(done) : ""].filter(Boolean).join(DOT);
  return (
    <Card>
      <CardHead title={T.agents} meta={meta} />
      <div class="rows">
        {shown.map((a) => (
          <div class="row static" key={a.id}>
            <span class={cx("icon-tile", a.finished ? "it-plain ok-ink" : "it-brand spin")} aria-hidden="true">
              <Icon name={a.finished ? "check" : "loader"} size={22} />
            </span>
            <span class="row-text">
              <span class="row-title" dir="auto">
                {a.description || a.type}
              </span>
              <span class="row-sub">
                {a.finished ? T.finished : T.running(a.startedAt ? duration(now - a.startedAt) : "")}
                {DOT}
                <bdi>{a.type}</bdi>
              </span>
            </span>
          </div>
        ))}
      </div>
      {(hidden > 0 || all) && doneItems.length > 3 && (
        <button type="button" class="link-btn" onClick={() => setAll(!all)}>
          {all ? T.hideFinished : T.showAllFinished(hidden)}
        </button>
      )}
    </Card>
  );
}

export function linkSub(remoteSteered: boolean, last: number, now: number) {
  return remoteSteered ? T.lastUsedRemote(relativeTime(last, now)) : T.lastUsed(relativeTime(last, now));
}

function LinksCard({ s }: { s: Session }) {
  const { now, nav } = useApp();
  if (!s.links.length) return null;
  return (
    <Card>
      <CardHead title={T.devices} meta={s.links.length} />
      <div class="rows">
        {s.links.map((l) => (
          <button
            type="button"
            key={l.remoteId}
            class="row"
            onClick={() => nav.push({ kind: "device", sessionId: s.id, remoteId: l.remoteId })}
          >
            <IconTile icon={l.kind === "remote-control" ? "cast" : "link"} />
            <span class="row-text">
              <span class="row-title">{linkName(l)}</span>
              <span class="row-sub">{linkSub(s.remoteSteered, s.lastActivityAt, now)}</span>
            </span>
            <Chevron />
          </button>
        ))}
      </div>
    </Card>
  );
}

function VersionsCard({ s }: { s: Session }) {
  const { idx, nav } = useApp();
  const olds = [...s.replaces].reverse().map((id) => idx.byId.get(id)).filter((x): x is Session => !!x);
  if (!olds.length) return null;
  return (
    <Card>
      <CardHead icon="history" title={T.olderVersions} meta={olds.length} />
      <div class="rows">
        {olds.map((o) => (
          <button type="button" key={o.id} class="row" onClick={() => nav.push({ kind: "chat", id: o.id })}>
            <Dot tone="replaced" />
            <span class="row-text">
              <span class="row-title">{dateTime(o.lastActivityAt)}</span>
              <span class="row-sub">
                {T.disconnected}
                {DOT}
                {T.replacedAfterRestart}
              </span>
            </span>
            <Chevron />
          </button>
        ))}
      </div>
    </Card>
  );
}

function ReplacedChat({ s }: { s: Session }) {
  const { idx, nav } = useApp();
  const next = newestInChain(s, idx.byId);
  const nextTone = tone(next, idx);
  return (
    <div class="screen inner">
      <BackBar />
      <TitleBlock s={s} replaced />
      <section class="replaced-banner">
        <span class="rb-icon">
          <Icon name="unplug" size={30} />
        </span>
        <h2>{T.replacedTitle}</h2>
        <p>
          <bdi>Claude</bdi>
          {T.replacedText}
        </p>
        {next.id !== s.id && (
          <>
            <button type="button" class="btn-primary" onClick={() => nav.replaceTop({ kind: "chat", id: next.id })}>
              {T.goToNew}
              <Icon name="arrow-left" size={22} flip />
            </button>
            <p class="rb-caption">
              {T.newSession}
              <bdi>{next.title}</bdi>
              {DOT}
              {nextTone === "waiting" ? T.status.waiting : statusName(next.status)}
            </p>
          </>
        )}
      </section>
      <SummaryCard s={s} before />
      {s.openUrl && (
        <a class="btn-outline wide" href={s.openUrl} target="_blank" rel="noopener">
          <OpenLabel prefix={T.openOldIn} />
          <Icon name="external" size={22} />
        </a>
      )}
    </div>
  );
}
