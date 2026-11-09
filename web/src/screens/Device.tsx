import { Icon } from "../components/Icon";
import { BackBar, Card, Empty, useApp } from "../components/ui";
import { dir, T } from "../i18n";
import { relativeTime, shortId } from "../util";
import { linkName } from "./Chat";

export function DeviceScreen({ sessionId, remoteId }: { sessionId: string; remoteId: string }) {
  const { idx, now } = useApp();
  const s = idx.byId.get(sessionId);
  const link = s?.links.find((l) => l.remoteId === remoteId);
  if (!s || !link) {
    return (
      <div class="screen inner">
        <BackBar />
        <Empty icon="devices" title={T.linkNotFound} text={T.linkNotFoundText} />
      </div>
    );
  }
  const rc = link.kind === "remote-control";
  return (
    <div class="screen inner">
      <BackBar />
      <div class="device-hero">
        <span class="hero-tile" aria-hidden="true">
          <Icon name={rc ? "cast" : "link"} size={34} />
        </span>
        <h1>{linkName(link)}</h1>
        <p>
          {T.linkOf}
          <bdi>{s.title}</bdi>
        </p>
      </div>
      <Card class="kv-card">
        <dl class="kv">
          <div>
            <dt>{T.linkType}</dt>
            <dd>{rc ? "Remote Control" : T.bridge}</dd>
          </div>
          <div>
            <dt>{s.remoteSteered ? T.lastUsedRemoteKey : T.lastActivity}</dt>
            <dd>{relativeTime(s.lastActivityAt, now)}</dd>
          </div>
          <div>
            <dt>{T.lastTurn}</dt>
            <dd>{s.remoteSteered ? T.fromRemote : T.fromComputer}</dd>
          </div>
          <div>
            <dt>{T.id}</dt>
            <dd class="mono" dir="ltr">
              {shortId(link.remoteId)}
            </dd>
          </div>
        </dl>
      </Card>
      <a class="btn-outline wide" href={link.url} target="_blank" rel="noopener">
        <span dir={dir()}>
          {T.openIn}
          <bdi>claude.ai</bdi>
        </span>
        <Icon name="external" size={22} />
      </a>
      <div class="info-note">
        <Icon name="info" size={22} />
        <div>
          <strong>
            {T.disconnectIn[0]}
            <bdi>Claude</bdi>
            {T.disconnectIn[1]}
          </strong>
          <p>{T.deviceNote}</p>
        </div>
      </div>
    </div>
  );
}
