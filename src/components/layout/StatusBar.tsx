import { useSessionStore } from "../../stores/session-store";
import { useSyncStore } from "../../stores/sync-store";
import { useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, RefreshCw } from "lucide-react";
import { parseSqliteUtc, relativeTime } from "../../utils/time";
import type { SyncStatusSnapshot } from "../../types";

/*
 * Compact dataset-sync indicator. It is ambient by design: it reads the
 * snapshots the scheduler pushes into the store, never opens a dialog, and an
 * unreachable endpoint degrades to an error badge — app start and the rest of
 * the status bar are never blocked by a sync that cannot reach its server.
 *
 * Priority is syncing → error → idle, so a running dataset is never hidden
 * behind a failure of another one. Nothing renders while no dataset exists.
 */
function SyncIndicator({ statuses }: { statuses: SyncStatusSnapshot[] }) {
  const running = statuses.find((s) => s.phase === "pulling" || s.phase === "pushing");
  const failed = statuses.find((s) => s.phase === "error");

  if (running) {
    const verb = running.phase === "pulling" ? "Pulling" : "Pushing";
    return (
      <span
        role="status"
        data-testid="status-bar-sync"
        aria-label={`Syncing: ${verb.toLowerCase()} dataset ${running.name}`}
        title={`${running.name} — ${verb.toLowerCase()} changes`}
        className="flex items-center gap-1.5 text-text-secondary"
      >
        <RefreshCw size={12} strokeWidth={2} className="motion-safe:animate-spin" />
        <span>{verb} {running.name}…</span>
      </span>
    );
  }

  if (failed) {
    return (
      <span
        role="status"
        data-testid="status-bar-sync"
        aria-label={`Sync error for dataset ${failed.name}`}
        title={`${failed.name} — ${failed.message ?? "the last sync failed"}`}
        className="flex items-center gap-1.5 text-status-error"
      >
        <AlertCircle size={12} strokeWidth={2} />
        <span>Sync error</span>
      </span>
    );
  }

  /* Newest across every dataset, compared as instants: the backend reports
   * timestamps in both RFC3339 and SQLite form, so string order is not order. */
  const lastSyncedAt =
    statuses
      .flatMap((s) => (s.lastSyncedAt ? [s.lastSyncedAt] : []))
      .sort((a, b) => parseSqliteUtc(b).getTime() - parseSqliteUtc(a).getTime())[0] ?? null;

  return (
    <span
      role="status"
      data-testid="status-bar-sync"
      aria-label={lastSyncedAt ? `Datasets synced ${relativeTime(lastSyncedAt)}` : "Datasets not synced yet"}
      title={lastSyncedAt ? `Last dataset sync ${relativeTime(lastSyncedAt)}` : "No dataset has synced yet"}
      className="flex items-center gap-1.5 text-text-muted"
    >
      <CheckCircle2 size={12} strokeWidth={2} />
      <span>{lastSyncedAt ? `Synced ${relativeTime(lastSyncedAt)}` : "Not synced yet"}</span>
    </span>
  );
}

export function StatusBar() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionCount = sessions.size;
  const activeSession = activeSessionId ? sessions.get(activeSessionId) : null;

  const statuses = useSyncStore((s) => s.statuses);
  const loadStatus = useSyncStore((s) => s.loadStatus);
  const subscribeSyncStatus = useSyncStore((s) => s.subscribeSyncStatus);

  /* One read for the current phase, then the event stream. The listener is
   * shared with the Settings rows; releasing it here must always run, including
   * when the mount is discarded before `listen` resolves. */
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void loadStatus();
    void subscribeSyncStatus()
      .then((release) => {
        if (cancelled) release();
        else unlisten = release;
      })
      .catch(() => { /* no listener: the indicator keeps the last read */ });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadStatus, subscribeSyncStatus]);

  const syncList = useMemo(() => Object.values(statuses), [statuses]);

  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    if (!activeSession || activeSession.status !== "Connected") {
      setElapsed("");
      return;
    }

    const start = Date.now();
    const interval = setInterval(() => {
      const diff = Math.floor((Date.now() - start) / 1000);
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = diff % 60;
      setElapsed(
        h > 0
          ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
          : `${m}:${String(s).padStart(2, "0")}`,
      );
    }, 1000);

    return () => clearInterval(interval);
  }, [activeSession]);

  const statusColor = !activeSession
    ? "bg-status-disconnected"
    : activeSession.status === "Connected"
      ? "bg-status-connected"
      : activeSession.status === "Connecting"
        ? "bg-status-connecting"
        : activeSession.status === "Error"
          ? "bg-status-error"
          : "bg-status-disconnected";

  return (
    <div className="flex items-center h-[var(--statusbar-height)] px-3 bg-bg-surface border-t border-border text-[length:var(--text-xs)] text-text-secondary no-select">
      {activeSession ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusColor} ${activeSession.status === "Connecting" ? "motion-safe:animate-pulse" : ""}`} />
            <span className="font-mono text-text-primary">
              {activeSession.hostConfig.username}@{activeSession.hostConfig.host}:{activeSession.hostConfig.port}
            </span>
          </span>
          <span className="mx-2 w-px h-3 bg-border" />
          <span>{activeSession.status}</span>
          {elapsed && (
            <>
              <span className="mx-2 w-px h-3 bg-border" />
              <span className="font-mono tabular-nums">{elapsed}</span>
            </>
          )}
          {syncList.length > 0 && (
            <>
              <span className="mx-2 w-px h-3 bg-border" />
              <SyncIndicator statuses={syncList} />
            </>
          )}
          <span className="flex-1" />
          <span className="font-mono text-text-muted tabular-nums">
            {sessionCount} session{sessionCount !== 1 ? "s" : ""}
          </span>
        </>
      ) : (
        <>
          <span className="text-text-muted">No active session</span>
          {syncList.length > 0 && (
            <>
              <span className="flex-1" />
              <SyncIndicator statuses={syncList} />
            </>
          )}
        </>
      )}
    </div>
  );
}
