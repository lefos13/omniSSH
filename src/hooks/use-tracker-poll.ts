/* Interval polling hook for tracker views. Runs one read-only command per
 * interval via hidden exec, with an in-flight guard (mirrors health-store)
 * and cleanup when the session disconnects or the component unmounts. */

import { useEffect, useRef, useState } from "react";
import { execOnSession } from "../lib/trackers";
import type { SshExecResult } from "../types";

export interface TrackerPollState<T> {
  data: T | null;
  error: string | null;
  refreshing: boolean;
  refresh: () => void;
}

function extractError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return "Poll failed";
}

export function useTrackerPoll<T>(
  sessionId: string | null,
  command: string,
  intervalMs: number,
  parse: (result: SshExecResult) => T,
): TrackerPollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionId || !command || intervalMs <= 0) return;
    let cancelled = false;

    const run = async () => {
      if (inFlight.current || cancelled) return;
      inFlight.current = true;
      setRefreshing(true);
      try {
        const result = await execOnSession(sessionId, command);
        if (cancelled) return;
        if (result.exitCode !== 0) {
          setError(result.stderr.trim() || `command exited with ${result.exitCode}`);
          return;
        }
        setData(parseRef.current(result));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(extractError(err));
      } finally {
        inFlight.current = false;
        if (!cancelled) setRefreshing(false);
      }
    };

    void run();
    const timer = setInterval(() => { void run(); }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, command, intervalMs, tick]);

  return { data, error, refreshing, refresh: () => setTick((t) => t + 1) };
}
