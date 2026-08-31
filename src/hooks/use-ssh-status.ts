import { useEffect } from "react";
import { useSessionStore } from "../stores/session-store";
import { useSftpStore } from "../stores/sftp-store";
import { useTabStore } from "../stores/tab-store";
import type { SftpSession } from "../stores/sftp-store";
import type { SshStatusPayload } from "../types";

type ExplorerTransport = "sftp" | "scp";

function sessionTransport(session: SftpSession): ExplorerTransport | undefined {
  /* The linked-explorer branch will add this narrow field to SftpSession. */
  const transport = (session as SftpSession & { transport?: unknown }).transport;
  return transport === "sftp" || transport === "scp" ? transport : undefined;
}

/*
 * A lost SSH transport invalidates every explorer channel attached to it.
 * Prefer session metadata so linked panels without tabs can select SCP; use
 * tab metadata for current standalone tabs, then default unknown sessions to
 * SFTP until linked explorers store this same narrow transport metadata.
 */
async function cleanupDisconnectedSftpSessions(sshSessionId: string): Promise<void> {
  const sessions = [...useSftpStore.getState().sessions.values()]
    .filter((session) => session.sshSessionId === sshSessionId)
    .map((session) => {
      const tab = useTabStore.getState().tabs.get(session.sftpSessionId);
      const transport = sessionTransport(session)
        ?? (tab?.type === "sftp" ? tab.transport : undefined)
        ?? "sftp";
      return {
        sftpSessionId: session.sftpSessionId,
        closeCommand: transport === "scp" ? "scp_close" : "sftp_close",
      } as const;
    });
  if (sessions.length === 0) return;

  let core: typeof import("@tauri-apps/api/core") | null = null;
  try {
    core = await import("@tauri-apps/api/core");
  } catch {
    // Continue with local cleanup when Tauri is unavailable.
  }

  for (const { sftpSessionId, closeCommand } of sessions) {
    const closeArgs = closeCommand === "scp_close"
      ? { scpSessionId: sftpSessionId }
      : { sftpSessionId };

    try {
      await core?.invoke(closeCommand, closeArgs);
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
