/*
 * Automatic terminal working-directory reporting.
 *
 * Recent paths in a terminal come from OSC 7 sequences the remote shell emits,
 * which requires a session-local hook. Previously that hook was strictly
 * opt-in, so a plain terminal session recorded nothing. This installs it once
 * per session when the connection comes up, so the recent-paths menu fills in
 * without the user knowing the control exists. The manual "Sync CWD" menu
 * remains for re-applying it or emitting a one-shot.
 */

import type { HostConfig } from "../types";
import { useHostsStore } from "../stores/hosts-store";
import { buildAutoCwdSyncCommand } from "./shell-sync";

/** Sessions we have already sent the installer to (per app run). */
const attempted = new Set<string>();

/** Give the login banner and first prompt time to print before typing. */
const INSTALL_DELAY_MS = 1200;

/**
 * Best-effort remote shell for `hostConfig`: an explicit per-session value
 * wins, otherwise the saved host's configured default shell. `null` means
 * "unknown" and the caller uses the POSIX installer.
 */
function resolveShell(hostConfig: HostConfig): string | null {
  if (hostConfig.default_shell) return hostConfig.default_shell;
  const savedHostId = hostConfig.savedHostId;
  if (!savedHostId) return null;
  const host = useHostsStore.getState().hosts.find((h) => h.id === savedHostId);
  return host?.default_shell ?? null;
}

/**
 * Enable OSC 7 CWD reporting for `sessionId` exactly once. Safe to call on
 * every mount — repeated calls are ignored.
 */
export function ensureAutoCwdSync(sessionId: string, hostConfig: HostConfig): void {
  if (attempted.has(sessionId)) return;
  attempted.add(sessionId);

  const command = buildAutoCwdSyncCommand(resolveShell(hostConfig));

  setTimeout(() => {
    void (async () => {
      try {
        const { sendInputToSession } = await import("./shell-sync");
        await sendInputToSession(sessionId, command);
      } catch {
        // Non-fatal: the session may have closed, or the shell may be one we
        // cannot instrument. Manual sync stays available.
      }
    })();
  }, INSTALL_DELAY_MS);
}

/** Test helper: clear the per-session dedupe set. */
export function _resetAutoCwdSync(): void {
  attempted.clear();
}
