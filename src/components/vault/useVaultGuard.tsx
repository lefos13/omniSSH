import { useState } from "react";
import { CreateVaultDialog } from "./CreateVaultDialog";
import { UnlockVaultDialog } from "./UnlockVaultDialog";
import { VaultDefaultStorageDialog } from "./VaultDefaultStorageDialog";
import { useLocalVaultStore } from "../../stores/local-vault-store";
import { useSettingsStore } from "../../stores/settings-store";

export function useVaultGuard() {
  const loadStatus = useLocalVaultStore((s) => s.loadStatus);
  const setDefaultCredentialStorage = useSettingsStore((s) => s.setDefaultCredentialStorage);
  const [createVaultOpen, setCreateVaultOpen] = useState(false);
  const [unlockVaultOpen, setUnlockVaultOpen] = useState(false);
  const [promptDefaultStorageOpen, setPromptDefaultStorageOpen] = useState(false);
  const [vaultHostLabel, setVaultHostLabel] = useState<string | undefined>();
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const checkVault = async (
    actionFn: () => void,
    hostLabel?: string,
    createIfMissing = true
  ): Promise<boolean> => {
    const status = await loadStatus();
    if (!status.configured) {
      if (!createIfMissing) return true;
      setPendingAction(() => actionFn);
      setVaultHostLabel(hostLabel);
      setCreateVaultOpen(true);
      return false;
    }
    if (!status.unlocked) {
      setPendingAction(() => actionFn);
      setVaultHostLabel(hostLabel);
      setUnlockVaultOpen(true);
      return false;
    }
    return true;
  };

  const renderVaultDialogs = () => (
    <>
      <CreateVaultDialog
        open={createVaultOpen}
        onClose={() => { setCreateVaultOpen(false); setPendingAction(null); }}
        onSuccess={() => {
          setCreateVaultOpen(false);
          const action = pendingAction;
          setPendingAction(null);
          if (action) action();
          /* A brand-new vault is the moment to offer it as the storage default,
           * unless the user already prefers it. */
          if (useSettingsStore.getState().defaultCredentialStorage !== "localVault") {
            setPromptDefaultStorageOpen(true);
          }
        }}
      />
      <UnlockVaultDialog
        open={unlockVaultOpen}
        onClose={() => { setUnlockVaultOpen(false); setPendingAction(null); }}
        onSuccess={() => {
          setUnlockVaultOpen(false);
          const action = pendingAction;
          setPendingAction(null);
          if (action) action();
        }}
        hostLabel={vaultHostLabel}
      />
      <VaultDefaultStorageDialog
        open={promptDefaultStorageOpen}
        onClose={() => setPromptDefaultStorageOpen(false)}
        onAccept={() => {
          setDefaultCredentialStorage("localVault");
          setPromptDefaultStorageOpen(false);
        }}
      />
    </>
  );

  return { checkVault, renderVaultDialogs };
}
