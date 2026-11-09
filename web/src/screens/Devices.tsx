import { useEffect, useState } from "preact/hooks";
import * as api from "../api";
import { Card, Chevron, Dot, Empty, IconTile, TabHeader, useApp } from "../components/ui";
import { T } from "../i18n";
import type { Devices } from "../types";
import { cx, tildePath, tone } from "../util";
import { linkName, linkSub } from "./Chat";

/** All remote connections grouped by chat, plus the shared folders. */
export function DevicesTab() {
  const { deck, idx, now, nav } = useApp();
  const [data, setData] = useState<Devices | null>(null);
  const [failed, setFailed] = useState(false);

  // Refetch when the snapshot changes (debounced), so links stay current.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () =>
        api.getDevices().then(
          (d) => alive && (setData(d), setFailed(false)),
          () => alive && setFailed(true),
        ),
      data ? 600 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [deck.generatedAt]);

  const sessions = (data?.sessions ?? [])
    .filter((d) => d.links.length)
    .map((d) => ({ d, s: idx.byId.get(d.sessionId) }))
    .sort((a, b) => b.d.lastActivityAt - a.d.lastActivityAt);
  const folders = data?.sharedFolders ?? [];

  return (
    <div class="screen">
      <TabHeader title={T.tabDevices} sub={T.devicesSub} />
      {!data && !failed && <div class="card skeleton" aria-busy="true" aria-label={T.loading} />}
      {failed && !data && <Empty icon="offline" title={T.loadFailed} text={T.loadFailedText} />}
      {data && sessions.length === 0 && (
        <Empty icon="devices" title={T.noLinksTitle} text={T.noLinksText} />
      )}
      <div class="stack">
        {sessions.map(({ d, s }) => (
          <Card key={d.sessionId}>
            <div class="card-head">
              <h2 class="dev-title">
                {s && <Dot tone={tone(s, idx)} />}
                <bdi>{s?.title ?? d.sessionId}</bdi>
              </h2>
              <span class="card-meta">{d.links.length === 1 ? T.linkOne : T.linkMany(d.links.length)}</span>
            </div>
            <div class="rows">
              {d.links.map((l) => (
                <button
                  type="button"
                  key={l.remoteId}
                  class="row"
                  disabled={!s}
                  onClick={() => nav.push({ kind: "device", sessionId: d.sessionId, remoteId: l.remoteId })}
                >
                  <IconTile icon={l.kind === "remote-control" ? "cast" : "link"} />
                  <span class="row-text">
                    <span class="row-title">{linkName(l)}</span>
                    <span class="row-sub">
                      {linkSub(d.remoteSteered, d.lastActivityAt, now)}
                    </span>
                  </span>
                  <Chevron />
                </button>
              ))}
            </div>
          </Card>
        ))}
      </div>
      {folders.length > 0 && (
        <>
          <div class="section-head">
            <h2>{T.sharedFolders}</h2>
            <span>{folders.length}</span>
          </div>
          <Card>
            <div class="rows">
              {folders.map((f) => (
                <div class="row static" key={f.path}>
                  <IconTile icon="folder-open" tone="plain" />
                  <span class="row-text">
                    <span class="row-title mono" dir="ltr">
                      {tildePath(f.path)}
                    </span>
                  </span>
                  <span class={cx("chip", "chip-state")}>
                    <span class={cx("dot small", f.serving ? "t-working" : "t-idle")} />
                    {f.serving ? T.folderOn : T.folderOff}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
