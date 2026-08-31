import { useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle, Check, FileText } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";
import type {
  ImportResult,
  MobaXtermEntry,
  SshConfigEntry,
  SshConfigImportEntry,
  TermiusCommitResponse,
  TermiusPreviewResponse,
} from "../../types";

/* The modal keeps the existing OpenSSH flow and adds MobaXterm as a source
 * selection. Both sources use the same preview and save payload shape, while
 * the native dialog and file parsing remain behind source-specific Rust IPC. */
export type ImportSource = "ssh" | "mobaxterm" | "termius";

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

/* Preview order is immutable for file-based sources, while Termius supplies
 * opaque IDs. The union keeps both selection models local to this modal. */
type ImportRowId = number | string;

function termiusErrorMessage(error: unknown): string {
  const kind = error && typeof error === "object" && "kind" in error
    ? String((error as { kind: string }).kind)
    : "";
  switch (kind) {
    case "source_running":
      return "Close Termius completely, then try again. Its local database is locked while the app is open.";
    case "source_unavailable":
      return "Termius data was not found. Make sure Termius has been used on this device, or choose its data directory.";
    case "source_read":
      return "Termius data could not be read. Check the selected data directory and try again.";
    case "preview_expired":
      return "This Termius preview expired. Scan again before importing.";
    case "credentials_confirmation_required":
      return "Confirm credential import before continuing.";
    case "credentials_unavailable":
      return "Selected Termius credentials are unavailable. Import metadata only or scan again.";
    case "invalid_selection":
      return "The selected Termius hosts are no longer available. Scan again before importing.";
    default:
      return error && typeof error === "object" && "message" in error
        ? String((error as { message: string }).message)
        : "Termius import failed";
  }
}

export function ImportSshConfigModal({
  onClose,
  onImported,
  initialSource = "ssh",
}: ImportSshConfigModalProps) {
  const [source, setSource] = useState<ImportSource>(initialSource);
  const [entries, setEntries] = useState<SshConfigEntry[]>([]);
  const [selected, setSelected] = useState<Set<ImportRowId>>(new Set());
  const [scanning, setScanning] = useState(initialSource === "ssh" || initialSource === "termius");
  const [importing, setImporting] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [termiusPreview, setTermiusPreview] = useState<TermiusPreviewResponse | null>(null);
  const [termiusPreviewToken, setTermiusPreviewToken] = useState<string | null>(null);
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [credentialsConfirmed, setCredentialsConfirmed] = useState(false);
  const [termiusResult, setTermiusResult] = useState<TermiusCommitResponse | null>(null);
  const scanRequest = useRef(0);
  /* Continuations capture this generation so a dialog or IPC response cannot
   * repopulate state after the user changes source or starts another operation. */
  const sourceGeneration = useRef(0);
  const sshSourceRef = useRef<HTMLButtonElement>(null);
  const mobaxtermSourceRef = useRef<HTMLButtonElement>(null);
  const termiusSourceRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  /* Put keyboard focus inside the dialog as soon as it mounts, so opening an
   * import source does not leave assistive technology focus on the dashboard. */
  useEffect(() => {
    const sourceRef = initialSource === "ssh"
      ? sshSourceRef
      : initialSource === "mobaxterm" ? mobaxtermSourceRef : termiusSourceRef;
    sourceRef.current?.focus();
  }, [initialSource]);

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
    const requestGeneration = sourceGeneration.current;
    setScanning(true);
    setScanError(null);
    setEntries([]);
    setSelected(new Set());
    if (nextSource === "termius") {
      setTermiusPreview(null);
      setTermiusPreviewToken(null);
      setIncludeCredentials(false);
      setCredentialsConfirmed(false);
      setTermiusResult(null);
    }
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (nextSource === "termius") {
        /* The preview request intentionally asks Rust for metadata only. The
         * returned token is retained solely in component state for one commit. */
        const preview = await invoke<TermiusPreviewResponse>("import_preview_termius", {
          request: {
            source_path: path,
            metadata_only: true,
          },
        });
        if (requestId !== scanRequest.current || requestGeneration !== sourceGeneration.current) return;
        setTermiusPreview(preview);
        setTermiusPreviewToken(preview.preview_token);
        setSelected(new Set(
          preview.hosts.filter((host) => !host.already_exists).map((host) => host.id),
        ));
        return;
      }
      const results = nextSource === "ssh"
        ? await invoke<SshConfigEntry[]>("import_parse_ssh_config", { path })
        : await invoke<MobaXtermEntry[]>("import_parse_mobaxterm", { path });
      if (requestId !== scanRequest.current || requestGeneration !== sourceGeneration.current) return;
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
      if (requestId !== scanRequest.current || requestGeneration !== sourceGeneration.current) return;
      const msg = nextSource === "termius"
        ? termiusErrorMessage(err)
        : err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : nextSource === "ssh" ? "Failed to parse SSH config" : "Failed to parse MobaXterm file";
      setScanError(msg);
      if (nextSource === "termius") {
        setTermiusPreview(null);
        setTermiusPreviewToken(null);
      }
    } finally {
      if (requestId === scanRequest.current && requestGeneration === sourceGeneration.current) setScanning(false);
    }
  };

  // Scan default sources on mount; MobaXterm waits for a file pick.
  useEffect(() => {
    if (initialSource === "ssh" || initialSource === "termius") void scan(initialSource, null);
  }, []);

  const handleSourceChange = (nextSource: ImportSource) => {
    if (nextSource === source) return;
    sourceGeneration.current += 1;
    scanRequest.current += 1;
    setSource(nextSource);
    setConfigPath(null);
    setEntries([]);
    setSelected(new Set());
    setTermiusPreview(null);
    setTermiusPreviewToken(null);
    setIncludeCredentials(false);
    setCredentialsConfirmed(false);
    setTermiusResult(null);
    setScanError(null);
    setResult(null);
    setScanning(nextSource === "ssh" || nextSource === "termius");
    if (nextSource === "ssh" || nextSource === "termius") void scan(nextSource, null);
  };

  const handleBrowse = async () => {
    if (importing) return;
    const browseGeneration = sourceGeneration.current;
    const browseSource = source;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        title: source === "ssh" ? "Select SSH config file" : source === "mobaxterm" ? "Select MobaXterm file" : "Select Termius LevelDB directory",
        multiple: false,
        ...(source === "termius" && { directory: true }),
        ...(source === "mobaxterm" && {
          filters: [{ name: "MobaXterm files", extensions: ["mxtsessions", "ini"] }],
        }),
      });
      if (path && typeof path === "string" && browseGeneration === sourceGeneration.current && !importing) {
        setConfigPath(path);
        await scan(browseSource, path);
      }
    } catch { /* cancelled */ }
  };

  const handleImport = async () => {
    if (importing) return;
    const importGeneration = ++sourceGeneration.current;
    const importSource = source;
    setImporting(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (importSource === "termius") {
        if (!termiusPreviewToken) return;
        /* Commit sends only opaque selection IDs and explicit consent flags;
         * decrypted credentials never enter React state or the IPC payload. */
        const response = await invoke<TermiusCommitResponse>("import_commit_termius", {
          request: {
            preview_token: termiusPreviewToken,
            selected_ids: termiusPreview?.hosts
              .filter((host) => selected.has(host.id))
              .map((host) => host.id) ?? [],
            include_credentials: includeCredentials,
            credentials_confirmed: includeCredentials && credentialsConfirmed,
          },
        });
        if (importGeneration !== sourceGeneration.current) return;
        setTermiusResult(response);
        onImported();
        return;
      }
      const toImport = entries
        .filter((e, index) => selected.has(index) && !e.is_pattern)
        .map(toImportEntry);

      const command = importSource === "ssh" ? "import_save_ssh_hosts" : "import_save_mobaxterm_hosts";
      const importResult = await invoke<ImportResult>(command, {
        entries: toImport,
      });
      if (importGeneration !== sourceGeneration.current) return;
      setResult(importResult);
      onImported();
    } catch (err) {
      if (importGeneration !== sourceGeneration.current) return;
      if (importSource === "termius") {
        setTermiusPreview(null);
        setTermiusPreviewToken(null);
        setSelected(new Set());
        setIncludeCredentials(false);
        setCredentialsConfirmed(false);
        setScanError(termiusErrorMessage(err));
      } else {
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Import failed";
        setScanError(msg);
      }
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
  const termiusImportableCount = termiusPreview?.hosts.filter((host) => selected.has(host.id)).length ?? 0;
  const termiusWarnings = termiusPreview
    ? [...new Set([
      ...termiusPreview.warnings,
      ...termiusPreview.hosts.flatMap((host) => host.warnings),
    ])]
    : [];
  const showingResult = source === "termius" ? termiusResult !== null : result !== null;

  useEffect(() => {
    if (showingResult) resultRef.current?.focus();
  }, [showingResult]);

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Import Connections"
      maxWidth="lg"
      scrollable
      busy={importing}
      footer={
        showingResult ? (
          <button type="button" onClick={onClose} className={BTN_PRIMARY}>Done</button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={importing} className={BTN_GHOST}>Cancel</button>
            <button
              type="button"
              data-testid={source === "ssh"
                ? "import-ssh-config-submit"
                : source === "mobaxterm" ? "import-mobaxterm-submit" : "import-termius-submit"}
              onClick={() => void handleImport()}
              disabled={importing || (source === "termius"
                ? termiusImportableCount === 0 || !termiusPreviewToken || (includeCredentials && !credentialsConfirmed)
                : importableCount === 0)}
              className={BTN_PRIMARY}
            >
              {importing ? "Importing…" : `Import ${source === "termius" ? termiusImportableCount : importableCount} host${(source === "termius" ? termiusImportableCount : importableCount) !== 1 ? "s" : ""}`}
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
              ref={sshSourceRef}
              data-testid="import-ssh-config-source"
              disabled={importing}
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
              ref={mobaxtermSourceRef}
              data-testid="import-mobaxterm-source"
              disabled={importing}
              aria-pressed={source === "mobaxterm"}
              onClick={() => handleSourceChange("mobaxterm")}
              className={[
                "flex-1 px-3 py-1.5 rounded-md text-[length:var(--text-xs)] font-medium transition-colors",
                source === "mobaxterm" ? "bg-bg-overlay text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary",
              ].join(" ")}
            >
              MobaXterm
            </button>
            <button
              type="button"
              ref={termiusSourceRef}
              data-testid="import-termius-source"
              disabled={importing}
              aria-pressed={source === "termius"}
              onClick={() => handleSourceChange("termius")}
              className={[
                "flex-1 px-3 py-1.5 rounded-md text-[length:var(--text-xs)] font-medium transition-colors",
                source === "termius" ? "bg-bg-overlay text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary",
              ].join(" ")}
            >
              Termius
            </button>
          </div>

          {/* Result view */}
          {showingResult ? (
            <div ref={resultRef} data-testid="import-result" role="status" tabIndex={-1} aria-live="polite" className="flex flex-col items-center gap-4 py-8">
              <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-status-connected/10">
                <Check size={26} strokeWidth={2} className="text-status-connected" />
              </div>
              <div className="text-center">
                <p className="text-[length:var(--text-sm)] font-semibold text-text-primary">
                  {source === "termius" ? termiusResult?.imported_hosts : result?.imported} host{(source === "termius" ? termiusResult?.imported_hosts : result?.imported) !== 1 ? "s" : ""} imported
                </p>
                {(source === "termius" ? termiusResult?.skipped_hosts : result?.skipped) ? (
                  <p className="text-[length:var(--text-xs)] text-text-muted mt-1">
                    {source === "termius" ? termiusResult?.skipped_hosts : result?.skipped} skipped
                  </p>
                ) : null}
                {(source === "termius" ? (termiusResult?.warnings.length ?? 0) > 0 : (result?.errors.length ?? 0) > 0) ? (
                  <div className="mt-3 text-left">
                    {(source === "termius" ? termiusResult?.warnings ?? [] : result?.errors ?? []).map((err, i) => (
                      <p key={i} className="text-[length:var(--text-xs)] text-status-connecting">{err}</p>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : scanning ? (
            <div className="flex flex-col items-center gap-4 py-12">
              <Loader2 size={26} strokeWidth={2} className="text-accent motion-safe:animate-spin" />
              <p className="text-[length:var(--text-sm)] text-text-muted">
                Scanning {source === "ssh" ? "SSH config" : source === "mobaxterm" ? "MobaXterm file" : "Termius data"}...
              </p>
            </div>
          ) : scanError ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <AlertCircle size={26} strokeWidth={1.8} className="text-status-error" />
              <p role="alert" className="text-[length:var(--text-sm)] text-status-error text-center">{scanError}</p>
              <button
                data-testid={source === "termius" ? "import-termius-rescan" : undefined}
                disabled={importing}
                onClick={() => source === "termius" ? void scan("termius", configPath) : void handleBrowse()}
                className="px-4 py-2 text-[length:var(--text-sm)] font-medium text-text-inverse bg-accent hover:bg-accent-hover rounded-lg transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {source === "termius" ? "Scan again" : source === "ssh" ? "Browse for config file" : "Browse for MobaXterm file"}
              </button>
            </div>
          ) : source === "termius" && termiusPreview ? (
            <>
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[length:var(--text-2xs)] text-text-muted truncate flex-1">
                  {configPath ? "Selected Termius LevelDB directory" : "Automatic Termius data directory"}
                </span>
                <button type="button" disabled={importing} onClick={() => void handleBrowse()} className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover transition-colors duration-[var(--duration-fast)] shrink-0">
                  Browse
                </button>
              </div>
              <div className="mb-4 rounded-lg border border-border/60 bg-bg-base px-3 py-2">
                <p className="text-[length:var(--text-sm)] text-text-primary">Termius metadata preview</p>
                <p className="text-[length:var(--text-xs)] text-text-muted mt-1">
                  {termiusPreview.counts.hosts} host{termiusPreview.counts.hosts !== 1 ? "s" : ""} and {termiusPreview.counts.groups} group{termiusPreview.counts.groups !== 1 ? "s" : ""} found. Credentials are excluded until you opt in. A custom source must be the exact Termius LevelDB directory.
                </p>
              </div>

              {termiusWarnings.length > 0 && (
                <div
                  data-testid="import-termius-warnings"
                  role="status"
                  className="mb-4 rounded-lg border border-status-connecting/30 bg-status-connecting/10 px-3 py-2"
                >
                  {termiusWarnings.map((warning) => (
                    <p key={warning} className="text-[length:var(--text-xs)] text-status-connecting">{warning}</p>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-3 mb-3">
                <span className="text-[length:var(--text-xs)] text-text-muted">
                  {termiusImportableCount} of {termiusPreview.hosts.length} selected
                </span>
                <button type="button" disabled={importing} onClick={() => setSelected(new Set(termiusPreview.hosts.map((host) => host.id)))} className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover">All</button>
                <button type="button" disabled={importing} onClick={() => setSelected(new Set())} className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover">None</button>
              </div>

              <div className="rounded-lg bg-bg-base border border-border/60 divide-y divide-border/30 overflow-hidden">
                {termiusPreview.hosts.map((host) => (
                  <label key={host.id} data-testid={`import-termius-host-${host.id}`} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-bg-overlay/40 transition-colors duration-[var(--duration-fast)]">
                    <input
                      type="checkbox"
                      checked={selected.has(host.id)}
                      disabled={importing}
                      onChange={() => toggleSelect(host.id)}
                      aria-label={`Select ${host.label}`}
                      className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-ring shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[length:var(--text-sm)] font-medium text-text-primary truncate">{host.label}</span>
                        {host.already_exists && <span className="px-1.5 py-px rounded text-[9px] uppercase tracking-wide font-semibold bg-status-connecting/10 text-status-connecting">exists</span>}
                        {host.credential_available && <span className="px-1.5 py-px rounded text-[9px] uppercase tracking-wide font-semibold bg-bg-subtle text-text-muted">credential available</span>}
                      </div>
                      <p className="text-[length:var(--text-2xs)] font-mono text-text-muted truncate">{host.username}@{host.address}:{host.port}</p>
                    </div>
                  </label>
                ))}
              </div>

              {termiusPreview.counts.credential_available > 0 && (
                <div className="mt-4 rounded-lg border border-border/60 bg-bg-base px-3 py-2">
                  <label className="flex items-start gap-2 text-[length:var(--text-xs)] text-text-primary cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="import-termius-credentials"
                      checked={includeCredentials}
                      disabled={importing}
                      onChange={(event) => {
                        setIncludeCredentials(event.target.checked);
                        if (!event.target.checked) setCredentialsConfirmed(false);
                      }}
                      className="mt-0.5 w-3.5 h-3.5 rounded border-border text-accent focus:ring-ring shrink-0"
                    />
                    <span>Import available credentials into the secure vault</span>
                  </label>
                  {includeCredentials && (
                    <label className="flex items-start gap-2 mt-2 pl-5 text-[length:var(--text-xs)] text-text-muted cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid="import-termius-credentials-confirm"
                        checked={credentialsConfirmed}
                        disabled={importing}
                        onChange={(event) => setCredentialsConfirmed(event.target.checked)}
                        className="mt-0.5 w-3.5 h-3.5 rounded border-border text-accent focus:ring-ring shrink-0"
                      />
                      <span>I understand that selected credentials will be stored in anySCP’s secure vault.</span>
                    </label>
                  )}
                </div>
              )}
            </>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <FileText size={26} strokeWidth={1.5} className="text-text-muted/40" />
              <p className="text-[length:var(--text-sm)] text-text-muted">
                No hosts found in {source === "ssh" ? "SSH config" : "MobaXterm file"}
              </p>
              <button
                type="button"
                disabled={importing}
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
                  type="button"
                  disabled={importing}
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
                <button type="button" disabled={importing} onClick={selectAll} className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover">All</button>
                <button type="button" disabled={importing} onClick={selectNone} className="text-[length:var(--text-2xs)] text-accent hover:text-accent-hover">None</button>
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
                        disabled={disabled || importing}
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
