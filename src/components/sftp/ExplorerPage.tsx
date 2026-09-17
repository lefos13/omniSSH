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
import { PaneSourcePicker } from "./PaneSourcePicker";
import { ExplorerTransferActions } from "./ExplorerTransferActions";
import { DropOverwriteDialog } from "./DropOverwriteDialog";
import { S3Browser } from "../s3/S3Browser";
import { useSftpStore, type LeftPaneSource } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { toast } from "../../stores/toast-store";
import { explorerInvoke, transferEventName, type Transport } from "../../lib/explorer-transport";
import { relayEntries } from "../../lib/explorer-relay";
import { openExplorerSessionForHost } from "../../lib/open-explorer-session";
import { conflictingNames, backupFilename } from "../../lib/drop-conflicts";
import type { ExplorerEntry } from "../../types/explorer";
import type { SftpEntry, SavedHost } from "../../types";
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

/** Server-to-server copy whose destination names already exist. */
interface PendingRelayConflict {
  direction: "relay";
  srcSessionId: string;
  srcTransport: Transport;
  dstSessionId: string;
  dstTransport: Transport;
  /** Absolute source paths to copy. */
  paths: string[];
  /** Destination directory. */
  dstDir: string;
  conflicts: string[];
}

type PendingConflict = PendingUploadConflict | PendingDownloadConflict | PendingRelayConflict;

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

/* Stable "local machine" left-pane source. Must be a module constant: a fresh
 * object per render would make the zustand selector unstable and loop. */
const LOCAL_SOURCE: LeftPaneSource = { kind: "local" };


export function ExplorerPage({
  sftpSessionId,
  transport = "sftp",
  s3SessionId,
  isActive = true,
}: ExplorerPageProps) {
  const sftpSession = useSftpStore((s) => (sftpSessionId ? s.sessions.get(sftpSessionId) : null));
  const s3Session = useS3Store((s) => (s3SessionId ? s.sessions.get(s3SessionId) : null));

  /* Left-pane source: the local machine by default, or another saved host. */
  const leftSource = useSftpStore((s) =>
    sftpSessionId ? s.leftPane.get(sftpSessionId) ?? LOCAL_SOURCE : LOCAL_SOURCE,
  );
  const leftRemoteId = leftSource.kind === "remote" ? leftSource.sftpSessionId : null;
  const leftRemoteSession = useSftpStore((s) =>
    leftRemoteId ? s.sessions.get(leftRemoteId) : undefined,
  );
  const setLeftPane = useSftpStore((s) => s.setLeftPane);
  const closeLeftPane = useSftpStore((s) => s.closeLeftPane);
  const [leftConnecting, setLeftConnecting] = useState(false);

  const [leftSelection, setLeftSelection] = useState<ExplorerEntry[]>([]);
  const [remoteSelection, setRemoteSelection] = useState<ExplorerEntry[]>([]);
  const [localCurrentPath, setLocalCurrentPath] = useState<string>("");
  const [localListing, setLocalListing] = useState<LocalDirectoryListing | null>(null);
  const [localReloadToken, setLocalReloadToken] = useState<number>(0);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  /* Current directory of whichever pane sits on the left (remote panes keep
   * their path in the sftp store rather than local state). */
  const leftCurrentPath =
    leftSource.kind === "remote" ? (leftRemoteSession?.currentPath ?? "") : localCurrentPath;

  // A stale selection from the previous source must not be copied to the new one.
  useEffect(() => {
    setLeftSelection([]);
  }, [leftRemoteId, leftSource.kind]);
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

  // ─── Server-to-server (relay) copies ───────────────────────────────────────

  const runRelay = useCallback(async (conflict: PendingRelayConflict) => {
    setIsBusy(true);
    try {
      await relayEntries({
        srcSessionId: conflict.srcSessionId,
        srcTransport: conflict.srcTransport,
        dstSessionId: conflict.dstSessionId,
        dstTransport: conflict.dstTransport,
        paths: conflict.paths,
        dstDir: conflict.dstDir,
      });
    } catch (err) {
      toast.error(`Copy failed: ${errorMessage(err)}`);
    } finally {
      setIsBusy(false);
    }
  }, []);

  /*
   * Start a relay (or surface the overwrite dialog when names collide). The
   * backend overwrites silently, so the same guard the local upload/download
   * paths use must run here too — otherwise a server-to-server copy would
   * clobber existing files with no warning.
   */
  const startRelay = useCallback(
    async (params: {
      srcSessionId: string;
      srcTransport: Transport;
      dstSessionId: string;
      dstTransport: Transport;
      paths: string[];
      dstDir: string;
    }) => {
      const base: PendingRelayConflict = { direction: "relay", ...params, conflicts: [] };
      let conflicts: string[] = [];
      try {
        const existing = await explorerInvoke<SftpEntry[]>(
          params.dstTransport,
          "list_dir",
          params.dstSessionId,
          { path: params.dstDir },
        );
        conflicts = conflictingNames(params.paths, new Set(existing.map((e) => e.name)));
      } catch {
        // Best-effort pre-check: if list_dir fails, copy directly.
      }

      if (conflicts.length > 0) {
        triggerElementRef.current = (document.activeElement as HTMLElement) ?? null;
        setPendingConflict({ ...base, conflicts });
        return;
      }
      await runRelay(base);
    },
    [runRelay],
  );

  /*
   * Pre-check destination name conflicts before enqueuing remote files for download.
   * Compares selected remote basenames against the local pane's in-memory listing,
   * falling back to local_list_dir if not available.
   * Prompts the user with DropOverwriteDialog (Overwrite / Cancel only) if conflicting names exist.
   */
  const handleCopyToLocal = useCallback(async () => {
    if (!sftpSessionId || remoteSelection.length === 0 || !leftCurrentPath || isBusy) {
      return;
    }

    /* Right host → left host: stream server-to-server instead of staging
     * through the local machine. */
    if (leftSource.kind === "remote") {
      await startRelay({
        srcSessionId: sftpSessionId,
        srcTransport: transport,
        dstSessionId: leftSource.sftpSessionId,
        dstTransport: leftSource.transport,
        paths: remoteSelection.map((e) => e.id),
        dstDir: leftCurrentPath,
      });
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
  }, [sftpSessionId, remoteSelection, leftCurrentPath, leftSource, isBusy, localCurrentPath, localListing, enqueueDownload, transport, startRelay]);


  /*
   * Pre-check destination name conflicts before enqueuing local files for upload.
   * Prompts the user with DropOverwriteDialog if conflicting names exist.
   */
  const handleCopyToRemote = useCallback(async () => {
    if (!sftpSessionId || leftSelection.length === 0 || !sftpSession?.currentPath || isBusy) {
      return;
    }

    /* Left host → right host: stream server-to-server instead of staging
     * through the local machine. */
    if (leftSource.kind === "remote") {
      await startRelay({
        srcSessionId: leftSource.sftpSessionId,
        srcTransport: leftSource.transport,
        dstSessionId: sftpSessionId,
        dstTransport: transport,
        paths: leftSelection.map((e) => e.id),
        dstDir: sftpSession.currentPath,
      });
      return;
    }

    triggerElementRef.current = (document.activeElement as HTMLElement) ?? null;
    const localPaths = leftSelection.map((e) => e.id);
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
  }, [sftpSessionId, leftSelection, leftSource, sftpSession?.currentPath, isBusy, transport, enqueueUpload, startRelay]);

  // ─── Left-pane source switching ────────────────────────────────────────────

  const handleSelectLocalSource = useCallback(() => {
    if (!sftpSessionId) return;
    // closeLeftPane releases any bound remote session and clears the binding.
    void closeLeftPane(sftpSessionId);
  }, [sftpSessionId, closeLeftPane]);

  const handleSelectHostSource = useCallback(
    async (host: SavedHost) => {
      if (!sftpSessionId) return;
      const label = host.label || `${host.username}@${host.host}`;
      setLeftConnecting(true);
      try {
        const opened = await openExplorerSessionForHost(host.id, {
          attemptId: crypto.randomUUID(),
        });
        if (!opened) return;

        useSftpStore
          .getState()
          .openSession(
            opened.sftpSessionId,
            opened.sshSessionId,
            label,
            host.username,
            false,
            host.start_directory ?? undefined,
            opened.transport,
            host.id,
          );

        // Release the previously bound left session (if any) before rebinding.
        await closeLeftPane(sftpSessionId);
        setLeftPane(sftpSessionId, {
          kind: "remote",
          sftpSessionId: opened.sftpSessionId,
          transport: opened.transport,
          label,
          hostId: host.id,
        });
      } catch (err) {
        toast.error(`Could not open ${label}: ${errorMessage(err)}`);
      } finally {
        setLeftConnecting(false);
      }
    },
    [sftpSessionId, closeLeftPane, setLeftPane],
  );

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
    } else if (pending.direction === "download") {
      await enqueueDownload(pending.remotePaths, pending.localDir);
    } else {
      await runRelay(pending);
    }
  }, [pendingConflict, enqueueUpload, enqueueDownload, runRelay]);

  /** Rename conflicting entries in `dir` to <name>.<YYYYMMDD>.bak on `sessionId`. */
  const backupConflictingEntries = useCallback(
    async (sessionId: string, tx: Transport, dir: string, names: string[]) => {
      const date = new Date();
      const at = (name: string) => (dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`);
      for (const name of names) {
        await explorerInvoke(tx, "rename", sessionId, {
          oldPath: at(name),
          newPath: at(backupFilename(name, date)),
        });
      }
    },
    [],
  );

  /*
   * Rename conflicting entries to <name>.<YYYYMMDD>.bak before copying, to
   * preserve the previous versions in the destination. Works for local uploads
   * and for server-to-server relay copies.
   */
  const handleBackupAndCopy = useCallback(async () => {
    const pending = pendingConflict;
    setPendingConflict(null);
    requestAnimationFrame(() => {
      triggerElementRef.current?.focus();
    });
    if (!pending || (pending.direction !== "upload" && pending.direction !== "relay")) return;

    if (pending.direction === "relay") {
      setIsBusy(true);
      try {
        await backupConflictingEntries(
          pending.dstSessionId,
          pending.dstTransport,
          pending.dstDir,
          pending.conflicts,
        );
      } catch (err) {
        setIsBusy(false);
        toast.error(`Backup failed: ${errorMessage(err)}`);
        return;
      }
      await runRelay({ ...pending, conflicts: [] });
      return;
    }

    if (!sftpSessionId) return;
    setIsBusy(true);
    try {
      await backupConflictingEntries(sftpSessionId, transport, pending.remoteDir, pending.conflicts);

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
  }, [
    pendingConflict,
    sftpSessionId,
    transport,
    enqueueUpload,
    runRelay,
    backupConflictingEntries,
  ]);
  /*
   * Refresh destination local pane when a download transfer completes for
   * this active host explorer session. Gated on isActive so hidden mounted tabs
   * do not react to background completions. Failed or cancelled transfers
   * leave the current listing untouched.
   */
  useEffect(() => {
    // Only the local pane needs a refresh token; a remote left pane receives
    // relay progress through the transfers popover instead.
    if (!isActive || !sftpSessionId || leftSource.kind !== "local") return;

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
  }, [isActive, sftpSessionId, transport, leftSource.kind]);

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
            {/* Left pane: local machine or another saved host */}
            <section
              aria-label={leftSource.kind === "remote" ? "Left remote filesystem" : "Local filesystem"}
              data-explorer-pane={leftSource.kind === "remote" ? "left-remote" : "local"}
              className="flex-1 min-w-0 h-full flex flex-col border-r border-border/60"
            >
              <PaneSourcePicker
                source={leftSource}
                excludeHostId={sftpSession?.savedHostId ?? null}
                busy={leftConnecting}
                disabled={isBusy}
                onSelectLocal={handleSelectLocalSource}
                onSelectHost={(host) => void handleSelectHostSource(host)}
              />
              {leftSource.kind === "remote" ? (
                <div className="flex-1 min-h-0 flex flex-col">
                  <ExplorerView
                    sessionId={leftSource.sftpSessionId}
                    transport={leftSource.transport}
                    isActive={isActive}
                    showSudo={false}
                    onSelectionChange={setLeftSelection}
                  />
                </div>
              ) : (
                <LocalExplorerPane
                  isActive={isActive}
                  hostSessionId={sftpSessionId}
                  onSelectionChange={setLeftSelection}
                  onCurrentPathChange={setLocalCurrentPath}
                  onListingChange={setLocalListing}
                  reloadToken={localReloadToken}
                />
              )}
            </section>

            {/* Center transfer action rail */}
            <ExplorerTransferActions
              localSelectedCount={leftSelection.length}
              remoteSelectedCount={remoteSelection.length}
              hasRemoteDir={Boolean(sftpSession?.currentPath)}
              hasLocalDir={Boolean(leftCurrentPath)}
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
        {pendingConflict && (() => {
          const isRelay = pendingConflict.direction === "relay";
          const isUpload = pendingConflict.direction === "upload";
          return (
            <DropOverwriteDialog
              conflicts={pendingConflict.conflicts}
              targetDir={
                isRelay
                  ? pendingConflict.dstDir
                  : isUpload
                    ? pendingConflict.remoteDir
                    : pendingConflict.localDir
              }
              onConfirm={() => void handleConfirmOverwrite()}
              onBackupAndCopy={
                isUpload || isRelay ? () => void handleBackupAndCopy() : undefined
              }
              onCancel={handleCancelConflict}
              actionVerb={isRelay ? "copying" : isUpload ? "uploading" : "downloading"}
            />
          );
        })()}
      </div>
    </div>
  );
}
