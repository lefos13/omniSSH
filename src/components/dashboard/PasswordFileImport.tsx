/* Standalone and embedded password file import component.
 *
 * Prompts the user for a text file with `user@host = password` lines, previews
 * matched hosts and their target storage, and commits passwords into the OS
 * keychain or encrypted App Vault with overwrite confirmation. */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { BTN_PRIMARY } from "../shared/ModalShell";
import { useVaultGuard } from "../vault";
import type { PasswordFilePreview, PasswordFileSaveResult } from "../../types";

export interface PasswordFileImportProps {
  heading?: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
  onSaved?: (result: PasswordFileSaveResult) => void;
  emptyMessage?: string;
}

export function PasswordFileImport({
  heading,
  description,
  disabled = false,
  onSaved,
  emptyMessage = "No saved hosts match this file.",
}: PasswordFileImportProps) {
  const [passwordPath, setPasswordPath] = useState<string | null>(null);
  const [passwordPreview, setPasswordPreview] = useState<PasswordFilePreview | null>(null);
  const [passwordPreviewLoading, setPasswordPreviewLoading] = useState(false);
  const [passwordPreviewError, setPasswordPreviewError] = useState<string | null>(null);
  const [passwordSelection, setPasswordSelection] = useState<Set<string>>(new Set());
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordConfirm, setPasswordConfirm] = useState(false);
  const [passwordSaveResult, setPasswordSaveResult] = useState<PasswordFileSaveResult | null>(null);
  const [passwordSaveError, setPasswordSaveError] = useState<string | null>(null);

  const { checkVault, renderVaultDialogs } = useVaultGuard();
  const passwordRequest = useRef(0);
  const passwordResultRef = useRef<HTMLDivElement>(null);

  /* The password file is read in Rust and only match metadata enters component
   * state — passwords stay in Rust. The dialog and IPC modules are loaded
   * dynamically so tests can mock them. */
  const handleBrowsePasswords = async () => {
    if (disabled || passwordSaving) return;
    const requestId = ++passwordRequest.current;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        title: "Select password file",
        multiple: false,
        filters: [{ name: "Text files", extensions: ["txt"] }],
      });
      if (!path || typeof path !== "string") return;
      if (requestId !== passwordRequest.current) return;

      setPasswordPath(path);
      setPasswordPreview(null);
      setPasswordPreviewError(null);
      setPasswordPreviewLoading(true);
      /* A new file replaces previous results so stale summary counts cannot persist. */
      setPasswordSaveResult(null);
      setPasswordSaveError(null);
      setPasswordConfirm(false);

      const { invoke } = await import("@tauri-apps/api/core");
      const preview = await invoke<PasswordFilePreview>(
        "import_preview_password_file",
        { path },
      );
      if (requestId !== passwordRequest.current) return;
      setPasswordPreview(preview);
      /* Key-auth hosts cannot take a password, so they start unticked and disabled. */
      setPasswordSelection(
        new Set(preview.matches.filter((match) => match.status !== "keyAuth").map((match) => match.host_id)),
      );
    } catch (err) {
      if (requestId !== passwordRequest.current) return;
      setPasswordPreviewError(
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Failed to read password file",
      );
    } finally {
      if (requestId === passwordRequest.current) {
        setPasswordPreviewLoading(false);
      }
    }
  };

  const togglePasswordRow = (hostId: string) => {
    setPasswordSelection((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    });
  };

  /* Save re-reads the file in Rust and writes only the ticked hosts. The request
   * guard drops responses that arrive after the user picks another file. */
  const handleSavePasswords = async () => {
    if (disabled || passwordSaving || !passwordPath || passwordSelectedCount === 0) return;

    /* A vault target commits ciphertext through the App Vault, requiring unlock. */
    if (passwordVaultTargetCount > 0 && !await checkVault(handleSavePasswords)) return;

    const saveRequestId = passwordRequest.current;
    const selectedIds = passwordSelectable
      .filter((match) => passwordSelection.has(match.host_id))
      .map((match) => match.host_id);

    setPasswordSaving(true);
    setPasswordSaveError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const saveResult = await invoke<PasswordFileSaveResult>(
        "import_save_password_file",
        { path: passwordPath, hostIds: selectedIds },
      );
      if (saveRequestId !== passwordRequest.current) return;
      setPasswordSaveResult(saveResult);
      onSaved?.(saveResult);
    } catch (err) {
      if (saveRequestId !== passwordRequest.current) return;
      setPasswordSaveError(
        err && typeof err === "object" && "message" in err
          ? String(err.message)
          : "Failed to save passwords",
      );
    } finally {
      if (saveRequestId === passwordRequest.current) setPasswordSaving(false);
    }
  };

  const passwordSelectable = passwordPreview?.matches.filter((match) => match.status !== "keyAuth") ?? [];
  const passwordSelectedCount = passwordSelectable.filter((match) => passwordSelection.has(match.host_id)).length;
  const passwordCounts = passwordPreview
    ? [
      passwordPreview.unmatched_entries > 0
        ? `${passwordPreview.unmatched_entries} ${passwordPreview.unmatched_entries === 1 ? "entry" : "entries"} matched no saved host`
        : null,
      passwordPreview.conflicts > 0
        ? `${passwordPreview.conflicts} conflicting ${passwordPreview.conflicts === 1 ? "entry" : "entries"} skipped`
        : null,
      passwordPreview.malformed_lines > 0
        ? `${passwordPreview.malformed_lines} unreadable ${passwordPreview.malformed_lines === 1 ? "line" : "lines"}`
        : null,
    ].filter(Boolean).join(" · ")
    : "";

  /* Only a ticked row that overwrites an existing password needs an explicit
   * acknowledgement, so unticking it removes the requirement again. */
  const passwordReplaceCount = passwordSelectable.filter(
    (match) => passwordSelection.has(match.host_id) && match.status === "replaces",
  ).length;
  const passwordNeedsConfirm = passwordReplaceCount > 0;
  const passwordVaultTargetCount = passwordSelectable.filter(
    (match) => passwordSelection.has(match.host_id) && match.storage === "localVault",
  ).length;
  const passwordStoredCount =
    (passwordSaveResult?.stored_in_keychain ?? 0) + (passwordSaveResult?.stored_in_vault ?? 0);

  const passwordSaveSummary = passwordSaveResult
    ? [
      passwordStoredCount > 0
        ? `${passwordStoredCount} password${passwordStoredCount === 1 ? "" : "s"} saved: ${[
          passwordSaveResult.stored_in_vault > 0
            ? `${passwordSaveResult.stored_in_vault} to App Vault`
            : null,
          passwordSaveResult.stored_in_keychain > 0
            ? `${passwordSaveResult.stored_in_keychain} to Keychain`
            : null,
        ].filter(Boolean).join(", ")}`
        : null,
      passwordSaveResult.skipped > 0 ? `${passwordSaveResult.skipped} skipped` : null,
    ].filter(Boolean).join(" · ")
    : "";

  useEffect(() => {
    if (!passwordNeedsConfirm) setPasswordConfirm(false);
  }, [passwordNeedsConfirm]);

  useEffect(() => {
    if (passwordSaveResult) passwordResultRef.current?.focus();
  }, [passwordSaveResult]);

  return (
    <>
      <div data-testid="password-file-import-card" className="rounded-lg border border-border/60 bg-bg-base px-3 py-3">
        {heading}
        {description}

        <div className="flex items-center gap-2 mt-3">
          <span className="text-[length:var(--text-2xs)] font-mono text-text-muted truncate flex-1">
            {passwordPath ?? "No password file selected"}
          </span>
          <button
            type="button"
            data-testid="password-file-import-browse"
            disabled={disabled || passwordPreviewLoading}
            onClick={() => void handleBrowsePasswords()}
            className="px-3 py-1.5 text-[length:var(--text-xs)] font-medium text-text-muted border border-border rounded-lg hover:text-text-primary hover:bg-bg-overlay transition-all duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
          >
            Browse
          </button>
        </div>

        {passwordPreviewLoading ? (
          <div role="status" className="flex items-center gap-2 mt-3">
            <Loader2 size={16} strokeWidth={2} className="text-accent motion-safe:animate-spin" />
            <span className="text-[length:var(--text-xs)] text-text-muted">Reading password file…</span>
          </div>
        ) : passwordPreviewError ? (
          <p role="alert" className="mt-3 text-[length:var(--text-xs)] text-status-error">
            {passwordPreviewError}
          </p>
        ) : passwordPreview ? (
          <div data-testid="password-file-import-preview">
            {passwordPreview.matches.length === 0 ? (
              <p data-testid="password-file-import-empty" className="mt-3 text-[length:var(--text-xs)] text-text-muted">
                {emptyMessage}
              </p>
            ) : (
              <>
                <div className="rounded-lg bg-bg-base border border-border/60 divide-y divide-border/30 overflow-hidden mt-3">
                  {passwordPreview.matches.map((match) => {
                    const isKeyAuth = match.status === "keyAuth";
                    return (
                      <label
                        key={match.host_id}
                        data-testid={`password-file-import-row-${match.host_id}`}
                        className={[
                          "flex items-center gap-3 px-3 py-2 cursor-pointer",
                          "hover:bg-bg-overlay/40 transition-colors duration-[var(--duration-fast)]",
                          isKeyAuth ? "opacity-40 cursor-not-allowed" : "",
                        ].join(" ")}
                      >
                        <input
                          type="checkbox"
                          checked={!isKeyAuth && passwordSelection.has(match.host_id)}
                          disabled={isKeyAuth || disabled}
                          onChange={() => togglePasswordRow(match.host_id)}
                          aria-label={`Include ${match.host_label}`}
                          className="w-3.5 h-3.5 rounded border-border text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[length:var(--text-sm)] font-medium text-text-primary truncate">
                              {match.host_label}
                            </span>
                            <span className="px-1.5 py-px rounded text-[9px] uppercase tracking-wide font-semibold bg-bg-subtle text-text-muted">
                              {match.storage === "localVault" ? "App Vault" : "Keychain"}
                            </span>
                            {match.status === "replaces" && (
                              <span className="px-1.5 py-px rounded text-[9px] uppercase tracking-wide font-semibold bg-status-connecting/10 text-status-connecting">
                                replaces saved password
                              </span>
                            )}
                            {isKeyAuth && (
                              <span className="px-1.5 py-px rounded text-[9px] uppercase tracking-wide font-semibold bg-bg-subtle text-text-muted">
                                key login
                              </span>
                            )}
                          </div>
                          <p className="text-[length:var(--text-2xs)] font-mono text-text-muted truncate">
                            {match.username}@{match.host}:{match.port}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {/* Bulk controls sit after the rows so the Tab order
                    reaches each host before the select-all helpers. */}
                <div className="flex items-center gap-3 mt-3">
                  <span className="text-[length:var(--text-xs)] text-text-muted">
                    {passwordSelectedCount} of {passwordSelectable.length} selected
                  </span>
                  <button
                    type="button"
                    data-testid="password-file-import-all"
                    disabled={disabled}
                    onClick={() => setPasswordSelection(new Set(passwordSelectable.map((match) => match.host_id)))}
                    className="rounded text-[length:var(--text-2xs)] text-accent hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    data-testid="password-file-import-none"
                    disabled={disabled}
                    onClick={() => setPasswordSelection(new Set())}
                    className="rounded text-[length:var(--text-2xs)] text-accent hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    None
                  </button>
                </div>
              </>
            )}
            {passwordCounts && (
              <p data-testid="password-file-import-counts" className="mt-2 text-[length:var(--text-2xs)] text-text-muted">
                {passwordCounts}
              </p>
            )}
            {passwordPreview.matches.length > 0 && (
              <>
                {passwordNeedsConfirm && (
                  <label className="flex items-start gap-2 mt-3 text-[length:var(--text-xs)] text-text-primary cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="password-file-import-confirm"
                      checked={passwordConfirm}
                      disabled={disabled || passwordSaving}
                      onChange={(event) => setPasswordConfirm(event.target.checked)}
                      className="mt-0.5 w-3.5 h-3.5 rounded border-border text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                    />
                    <span>
                      I understand saved passwords on {passwordReplaceCount} host{passwordReplaceCount === 1 ? "" : "s"} will be replaced.
                    </span>
                  </label>
                )}

                <div className="flex items-center gap-3 mt-3">
                  <button
                    type="button"
                    data-testid="password-file-import-save"
                    disabled={passwordSaving || passwordSelectedCount === 0 || (passwordNeedsConfirm && !passwordConfirm)}
                    onClick={() => void handleSavePasswords()}
                    className={BTN_PRIMARY}
                  >
                    {passwordSaving
                      ? "Saving…"
                      : `Save ${passwordSelectedCount} password${passwordSelectedCount === 1 ? "" : "s"}`}
                  </button>
                </div>

                {passwordSaveError && (
                  <p role="alert" className="mt-3 text-[length:var(--text-xs)] text-status-error">
                    {passwordSaveError}
                  </p>
                )}

                {passwordSaveResult && (
                  <div
                    ref={passwordResultRef}
                    data-testid="password-file-import-result"
                    role="status"
                    tabIndex={-1}
                    className="mt-3 rounded-lg border border-border/60 bg-bg-base px-3 py-2"
                  >
                    {passwordSaveSummary && (
                      <p className="text-[length:var(--text-xs)] text-text-primary">
                        {passwordSaveSummary}
                      </p>
                    )}
                    {passwordSaveResult.failed.map((failure) => (
                      <p
                        key={failure.host_id}
                        className="mt-1 text-[length:var(--text-xs)] text-status-connecting"
                      >
                        {failure.host_label}: {failure.error}
                      </p>
                    ))}
                    {passwordStoredCount > 0 && (
                      <p
                        data-testid="password-file-import-delete-hint"
                        className="mt-2 text-[length:var(--text-2xs)] text-text-muted"
                      >
                        Your password file is plaintext. Delete it now that the passwords are stored.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
      {renderVaultDialogs()}
    </>
  );
}
