import { useEffect } from "react";
import { useSessionStore } from "../stores/session-store";
import { useSftpStore } from "../stores/sftp-store";
import { useTabStore } from "../stores/tab-store";
import type { SshStatusPayload } from "../types";

/*
 * A lost SSH transport invalidates every explorer channel attached to it.
 * Close the backend channel when possible, then always remove local state so
 * a disconnected explorer cannot remain visible or be reused.
 */
async function cleanupDisconnectedSftpSessions(sshSessionId: string): Promise<void> {
  const sessionIds = [...useSftpStore.getState().sessions.values()]
    .filter((session) => session.sshSessionId === sshSessionId)
    .map((session) => session.sftpSessionId);
  if (sessionIds.length === 0) return;

  let core: typeof import("@tauri-apps/api/core") | null = null;
  try {
    core = await import("@tauri-apps/api/core");
  } catch {
    // Continue with local cleanup when Tauri is unavailable.
  }

  for (const sftpSessionId of sessionIds) {
    try {
      await core?.invoke("sftp_close", { sftpSessionId });
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
