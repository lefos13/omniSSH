/*
 * Offered right after an App Vault is created. The vault is cross-platform and
 * avoids the repeated macOS Keychain prompts, so the user is asked whether new
 * password-authenticated hosts should store their credential there by default.
 * Purely a preference: declining leaves the existing default untouched.
 */

import { ShieldCheck } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";

export interface VaultDefaultStorageDialogProps {
  open: boolean;
  onClose: () => void;
  onAccept: () => void;
}

export function VaultDefaultStorageDialog({
  open,
  onClose,
  onAccept,
}: VaultDefaultStorageDialogProps) {
  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Use the App Vault by default?"
      subtitle="New password-authenticated hosts will store their credential here."
      icon={ShieldCheck}
      maxWidth="md"
      testId="vault-default-storage-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            Not now
          </button>
          <button
            type="button"
            data-testid="vault-default-storage-accept"
            onClick={onAccept}
            className={BTN_PRIMARY}
          >
            Use App Vault
          </button>
        </>
      }
    >
      <p className="text-[length:var(--text-sm)] text-text-secondary">
        The App Vault encrypts host passwords on this machine. It behaves the same on
        macOS, Windows, and Linux and avoids the repeated macOS Keychain prompts, so it
        is the steadier default. You can switch this any time under Settings → Security
        &amp; Vault.
      </p>
    </ModalShell>
  );
}
