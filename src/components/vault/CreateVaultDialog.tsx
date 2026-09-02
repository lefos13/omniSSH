/* Accessible modal dialog for setting up the local encrypted password vault.
 * Requires master password entry with confirmation and displays an explicit
 * no-recovery warning banner. On successful setup, migrates host credentials if requested. */

import { useState, useCallback, useEffect, useRef } from "react";
import type { FormEvent } from "react";
import { ShieldCheck, AlertTriangle, Eye, EyeOff } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";
import { useLocalVaultStore } from "../../stores/local-vault-store";

export interface CreateVaultDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function CreateVaultDialog({
  open,
  onClose,
  onSuccess,
}: CreateVaultDialogProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  const setupVault = useLocalVaultStore((s) => s.setupVault);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  /* Resets all transient password state and error messages when the dialog opens or closes. */
  useEffect(() => {
    if (open) {
      setPassword("");
      setConfirmPassword("");
      setShowPassword(false);
      setValidationError(null);
      setIsSubmitting(false);
      isSubmittingRef.current = false;
      requestAnimationFrame(() => passwordInputRef.current?.focus());
    } else {
      setPassword("");
      setConfirmPassword("");
      setValidationError(null);
      isSubmittingRef.current = false;
    }
  }, [open]);

  /* Validates matching master passwords and initializes the local vault through
   * Tauri IPC. Host migration happens only after this operation succeeds. */
  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (isSubmittingRef.current) return;
      setValidationError(null);

      const trimmedPass = password.trim();
      if (!trimmedPass) {
        setValidationError("Master password cannot be empty");
        return;
      }

      if (trimmedPass.length < 12) {
        setValidationError("Use at least 12 characters for the master password");
        return;
      }

      if (password !== confirmPassword) {
        setValidationError("Passwords do not match");
        return;
      }

      setIsSubmitting(true);
      isSubmittingRef.current = true;
      try {
        await setupVault(password);
        setPassword("");
        setConfirmPassword("");
        onSuccess?.();
        onClose();
      } catch (err: unknown) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : "Failed to initialize encrypted vault";
        setValidationError(msg);
      } finally {
        setIsSubmitting(false);
        isSubmittingRef.current = false;
      }
    },
    [password, confirmPassword, setupVault, onSuccess, onClose]
  );

  const inputClass =
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2 pr-10 text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus focus:ring-2 focus:ring-ring transition-[border-color,box-shadow] duration-[var(--duration-fast)]";
  const labelClass =
    "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Set Up Encrypted App Vault"
      subtitle="Create a master password to encrypt host credentials locally."
      icon={ShieldCheck}
      maxWidth="md"
      busy={isSubmitting}
      testId="create-vault-dialog"
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
            form="create-vault-form"
            data-testid="local-vault-submit"
            disabled={isSubmitting || !password || !confirmPassword}
            onClick={(e) => {
              void handleSubmit(e);
            }}
            className={BTN_PRIMARY}
          >
            {isSubmitting ? "Creating Vault…" : "Create Vault"}
          </button>
        </>
      }
    >
      <form id="create-vault-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Warning banner */}
        <div
          data-testid="local-vault-warning"
          className="flex items-start gap-3 p-3 rounded-lg bg-status-connecting/10 border border-status-connecting/30 text-text-primary"
        >
          <AlertTriangle
            size={18}
            className="text-status-connecting shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="text-[length:var(--text-xs)] leading-relaxed">
            <p className="font-semibold text-text-primary">Important: No Password Recovery</p>
            <p className="text-text-secondary mt-0.5">
              OmniSSH cannot recover or reset a lost master password. If forgotten, passwords
              stored in the local encrypted vault cannot be retrieved.
            </p>
          </div>
        </div>

        {/* Master Password Field */}
        <div>
          <label htmlFor="cv-master-password" className={labelClass}>
            Master Password
          </label>
          <div className="relative">
            <input
              ref={passwordInputRef}
              id="cv-master-password"
              data-testid="local-vault-master-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setValidationError(null);
              }}
              placeholder="Enter master password"
              disabled={isSubmitting}
              autoComplete="new-password"
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

        {/* Confirm Master Password Field */}
        <div>
          <label htmlFor="cv-confirm-password" className={labelClass}>
            Confirm Master Password
          </label>
          <div className="relative">
            <input
              id="cv-confirm-password"
              data-testid="local-vault-confirm-password"
              type={showPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setValidationError(null);
              }}
              placeholder="Re-enter master password"
              disabled={isSubmitting}
              autoComplete="new-password"
              className={inputClass}
            />
          </div>
        </div>

        {/* Validation / Error message */}
        {validationError && (
          <div
            data-testid="local-vault-error"
            role="alert"
            className="text-[length:var(--text-xs)] text-status-error font-medium animate-in fade-in duration-[var(--duration-fast)]"
          >
            {validationError}
          </div>
        )}
      </form>
    </ModalShell>
  );
}
