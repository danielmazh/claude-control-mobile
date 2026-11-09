import { useMemo, useState } from "preact/hooks";
import { Icon } from "../components/Icon";
import { Chevron, Dot, Empty, SourceTag, TabHeader, useApp } from "../components/ui";
import { controlLine, fallenSessions, resumeAllSpec, reviveSpec, RunSheet, useControlStatus, type RunSpec } from "../components/Revive";
import { dir, T } from "../i18n";
import type { Kind, Session } from "../types";
import { compare, compareChildren, cx, DOT, isLive, liveChildren, relativeTime, tone, type Index } from "../util";

interface Node {
  s: Session;
  kids: Node[];
}

/** Keeps a node when it or a descendant matches. A matching node keeps all its children. */
function prune(s: Session, idx: Index, match: (s: Session) => boolean): Node | null {
  const kids = liveChildren(s, idx.byId).sort(compareChildren(idx));
  if (match(s)) return { s, kids: kids.map((k) => prune(k, idx, () => true)!) };
  const kept = kids.map((k) => prune(k, idx, match)).filter((n): n is Node => !!n);
  return kept.length ? { s, kids: kept } : null;
}

const KIND_KEY = "hub.chatsKind";

/** The last segment, per device. Storage can throw (private mode), so every access is guarded. */
function readKind(): Kind {
  try {
    return localStorage.getItem(KIND_KEY) === "general" ? "general" : "code";
  } catch {
    return "code";
  }
}

function saveKind(k: Kind): void {
  try {
    localStorage.setItem(KIND_KEY, k);
  } catch {
    // not saved, still works for this visit
  }
}

/** Every chat as a tree, code and general apart (spec 0005). The star decides what shows on home. */
export function ChatsTab() {
  const { deck, idx } = useApp();
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string | null>(null);
  const [kind, setKindState] = useState<Kind>(readKind);
  const setKind = (k: Kind) => {
    setKindState(k);
    setProject(null);
    saveKind(k);
  };

  const allRoots = useMemo(() => deck.sessions.filter((s) => isLive(s) && !s.parentId).sort(compare(idx)), [deck.sessions, idx]);
  const counts = useMemo(() => {
    const c: Record<Kind, number> = { code: 0, general: 0 };
    for (const s of allRoots) c[s.kind]++;
    return c;
  }, [allRoots]);
  const roots = useMemo(() => allRoots.filter((s) => s.kind === kind), [allRoots, kind]);

  const projects = useMemo(() => {
    const count = new Map<string, number>();
    for (const s of roots) count.set(s.project, (count.get(s.project) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
  }, [roots]);
  const activeProject = project && projects.includes(project) ? project : null;

  const tree = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: Session) => !q || s.title.toLowerCase().includes(q) || s.project.toLowerCase().includes(q);
    return roots
      .filter((r) => !activeProject || r.project === activeProject)
      .map((r) => prune(r, idx, match))
      .filter((n): n is Node => !!n);
  }, [roots, idx, query, activeProject]);

  const emptyText =
    kind === "general"
      ? T.noChatsGeneral
      : T.noChatsCode;

  return (
    <div class="screen">
      <TabHeader title={T.tabChats} sub={T.chatsSub} />
      <div class="segmented kind-seg" role="radiogroup" aria-label={T.chatKind}>
        {(["code", "general"] as const).map((k) => (
          <button type="button" key={k} role="radio" aria-checked={kind === k} class={cx("seg", kind === k && "on")} onClick={() => setKind(k)}>
            <Icon name={k === "code" ? "terminal" : "chat"} size={18} />
            {T.kind[k]}
            <span class="seg-count">{counts[k]}</span>
          </button>
        ))}
      </div>
      {kind === "code" && <FallenSection />}
      <label class="search">
        <Icon name="search" size={22} />
        <input
          type="search"
          dir="auto"
          placeholder={T.search}
          aria-label={T.search}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
        {query && (
          <button type="button" class="search-clear" aria-label={T.clearSearch} onClick={() => setQuery("")}>
            <Icon name="x" size={18} />
          </button>
        )}
      </label>
      {projects.length > 1 && (
        <div class="chip-scroll" role="group" aria-label={T.filterProject}>
          <button type="button" class={cx("filter-chip", !activeProject && "on")} aria-pressed={!activeProject} onClick={() => setProject(null)}>
            {T.all}
          </button>
          {projects.map((p) => (
            <button
              type="button"
              key={p}
              class={cx("filter-chip", activeProject === p && "on")}
              aria-pressed={activeProject === p}
              onClick={() => setProject(activeProject === p ? null : p)}
            >
              <bdi>{p}</bdi>
            </button>
          ))}
        </div>
      )}
      {tree.length === 0 ? (
        <Empty
          icon="search"
          title={roots.length ? T.noMatchTitle : T.noChatsTitle}
          text={roots.length ? T.noMatchText : emptyText}
        />
      ) : (
        <section class="card tree-card">
          {tree.map((n) => (
            <RootNode key={n.s.id} node={n} />
          ))}
        </section>
      )}
    </div>
  );
}

function RootNode({ node }: { node: Node }) {
  const { idx, now, nav, deck } = useApp();
  const s = node.s;
  return (
    <div class="tree-root">
      <div class="root-row">
        <button type="button" class="root-main" onClick={() => nav.push({ kind: "chat", id: s.id })}>
          <Dot tone={tone(s, idx)} />
          <span class="row-text">
            <span class="row-title">
              <bdi>{s.title}</bdi>
            </span>
            <span class="row-sub">
              {relativeTime(idx.lastDeep.get(s.id) ?? s.lastActivityAt, now)}
              {DOT}
              <bdi>{s.project}</bdi>
              <SourceTag s={s} />
            </span>
          </span>
        </button>
        <button
          type="button"
          class={cx("star-btn", s.pinned && "on")}
          aria-label={s.pinned ? T.pinOff : T.pinOn}
          aria-pressed={s.pinned}
          onClick={() => deck.patch(s.id, { pinned: !s.pinned })}
        >
          <Icon name="star" size={24} />
        </button>
      </div>
      {node.kids.length > 0 && <KidList nodes={node.kids} />}
    </div>
  );
}

function KidList({ nodes }: { nodes: Node[] }) {
  const { idx, nav } = useApp();
  return (
    <div class="kid-list">
      {nodes.map((n) => (
        <div key={n.s.id}>
          <button
            type="button"
            class={cx("kid-row", idx.waitsDeep.has(n.s.id) && "waiting", n.s.status === "archived" && "archived")}
            onClick={() => nav.push({ kind: "chat", id: n.s.id })}
          >
            <Dot tone={tone(n.s, idx)} small />
            <span class="kid-title">
              <bdi>{n.s.title}</bdi>
            </span>
            <SourceTag s={n.s} />
            <Chevron />
          </button>
          {n.kids.length > 0 && <KidList nodes={n.kids} />}
        </div>
      ))}
    </div>
  );
}

/** Spec 0004: manifest sessions that do not run, with revive buttons, and the Claude Control status line. */
function FallenSection() {
  const { deck, idx, now, nav } = useApp();
  const st = useControlStatus();
  const [sheet, setSheet] = useState<RunSpec | null>(null);
  const fallen = useMemo(() => fallenSessions(deck.sessions).sort(compare(idx)), [deck.sessions, idx]);
  const canRun = st?.reachable !== false;
  return (
    <>
      <p class="control-line" role="status">
        <Dot tone={!st ? "idle" : !st.reachable ? "waiting" : st.action && !st.action.done ? "working" : "idle"} small />
        <span dir={dir()}>{controlLine(st)}</span>
      </p>
      {fallen.length > 0 && (
        <section id="fallen" class="card fall-card">
          <div class="card-head">
            <h2>
              <Icon name="unplug" size={20} />
              {T.fallenTitle}
            </h2>
            <span class="card-meta">{fallen.length}</span>
          </div>
          <div class="rows">
            {fallen.map((s) => (
              <div class="row" key={s.id}>
                <button type="button" class="row-text fall-main" onClick={() => nav.push({ kind: "chat", id: s.id })}>
                  <span class="row-title">
                    <bdi>{s.title}</bdi>
                  </span>
                  <span class="row-sub">
                    {T.stopped}
                    {DOT}
                    {relativeTime(s.lastActivityAt, now)}
                  </span>
                </button>
                <span class="row-meta">
                  <button type="button" class="btn-outline small" disabled={!canRun} onClick={() => setSheet(reviveSpec(s))}>
                    {T.revive}
                  </button>
                </span>
              </div>
            ))}
          </div>
          {fallen.length > 1 && (
            <div class="card-actions">
              <button type="button" class="btn-primary" disabled={!canRun} onClick={() => setSheet(resumeAllSpec())}>
                <Icon name="history" size={20} />
                {T.reviveAll}
              </button>
            </div>
          )}
        </section>
      )}
      {sheet && <RunSheet spec={sheet} onClose={() => setSheet(null)} />}
    </>
  );
}
