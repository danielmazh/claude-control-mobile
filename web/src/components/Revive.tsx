// Revive through Claude Control (spec 0004): a confirm sheet that runs the action,
// follows it (GET /api/control every 2s) and shows the steps at the end.
import { useEffect, useRef, useState } from "preact/hooks";
import * as api from "../api";
import type { ControlResult, ControlStatus, ControlStep, Session } from "../types";
import { dir, T } from "../i18n";
import { cx } from "../util";
import { Icon } from "./Icon";

export const POLL_MS = 2000;
const FOLLOW_MAX_MS = 5 * 60 * 1000;

/** Display name of a Claude Control action, in the active language. */
export const actionText = (a: string) => T.actions[a] ?? a;

/** Manifest sessions that do not run. */
export const fallenSessions = (sessions: Session[]) =>
  sessions.filter((s) => s.terminal && !s.terminal.running && !s.replacedBy && s.revive === "restart");

/** Poll Claude Control status while the component is shown. null until the first answer. */
export function useControlStatus(intervalMs = 15_000): ControlStatus | null {
  const [st, setSt] = useState<ControlStatus | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const v = await api.getControl();
        if (!stop) setSt(v);
      } catch {
        if (!stop) setSt((p) => p ?? { reachable: false, overall: null, networkUp: null, daemon: null, sessions: { total: 0, running: 0 }, issues: 0, action: null });
      }
      if (!stop) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [intervalMs]);
  return st;
}

export function controlLine(st: ControlStatus | null): string {
  if (!st) return T.controlChecking;
  if (!st.reachable) return T.controlOff;
  if (st.action && !st.action.done) return T.controlBusy(actionText(st.action.action));
  return T.controlOn(st.sessions.running, st.sessions.total);
}

export interface RunSpec {
  title: string;
  text: string;
  confirm: string;
  run: (dry: boolean) => Promise<ControlResult>;
  plan?: boolean; // show the dry-run plan before the confirm
}

type Phase = "confirm" | "running" | "done" | "error";

export function RunSheet({ spec, onClose }: { spec: RunSpec; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [plan, setPlan] = useState<ControlStep[] | null>(null);
  const [steps, setSteps] = useState<ControlStep[]>([]);
  const [ok, setOk] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (spec.plan) {
      spec.run(true).then(
        (r) => alive.current && setPlan(r.results),
        () => alive.current && setPlan([]),
      );
    }
    return () => {
      alive.current = false;
    };
  }, []);

  const finish = (good: boolean | null, msg: string, list: ControlStep[]) => {
    if (!alive.current) return;
    setOk(good);
    setMessage(msg);
    setSteps(list);
    setPhase("done");
  };

  const follow = async (r: ControlResult) => {
    const end = Date.now() + FOLLOW_MAX_MS;
    while (alive.current && Date.now() < end) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      let st: ControlStatus;
      try {
        st = await api.getControl();
      } catch {
        continue;
      }
      const a = st.action;
      if (a && a.action === r.action) {
        if (alive.current) setSteps(a.results);
        if (a.done) return finish(a.ok, a.message ?? (a.ok ? T.done : T.failed), a.results);
      }
    }
    finish(null, T.noFinal, []);
  };

  const go = async () => {
    setPhase("running");
    try {
      const r = await spec.run(false);
      if (r.started) {
        setMessage(r.message);
        await follow(r);
      } else finish(r.ok, r.message, r.results);
    } catch (err) {
      if (!alive.current) return;
      setMessage(err instanceof Error ? err.message : T.actionFailed);
      setPhase("error");
    }
  };

  const busy = phase === "running";
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <span class="sheet-grip" aria-hidden="true" />
        <h2 id="sheet-title" class="sheet-title">
          <span dir={dir()}>{spec.title}</span>
        </h2>
        {phase === "confirm" && (
          <>
            <p class="sheet-text">{spec.text}</p>
            {spec.plan && (
              <div class="sheet-plan">
                <span class="row-sub">{T.whatWillHappen}</span>
                {plan === null ? (
                  <span class="row-sub">{T.loadingPlan}</span>
                ) : plan.length === 0 ? (
                  <span class="row-sub">{T.noPlan}</span>
                ) : (
                  <StepList steps={plan} plan />
                )}
              </div>
            )}
            <div class="sheet-actions">
              <button type="button" class="btn-primary" onClick={go}>
                {spec.confirm}
              </button>
              <button type="button" class="btn-outline wide" onClick={onClose}>
                {T.cancel}
              </button>
            </div>
          </>
        )}
        {phase === "running" && (
          <>
            <p class="sheet-status" role="status">
              <span class="icon-tile it-brand spin" aria-hidden="true">
                <Icon name="loader" size={22} />
              </span>
              {message || T.sending}
            </p>
            {steps.length > 0 && <StepList steps={steps} />}
          </>
        )}
        {phase === "done" && (
          <>
            <p class={cx("sheet-status", ok === false && "bad", ok === true && "good")} role="status">
              <Icon name={ok === false ? "alert" : ok === true ? "check" : "info"} size={22} />
              <span dir="auto">{message}</span>
            </p>
            {steps.length > 0 && <StepList steps={steps} />}
            <div class="sheet-actions">
              <button type="button" class="btn-outline wide" onClick={onClose}>
                {T.close}
              </button>
            </div>
          </>
        )}
        {phase === "error" && (
          <>
            <p class="sheet-status bad" role="alert">
              <Icon name="alert" size={22} />
              <span dir="auto">{message}</span>
            </p>
            <div class="sheet-actions">
              <button type="button" class="btn-outline wide" onClick={onClose}>
                {T.close}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StepList({ steps, plan = false }: { steps: ControlStep[]; plan?: boolean }) {
  return (
    <ul class="step-list">
      {steps.map((s, i) => (
        <li key={i} class={cx("step", !s.ok && "bad")}>
          <Icon name={plan ? "chevron-left" : s.ok ? "check" : "alert"} size={18} flip={plan} />
          <span class="step-text">
            <code dir="ltr">{s.step}</code>
            {s.detail && (
              <span class="step-detail" dir="auto">
                {s.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Specs for the common actions, so every screen words them the same way. */
export function reviveSpec(s: Session): RunSpec {
  if (s.revive === "resume") {
    return {
      title: T.specResumeTitle(s.title),
      text: T.specResumeText,
      confirm: T.reviveInTerminal,
      run: (dry) => api.revive(s.id, dry),
    };
  }
  const running = !!s.terminal?.running;
  return running
    ? {
        title: T.specRestartTitle(s.title),
        text: T.specRestartText,
        confirm: T.restart,
        run: (dry) => api.revive(s.id, dry),
      }
    : {
        title: T.specReviveTitle(s.title),
        text: T.specReviveText,
        confirm: T.revive,
        run: (dry) => api.revive(s.id, dry),
      };
}

export const resumeAllSpec = (): RunSpec => ({
  title: T.reviveAll,
  text: T.specAllText,
  confirm: T.reviveAll,
  run: (dry) => api.controlAction("resume_missing", dry),
});

export const fixAllSpec = (): RunSpec => ({
  title: T.fixAll,
  text: T.specFixText,
  confirm: T.specFixConfirm,
  run: (dry) => api.controlAction("fix_all", dry),
  plan: true,
});

export const restartDaemonSpec = (): RunSpec => ({
  title: T.actions.restart_daemon,
  text: T.specDaemonText,
  confirm: T.restart,
  run: (dry) => api.controlAction("restart_daemon", dry),
});
