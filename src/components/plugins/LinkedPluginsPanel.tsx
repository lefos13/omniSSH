/* Linked plugins side panel. Bound to the active terminal pane's SSH
 * session like LinkedExplorerPanel: follows pane focus in splits, and shows
 * the same style of blocking message when cross-pane input sync is active.
 * Renders the enabled tracker cards for the focused session. */

import { useState, useEffect, useMemo } from "react";
import { Puzzle, X, Link2 } from "lucide-react";
import { useSessionStore } from "../../stores/session-store";
import type { LayoutNode } from "../../types";
import { useLinkedPluginsStore, collectTabSessionIds } from "../../stores/linked-plugins-store";
import { getTerminal } from "../../stores/terminal-instances";
import { PluginTrackersView } from "./PluginTrackersView";
import { usePluginConfigStore } from "../../stores/plugin-config-store";

interface LinkedPluginsPanelProps {
  tabId: string;
  isActive?: boolean;
}

export function LinkedPluginsPanel({ tabId, isActive = true }: LinkedPluginsPanelProps) {
  const termTab = useSessionStore((s) => s.tabs.get(tabId));
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  const [retainedPaneId, setRetainedPaneId] = useState<string | null>(null);

  const tabSessionIds = useMemo(() => {
    return termTab ? collectTabSessionIds(termTab.layout) : [];
  }, [termTab]);

  useEffect(() => {
    if (isActive && activeSessionId && tabSessionIds.includes(activeSessionId)) {
      setRetainedPaneId(activeSessionId);
    }
  }, [isActive, activeSessionId, tabSessionIds]);

  const activePaneSessionId: string | null = useMemo(() => {
    if (isActive && activeSessionId && tabSessionIds.includes(activeSessionId)) {
      return activeSessionId;
    }
    if (retainedPaneId && tabSessionIds.includes(retainedPaneId)) {
      return retainedPaneId;
    }
    return tabSessionIds[0] ?? null;
  }, [isActive, activeSessionId, retainedPaneId, tabSessionIds]);

  const closeLinkedPlugins = useLinkedPluginsStore((s) => s.closeLinkedPlugins);
  const logTarget = useLinkedPluginsStore((s) => s.logTarget);
  const consumeLogTarget = useLinkedPluginsStore((s) => s.consumeLogTarget);
  const isTabSynced = useSessionStore((s) => s.syncedTabIds.has(tabId));
  const hasSplits = useSessionStore((s) => {
    const tab = s.tabs.get(tabId);
    return tab ? (tab.layout as LayoutNode).type === "split" : false;
  });
  const isSyncedSplitted = isTabSynced && hasSplits;

  const session = useSessionStore((s) =>
    activePaneSessionId ? s.sessions.get(activePaneSessionId) : null,
  );

  /* Deep link from the explorer's "Tail log in Plugins": hold the path for
   * this render pass so PluginTrackersView auto-tails it, while also
   * enabling the log viewer on this host for subsequent visits. The store
   * target is consumed at most once per distinct (tabId, path). */
  const pendingLogPath = logTarget?.tabId === tabId ? logTarget.path : undefined;
  const consumedLogTargetRef = useState(() => ({ value: null as string | null }))[0];
  useEffect(() => {
    if (!pendingLogPath || !session?.hostConfig.savedHostId) return;
    const hostId = session.hostConfig.savedHostId;
    const store = usePluginConfigStore.getState();
    const existing = store.byHostId[hostId]?.logs;
    if (!existing) {
      void store.setPlugin(hostId, "logs", { enabled: true, config: { path: pendingLogPath } });
    }
    if (consumedLogTargetRef.value !== `${tabId}:${pendingLogPath}`) {
      consumedLogTargetRef.value = `${tabId}:${pendingLogPath}`;
      consumeLogTarget();
    }
  }, [pendingLogPath, session?.hostConfig.savedHostId, consumeLogTarget, consumedLogTargetRef, tabId]);
  /* Keep the primed path across the consume so the auto-tail still fires on
   * this mount. Clears when a different target arrives. */
  const [stickyLogPath, setStickyLogPath] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (pendingLogPath) setStickyLogPath(pendingLogPath);
  }, [pendingLogPath]);
  const initialLogPath = pendingLogPath ?? stickyLogPath;

  const handleClose = () => {
    closeLinkedPlugins(tabId);
    if (activePaneSessionId) {
      const term = getTerminal(activePaneSessionId);
      term?.term.focus();
    }
  };

  const btnClass =
    "inline-flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-bg-muted transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <div
      data-testid="linked-plugins-panel"
      className="flex flex-col h-full rounded-lg overflow-hidden border border-border/60 bg-bg-surface/90 shadow-sm"
    >
      <div className="flex items-center h-8 px-2 gap-1.5 shrink-0 no-select border-b border-border/60 bg-bg-surface/80">
        <Puzzle size={14} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="text-[11px] font-medium truncate flex-1 min-w-0 text-text-primary leading-none">
          Plugins
          {session && (
            <span className="ml-1 text-[10px] text-text-muted font-normal font-mono truncate" title={session.label}>
              · {session.hostConfig.label || session.hostConfig.host}
            </span>
          )}
        </span>
        <button
          type="button"
          data-testid="linked-plugins-close"
          onClick={handleClose}
          title="Close plugins panel"
          aria-label="Close plugins panel"
          className={btnClass}
        >
          <X size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {isSyncedSplitted ? (
          <div
            data-testid="linked-plugins-synced-blocked"
            className="flex-1 min-h-0 flex flex-col items-center justify-center p-6 text-center select-none gap-3"
          >
            <div className="w-12 h-12 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center text-accent mb-1">
              <Link2 size={24} strokeWidth={2} aria-hidden="true" />
            </div>
            <div className="space-y-1.5 max-w-[240px]">
              <p className="text-xs font-semibold text-text-primary">Plugins Unavailable</p>
              <p className="text-[11px] text-text-muted leading-relaxed">
                Plugins not available when terminals are synced in splitted mode
              </p>
            </div>
          </div>
        ) : !activePaneSessionId || !session ? (
          <div className="flex-1 flex items-center justify-center p-4 text-xs text-text-muted">
            No active terminal pane
          </div>
        ) : (
          <PluginTrackersView
            key={activePaneSessionId}
            sessionId={activePaneSessionId}
            initialLogPath={initialLogPath}
          />
        )}
      </div>
    </div>
  );
}
