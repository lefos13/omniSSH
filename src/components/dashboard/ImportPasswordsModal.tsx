/* Modal for importing a password file into saved hosts.
 *
 * Explains the user@host = password text format, shows format examples,
 * and matches entries against existing saved hosts across their configured
 * credential storage backends. */

import { useEffect, useRef } from "react";
import { ModalShell, BTN_PRIMARY } from "../shared/ModalShell";
import { useHostsStore } from "../../stores/hosts-store";
import { PasswordFileImport } from "./PasswordFileImport";

export interface ImportPasswordsModalProps {
  onClose: () => void;
  onSaved: () => void;
}

export function ImportPasswordsModal({ onClose, onSaved }: ImportPasswordsModalProps) {
  const hosts = useHostsStore((state) => state.hosts);
  const doneButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    doneButtonRef.current?.focus();
  }, []);

  const hasHosts = hosts.length > 0;

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Import Passwords"
      maxWidth="md"
      scrollable
      footer={
        <button
          ref={doneButtonRef}
          type="button"
          onClick={onClose}
          className={BTN_PRIMARY}
        >
          Done
        </button>
      }
    >
      <div className="space-y-4">
        {/* Format documentation and explanation */}
        <div className="rounded-lg border border-border/60 bg-bg-base px-3.5 py-3 text-[length:var(--text-xs)] text-text-muted space-y-2">
          <p className="text-text-primary font-medium">
            Password File Format
          </p>
          <p>
            A password file is a plaintext file with one <code className="px-1 py-0.5 rounded bg-bg-surface font-mono text-text-primary text-[length:var(--text-2xs)]">user@host = password</code> entry per line. Lines starting with <code className="px-1 py-0.5 rounded bg-bg-surface font-mono text-text-primary text-[length:var(--text-2xs)]">#</code> or <code className="px-1 py-0.5 rounded bg-bg-surface font-mono text-text-primary text-[length:var(--text-2xs)]">;</code> are treated as comments.
          </p>
          <pre
            data-testid="import-passwords-format-example"
            className="p-2.5 rounded-md bg-bg-surface font-mono text-[length:var(--text-2xs)] text-text-primary overflow-x-auto"
          >
{`deploy@10.0.0.5 = s3cret
root@db.example.com = hunter2`}
          </pre>
          <p>
            Each entry is matched to every saved host with that username and host (on any port). Passwords are saved directly to each host&apos;s configured storage (System Keychain or encrypted App Vault). MobaXterm&apos;s &ldquo;Stored Passwords&rdquo; export already uses this format.
          </p>
        </div>

        {/* Zero-hosts empty state or import component */}
        {!hasHosts ? (
          <div
            data-testid="import-passwords-zero-hosts"
            className="rounded-lg border border-border/60 bg-bg-base p-6 text-center"
          >
            <p className="text-[length:var(--text-sm)] font-medium text-text-primary">
              No saved hosts available
            </p>
            <p className="mt-1 text-[length:var(--text-xs)] text-text-muted">
              Add or import hosts first — passwords are matched to existing hosts.
            </p>
          </div>
        ) : (
          <PasswordFileImport
            onSaved={onSaved}
            emptyMessage="No saved hosts match this file. Add or import the hosts first, then pick the file again."
          />
        )}
      </div>
    </ModalShell>
  );
}
