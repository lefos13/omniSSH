/*
 * Global header for split terminal sessions.
 * Displays tab-level actions when in split mode: file explorer toggle
 * and parallel input synchronization (link/broadcast) toggle, avoiding
 * redundant per-pane controls across split sessions.
 */

import { Columns2, FolderOpen, Link2, Unlink2 } from "lucide-react";
import { useSessionStore, countPanes, computeTabLabel } from "../../stores/session-store";
import { useLinkedExplorerStore } from "../../stores/linked-explorer-store";
import type { LayoutNode } from "../../types";

interface SplitGlobalHeaderProps {
  tabId: string;
  layout: LayoutNode;
}

export function SplitGlobalHeader({ tabId, layout }: SplitGlobalHeaderProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const isSynced = useSessionStore((s) => s.isTabSynced(tabId));
  const toggleSyncPanes = useSessionStore((s) => s.toggleSyncPanes);
  const isLinkedOpen = useLinkedExplorerStore((s) => s.openTabIds.has(tabId));
  const toggleLinkedExplorer = useLinkedExplorerStore((s) => s.toggleLinkedExplorer);

  const paneCount = countPanes(layout);
  const tabLabel = computeTabLabel(layout, sessions);

  const btnClass =
    "inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring select-none";

  return (
    <div
      data-testid="split-global-header"
      className="flex items-center justify-between h-8 px-2.5 mb-1.5 shrink-0 rounded-md border border-border/50 bg-bg-surface/70 backdrop-blur-xs no-select"
    >
      {/* Left: split summary and synced badge */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-text-muted min-w-0">
          <Columns2 size={13} className="text-accent shrink-0" aria-hidden="true" />
          <span className="text-[11px] font-medium text-text-primary truncate">
            Split Sessions
          </span>
          <span className="text-[10px] text-text-muted font-mono truncate">
            ({paneCount}) · {tabLabel}
          </span>
        </div>

        {isSynced && (
          <span
            data-testid="split-synced-badge"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/15 text-accent border border-accent/30 shrink-0 animate-in fade-in duration-150"
            title="Parallel command execution is active: keystrokes broadcast to all sessions in this tab"
          >
            <Link2 size={10} strokeWidth={2.5} aria-hidden="true" />
            Synced
          </span>
        )}
      </div>

      {/* Right: global actions (Link all + Explorer) */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Parallel execution / sync toggle */}
        <button
          type="button"
          onClick={() => toggleSyncPanes(tabId)}
          className={[
            btnClass,
            isSynced
              ? "text-accent hover:text-accent-hover bg-accent/15 border border-accent/30 shadow-[0_0_8px_oklch(var(--accent)/.2)]"
              : "text-text-muted hover:text-text-primary hover:bg-bg-muted border border-transparent",
          ].join(" ")}
          data-testid="pane-sync-toggle"
          aria-label={isSynced ? "Unlink terminal input" : "Link terminal input"}
          aria-pressed={isSynced}
          title={
            isSynced
              ? "Unlink terminal input (currently broadcasting to all split panes) (⌥⌘S)"
              : "Link terminal input (broadcast to all split panes in this tab) (⌥⌘S)"
          }
        >
          {isSynced ? (
            <Link2 size={13} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Unlink2 size={13} strokeWidth={1.8} aria-hidden="true" />
          )}
          <span>{isSynced ? "Linked" : "Link Input"}</span>
        </button>

        {/* Linked Explorer toggle */}
        <button
          type="button"
          onClick={() => toggleLinkedExplorer(tabId)}
          className={[
            btnClass,
            isLinkedOpen
              ? "text-accent hover:text-accent-hover bg-accent/15 border border-accent/30"
              : "text-text-muted hover:text-text-primary hover:bg-bg-muted border border-transparent",
          ].join(" ")}
          data-testid="pane-linked-explorer-toggle"
          aria-label={isLinkedOpen ? "Close file explorer" : "Open file explorer"}
          title={isLinkedOpen ? "Close file explorer (⇧⌘E)" : "Open file explorer (⇧⌘E)"}
        >
          <FolderOpen size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>Explorer</span>
        </button>
      </div>
    </div>
  );
}
