import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { ApiError, errorMessage } from "./api";
import { pollDelay } from "./domain";

/** One request at a time; a manual refresh joins an already-running request. */
export function usePolling<T>(
  key: string,
  load: (signal: AbortSignal, manual: boolean) => Promise<T>,
  shouldPoll: (value: T) => boolean = () => false,
) {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  const pollRef = useRef(shouldPoll);
  loadRef.current = load;
  pollRef.current = shouldPoll;
  const refreshRef = useRef<(manual?: boolean) => Promise<void>>(async () => {});
  const latest = useRef<T | null>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const setData = useCallback((action: SetStateAction<T | null>) => {
    const next = typeof action === "function" ? (action as (current: T | null) => T | null)(latest.current) : action;
    latest.current = next;
    setDataState(next);
    scheduleRef.current();
  }, []);

  useEffect(() => {
    let disposed = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | undefined;
    let retryable = true;
    const controller = new AbortController();
    latest.current = null;
    setDataState(null);
    setError("");
    setLoading(true);
    const run = (manual = false): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (inFlight) return inFlight;
      if (!manual && latest.current && !pollRef.current(latest.current)) return Promise.resolve();
      clearTimeout(timer);
      setLoading(true);
      inFlight = (async () => {
        try {
          const value = await loadRef.current(controller.signal, manual);
          if (disposed) return;
          latest.current = value;
          failures = 0;
          retryable = true;
          setDataState(value);
          setError("");
        } catch (cause) {
          if (disposed) return;
          failures++;
          retryable = !(cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 429);
          setError(errorMessage(cause));
        } finally {
          if (!disposed) {
            setLoading(false);
            schedule();
          }
          inFlight = undefined;
        }
      })();
      return inFlight;
    };
    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && retryable && ((latest.current && pollRef.current(latest.current)) || (!latest.current && failures > 0))) timer = setTimeout(() => void run(), pollDelay(failures));
    };
    scheduleRef.current = schedule;
    refreshRef.current = run;
    void run();
    return () => { disposed = true; clearTimeout(timer); controller.abort(); scheduleRef.current = () => {}; };
  }, [key]);
  const wantsPolling = data !== null && shouldPoll(data);
  useEffect(() => { scheduleRef.current(); }, [wantsPolling]);

  return { data, error, loading, setData, refresh: useCallback(() => refreshRef.current(true), []) };
}
