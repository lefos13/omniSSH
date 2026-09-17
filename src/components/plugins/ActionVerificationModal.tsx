/* Verification gate for every state-changing tracker action. Shows the exact
 * fully-interpolated command for review; Confirm executes precisely that
 * string via hidden exec (no re-interpolation), Cancel invokes nothing. */

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_DANGER } from "../shared/ModalShell";
import { execReviewedCommand } from "../../lib/trackers";

export interface PendingAction {
  command: string;
  label: string;
  hostLabel: string;
}

interface ActionVerificationModalProps {
  action: PendingAction | null;
  sessionId: string | null;
  onClose: () => void;
  onExecuted: (output: string) => void;
}

export function ActionVerificationModal({ action, sessionId, onClose, onExecuted }: ActionVerificationModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const close = () => {
    if (busy) return;
    setError(null);
    setCopied(false);
    onClose();
  };

  const copyCommand = async () => {
    if (!action) return;
    try {
      await navigator.clipboard.writeText(action.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const confirm = async () => {
    if (!action || !sessionId || busy) return;
    /* Capture the reviewed string now: the invoke payload must equal what
     * the user saw, even if props change mid-flight. */
    const reviewed = action.command;
    setBusy(true);
    setError(null);
    try {
      const result = await execReviewedCommand(sessionId, reviewed);
      if (result.exitCode !== 0) {
        setError(result.stderr.trim() || `command exited with ${result.exitCode}`);
        return;
      }
      onExecuted(result.stdout);
      onClose();
    } catch (err) {
      setError(err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Execution failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open={action !== null}
      onClose={close}
      title={action ? action.label : "Confirm action"}
      subtitle={action ? `on ${action.hostLabel}` : undefined}
      icon={AlertTriangle}
      iconVariant="danger"
      maxWidth="md"
      busy={busy}
      testId="action-verification-modal"
      footer={
        <>
          <button type="button" onClick={close} disabled={busy} className={BTN_GHOST} data-testid="action-verification-cancel">
            Cancel
          </button>
          <button type="button" onClick={copyCommand} disabled={busy} className={BTN_GHOST} data-testid="action-verification-copy">
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={confirm} disabled={busy || !sessionId} className={BTN_DANGER} data-testid="action-verification-confirm">
            {busy ? "Running…" : "Run command"}
          </button>
        </>
      }
    >
      <p className="text-[length:var(--text-sm)] text-text-secondary mb-2">
        Review the exact command to run. Nothing executes until you confirm.
      </p>
      <pre
        data-testid="action-verification-command"
        className="font-mono text-[length:var(--text-sm)] text-text-primary bg-bg-base border border-border rounded-lg px-3 py-2.5 overflow-x-auto whitespace-pre-wrap break-all"
      >
        {action?.command}
      </pre>
      {error && (
        <p role="alert" data-testid="action-verification-error" className="text-[length:var(--text-sm)] text-status-error mt-2">
          {error}
        </p>
      )}
    </ModalShell>
  );
}
