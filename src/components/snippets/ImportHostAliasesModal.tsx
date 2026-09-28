/*
 * Dialog for scanning and importing remote shell aliases into OmniSSH snippets.
 * Probes the connected SSH session for aliases across Bash, Zsh, and Fish,
 * presenting a filterable checklist with optional destination folder assignment.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { Terminal, Search, Loader2, AlertCircle, RefreshCw, CheckSquare, Square } from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";
import { CustomSelect } from "../shared/CustomSelect";
import { useSessionStore } from "../../stores/session-store";
import { useSnippetsStore } from "../../stores/snippets-store";
import { toast } from "../../stores/toast-store";
import type { HostAlias, Snippet } from "../../types";

export interface ImportHostAliasesModalProps {
  open: boolean;
  sessionId: string;
  onClose: () => void;
  onImported?: (count: number) => void;
}

export function ImportHostAliasesModal({
  open,
  sessionId,
  onClose,
  onImported,
}: ImportHostAliasesModalProps) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const { folders, loadFolders, saveFolder, saveSnippets, snippets } = useSnippetsStore();

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [aliases, setAliases] = useState<HostAlias[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [createNewFolder, setCreateNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [importing, setImporting] = useState(false);

  const hostLabel = session?.label ?? session?.hostConfig.host ?? "Remote Host";

  // Scan host aliases
  const scan = useCallback(async () => {
    if (!sessionId) return;
    setScanning(true);
    setScanError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const detected = await invoke<HostAlias[]>("ssh_detect_aliases", { sessionId });
      setAliases(detected);
      setSelected(new Set(detected.map((a) => a.name)));
    } catch (err: unknown) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Failed to detect aliases from host";
      setScanError(msg);
      setAliases([]);
      setSelected(new Set());
    } finally {
      setScanning(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (open) {
      void loadFolders();
      void scan();
      setSearchQuery("");
      setCreateNewFolder(false);
      setNewFolderName(`${hostLabel} Aliases`);
    }
  }, [open, scan, loadFolders, hostLabel]);

  // Filtered aliases based on typeahead
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return aliases;
    return aliases.filter(
      (a) => a.name.toLowerCase().includes(q) || a.command.toLowerCase().includes(q),
    );
  }, [aliases, searchQuery]);

  // Existing snippet names set to flag collisions
  const existingNames = useMemo(() => {
    return new Set((snippets ?? []).map((s) => s.name));
  }, [snippets]);

  // Toggle selection
  const toggleSelect = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelected(new Set(aliases.map((a) => a.name)));
  };

  const handleDeselectAll = () => {
    setSelected(new Set());
  };

  // Perform import
  const handleImport = async () => {
    if (selected.size === 0) return;
    setImporting(true);

    try {
      let folderId: string | null = selectedFolderId || null;

      if (createNewFolder && newFolderName.trim()) {
        const newFolder = {
          id: crypto.randomUUID(),
          name: newFolderName.trim(),
          parent_id: null,
          color: null,
          icon: null,
          sort_order: folders.length,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        await saveFolder(newFolder);
        folderId = newFolder.id;
      }

      const now = new Date().toISOString();
      const selectedAliases = aliases.filter((a) => selected.has(a.name));

      const snippetsToSave: Snippet[] = selectedAliases.map((alias, idx) => ({
        id: crypto.randomUUID(),
        name: alias.name,
        command: alias.command,
        description: `Imported alias from ${hostLabel}`,
        folder_id: folderId,
        tags: `alias,${hostLabel}`,
        variables: null,
        is_dangerous: false,
        use_count: 0,
        last_used_at: null,
        sort_order: idx,
        created_at: now,
        updated_at: now,
      }));

      await saveSnippets(snippetsToSave);
      toast.success(
        `Imported ${snippetsToSave.length} alias snippet${snippetsToSave.length === 1 ? "" : "s"}.`,
      );
      onImported?.(snippetsToSave.length);
      onClose();
    } catch (err: unknown) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "Failed to save imported snippets";
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  };

  const allFilteredSelected = filtered.length > 0 && filtered.every((a) => selected.has(a.name));

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Import Host Aliases"
      subtitle={`Detected in shell on ${hostLabel}`}
      icon={Terminal}
      maxWidth="2xl"
      scrollable
      testId="import-aliases-modal"
      footer={
        <div className="flex items-center justify-between w-full">
          <div className="text-[length:var(--text-xs)] text-text-muted">
            {aliases.length > 0 && (
              <span>
                {selected.size} of {aliases.length} selected
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={importing}
              className={BTN_GHOST}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="import-aliases-submit"
              onClick={() => void handleImport()}
              disabled={importing || selected.size === 0 || scanning}
              className={BTN_PRIMARY}
            >
              {importing ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  <span>Importing…</span>
                </>
              ) : (
                `Import ${selected.size} Snippet${selected.size === 1 ? "" : "s"}`
              )}
            </button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Scanning State */}
        {scanning && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 size={24} className="text-accent animate-spin" aria-hidden="true" />
            <p className="text-[length:var(--text-sm)] text-text-secondary">
              Scanning shell environment for aliases…
            </p>
          </div>
        )}

        {/* Error State */}
        {!scanning && scanError && (
          <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
            <div className="w-10 h-10 rounded-full bg-status-error/10 text-status-error flex items-center justify-center">
              <AlertCircle size={20} aria-hidden="true" />
            </div>
            <div>
              <p className="text-[length:var(--text-sm)] font-medium text-text-primary">
                Could not scan aliases
              </p>
              <p className="text-[length:var(--text-xs)] text-text-muted mt-1 max-w-md">
                {scanError}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void scan()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[length:var(--text-xs)] font-medium bg-bg-surface border border-border text-text-secondary hover:text-text-primary"
            >
              <RefreshCw size={13} aria-hidden="true" />
              <span>Retry</span>
            </button>
          </div>
        )}

        {/* Empty State */}
        {!scanning && !scanError && aliases.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <div className="w-10 h-10 rounded-full bg-bg-muted flex items-center justify-center text-text-muted">
              <Terminal size={20} aria-hidden="true" />
            </div>
            <div>
              <p className="text-[length:var(--text-sm)] font-medium text-text-primary">
                No shell aliases detected
              </p>
              <p className="text-[length:var(--text-xs)] text-text-muted mt-1 max-w-sm">
                No aliases were found in the current shell environment or configuration files (~/.bashrc, ~/.zshrc).
              </p>
            </div>
            <button
              type="button"
              onClick={() => void scan()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[length:var(--text-xs)] font-medium bg-bg-surface border border-border text-text-secondary hover:text-text-primary"
            >
              <RefreshCw size={13} aria-hidden="true" />
              <span>Scan Again</span>
            </button>
          </div>
        )}

        {/* Detected List & Controls */}
        {!scanning && !scanError && aliases.length > 0 && (
          <>
            {/* Folder Organization Options */}
            <div className="p-3 rounded-lg border border-border bg-bg-surface/50 flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="create-new-folder-chk"
                  data-testid="import-aliases-create-folder-chk"
                  checked={createNewFolder}
                  onChange={(e) => setCreateNewFolder(e.target.checked)}
                  className="rounded border-border text-accent focus:ring-accent"
                />
                <label
                  htmlFor="create-new-folder-chk"
                  className="text-[length:var(--text-xs)] font-medium text-text-primary cursor-pointer select-none"
                >
                  Create new folder for these snippets
                </label>
              </div>

              {createNewFolder ? (
                <input
                  type="text"
                  data-testid="import-aliases-new-folder-name"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Folder name"
                  className="w-full rounded-md bg-bg-base border border-border px-2.5 py-1.5 text-[length:var(--text-xs)] text-text-primary outline-none focus:border-border-focus focus:ring-1 focus:ring-ring"
                />
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[length:var(--text-xs)] text-text-muted shrink-0">
                    Add to folder:
                  </span>
                  <div className="flex-1">
                    <CustomSelect
                      value={selectedFolderId}
                      onChange={setSelectedFolderId}
                      placeholder="None (Root)"
                      options={[
                        { value: "", label: "None (Root)" },
                        ...(folders ?? []).map((f) => ({ value: f.id, label: f.name })),
                      ]}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Filter and Selection Header */}
            <div className="flex items-center justify-between gap-2">
              <div className="relative flex-1">
                <Search
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  data-testid="import-aliases-search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter aliases…"
                  className="w-full pl-8 pr-3 py-1.5 rounded-md bg-bg-base border border-border text-[length:var(--text-xs)] text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus focus:ring-1 focus:ring-ring"
                />
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  data-testid="import-aliases-toggle-all"
                  onClick={allFilteredSelected ? handleDeselectAll : handleSelectAll}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[length:var(--text-xs)] font-medium text-text-secondary hover:text-text-primary bg-bg-surface hover:bg-bg-muted border border-border transition-colors"
                >
                  {allFilteredSelected ? (
                    <>
                      <Square size={13} aria-hidden="true" />
                      <span>Deselect all</span>
                    </>
                  ) : (
                    <>
                      <CheckSquare size={13} aria-hidden="true" />
                      <span>Select all</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Aliases Table */}
            <div className="rounded-lg border border-border overflow-hidden max-h-[300px] overflow-y-auto bg-bg-base">
              {filtered.length === 0 ? (
                <div className="py-8 text-center text-[length:var(--text-xs)] text-text-muted">
                  No aliases match &ldquo;{searchQuery}&rdquo;
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {filtered.map((alias) => {
                    const isChecked = selected.has(alias.name);
                    const alreadyExists = existingNames.has(alias.name);

                    return (
                      <div
                        key={alias.name}
                        data-testid={`import-alias-row-${alias.name}`}
                        onClick={() => toggleSelect(alias.name)}
                        className={[
                          "flex items-center gap-3 px-3 py-2 text-left cursor-pointer transition-colors duration-75 select-none",
                          isChecked ? "bg-accent/5 hover:bg-accent/10" : "hover:bg-bg-subtle",
                        ].join(" ")}
                      >
                        <input
                          type="checkbox"
                          data-testid={`import-alias-checkbox-${alias.name}`}
                          checked={isChecked}
                          onChange={() => {}} // handled by row onClick
                          className="rounded border-border text-accent focus:ring-accent shrink-0 pointer-events-none"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[length:var(--text-xs)] font-semibold text-text-primary">
                              {alias.name}
                            </span>
                            {alreadyExists && (
                              <span className="text-[10px] px-1.5 py-0.2 rounded bg-bg-muted text-text-muted">
                                Existing
                              </span>
                            )}
                          </div>
                          <p className="font-mono text-[11px] text-text-muted truncate mt-0.5">
                            {alias.command}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}
