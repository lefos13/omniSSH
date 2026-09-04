/*
 * Host explorer page container.
 *
 * Renders standalone host explorer tabs: for SFTP/SCP sessions, a dual-pane
 * layout is displayed with the local filesystem browser on the left and the
 * remote host explorer on the right. S3 sessions continue to render as a
 * single-pane bucket browser. Preserves remote transport and session data
 * attributes for E2E selector compatibility.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { FolderOpen, Cloud } from "lucide-react";
import { ExplorerView } from "./ExplorerView";
import { LocalExplorerPane } from "./LocalExplorerPane";
import { ExplorerTransferActions } from "./ExplorerTransferActions";
import { DropOverwriteDialog } from "./DropOverwriteDialog";
import { S3Browser } from "../s3/S3Browser";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { toast } from "../../stores/toast-store";
import { explorerInvoke, transferEventName, type Transport } from "../../lib/explorer-transport";
import { conflictingNames, backupFilename } from "../../lib/drop-conflicts";
import type { ExplorerEntry } from "../../types/explorer";
import type { SftpEntry } from "../../types";
import type { LocalDirectoryListing } from "../../types/local-fs";
interface ExplorerPageProps {
  /** SFTP/SCP transport session id (both live in the sftp store). */
  sftpSessionId?: string;
  /** Defaults to "sftp"; "scp" when the host fell back to SCP. */
  transport?: Transport;
  s3SessionId?: string;
  /** Whether this tab is the active/visible one. Explorer tabs stay mounted
   *  (issue #17), so document-level listeners must only fire for the active one. */
  isActive?: boolean;
}
interface PendingUploadConflict {
  direction: "upload";
  localPaths: string[];
  remoteDir: string;
  conflicts: string[];
}

interface PendingDownloadConflict {
  direction: "download";
  remotePaths: string[];
  localDir: string;
  conflicts: string[];
}

type PendingConflict = PendingUploadConflict | PendingDownloadConflict;

/*
 * Extract human-readable error message from backend error payloads.
 */
function errorMessage(err: unknown, fallback = "Unexpected error"): string {
  if (err && typeof err === "object" && "message" in err) {
    const msg = err.message;
    return typeof msg === "string" ? msg : String(msg);
  }
  return typeof err === "string" ? err : fallback;
}


export function ExplorerPage({
  sftpSessionId,
  transport = "sftp",
  s3SessionId,
  isActive = true,
}: ExplorerPageProps) {
  const sftpSession = useSftpStore((s) => (sftpSessionId ? s.sessions.get(sftpSessionId) : null));
  const s3Session = useS3Store((s) => (s3SessionId ? s.sessions.get(s3SessionId) : null));

  const [localSelection, setLocalSelection] = useState<ExplorerEntry[]>([]);
  const [remoteSelection, setRemoteSelection] = useState<ExplorerEntry[]>([]);
  const [localCurrentPath, setLocalCurrentPath] = useState<string>("");
  const [localListing, setLocalListing] = useState<LocalDirectoryListing | null>(null);
  const [localReloadToken, setLocalReloadToken] = useState<number>(0);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);
  /*
   * Enqueue upload jobs for local paths into the remote directory.
   * Surfaces failures via the toast store while per-file transfer progress
   * and errors continue to report through the transfer popover.
   */
  const enqueueUpload = useCallback(
    async (localPaths: string[], remoteDir: string) => {
      if (!sftpSessionId || localPaths.length === 0) return;
      setIsBusy(true);
      try {
        await explorerInvoke(transport, "enqueue_upload", sftpSessionId, {
          localPaths,
          remoteDir,
        });
      } catch (err) {
        toast.error(`Upload failed: ${errorMessage(err)}`);
      } finally {
        setIsBusy(false);
        requestAnimationFrame(() => {
          if (document.activeElement === document.body && triggerElementRef.current?.isConnected) {
            triggerElementRef.current.focus();
          }
        });
      }
    },
    [sftpSessionId, transport],
  );
  /*
   * Enqueue download jobs for remote paths into the local directory.
   * Surfaces failures via the toast store while per-file transfer progress
   * and errors continue to report through the transfer popover.
   */
  const enqueueDownload = useCallback(
    async (remotePaths: string[], localDir: string) => {
      if (!sftpSessionId || remotePaths.length === 0) return;
      setIsBusy(true);
      try {
        await explorerInvoke(transport, "enqueue_download", sftpSessionId, {
          remotePaths,
          localDir,
        });
      } catch (err) {
        toast.error(`Download failed: ${errorMessage(err)}`);
      } finally {
        setIsBusy(false);
        requestAnimationFrame(() => {
          if (document.activeElement === document.body && triggerElementRef.current?.isConnected) {
            triggerElementRef.current.focus();
          }
        });
      }
    },
    [sftpSessionId, transport],
  );

  /*
   * Pre-check destination name conflicts before enqueuing remote files for download.
   * Compares selected remote basenames against the local pane's in-memory listing,
   * falling back to local_list_dir if not available.
   * Prompts the user with DropOverwriteDialog (Overwrite / Cancel only) if conflicting names exist.
   */
  const handleCopyToLocal = useCallback(async () => {
    if (!sftpSessionId || remoteSelection.length === 0 || !localCurrentPath || isBusy) {
      return;
    }
    triggerElementRef.current = (document.activeElement as HTMLElement) ?? null;
    const remotePaths = remoteSelection.map((e) => e.id);
    const localDir = localCurrentPath;

    setIsBusy(true);
    let conflicts: string[] = [];
    try {
      let existingNames: Set<string>;
      if (localListing && localListing.path === localDir) {
        existingNames = new Set(localListing.entries.map((e) => e.name));
      } else {
        // Dynamic import enables Vitest module mocking in unit tests and non-Tauri contexts
        const { invoke } = await import("@tauri-apps/api/core");
        const list = await invoke<LocalDirectoryListing>("local_list_dir", { path: localDir });
        existingNames = new Set(list.entries.map((e) => e.name));
      }
      conflicts = conflictingNames(remotePaths, existingNames);
    } catch {
      // Best-effort pre-check: if listing fails, proceed directly to download
    }

    if (conflicts.length > 0) {
      setIsBusy(false);
      setPendingConflict({
        direction: "download",
        remotePaths,
        localDir,
        conflicts,
      });
      return;
    }

    await enqueueDownload(remotePaths, localDir);
  }, [sftpSessionId, remoteSelection, localCurrentPath, isBusy, localListing, enqueueDownload]);


  /*
   * Pre-check destination name conflicts before enqueuing local files for upload.
   * Prompts the user with DropOverwriteDialog if conflicting names exist.
   */
  const handleCopyToRemote = useCallback(async () => {
    if (!sftpSessionId || localSelection.length === 0 || !sftpSession?.currentPath || isBusy) {
      return;
    }
    triggerElementRef.current = (document.activeElement as HTMLElement) ?? null;
    const localPaths = localSelection.map((e) => e.id);
    const remoteDir = sftpSession.currentPath;

    setIsBusy(true);
    let conflicts: string[] = [];
    try {
      const existing = await explorerInvoke<SftpEntry[]>(transport, "list_dir", sftpSessionId, {
        path: remoteDir,
      });
      conflicts = conflictingNames(localPaths, new Set(existing.map((e) => e.name)));
    } catch {
      // Best-effort pre-check: if list_dir fails, proceed directly to upload
    }

    if (conflicts.length > 0) {
      setIsBusy(false);
      setPendingConflict({
        direction: "upload",
        localPaths,
        remoteDir,
        conflicts,
      });
      return;
    }

    await enqueueUpload(localPaths, remoteDir);
  }, [sftpSessionId, localSelection, sftpSession?.currentPath, isBusy, transport, enqueueUpload]);

  const handleCancelConflict = useCallback(() => {
    setPendingConflict(null);
    requestAnimationFrame(() => {
      triggerElementRef.current?.focus();
    });
  }, []);

  const handleConfirmOverwrite = useCallback(async () => {
    const pending = pendingConflict;
    setPendingConflict(null);
    requestAnimationFrame(() => {
      triggerElementRef.current?.focus();
    });
    if (!pending) return;
    if (pending.direction === "upload") {
      await enqueueUpload(pending.localPaths, pending.remoteDir);
    } else {
      await enqueueDownload(pending.remotePaths, pending.localDir);
    }
  }, [pendingConflict, enqueueUpload, enqueueDownload]);

  /*
   * Rename conflicting remote entries to <name>.<YYYYMMDD>.bak before enqueuing
   * upload to preserve previous versions in the destination.
   */
  const handleBackupAndCopy = useCallback(async () => {
    const pending = pendingConflict;
    setPendingConflict(null);
    requestAnimationFrame(() => {
      triggerElementRef.current?.focus();
    });
    if (!pending || pending.direction !== "upload" || !sftpSessionId) return;
    setIsBusy(true);
    try {
      const date = new Date();
      for (const name of pending.conflicts) {
        const oldPath = pending.remoteDir.endsWith("/")
          ? `${pending.remoteDir}${name}`
          : `${pending.remoteDir}/${name}`;
        const newName = backupFilename(name, date);
        const newPath = pending.remoteDir.endsWith("/")
          ? `${pending.remoteDir}${newName}`
          : `${pending.remoteDir}/${newName}`;
        await explorerInvoke(transport, "rename", sftpSessionId, { oldPath, newPath });
      }

      try {
        const entries = await explorerInvoke<SftpEntry[]>(transport, "list_dir", sftpSessionId, {
          path: pending.remoteDir,
        });
        useSftpStore.getState().setEntries(sftpSessionId, pending.remoteDir, entries);
      } catch {
        // Best-effort reload; transfer completion also triggers reload
      }

      await enqueueUpload(pending.localPaths, pending.remoteDir);
    } catch (err) {
      setIsBusy(false);
      toast.error(`Backup failed: ${errorMessage(err)}`);
    }
  }, [pendingConflict, sftpSessionId, transport, enqueueUpload]);
  /*
   * Refresh destination local pane when a download transfer completes for
   * this active host explorer session. Gated on isActive so hidden mounted tabs
   * do not react to background completions. Failed or cancelled transfers
   * leave the current listing untouched.
   */
  useEffect(() => {
    if (!isActive || !sftpSessionId) return;

    let unlisten: (() => void) | undefined;
    let aborted = false;

    (async () => {
      try {
        // Dynamic import enables Vitest module mocking in unit tests and non-Tauri contexts
        const { listen } = await import("@tauri-apps/api/event");

        const unsub = await listen<{
          sftp_session_id?: string;
          scp_session_id?: string;
          direction: string;
          status: string;
        }>(transferEventName(transport), (event) => {
          const { direction, status } = event.payload;
          const sid = transport === "scp" ? event.payload.scp_session_id : event.payload.sftp_session_id;
          if (sid === sftpSessionId && direction === "Download" && status === "Completed") {
            setLocalReloadToken((v) => v + 1);
          }
        });

        if (aborted) {
          unsub();
        } else {
          unlisten = unsub;
        }
      } catch {
        // Not in Tauri context
      }
    })();

    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [isActive, sftpSessionId, transport]);

  const baseLabel = sftpSession?.label ?? s3Session?.label ?? "Explorer";
  // Surface SCP fallback subtly so the user understands why server-side
  // metadata (timestamps, etc.) may look slightly different.
  const label = sftpSessionId && transport === "scp" ? `${baseLabel} · SCP` : baseLabel;
  const isSftp = !!sftpSessionId;
  const Icon = isSftp ? FolderOpen : Cloud;

  return (
    <div className="flex flex-col h-full p-2">
      <div className="flex flex-col flex-1 min-h-0 rounded-lg overflow-hidden border border-border/60">
        {/* Pane header — matching terminal pane style */}
        <div className="flex items-center h-8 px-2.5 gap-2.5 shrink-0 no-select bg-bg-surface/80 border-b border-border/60">
          <Icon size={14} strokeWidth={1.8} className="shrink-0 text-status-connected" aria-hidden="true" />
          <span className="text-[11px] font-mono truncate flex-1 min-w-0 text-text-primary leading-none" title={label}>
            {label}
          </span>
        </div>

        {/* Browser content */}
        {sftpSessionId && (
          <div className="flex flex-1 min-h-0 h-full bg-bg-base">
            {/* Left pane: Local filesystem */}
            <section
              aria-label="Local filesystem"
              data-explorer-pane="local"
              className="flex-1 min-w-0 h-full flex flex-col border-r border-border/60"
            >
              <LocalExplorerPane
                isActive={isActive}
                hostSessionId={sftpSessionId}
                onSelectionChange={setLocalSelection}
                onCurrentPathChange={setLocalCurrentPath}
                onListingChange={setLocalListing}
                reloadToken={localReloadToken}
              />
            </section>

            {/* Center transfer action rail */}
            <ExplorerTransferActions
              localSelectedCount={localSelection.length}
              remoteSelectedCount={remoteSelection.length}
              hasRemoteDir={Boolean(sftpSession?.currentPath)}
              hasLocalDir={Boolean(localCurrentPath)}
              busy={isBusy}
              onCopyToRemote={() => void handleCopyToRemote()}
              onCopyToLocal={() => void handleCopyToLocal()}
            />

            {/* Right pane: Remote host filesystem */}
            <section
              aria-label="Remote filesystem"
              data-explorer-pane="remote"
              className="flex-1 min-w-0 h-full flex flex-col"
              data-session-id={sftpSessionId}
              data-explorer-session-id={sftpSessionId}
              data-explorer-transport={transport}
            >
              <ExplorerView
                sessionId={sftpSessionId}
                transport={transport}
                isActive={isActive}
                onSelectionChange={setRemoteSelection}
              />
            </section>
          </div>
        )}

        {s3SessionId && (
          <div
            className="flex-1 min-h-0 bg-bg-base"
            data-session-id={s3SessionId}
            data-explorer-session-id={s3SessionId}
            data-explorer-transport="s3"
          >
            <S3Browser sessionId={s3SessionId} isActive={isActive} />
          </div>
        )}
        {pendingConflict && (
          <DropOverwriteDialog
            conflicts={pendingConflict.conflicts}
            targetDir={pendingConflict.direction === "upload" ? pendingConflict.remoteDir : pendingConflict.localDir}
            onConfirm={() => void handleConfirmOverwrite()}
            onBackupAndCopy={pendingConflict.direction === "upload" ? () => void handleBackupAndCopy() : undefined}
            onCancel={handleCancelConflict}
            actionVerb={pendingConflict.direction === "upload" ? "uploading" : "downloading"}
          />
        )}
      </div>
    </div>
  );
}
