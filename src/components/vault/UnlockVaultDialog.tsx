/* Accessible modal dialog for unlocking the local encrypted password vault.
 * Prompts for the master password to unlock host credentials for the active app session.
 * Displays inline validation and error feedback when an incorrect password is provided. */

import { useState, useCallback, useEffect, useRef } from "react";
import type { FormEvent } from "react";
import { Lock, Eye, EyeOff } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";
import { useLocalVaultStore } from "../../stores/local-vault-store";

export interface UnlockVaultDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  title?: string;
  subtitle?: string;
  hostLabel?: string;
}

export function UnlockVaultDialog({
  open,
  onClose,
  onSuccess,
  title = "Unlock Encrypted Vault",
  subtitle = "Enter your master password to unlock host credentials.",
  hostLabel,
}: UnlockVaultDialogProps) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  const unlockVault = useLocalVaultStore((s) => s.unlockVault);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  /* Clears transient state when dialog visibility changes. */
  useEffect(() => {
    if (open) {
      setPassword("");
      setShowPassword(false);
      setError(null);
      setIsSubmitting(false);
      isSubmittingRef.current = false;
      requestAnimationFrame(() => passwordInputRef.current?.focus());
    } else {
      setPassword("");
      setError(null);
      isSubmittingRef.current = false;
    }
  }, [open]);

  /* Submits the master password to unlock the local vault via Tauri IPC.
   * If unlock fails, surfaces the backend error inline without clearing the form. */
  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (isSubmittingRef.current) return;
      setError(null);

      const trimmedPass = password.trim();
      if (!trimmedPass) {
        setError("Master password cannot be empty");
        return;
      }

      setIsSubmitting(true);
      isSubmittingRef.current = true;
      try {
        await unlockVault(password);
        setPassword("");
        onSuccess?.();
        onClose();
      } catch (err: unknown) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : "Incorrect master password";
        setError(msg);
      } finally {
        setIsSubmitting(false);
        isSubmittingRef.current = false;
      }
    },
    [password, unlockVault, onSuccess, onClose]
  );

  const inputClass =
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2 pr-10 text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus focus:ring-2 focus:ring-ring transition-[border-color,box-shadow] duration-[var(--duration-fast)]";
  const labelClass =
    "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={title}
      subtitle={hostLabel ? `Unlock vault to access ${hostLabel}` : subtitle}
      icon={Lock}
      maxWidth="md"
      busy={isSubmitting}
      testId="local-vault-unlock-dialog"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className={BTN_GHOST}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="unlock-vault-form"
            data-testid="local-vault-unlock-submit"
            disabled={isSubmitting || !password}
            onClick={(e) => {
              void handleSubmit(e);
            }}
            className={BTN_PRIMARY}
          >
            {isSubmitting ? "Unlocking…" : "Unlock Vault"}
          </button>
        </>
      }
    >
      <form id="unlock-vault-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="uv-master-password" className={labelClass}>
            Master Password
          </label>
          <div className="relative">
            <input
              ref={passwordInputRef}
              id="uv-master-password"
              data-testid="local-vault-unlock-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              placeholder="Enter master password"
              disabled={isSubmitting}
              autoComplete="current-password"
              className={inputClass}
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              disabled={isSubmitting}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        {error && (
          <div
            data-testid="local-vault-unlock-error"
            role="alert"
            className="text-[length:var(--text-xs)] text-status-error font-medium animate-in fade-in duration-[var(--duration-fast)]"
          >
            {error}
          </div>
        )}
      </form>
    </ModalShell>
  );
}
