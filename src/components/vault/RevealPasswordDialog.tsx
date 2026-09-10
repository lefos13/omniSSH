/* Accessible modal dialog for revealing a stored host password.
 * Requires fresh master password verification via a one-shot Rust command.
 * Keeps revealed credentials in ephemeral component memory only and clears
 * them immediately when the dialog closes. */

import { useState, useCallback, useEffect, useRef } from "react";
import type { FormEvent } from "react";
import { KeyRound, Eye, EyeOff, Copy, Check, ShieldAlert } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";
import type { CredentialStorage } from "../../types";

export interface RevealPasswordDialogProps {
  open: boolean;
  onClose: () => void;
  hostId: string;
  hostLabel: string;
  storage: CredentialStorage;
  onMigratedToVault?: () => void;
}

export function RevealPasswordDialog({
  open,
  onClose,
  hostId,
  hostLabel,
  storage,
  onMigratedToVault,
}: RevealPasswordDialogProps) {
  const [currentStorage, setCurrentStorage] = useState<CredentialStorage>(storage);
  const [masterPassword, setMasterPassword] = useState("");
  const [showMasterPassword, setShowMasterPassword] = useState(false);
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [showRevealedPassword, setShowRevealedPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);

  const passwordInputRef = useRef<HTMLInputElement>(null);
  const copyTimeoutRef = useRef<number | null>(null);

  /* Reset all ephemeral state when the dialog closes or opens.
   * Ensures plaintext credentials never persist beyond dialog visibility. */
  useEffect(() => {
    if (!open) {
      setMasterPassword("");
      setShowMasterPassword(false);
      setRevealedPassword(null);
      setShowRevealedPassword(false);
      setCopied(false);
      setError(null);
      setIsSubmitting(false);
      setIsMigrating(false);
    } else {
      setCurrentStorage(storage);
      setError(null);
      setRevealedPassword(null);
      setShowRevealedPassword(false);
      setCopied(false);
      requestAnimationFrame(() => passwordInputRef.current?.focus());
    }
    return () => {
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
    };
  }, [open, storage]);

  const handleClose = useCallback(() => {
    setMasterPassword("");
    setRevealedPassword(null);
    setShowRevealedPassword(false);
    setError(null);
    onClose();
  }, [onClose]);

  /* Submits the master password to reveal the stored password via Tauri IPC. */
  const handleReveal = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (!masterPassword || isSubmitting) return;

      setIsSubmitting(true);
      setError(null);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const password = await invoke<string>("local_vault_reveal_password", {
          hostId,
          masterPassword,
        });
        setRevealedPassword(password);
        setMasterPassword("");
        setShowRevealedPassword(false);
      } catch (err: unknown) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : "Failed to reveal password";
        setError(msg);
      } finally {
        setIsSubmitting(false);
      }
    },
    [hostId, masterPassword, isSubmitting]
  );

  /* Migrates a Keychain-backed host into the Encrypted App Vault. */
  const handleMigrate = useCallback(async () => {
    setIsMigrating(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("local_vault_migrate_host_password", { hostId });
      setCurrentStorage("localVault");
      if (onMigratedToVault) onMigratedToVault();
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Failed to migrate host to App Vault";
      setError(msg);
    } finally {
      setIsMigrating(false);
    }
  }, [hostId, onMigratedToVault]);

  const handleCopy = useCallback(async () => {
    if (!revealedPassword) return;
    try {
      await navigator.clipboard.writeText(revealedPassword);
      setCopied(true);
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }, [revealedPassword]);

  const inputClass =
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2 pr-10 text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus focus:ring-2 focus:ring-ring transition-[border-color,box-shadow] duration-[var(--duration-fast)]";
  const labelClass =
    "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

  const isKeychain = currentStorage === "keychain";

  return (
    <ModalShell
      open={open}
      onClose={handleClose}
      title="Reveal Stored Password"
      subtitle={
        isKeychain
          ? `Stored in System Keychain for ${hostLabel}`
          : revealedPassword !== null
            ? `Stored password for ${hostLabel}`
            : `Enter master password to reveal the password for ${hostLabel}`
      }
      icon={isKeychain ? ShieldAlert : KeyRound}
      maxWidth="md"
      busy={isSubmitting || isMigrating}
      testId="reveal-password-dialog"
      footer={
        isKeychain ? (
          <>
            <button
              type="button"
              onClick={handleClose}
              disabled={isMigrating}
              className={BTN_GHOST}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="reveal-password-migrate-submit"
              disabled={isMigrating}
              onClick={() => void handleMigrate()}
              className={BTN_PRIMARY}
            >
              {isMigrating ? "Migrating…" : "Migrate to App Vault"}
            </button>
          </>
        ) : revealedPassword !== null ? (
          <button
            type="button"
            data-testid="reveal-password-done"
            onClick={handleClose}
            className={BTN_PRIMARY}
          >
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className={BTN_GHOST}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="reveal-password-form"
              data-testid="reveal-password-submit"
              disabled={isSubmitting || !masterPassword}
              onClick={(e) => {
                void handleReveal(e);
              }}
              className={BTN_PRIMARY}
            >
              {isSubmitting ? "Verifying…" : "Reveal Password"}
            </button>
          </>
        )
      }
    >
      {isKeychain ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg bg-status-connecting/10 border border-status-connecting/30 px-3.5 py-3 text-[length:var(--text-sm)] text-text-secondary">
            <p className="font-medium text-text-primary mb-1">
              Protected by System Keychain
            </p>
            <p className="text-[length:var(--text-xs)] text-text-muted leading-relaxed">
              This host&apos;s password is saved in your operating system&apos;s Keychain.
              To protect your credentials, password revelation is only available for passwords stored
              in the Encrypted App Vault.
            </p>
          </div>
          <p className="text-[length:var(--text-xs)] text-text-muted">
            Clicking &ldquo;Migrate to App Vault&rdquo; moves the credential into your
            Encrypted App Vault, where it can be unlocked and viewed using your master password.
          </p>
          {error && (
            <div
              data-testid="reveal-password-error"
              role="alert"
              className="text-[length:var(--text-xs)] text-status-error font-medium"
            >
              {error}
            </div>
          )}
        </div>
      ) : revealedPassword !== null ? (
        <div className="flex flex-col gap-4">
          <div>
            <label className={labelClass}>Stored Password</label>
            <div className="flex items-center gap-2">
              <div
                data-testid="reveal-password-value"
                className="flex-1 min-w-0 font-mono text-[length:var(--text-sm)] rounded-lg bg-bg-base border border-border px-3 py-2 select-all break-all"
              >
                {showRevealedPassword
                  ? revealedPassword
                  : "\u2022".repeat(Math.max(8, Math.min(revealedPassword.length, 24)))}
              </div>
              <button
                type="button"
                data-testid="reveal-password-toggle-mask"
                onClick={() => setShowRevealedPassword((prev) => !prev)}
                aria-label={showRevealedPassword ? "Mask password" : "Show password"}
                className="p-2 text-text-muted hover:text-text-primary rounded-lg border border-border bg-bg-base hover:bg-bg-overlay transition-colors shrink-0"
              >
                {showRevealedPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              <button
                type="button"
                data-testid="reveal-password-copy"
                onClick={() => void handleCopy()}
                aria-label={copied ? "Copied" : "Copy password"}
                className="p-2 text-text-muted hover:text-text-primary rounded-lg border border-border bg-bg-base hover:bg-bg-overlay transition-colors shrink-0"
              >
                {copied ? <Check size={16} className="text-status-connected" /> : <Copy size={16} />}
              </button>
            </div>
            <p className="mt-2 text-[length:var(--text-2xs)] text-text-muted">
              This password is held in temporary memory and will be cleared when you close this window.
            </p>
          </div>
        </div>
      ) : (
        <form id="reveal-password-form" onSubmit={handleReveal} className="flex flex-col gap-4">
          <div>
            <label htmlFor="rp-master-password" className={labelClass}>
              Master Password
            </label>
            <div className="relative">
              <input
                ref={passwordInputRef}
                id="rp-master-password"
                data-testid="reveal-password-master-input"
                type={showMasterPassword ? "text" : "password"}
                value={masterPassword}
                onChange={(e) => {
                  setMasterPassword(e.target.value);
                  setError(null);
                }}
                placeholder="Enter master password to reveal"
                disabled={isSubmitting}
                autoComplete="current-password"
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => setShowMasterPassword((prev) => !prev)}
                disabled={isSubmitting}
                aria-label={showMasterPassword ? "Hide password" : "Show password"}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showMasterPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {error && (
            <div
              data-testid="reveal-password-error"
              role="alert"
              className="text-[length:var(--text-xs)] text-status-error font-medium"
            >
              {error}
            </div>
          )}
        </form>
      )}
    </ModalShell>
  );
}
