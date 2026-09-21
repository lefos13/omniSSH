/*
 * Shared handling for the local vault's locked state on connection attempts.
 *
 * Rust returns a distinct `vault_locked` error kind when a vault-stored host is
 * contacted while the vault is locked. That is a recoverable condition: instead
 * of a generic "Connection Failed" retry loop, callers open the global unlock
 * prompt and re-run the attempt after a successful unlock.
 */

import type { SshErrorPayload } from "../types/ssh";
import { useVaultPromptStore } from "../stores/vault-prompt-store";

export function isVaultLockedError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "kind" in error &&
    (error as SshErrorPayload).kind === "vault_locked"
  );
}

/**
 * Opens the global unlock prompt for a locked-vault error and schedules `retry`
 * to run after a successful unlock. Returns `true` when the error was handled
 * this way, so the caller suppresses its generic failure UI.
 */
export function handleVaultLockedError(
  error: unknown,
  hostLabel: string,
  retry: () => void,
): boolean {
  if (!isVaultLockedError(error)) return false;
  useVaultPromptStore.getState().request({ hostLabel, onUnlocked: retry });
  return true;
}
