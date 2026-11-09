import { T } from "../i18n";
import { Icon, LogoMark } from "./Icon";

export function AuthScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <main class="center-screen">
      <LogoMark size={72} />
      <h1>{T.authTitle}</h1>
      <p>{T.authText}</p>
      <code dir="ltr">/login?token=...</code>
      <p class="muted">{T.authNote}</p>
      <button type="button" class="btn-primary" onClick={onRetry}>
        {T.tryAgain}
      </button>
    </main>
  );
}

export function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main class="center-screen">
      <span class="empty-icon big" aria-hidden="true">
        <Icon name="offline" size={36} />
      </span>
      <h1>{T.noServer}</h1>
      <p class="muted" dir="auto">
        {message}
      </p>
      <button type="button" class="btn-primary" onClick={onRetry}>
        {T.tryAgain}
      </button>
    </main>
  );
}

export function LoadingScreen() {
  return (
    <main class="screen" aria-busy="true" aria-label={T.loading}>
      <div class="skeleton-head" />
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} class="card skeleton" />
      ))}
    </main>
  );
}
