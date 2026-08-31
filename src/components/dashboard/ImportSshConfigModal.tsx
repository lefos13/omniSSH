import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle, Check, FileText } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";
import type {
  ImportResult,
  MobaXtermEntry,
  SshConfigEntry,
  SshConfigImportEntry,
} from "../../types";

/* The modal keeps the existing OpenSSH flow and adds MobaXterm as a source
 * selection. Both sources use the same preview and save payload shape, while
 * the native dialog and file parsing remain behind source-specific Rust IPC. */
export type ImportSource = "ssh" | "mobaxterm";

interface ImportSshConfigModalProps {
  onClose: () => void;
  onImported: () => void;
  initialSource?: ImportSource;
}

export function toImportEntry(entry: SshConfigEntry): SshConfigImportEntry {
  return {
    host_alias: entry.host_alias,
    hostname: entry.hostname || entry.host_alias,
    user: entry.user || "root",
    port: entry.port ?? 22,
    identity_file: entry.identity_file,
    proxy_jump: entry.proxy_jump,
    keep_alive_interval: entry.keep_alive_interval,
    group_path: entry.group_path ?? entry.groupPath ?? null,
    startup_command: entry.startup_command ?? entry.startupCommand ?? null,
    notes: entry.notes ?? null,
    start_directory: entry.start_directory ?? entry.startDirectory ?? null,
  };
}

/* Preview order is immutable until the next scan, so the row index is a
 * unique identity even when MobaXterm repeats a bookmark label in folders. */
type ImportRowId = number;

export function ImportSshConfigModal({
  onClose,
  onImported,
  initialSource = "ssh",
}: ImportSshConfigModalProps) {
  const [source, setSource] = useState<ImportSource>(initialSource);
  const [entries, setEntries] = useState<SshConfigEntry[]>([]);
  const [selected, setSelected] = useState<Set<ImportRowId>>(new Set());
  const [scanning, setScanning] = useState(initialSource === "ssh");
  const [importing, setImporting] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const scanRequest = useRef(0);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !importing) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, importing]);

  const scan = async (nextSource: ImportSource, path: string | null) => {
    if (nextSource === "mobaxterm" && !path) {
      setScanning(false);
      return;
    }

    const requestId = ++scanRequest.current;
    setScanning(true);
    setScanError(null);
    setEntries([]);
    setSelected(new Set());
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const results = nextSource === "ssh"
        ? await invoke<SshConfigEntry[]>("import_parse_ssh_config", { path })
        : await invoke<MobaXtermEntry[]>("import_parse_mobaxterm", { path });
      if (requestId !== scanRequest.current) return;
      setEntries(results);
      // Auto-select non-pattern, non-duplicate entries
      const autoSelected = new Set<ImportRowId>();
      for (const [index, e] of results.entries()) {
        if (!e.is_pattern && !e.already_exists) {
          autoSelected.add(index);
        }
      }
      setSelected(autoSelected);
    } catch (err) {
      if (requestId !== scanRequest.current) return;
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : nextSource === "ssh" ? "Failed to parse SSH config" : "Failed to parse MobaXterm file";
      setScanError(msg);
    } finally {
      if (requestId === scanRequest.current) setScanning(false);
    }
  };

  // Scan the default OpenSSH config on mount; MobaXterm waits for a file pick.
  useEffect(() => {
    if (initialSource === "ssh") void scan("ssh", null);
  }, []);

  const handleSourceChange = (nextSource: ImportSource) => {
    if (nextSource === source) return;
    scanRequest.current += 1;
    setSource(nextSource);
    setConfigPath(null);
    setEntries([]);
    setSelected(new Set());
    setScanError(null);
    setResult(null);
    setScanning(nextSource === "ssh");
    if (nextSource === "ssh") void scan("ssh", null);
  };

  const handleBrowse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        title: source === "ssh" ? "Select SSH config file" : "Select MobaXterm file",
        multiple: false,
        ...(source === "mobaxterm" && {
          filters: [{ name: "MobaXterm files", extensions: ["mxtsessions", "ini"] }],
        }),
      });
      if (path && typeof path === "string") {
        setConfigPath(path);
        await scan(source, path);
      }
    } catch { /* cancelled */ }
  };

  const handleImport = async () => {
    setImporting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const toImport = entries
        .filter((e, index) => selected.has(index) && !e.is_pattern)
        .map(toImportEntry);

      const command = source === "ssh" ? "import_save_ssh_hosts" : "import_save_mobaxterm_hosts";
      const importResult = await invoke<ImportResult>(command, {
        entries: toImport,
      });
      setResult(importResult);
      onImported();
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Import failed";
      setScanError(msg);
    } finally {
      setImporting(false);
    }
  };

  const toggleSelect = (rowId: ImportRowId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  const selectAll = () => {
    const all = new Set<ImportRowId>();
    for (const [index, e] of entries.entries()) {
      if (!e.is_pattern) all.add(index);
    }
    setSelected(all);
  };

  const selectNone = () => setSelected(new Set());

  const importableCount = entries.filter((e, index) => selected.has(index) && !e.is_pattern).length;
  const warnings = [...new Set(entries.flatMap((entry) => entry.warnings ?? []))];

  return (
    <ModalShell
      open
      onClose={onClose}
      title={source === "ssh" ? "Import SSH Config" : "Import MobaXterm"}
      maxWidth="lg"
      scrollable
      busy={importing}
      footer={
        result ? (
          <button type="button" onClick={onClose} className={BTN_PRIMARY}>Done</button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={importing} className={BTN_GHOST}>Cancel</button>
            <button
              type="button"
              data-testid={source === "ssh" ? "import-ssh-config-submit" : "import-mobaxterm-submit"}
              onClick={() => void handleImport()}
              disabled={importing || importableCount === 0}
              className={BTN_PRIMARY}
            >
              {importing ? "Importing…" : `Import ${importableCount} host${importableCount !== 1 ? "s" : ""}`}
            </button>
          </>
        )
      }
    >
        <div>
          {/* Source selection preserves the existing OpenSSH entry point while
              making MobaXterm a first-class path through the same preview. */}
          <div className="flex items-center gap-1 p-1 mb-4 rounded-lg bg-bg-base border border-border/60" role="group" aria-label="Import source">
            <button
              type="button"
              data-testid="import-ssh-config-source"
              aria-pressed={source === "ssh"}
              onClick={() => handleSourceChange("ssh")}
              className={[
                "flex-1 px-3 py-1.5 rounded-md text-[length:var(--text-xs)] font-medium transition-colors",
                source === "ssh" ? "bg-bg-overlay text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary",
              ].join(" ")}
            >
              OpenSSH
            </button>
            <button
              type="button"
              data-testid="import-mobaxterm-source"
              aria-pressed={source === "mobaxterm"}
              onClick={() => handleSourceChange("mobaxterm")}
              className={[
                "flex-1 px-3 py-1.5 rounded-md text-[length:var(--text-xs)] font-medium transition-colors",
                source === "mobaxterm" ? "bg-bg-overlay text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary",
              ].join(" ")}
            >
              MobaXterm
            </button>
          </div>

          {/* Result view */}
          {result ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-status-connected/10">
                <Check size={26} strokeWidth={2} className="text-status-connected" />
              </div>
              <div className="text-center">
                <p className="text-[length:var(--text-sm)] font-semibold text-text-primary">
                  {result.imported} host{result.imported !== 1 ? "s" : ""} imported
                </p>
                {result.skipped > 0 && (
                  <p className="text-[length:var(--text-xs)] text-text-muted mt-1">
                    {result.skipped} skipped
                  </p>
                )}
                {result.errors.length > 0 && (
                  <div className="mt-3 text-left">
                    {result.errors.map((err, i) => (
                      <p key={i} className="text-[length:var(--text-xs)] text-status-error">{err}</p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : scanning ? (
            <div className="flex flex-col items-center gap-4 py-12">
              <Loader2 size={26} strokeWidth={2} className="text-accent motion-safe:animate-spin" />
              <p className="text-[length:var(--text-sm)] text-text-muted">
                Scanning {source === "ssh" ? "SSH config" : "MobaXterm file"}...
              </p>
            </div>
          ) : scanError ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <AlertCircle size={26} strokeWidth={1.8} className="text-status-error" />
              <p className="text-[length:var(--text-sm)] text-status-error text-center">{scanError}</p>
              <button
                onClick={() => void handleBrowse()}
                className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {source === "ssh" ? "Browse for config file" : "Browse for MobaXterm file"}
              </button>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <FileText size={26} strokeWidth={1.5} className="text-text-muted/40" />
              <p className="text-[length:var(--text-sm)] text-text-muted">
                No hosts found in {source === "ssh" ? "SSH config" : "MobaXterm file"}
              </p>
              <button
                onClick={() => void handleBrowse()}
                className="px-3 py-1.5 text-[length:var(--text-xs)] font-medium text-text-muted border border-border rounded-lg hover:text-text-primary hover:bg-bg-overlay transition-all duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {source === "ssh" ? "Try a different file" : "Browse for MobaXterm file"}
              </button>
            </div>
          ) : (
            <>
              {/* Config path + browse */}
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[length:var(--text-2xs)] font-mono text-text-muted truncate flex-1">
                  {configPath ?? (source === "ssh" ? "~/.ssh/config" : "Choose a MobaXterm file")}
                </span>
                <button
                  onClick={() => void handleBrowse()}
                  className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover transition-colors duration-[var(--duration-fast)] shrink-0"
                >
                  {source === "ssh" ? "Change" : "Browse"}
                </button>
              </div>

              {warnings.length > 0 && (
                <div
                  data-testid="import-mobaxterm-warnings"
                  role="status"
                  className="mb-4 rounded-lg border border-status-connecting/30 bg-status-connecting/10 px-3 py-2"
                >
                  {warnings.map((warning) => (
                    <p key={warning} className="text-[length:var(--text-xs)] text-status-connecting">
                      {warning}
                    </p>
                  ))}
                </div>
              )}

              {/* Select all / none */}
              <div className="flex items-center gap-3 mb-3">
                <span className="text-[length:var(--text-xs)] text-text-muted">
                  {importableCount} of {entries.filter((e) => !e.is_pattern).length} selected
                </span>
                <button onClick={selectAll} className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover">All</button>
                <button onClick={selectNone} className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover">None</button>
              </div>

              {/* Host list */}
              <div className="rounded-lg bg-bg-base border border-border/60 divide-y divide-border/30 overflow-hidden">
                {entries.map((entry, index) => {
                  const isChecked = selected.has(index);
                  const disabled = entry.is_pattern;

                  return (
                    <label
                      key={`import-row-${index}`}
                      className={[
                        "flex items-center gap-3 px-3 py-2 cursor-pointer",
                        "hover:bg-bg-overlay/40 transition-colors duration-[var(--duration-fast)]",
                        disabled ? "opacity-40 cursor-not-allowed" : "",
                      ].join(" ")}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={disabled}
                        onChange={() => !disabled && toggleSelect(index)}
                        className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-ring shrink-0"
                      />

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[length:var(--text-sm)] font-medium text-text-primary truncate">
                            {entry.host_alias}
                          </span>
                          {entry.is_pattern && (
                            <span className="px-1.5 py-px rounded text-[9px] uppercase tracking-wide font-semibold bg-bg-subtle text-text-muted">
                              pattern
                            </span>
                          )}
                          {entry.already_exists && (
                            <span className="px-1.5 py-px rounded text-[9px] uppercase tracking-wide font-semibold bg-status-connecting/10 text-status-connecting">
                              exists
                            </span>
                          )}
                        </div>
                        <p className="text-[length:var(--text-2xs)] font-mono text-text-muted truncate">
                          {entry.user ?? "root"}@{entry.hostname ?? entry.host_alias}:{entry.port ?? 22}
                          {entry.identity_file && ` key:${entry.identity_file.split("/").pop()}`}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </div>
    </ModalShell>
  );
}
