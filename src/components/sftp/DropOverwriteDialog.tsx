import { AlertTriangle } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_SECONDARY, BTN_PRIMARY } from "../shared/ModalShell";
import { formatBackupDate, backupFilename } from "../../lib/drop-conflicts";

interface DropOverwriteDialogProps {
  conflicts: string[];
  targetDir: string;
  onConfirm: () => void;
  onBackupAndCopy?: () => void;
  onCancel: () => void;
}

/**
 * Confirmation shown when a drag-drop upload would overwrite existing remote
 * entries. The conflict list is computed from top-level basenames, so for a
 * dropped folder the match means the folder already exists — its contents are
 * merged and only same-named files inside are replaced.
 */
export function DropOverwriteDialog({
  conflicts,
  targetDir,
  onConfirm,
  onBackupAndCopy,
  onCancel,
}: DropOverwriteDialogProps) {
  const count = conflicts.length;

  return (
    <ModalShell
      open
      onClose={onCancel}
      title={count === 1 ? "Overwrite item?" : `Overwrite ${count} items?`}
      icon={AlertTriangle}
      iconVariant="danger"
      maxWidth="md"
      testId="explorer-overwrite-confirm"
      footer={
        <>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button autoFocus data-testid="explorer-overwrite-cancel" type="button" onClick={onCancel} className={BTN_GHOST}>
            Cancel
          </button>
          {onBackupAndCopy && (
            <button
              data-testid="explorer-overwrite-backup-button"
              type="button"
              onClick={onBackupAndCopy}
              className={BTN_SECONDARY}
            >
              {count === 1 ? "Backup & Copy" : `Backup & Copy ${count}`}
            </button>
          )}
          <button data-testid="explorer-overwrite-confirm-button" type="button" onClick={onConfirm} className={BTN_PRIMARY}>
            {count === 1 ? "Overwrite" : `Overwrite ${count}`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[length:var(--text-sm)] text-text-secondary">
          {count === 1 ? (
            <><span className="font-mono text-text-primary">{conflicts[0]}</span> already exists here.</>
          ) : (
            <>{count} items already exist here.</>
          )}
        </p>
        {count > 1 && (
          <ul className="max-h-32 overflow-y-auto rounded-md bg-bg-base border border-border/60 p-2 flex flex-col gap-0.5">
            {conflicts.map((n) => (
              <li key={n} className="font-mono text-[length:var(--text-2xs)] text-text-secondary truncate">{n}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-1 text-[length:var(--text-2xs)] text-text-muted">
          <p>
            <strong className="text-text-secondary font-medium">Backup &amp; Copy:</strong>{" "}
            {count === 1 ? (
              <>
                Renames existing file to <span className="font-mono text-text-secondary">{backupFilename(conflicts[0])}</span> before uploading.
              </>
            ) : (
              <>
                Renames existing files to <span className="font-mono text-text-secondary">&lt;name&gt;.{formatBackupDate()}.bak</span> before uploading.
              </>
            )}
          </p>
          <p>
            <strong className="text-text-secondary font-medium">Overwrite:</strong> Files are replaced; folders are merged, replacing only same-named files inside.
          </p>
        </div>
        <p className="font-mono text-[length:var(--text-2xs)] text-text-muted truncate">{targetDir}</p>
      </div>
    </ModalShell>
  );
}
