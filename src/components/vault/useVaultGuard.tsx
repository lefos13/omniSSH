import { useState } from "react";
import { CreateVaultDialog } from "./CreateVaultDialog";
import { UnlockVaultDialog } from "./UnlockVaultDialog";
import { useLocalVaultStore } from "../../stores/local-vault-store";

export function useVaultGuard() {
  const loadStatus = useLocalVaultStore((s) => s.loadStatus);
  const [createVaultOpen, setCreateVaultOpen] = useState(false);
  const [unlockVaultOpen, setUnlockVaultOpen] = useState(false);
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
    </>
  );

  return { checkVault, renderVaultDialogs };
}
