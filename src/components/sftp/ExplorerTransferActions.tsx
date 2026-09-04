/*
 * Transfer actions rail between local and remote explorer panes.
 *
 * Exposes explicit copy controls for dual-pane transfers:
 * - "Copy selected to remote" (Task 2): queues selected local files/folders
 *   into the remote host's current directory via SFTP/SCP.
 * - "Copy selected to local" (Task 3): queues selected remote files/folders
 *   into the local filesystem directory.
 * Disables buttons when selections are empty, when destinations are unknown,
 * or while an enqueue operation is in flight to prevent duplicate queueing.
 */

import { ArrowRight, ArrowLeft, Loader2 } from "lucide-react";

export interface ExplorerTransferActionsProps {
  /** Number of items selected in the local pane. */
  localSelectedCount: number;
  /** Number of items selected in the remote pane (for Task 3). */
  remoteSelectedCount?: number;
  /** Whether the remote current directory is known. */
  hasRemoteDir: boolean;
  /** Whether the local current directory is known (for Task 3). */
  hasLocalDir?: boolean;
  /** Whether a transfer enqueue operation is currently in flight. */
  busy?: boolean;
  /** Callback to copy selected local entries to the remote directory. */
  onCopyToRemote: () => void;
  /** Callback to copy selected remote entries to the local directory (for Task 3). */
  onCopyToLocal?: () => void;
  /** Optional custom class name. */
  className?: string;
}

export function ExplorerTransferActions({
  localSelectedCount,
  remoteSelectedCount = 0,
  hasRemoteDir,
  hasLocalDir = true,
  busy = false,
  onCopyToRemote,
  onCopyToLocal,
  className = "",
}: ExplorerTransferActionsProps) {
  const canCopyToRemote = localSelectedCount > 0 && hasRemoteDir && !busy;
  const canCopyToLocal = remoteSelectedCount > 0 && hasLocalDir && !busy;

  const remoteCountText =
    localSelectedCount === 1 ? "1 item" : `${localSelectedCount} items`;
  const copyToRemoteLabel = busy
    ? `Copy selected to remote (${remoteCountText}) — transfer in progress`
    : `Copy selected to remote (${remoteCountText})`;

  const localCountText =
    remoteSelectedCount === 1 ? "1 item" : `${remoteSelectedCount} items`;
  const copyToLocalLabel = busy
    ? `Copy selected to local (${localCountText}) — transfer in progress`
    : `Copy selected to local (${localCountText})`;

  const buttonBaseClass = [
    "flex items-center justify-center w-7 h-7 rounded-md",
    "text-text-secondary hover:text-text-primary bg-bg-surface hover:bg-bg-subtle active:bg-bg-muted",
    "border border-border/60 transition-colors duration-[var(--duration-fast)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-bg-base",
    "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-bg-surface disabled:hover:text-text-secondary",
    "aria-disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-bg-surface aria-disabled:hover:text-text-secondary",
  ].join(" ");

  return (
    <aside
      aria-label="Transfer actions"
      data-explorer-action-rail="true"
      className={`flex flex-col items-center justify-center gap-2 w-9 shrink-0 bg-bg-surface/50 border-r border-border/60 select-none ${className}`}
    >
      {/* Copy selected local entries to remote directory */}
      <button
        type="button"
        data-testid="explorer-copy-to-remote"
        title={copyToRemoteLabel}
        aria-label={copyToRemoteLabel}
        aria-busy={busy}
        disabled={!canCopyToRemote}
        onClick={onCopyToRemote}
        className={buttonBaseClass}
      >
        {busy ? (
          <Loader2 size={15} strokeWidth={2} className="animate-spin text-text-primary" aria-hidden="true" />
        ) : (
          <ArrowRight size={15} strokeWidth={2} aria-hidden="true" />
        )}
      </button>

      {/* Copy selected remote entries to local directory */}
      <button
        type="button"
        data-testid="explorer-copy-to-local"
        title={copyToLocalLabel}
        aria-label={copyToLocalLabel}
        aria-busy={busy}
        disabled={!canCopyToLocal}
        onClick={onCopyToLocal}
        className={buttonBaseClass}
      >
        {busy ? (
          <Loader2 size={15} strokeWidth={2} className="animate-spin text-text-primary" aria-hidden="true" />
        ) : (
          <ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
    </aside>
  );
}
