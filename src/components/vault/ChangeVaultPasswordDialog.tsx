/* The dialog collects the current and replacement master passwords only while
 * open, validates the replacement locally, and sends them directly to vault IPC. */
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";
import { useLocalVaultStore } from "../../stores/local-vault-store";

const MIN_MASTER_PASSWORD_LENGTH = 12;

export interface ChangeVaultPasswordDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function ChangeVaultPasswordDialog({
  open,
  onClose,
  onSuccess,
}: ChangeVaultPasswordDialogProps) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef(false);
  const changeMasterPassword = useLocalVaultStore((state) => state.changeMasterPassword);

  useEffect(() => {
    if (!open) return;
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setShowPasswords(false);
    setError(null);
    setIsSubmitting(false);
    isSubmittingRef.current = false;
    requestAnimationFrame(() => currentPasswordRef.current?.focus());
  }, [open]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSubmittingRef.current) return;
      if (newPassword.length < MIN_MASTER_PASSWORD_LENGTH) {
        setError(`Use at least ${MIN_MASTER_PASSWORD_LENGTH} characters for the new master password`);
        return;
      }
      if (newPassword !== confirmPassword) {
        setError("Passwords do not match");
        return;
      }

      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setError(null);
      try {
        await changeMasterPassword(currentPassword, newPassword);
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        onSuccess?.();
        onClose();
      } catch (reason: unknown) {
        const message = reason && typeof reason === "object" && "message" in reason
          ? String((reason as { message: unknown }).message)
          : "Could not change the master password";
        setError(message);
      } finally {
        setIsSubmitting(false);
        isSubmittingRef.current = false;
      }
    },
    [changeMasterPassword, confirmPassword, currentPassword, newPassword, onClose, onSuccess],
  );

  const inputClass =
    "w-full rounded-lg bg-bg-base border border-border px-3 py-2 pr-10 text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus focus:ring-2 focus:ring-ring transition-[border-color,box-shadow] duration-[var(--duration-fast)]";
  const labelClass =
    "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Change Master Password"
      subtitle="Re-encrypt local vault passwords with a new master password."
      icon={KeyRound}
      maxWidth="md"
      busy={isSubmitting}
      testId="local-vault-change-dialog"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={isSubmitting} className={BTN_GHOST}>
            Cancel
          </button>
          <button
            type="submit"
            form="change-vault-password-form"
            data-testid="local-vault-change-submit"
            disabled={isSubmitting || !currentPassword || !newPassword || !confirmPassword}
            className={BTN_PRIMARY}
          >
            {isSubmitting ? "Changing…" : "Change Password"}
          </button>
        </>
      }
    >
      <form id="change-vault-password-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="cv-current-password" className={labelClass}>Current Master Password</label>
          <PasswordInput
            ref={currentPasswordRef}
            id="cv-current-password"
            testId="local-vault-change-current-password"
            value={currentPassword}
            onChange={setCurrentPassword}
            placeholder="Enter current master password"
            show={showPasswords}
            disabled={isSubmitting}
            autoComplete="current-password"
            inputClass={inputClass}
            onToggle={() => setShowPasswords((visible) => !visible)}
          />
        </div>
        <div>
          <label htmlFor="cv-new-password" className={labelClass}>New Master Password</label>
          <PasswordInput
            id="cv-new-password"
            testId="local-vault-change-new-password"
            value={newPassword}
            onChange={setNewPassword}
            placeholder="Use at least 12 characters"
            show={showPasswords}
            disabled={isSubmitting}
            autoComplete="new-password"
            inputClass={inputClass}
            onToggle={() => setShowPasswords((visible) => !visible)}
          />
        </div>
        <div>
          <label htmlFor="cv-confirm-password" className={labelClass}>Confirm New Master Password</label>
          <PasswordInput
            id="cv-confirm-password"
            testId="local-vault-change-confirm-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder="Re-enter new master password"
            show={showPasswords}
            disabled={isSubmitting}
            autoComplete="new-password"
            inputClass={inputClass}
            onToggle={() => setShowPasswords((visible) => !visible)}
          />
        </div>
        <p className="rounded-lg border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-[length:var(--text-xs)] text-text-secondary">
          OmniSSH cannot recover a forgotten master password. Existing local vault passwords stay encrypted during this change.
        </p>
        {error && <p role="alert" className="text-[length:var(--text-xs)] font-medium text-status-error">{error}</p>}
      </form>
    </ModalShell>
  );
}

interface PasswordInputProps {
  id: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  show: boolean;
  disabled: boolean;
  autoComplete: "current-password" | "new-password";
  inputClass: string;
  onToggle: () => void;
}

const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(({
  id,
  testId,
  value,
  onChange,
  placeholder,
  show,
  disabled,
  autoComplete,
  inputClass,
  onToggle,
}, ref) => (
  <div className="relative">
    <input
      ref={ref}
      id={id}
      data-testid={testId}
      type={show ? "text" : "password"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      autoComplete={autoComplete}
      className={inputClass}
    />
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-label={show ? "Hide passwords" : "Show passwords"}
      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {show ? <EyeOff size={15} /> : <Eye size={15} />}
    </button>
  </div>
));
