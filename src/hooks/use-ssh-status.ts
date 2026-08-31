import { useEffect } from "react";
import { useSessionStore } from "../stores/session-store";
import { useSftpStore } from "../stores/sftp-store";
import { useTabStore } from "../stores/tab-store";
import { useLinkedExplorerStore } from "../stores/linked-explorer-store";
import type { SshStatusPayload } from "../types";
import { closeExplorerSession, resolveExplorerTransport } from "../lib/explorer-transport";

/*
 * A lost SSH transport invalidates every explorer channel attached to it.
 * Clear linked bindings first because they own panel state as well as protocol
 * sessions. The remaining store entries are standalone tabs and use their
 * session transport before falling back to tab metadata.
 */
async function cleanupDisconnectedSftpSessions(sshSessionId: string): Promise<void> {
  await useLinkedExplorerStore.getState().disconnectBindingsForSshSession(sshSessionId);

  const sessions = [...useSftpStore.getState().sessions.values()]
    .filter((session) => session.sshSessionId === sshSessionId)
    .map((session) => {
      const tab = useTabStore.getState().tabs.get(session.sftpSessionId);
      const transport = resolveExplorerTransport(
        session,
        tab?.type === "sftp" ? tab.transport : undefined,
      ) ?? "sftp";
      return {
        sftpSessionId: session.sftpSessionId,
        transport,
      };
    });
  if (sessions.length === 0) return;

  for (const { sftpSessionId, transport } of sessions) {
    try {
      await closeExplorerSession(transport, sftpSessionId);
    } catch {
      // The SSH transport is already gone; local cleanup is still required.
    }

    useSftpStore.getState().closeSession(sftpSessionId);
    if (useTabStore.getState().tabs.has(sftpSessionId)) {
      useTabStore.getState().removeTab(sftpSessionId);
    }
  }
}

/**
 * Global listener for `ssh:status` events emitted by the Rust backend.
 * Updates the session store so the UI reflects connection state changes.
 * Mount once in AppShell.
 */
export function useSshStatus(): void {
  const updateStatus = useSessionStore((s) => s.updateStatus);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;

      unlisten = await listen<SshStatusPayload>("ssh:status", (event) => {
        const { session_id, status } = event.payload;
        updateStatus(session_id, status.status, status.message);
        if (status.status === "Disconnected") {
          void cleanupDisconnectedSftpSessions(session_id);
        }
      });
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [updateStatus]);
}
