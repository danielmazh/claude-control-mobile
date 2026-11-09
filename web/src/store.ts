// App state: the last server snapshot plus pending optimistic patches.
// The view is always server state with pending patches on top, so a failed
// PATCH rolls back by just dropping its pending entry.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import * as api from "./api";
import type { ConnState } from "./api";
import { T } from "./i18n";
import type { Label, Session, SessionPatch, Snapshot } from "./types";

export type Phase = "loading" | "ready" | "auth" | "error";

interface Pending {
  seq: number;
  patch: SessionPatch;
}

export interface Deck {
  phase: Phase;
  conn: ConnState;
  sessions: Session[];
  labels: Label[];
  error: string;
  patch: (id: string, patch: SessionPatch) => Promise<boolean>;
  createLabel: (name: string, color: string) => Promise<Label | null>;
  updateLabel: (id: string, patch: Partial<Pick<Label, "name" | "color">>) => Promise<boolean>;
  deleteLabel: (id: string) => Promise<boolean>;
  generatedAt: number;
  retry: () => void;
}

export function useDeck(onError: (msg: string) => void): Deck {
  const [phase, setPhase] = useState<Phase>("loading");
  const [conn, setConn] = useState<ConnState>("connecting");
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [pending, setPending] = useState<Map<string, Pending[]>>(new Map());
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  const errRef = useRef(onError);
  errRef.current = onError;

  useEffect(() => {
    api.onUnauthorized(() => setPhase("auth"));
    let stop: (() => void) | undefined;
    let cancelled = false;
    setPhase("loading");
    api
      .init()
      .then((s) => {
        if (cancelled) return;
        setSnap(s);
        setPhase("ready");
        stop = api.subscribe(
          (next) => setSnap((prev) => (prev && prev.generatedAt > next.generatedAt ? prev : next)),
          setConn,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof api.ApiError && err.status === 401) return setPhase("auth");
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [attempt]);

  const sessions = useMemo(() => {
    if (!snap) return [];
    if (pending.size === 0) return snap.sessions;
    return snap.sessions.map((s) => {
      const list = pending.get(s.id);
      return list ? list.reduce<Session>((acc, p) => ({ ...acc, ...p.patch }), s) : s;
    });
  }, [snap, pending]);

  const drop = (id: string, n: number) =>
    setPending((prev) => {
      const next = new Map(prev);
      const list = (next.get(id) ?? []).filter((p) => p.seq !== n);
      if (list.length) next.set(id, list);
      else next.delete(id);
      return next;
    });

  const patch = useCallback(async (id: string, p: SessionPatch) => {
    const n = ++seq.current;
    setPending((prev) => new Map(prev).set(id, [...(prev.get(id) ?? []), { seq: n, patch: p }]));
    try {
      const updated = await api.patchSession(id, p);
      // Write the confirmed session into the snapshot, then drop the pending entry.
      setSnap((prev) =>
        prev ? { ...prev, sessions: prev.sessions.map((s) => (s.id === id ? updated : s)) } : prev,
      );
      drop(id, n);
      return true;
    } catch (err) {
      drop(id, n);
      if (!(err instanceof api.ApiError && err.status === 401)) errRef.current(T.patchFailed);
      return false;
    }
  }, []);

  const createLabel = useCallback(async (name: string, color: string) => {
    try {
      const label = await api.createLabel(name, color);
      setSnap((prev) =>
        prev && !prev.labels.some((l) => l.id === label.id)
          ? { ...prev, labels: [...prev.labels, label] }
          : prev,
      );
      return label;
    } catch {
      errRef.current(T.labelCreateFailed);
      return null;
    }
  }, []);

  const updateLabel = useCallback(async (id: string, p: Partial<Pick<Label, "name" | "color">>) => {
    try {
      const label = await api.updateLabel(id, p);
      setSnap((prev) => (prev ? { ...prev, labels: prev.labels.map((l) => (l.id === id ? label : l)) } : prev));
      return true;
    } catch {
      errRef.current(T.labelSaveFailed);
      return false;
    }
  }, []);

  const deleteLabel = useCallback(async (id: string) => {
    try {
      await api.deleteLabel(id);
      setSnap((prev) =>
        prev
          ? {
              ...prev,
              labels: prev.labels.filter((l) => l.id !== id),
              sessions: prev.sessions.map((s) =>
                s.labelIds.includes(id) ? { ...s, labelIds: s.labelIds.filter((x) => x !== id) } : s,
              ),
            }
          : prev,
      );
      return true;
    } catch {
      errRef.current(T.labelDeleteFailed);
      return false;
    }
  }, []);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  return {
    phase,
    conn,
    sessions,
    labels: snap?.labels ?? [],
    error,
    patch,
    createLabel,
    updateLabel,
    deleteLabel,
    retry,
    generatedAt: snap?.generatedAt ?? 0,
  };
}

/** A clock that ticks every 30s, for relative times. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    const vis = () => document.visibilityState === "visible" && setNow(Date.now());
    document.addEventListener("visibilitychange", vis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [intervalMs]);
  return now;
}
