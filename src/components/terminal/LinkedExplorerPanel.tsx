/*
 * Linked terminal explorer panel.
 * Displays a side panel bound to the active terminal pane's SSH session,
 * rendering the remote filesystem via ExplorerView with live OSC 7 working-directory
 * synchronization, session-local shell integration shortcuts, and explicit terminal
 * directory navigation. Only connects and rebinds while the owning tab is active.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  FolderOpen,
  X,
  Compass,
  Terminal as TerminalIcon,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useSessionStore } from "../../stores/session-store";
import type { LayoutNode } from "../../types";
import { useLinkedExplorerStore } from "../../stores/linked-explorer-store";
import { useSftpStore } from "../../stores/sftp-store";
import { getTerminal } from "../../stores/terminal-instances";
import { ExplorerView } from "../sftp/ExplorerView";
import { sendCdToTerminal, enableShellSync, type SupportedShell } from "../../lib/shell-sync";

interface LinkedExplorerPanelProps {
  tabId: string;
  isActive?: boolean;
}

/** Collect all session IDs in a layout node */
function collectSessionIds(node: LayoutNode): string[] {
  if (node.type === "pane") return [node.sessionId];
  return [
    ...collectSessionIds(node.children[0]),
    ...collectSessionIds(node.children[1]),
  ];
}

export function LinkedExplorerPanel({ tabId, isActive = true }: LinkedExplorerPanelProps) {
  const termTab = useSessionStore((s) => s.tabs.get(tabId));
  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  // Retain the active pane for this tab so switching away to another tab
  // doesn't cause a hidden tab to reset or rebind its pane unexpectedly.
  const [retainedPaneId, setRetainedPaneId] = useState<string | null>(null);

  const tabSessionIds = useMemo(() => {
    return termTab ? collectSessionIds(termTab.layout) : [];
  }, [termTab]);

  useEffect(() => {
    if (isActive && activeSessionId && tabSessionIds.includes(activeSessionId)) {
      setRetainedPaneId(activeSessionId);
    }
  }, [isActive, activeSessionId, tabSessionIds]);

  // Find the active pane in this tab
  const activePaneSessionId = useMemo(() => {
    if (isActive && activeSessionId && tabSessionIds.includes(activeSessionId)) {
      return activeSessionId;
    }
    if (retainedPaneId && tabSessionIds.includes(retainedPaneId)) {
      return retainedPaneId;
    }
    return tabSessionIds[0] ?? null;
  }, [isActive, activeSessionId, retainedPaneId, tabSessionIds]);

  const session = useSessionStore((s) =>
    activePaneSessionId ? s.sessions.get(activePaneSessionId) : null,
  );

  const binding = useLinkedExplorerStore((s) => s.bindings.get(tabId));
  const ensureConnected = useLinkedExplorerStore((s) => s.ensureConnected);
  const closeLinkedExplorer = useLinkedExplorerStore((s) => s.closeLinkedExplorer);
  const followPath = useLinkedExplorerStore((s) => s.followPath);
  const setFollowPath = useLinkedExplorerStore((s) => s.setFollowPath);

  const sftpSession = useSftpStore((s) =>
    binding?.sftpSessionId ? s.sessions.get(binding.sftpSessionId) : null,
  );
  const currentPath = sftpSession?.currentPath ?? "/";

  // Rebind / connect whenever active pane session changes ONLY if this tab is active
  useEffect(() => {
    if (!isActive) return;
    if (activePaneSessionId && session?.status === "Connected") {
      void ensureConnected(tabId, activePaneSessionId);
    }
  }, [isActive, tabId, activePaneSessionId, session?.status, ensureConnected]);

  // ─── Debounced OSC 7 remoteCwd follow ────────────────────────────────────

  const [debouncedNavPath, setDebouncedNavPath] = useState<string | null>(null);
  const remoteCwd = session?.remoteCwd ?? null;

  useEffect(() => {
    if (!followPath || !remoteCwd) {
      setDebouncedNavPath(null);
      return;
    }

    const timer = setTimeout(() => {
      setDebouncedNavPath(remoteCwd);
    }, 200);

    return () => clearTimeout(timer);
  }, [remoteCwd, followPath]);

  // ─── Sync menu state & click-away / Escape navigation ────────────────────

  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const syncMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!syncMenuOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSyncMenuOpen(false);
        triggerRef.current?.focus();
      }
    }
    function handlePointerDown(e: MouseEvent) {
      if (syncMenuRef.current && !syncMenuRef.current.contains(e.target as Node)) {
        setSyncMenuOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [syncMenuOpen]);

  const handleShellEnable = useCallback(
    async (shell: SupportedShell) => {
      setSyncMenuOpen(false);
      triggerRef.current?.focus();
      if (!activePaneSessionId) return;
      try {
        await enableShellSync(activePaneSessionId, shell);
      } catch (err) {
        console.error(`Failed to enable ${shell} sync:`, err);
      }
    },
    [activePaneSessionId],
  );

  const handleCdToTerminal = useCallback(
    (targetPath: string) => {
      if (!activePaneSessionId) return;
      void sendCdToTerminal(activePaneSessionId, targetPath);
    },
    [activePaneSessionId],
  );

  const handleClose = useCallback(() => {
    closeLinkedExplorer(tabId);
    if (activePaneSessionId) {
      const term = getTerminal(activePaneSessionId);
      term?.term.focus();
    }
  }, [closeLinkedExplorer, tabId, activePaneSessionId]);

  const isCwdSynced = session?.cwdSyncActive ?? false;

  const btnClass =
    "inline-flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-bg-muted transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <div
      data-testid="linked-explorer-panel"
      className="flex flex-col h-full rounded-lg overflow-hidden border border-border/60 bg-bg-surface/90 shadow-sm"
    >
      {/* ─── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center h-8 px-2 gap-1.5 shrink-0 no-select border-b border-border/60 bg-bg-surface/80">
        <FolderOpen
          size={14}
          strokeWidth={1.8}
          className="shrink-0 text-accent"
          aria-hidden="true"
        />

        <span className="text-[11px] font-medium truncate flex-1 min-w-0 text-text-primary leading-none">
          Files
          {binding?.transport === "scp" && (
            <span className="ml-1 text-[10px] text-text-muted font-normal font-mono">
              · SCP
            </span>
          )}
        </span>

        {/* Sync status button / dropdown trigger */}
        <div className="relative" ref={syncMenuRef}>
          <button
            ref={triggerRef}
            type="button"
            data-testid="linked-explorer-sync-status"
            onClick={() => setSyncMenuOpen((v) => !v)}
            aria-expanded={syncMenuOpen}
            aria-haspopup="menu"
            title={
              isCwdSynced
                ? `CWD sync active (${remoteCwd ?? ""})`
                : "CWD sync inactive — click to enable for shell"
            }
            className={[
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors",
              isCwdSynced
                ? "text-status-connected bg-status-connected/10 hover:bg-status-connected/20"
                : "text-text-muted bg-bg-muted hover:bg-bg-subtle hover:text-text-secondary",
            ].join(" ")}
          >
            {isCwdSynced ? (
              <CheckCircle2 size={11} strokeWidth={2.2} className="shrink-0" />
            ) : (
              <RefreshCw size={10} strokeWidth={2} className="shrink-0 opacity-70" />
            )}
            <span>{isCwdSynced ? "Synced" : "Sync CWD"}</span>
            <ChevronDown size={10} strokeWidth={2} className="shrink-0 opacity-60" />
          </button>

          {/* Sync menu dropdown */}
          {syncMenuOpen && (
            <div
              data-testid="linked-explorer-sync-menu"
              role="menu"
              className="absolute right-0 top-full mt-1 w-56 rounded-md border border-border bg-bg-surface p-1 shadow-xl z-50 text-xs"
            >
              <div className="px-2 py-1.5 border-b border-border/50 mb-1">
                <div className="font-semibold text-text-primary text-[11px] flex items-center gap-1">
                  <Sparkles size={12} className="text-accent" />
                  Shell CWD Sync (OSC 7)
                </div>
                <div className="text-[10px] text-text-muted mt-0.5">
                  Session-local · Does not modify remote rc files
                </div>
              </div>

              <button
                type="button"
                role="menuitem"
                data-testid="linked-explorer-sync-bash"
                onClick={() => void handleShellEnable("bash")}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-bg-subtle text-text-primary hover:text-accent transition-colors flex items-center justify-between text-[11px]"
              >
                <span>Enable for Bash</span>
                <span className="text-[10px] text-text-muted font-mono">PROMPT_COMMAND</span>
              </button>

              <button
                type="button"
                role="menuitem"
                data-testid="linked-explorer-sync-zsh"
                onClick={() => void handleShellEnable("zsh")}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-bg-subtle text-text-primary hover:text-accent transition-colors flex items-center justify-between text-[11px]"
              >
                <span>Enable for Zsh</span>
                <span className="text-[10px] text-text-muted font-mono">chpwd_functions</span>
              </button>

              <button
                type="button"
                role="menuitem"
                data-testid="linked-explorer-sync-fish"
                onClick={() => void handleShellEnable("fish")}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-bg-subtle text-text-primary hover:text-accent transition-colors flex items-center justify-between text-[11px]"
              >
                <span>Enable for Fish</span>
                <span className="text-[10px] text-text-muted font-mono">--on-variable PWD</span>
              </button>

              <div className="my-1 border-t border-border/40" />

              <button
                type="button"
                role="menuitem"
                data-testid="linked-explorer-sync-now"
                onClick={() => void handleShellEnable("oneshot")}
                className="w-full text-left px-2 py-1.5 rounded hover:bg-bg-subtle text-text-primary hover:text-accent transition-colors flex items-center justify-between text-[11px]"
              >
                <span>Trigger sync once</span>
                <span className="text-[10px] text-text-muted font-mono">printf OSC 7</span>
              </button>
            </div>
          )}
        </div>

        {/* Follow path toggle */}
        <button
          type="button"
          data-testid="linked-explorer-follow-toggle"
          onClick={() => setFollowPath(!followPath)}
          aria-pressed={followPath}
          title={
            followPath
              ? "Follow terminal working directory (active)"
              : "Auto-follow paused (click to follow terminal directory)"
          }
          className={[
            btnClass,
            followPath
              ? "text-accent hover:text-accent-hover bg-accent/10"
              : "text-text-muted hover:text-text-primary",
          ].join(" ")}
        >
          <Compass size={13} strokeWidth={1.8} aria-hidden="true" />
        </button>

        {/* cd here button */}
        <button
          type="button"
          data-testid="linked-explorer-cd-terminal"
          onClick={() => handleCdToTerminal(currentPath)}
          title={`Change terminal directory to ${currentPath}`}
          aria-label="cd here in terminal"
          className={btnClass}
        >
          <TerminalIcon size={13} strokeWidth={1.8} aria-hidden="true" />
        </button>

        {/* Close linked explorer */}
        <button
          type="button"
          data-testid="linked-explorer-close"
          onClick={handleClose}
          title="Close file explorer"
          aria-label="Close file explorer"
          className={btnClass}
        >
          <X size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      {/* ─── Body ────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 relative flex flex-col bg-bg-base overflow-hidden">
        {!activePaneSessionId || !session ? (
          <div className="flex-1 flex items-center justify-center p-4 text-xs text-text-muted">
            No active terminal pane
          </div>
        ) : binding?.status === "connecting" ? (
          <div
            data-testid="linked-explorer-loading"
            className="flex-1 flex flex-col items-center justify-center p-4 gap-2.5 text-xs text-text-muted"
          >
            <Loader2 size={18} strokeWidth={2} className="animate-spin text-accent" />
            <span>Connecting to remote filesystem...</span>
          </div>
        ) : binding?.status === "error" ? (
          <div
            data-testid="linked-explorer-error"
            className="flex-1 flex flex-col items-center justify-center p-4 gap-2.5 text-xs text-center text-status-error"
          >
            <AlertCircle size={20} strokeWidth={2} />
            <p className="max-w-[240px] leading-relaxed">{binding.error || "Connection failed"}</p>
            <button
              type="button"
              onClick={() => void ensureConnected(tabId, activePaneSessionId)}
              className="mt-1 px-2.5 py-1 rounded bg-bg-subtle text-text-primary hover:bg-bg-muted border border-border text-xs transition-colors"
            >
              Retry
            </button>
          </div>
        ) : binding?.status === "connected" && binding.sftpSessionId ? (
          <div
            className="flex-1 min-h-0 flex flex-col overflow-hidden"
            data-explorer-transport={binding.transport}
          >
            <ExplorerView
              sessionId={binding.sftpSessionId}
              transport={binding.transport}
              isActive={isActive}
              onCdToTerminal={handleCdToTerminal}
              externalNavigatePath={debouncedNavPath}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
