import { useMemo, useState } from "preact/hooks";
import { Icon } from "../components/Icon";
import { Dot, Empty, ProjectChip, SourceTag, TabHeader, useApp, Chevron } from "../components/ui";
import { fallenSessions } from "../components/Revive";
import { T } from "../i18n";
import type { Kind, Session } from "../types";
import { compare, compareChildren, cx, DOT, isFinished, isLive, liveChildren, relativeTime, todayLine, tone } from "../util";

const GROUPS: Kind[] = ["code", "general"];

/** Home: pinned live roots, each with its direct children, in a code group and a general group (spec 0005). */
export function Home() {
  const { deck, idx, now, nav } = useApp();
  const [onlyWaiting, setOnlyWaiting] = useState(false);

  const cards = useMemo(() => {
    const roots = deck.sessions.filter((s) => s.pinned && isLive(s) && !s.parentId).sort(compare(idx));
    return roots.map((root) => {
      const children = liveChildren(root, idx.byId)
        .filter((c) => idx.waitsDeep.has(c.id) || !isFinished(c, now))
        .sort(compareChildren(idx));
      return { root, children };
    });
  }, [deck.sessions, idx, now]);

  const waitingCount = cards.reduce(
    (n, c) => n + Number(c.root.status === "waiting") + c.children.filter((x) => idx.waitsDeep.has(x.id)).length,
    0,
  );
  const fallen = useMemo(() => fallenSessions(deck.sessions).length, [deck.sessions]);
  const filter = onlyWaiting && waitingCount > 0;
  const shown = filter ? cards.filter((c) => idx.waitsDeep.has(c.root.id)) : cards;

  return (
    <div class="screen">
      <TabHeader title="Claude Control Mobile" sub={todayLine(now)} logo />
      {fallen > 0 && (
        <button type="button" class="wait-strip fall-strip" onClick={() => nav.setTab("chats")}>
          <span class="ws-main">
            <Icon name="unplug" size={24} />
            {fallen === 1 ? T.fallenOne : T.fallenMany(fallen)}
          </span>
          <span class="ws-action">
            {T.toRevive}
            <Icon name="chevron-left" size={18} flip />
          </span>
        </button>
      )}
      {waitingCount > 0 && (
        <button type="button" class={cx("wait-strip", filter && "on")} onClick={() => setOnlyWaiting(!filter)} aria-pressed={filter}>
          <span class="ws-main">
            <Icon name="bell-ring" size={24} />
            {waitingCount === 1 ? T.waitingOne : T.waitingMany(waitingCount)}
          </span>
          <span class="ws-action">
            {filter ? T.showAll : T.showOnlyThem}
            <Icon name="chevron-left" size={18} flip />
          </span>
        </button>
      )}
      {cards.length === 0 && (
        <Empty icon="star" title={T.homeEmptyTitle} text={T.homeEmptyText}>
          <button type="button" class="btn-outline" onClick={() => nav.setTab("chats")}>
            {T.toChats}
          </button>
        </Empty>
      )}
      {GROUPS.map((g) => {
        const list = shown.filter((c) => c.root.kind === g);
        if (!list.length) return null;
        return (
          <section key={g} class="stack" aria-label={T.kind[g]}>
            <div class="section-head">
              <h2>{T.kind[g]}</h2>
              <span>{list.length}</span>
            </div>
            {list.map((c) => (
              <RootCard key={c.root.id} root={c.root} kids={c.children} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function RootCard({ root, kids }: { root: Session; kids: Session[] }) {
  const { idx, now, nav } = useApp();
  const waiting = idx.waitsDeep.has(root.id);
  const kidsWaiting = kids.filter((k) => idx.waitsDeep.has(k.id)).length;
  const agents = root.subagents.running + kids.reduce((n, k) => n + k.subagents.running, 0);
  const foot = [
    kids.length ? (kids.length === 1 ? T.chatOne : T.chatMany(kids.length)) : "",
    kidsWaiting ? T.kidsWaiting(kidsWaiting) : "",
    agents ? (agents === 1 ? T.agentOne : T.agentMany(agents)) : "",
  ].filter(Boolean);
  const open = () => nav.push({ kind: "chat", id: root.id });

  return (
    <article class={cx("card root-card", waiting && "waiting")}>
      <button type="button" class="rc-head" onClick={open}>
        <span class="rc-title-line">
          <Dot tone={tone(root, idx)} />
          <span class="rc-title">
            <bdi>{root.title}</bdi>
          </span>
          <span class="rc-time">{relativeTime(idx.lastDeep.get(root.id) ?? root.lastActivityAt, now)}</span>
        </span>
        <span class="rc-chips">
          <ProjectChip project={root.project} />
          <SourceTag s={root} />
          {waiting && <span class="chip chip-red">{T.status.waiting}</span>}
        </span>
      </button>
      {kids.length > 0 && (
        <div class="kid-list">
          {kids.map((k) => {
            const w = idx.waitsDeep.has(k.id);
            return (
              <button type="button" key={k.id} class={cx("kid-row", w && "waiting")} onClick={() => nav.push({ kind: "chat", id: k.id })}>
                <Dot tone={tone(k, idx)} small />
                <span class="kid-title">
                  <bdi>{k.title}</bdi>
                </span>
                <SourceTag s={k} />
                <Chevron />
              </button>
            );
          })}
        </div>
      )}
      {foot.length > 0 && <p class="rc-foot">{foot.join(DOT)}</p>}
    </article>
  );
}
