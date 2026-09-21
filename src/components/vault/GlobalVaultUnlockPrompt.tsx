/*
 * Single mount point for the global vault unlock prompt.
 *
 * Reads the pending request from the vault-prompt store and renders the shared
 * UnlockVaultDialog; on success it runs the request's retry (when present) and
 * clears the request. Rendering this once in AppShell guarantees the startup
 * check and locked-vault connection errors never stack two dialogs.
 */

import { UnlockVaultDialog } from "./UnlockVaultDialog";
import { useVaultPromptStore } from "../../stores/vault-prompt-store";

export function GlobalVaultUnlockPrompt() {
  const pending = useVaultPromptStore((s) => s.pending);

  const handleClose = () => {
    useVaultPromptStore.getState().clear();
  };

  const handleSuccess = () => {
    const onUnlocked = useVaultPromptStore.getState().pending?.onUnlocked;
    useVaultPromptStore.getState().clear();
    onUnlocked?.();
  };

  return (
    <UnlockVaultDialog
      open={pending !== null}
      hostLabel={pending?.hostLabel}
      onClose={handleClose}
      onSuccess={handleSuccess}
    />
  );
}
