/*
 * Modal dialog for creating and editing sync datasets.
 * Organizes server connection (SSH/SFTP), security/identity (name, passphrase, role),
 * and sync scope/content flags into structured, accessible sections.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Save,
  Pencil,
  Server,
  KeyRound,
  Layers,
} from "lucide-react";
import { ModalShell, BTN_PRIMARY, BTN_SECONDARY } from "../shared/ModalShell";
import {
  DEFAULT_SYNC_CONTENT_FLAGS,
  DEFAULT_SYNC_ENDPOINT,
  DEFAULT_SYNC_SCOPE_MODE,
  useSyncStore,
} from "../../stores/sync-store";
import { useGroupsStore } from "../../stores/groups-store";
import { useHostsStore } from "../../stores/hosts-store";
import { toast } from "../../stores/toast-store";
import type {
  SyncContentFlags,
  SyncContentKind,
  SyncDatasetInput,
  SyncDatasetSecrets,
  SyncDatasetSummary,
  SyncRole,
  SyncScopeMode,
  SyncErrorKind,
  SyncSaveOutcome,
} from "../../types";

const MIN_DATASET_PASSPHRASE = 12;

const LABEL_CLASS = "text-[length:var(--text-sm)] font-medium text-text-primary";
const DESC_CLASS = "text-[length:var(--text-xs)] text-text-muted mt-0.5";
const FIELD_LABEL_CLASS = "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

const TEXT_INPUT_CLASS = [
  "w-full px-3 py-2 rounded-lg text-[length:var(--text-sm)]",
  "bg-bg-base border border-border text-text-primary placeholder:text-text-muted",
  "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
  "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
].join(" ");

const BTN_ACTION_SECONDARY = [
  "inline-flex items-center justify-center gap-2 px-3.5 py-1.5 rounded-lg shrink-0",
  "text-[length:var(--text-sm)] font-medium text-text-secondary hover:text-text-primary",
  "bg-bg-subtle hover:bg-bg-muted border border-border disabled:opacity-50",
  "transition-all duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "whitespace-nowrap cursor-pointer",
].join(" ");

const CONTENT_CHILDREN: Partial<Record<SyncContentKind, SyncContentKind[]>> = {
  hosts: ["hostCredentials", "portForwards", "hostPlugins"],
  s3Connections: ["s3Credentials"],
};

const SCOPE_MODES: { mode: SyncScopeMode; label: string; hint: string }[] = [
  { mode: "all", label: "All hosts", hint: "Every host on this computer." },
  { mode: "groups", label: "Groups", hint: "Every host in the groups you pick." },
  { mode: "hosts", label: "Specific hosts", hint: "Only the hosts you pick." },
];

const SYNC_ERROR_HINTS: Partial<Record<SyncErrorKind, string>> = {
  conflict: "Another machine published first — pull before pushing.",
  roleDenied: "This dataset is pull-only for your role — only its owner can publish.",
  vault: "Unlock the App Vault and try again.",
  decrypt: "Wrong dataset passphrase — re-save the dataset with the correct passphrase.",
  sftpUnavailable: "Dataset sync needs a server with the SFTP subsystem enabled.",
  locked: "Another machine is syncing this dataset — try again in a moment.",
  unreachable: "The server could not be reached — sync retries on the next trigger.",
};

function ScopePicker({
  legend,
  items,
  selected,
  testidPrefix,
  onToggle,
}: {
  legend: string;
  items: { id: string; name: string }[];
  selected: string[];
  testidPrefix: string;
  onToggle: (id: string, checked: boolean) => void;
}) {
  return (
    <fieldset
      data-testid={`settings-sync-scope-picker-${testidPrefix}`}
      className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border/60 bg-bg-base px-3 py-2"
    >
      <legend className={`${LABEL_CLASS} px-1`}>{legend}</legend>
      {items.length === 0 ? (
        <p className={DESC_CLASS}>
          Nothing to pick yet — create it first, then come back to this dataset.
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => (
            <label key={item.id} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                data-testid={`settings-sync-scope-${testidPrefix}-${item.id}`}
                className="w-3.5 h-3.5 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer"
                checked={selected.includes(item.id)}
                onChange={(e) => onToggle(item.id, e.target.checked)}
              />
              <span className="text-[length:var(--text-xs)] text-text-secondary truncate">
                {item.name}
              </span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function SyncSaveReport({ outcome }: { outcome: SyncSaveOutcome }) {
  const generation =
    outcome.joined && outcome.remoteGeneration > 0
      ? ` (generation ${outcome.remoteGeneration})`
      : "";
  return (
    <div
      data-testid="settings-sync-save-outcome"
      role="status"
      className={[
        "flex items-start gap-2 px-3 py-2.5 rounded-lg border",
        "text-[length:var(--text-xs)] text-text-secondary",
        outcome.joined
          ? "bg-status-success/10 border-status-success/30"
          : "bg-status-connecting/10 border-status-connecting/30",
      ].join(" ")}
    >
      {outcome.joined ? (
        <CheckCircle2 size={13} strokeWidth={2} className="text-status-success shrink-0 mt-0.5" />
      ) : (
        <AlertTriangle
          size={13}
          strokeWidth={2}
          className="text-status-connecting shrink-0 mt-0.5"
        />
      )}
      <span>
        {outcome.joined
          ? `Joined the dataset published at this path${generation}. Press Pull now to bring it in.`
          : "No dataset is published at this path yet, so a new one was created. Press Push now to publish it."}
      </span>
    </div>
  );
}

export interface SyncDatasetModalProps {
  open: boolean;
  editing: SyncDatasetSummary | null;
  onClose: () => void;
  onCancelEdit?: () => void;
}

export function SyncDatasetModal({
  open,
  editing,
  onClose,
  onCancelEdit,
}: SyncDatasetModalProps) {
  const {
    endpoint,
    testing,
    testResult,
    error,
    errorKind,
    saveOutcome,
    setEndpoint,
    testConnection,
    saving,
    saveDataset,
    loadDatasets,
    clearSaveOutcome,
    clearDatasetError,
  } = useSyncStore();

  const [password, setPassword] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [useKey, setUseKey] = useState(false);
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [contentFlags, setContentFlags] = useState<SyncContentFlags>({
    ...DEFAULT_SYNC_CONTENT_FLAGS,
  });
  const [scopeMode, setScopeMode] = useState<SyncScopeMode>(DEFAULT_SYNC_SCOPE_MODE);
  const [scopeMemberIds, setScopeMemberIds] = useState<string[]>([]);
  const [role, setRole] = useState<SyncRole>("owner");

  const groups = useGroupsStore((s) => s.groups);
  const hosts = useHostsStore((s) => s.hosts);

  /* Sync modal form fields when opened or when editing changes */
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setContentFlags({ ...editing.contentFlags });
      setScopeMode(editing.scopeMode);
      setScopeMemberIds([...editing.scopeMemberIds]);
      setUseKey(editing.authType === "privateKey");
      setRole(editing.role);
      setPassword("");
      setPassphrase("");
      setKeyPassphrase("");
      setFormError(null);
      clearSaveOutcome();
      setEndpoint({
        host: editing.host,
        port: editing.port,
        username: editing.username,
        remotePath: editing.remotePath,
        keyPath: editing.keyPath ?? "",
      });
    } else {
      setName("");
      setContentFlags({ ...DEFAULT_SYNC_CONTENT_FLAGS });
      setScopeMode(DEFAULT_SYNC_SCOPE_MODE);
      setScopeMemberIds([]);
      setUseKey(false);
      setRole("owner");
      setPassword("");
      setPassphrase("");
      setKeyPassphrase("");
      setFormError(null);
      clearSaveOutcome();
      setEndpoint({ ...DEFAULT_SYNC_ENDPOINT });
    }
  }, [open, editing, clearSaveOutcome, setEndpoint]);

  const runTest = useCallback(async () => {
    try {
      await testConnection(useKey ? { keyPassphrase } : { password });
    } catch {
      /* surfaced through the store's error state */
    }
  }, [testConnection, useKey, keyPassphrase, password]);

  const toggleContent = useCallback(
    (kind: SyncContentKind, value: boolean) => {
      clearSaveOutcome();
      setContentFlags((prev) => {
        const next: SyncContentFlags = { ...prev, [kind]: value };
        if (!value) {
          for (const child of CONTENT_CHILDREN[kind] ?? []) next[child] = false;
        }
        return next;
      });
    },
    [clearSaveOutcome],
  );

  const chooseScopeMode = useCallback(
    (mode: SyncScopeMode) => {
      clearSaveOutcome();
      setScopeMode(mode);
      setScopeMemberIds((prev) => (mode === "all" ? [] : prev));
    },
    [clearSaveOutcome],
  );

  const toggleScopeMember = useCallback(
    (id: string, checked: boolean) => {
      clearSaveOutcome();
      setScopeMemberIds((prev) =>
        checked ? [...prev, id] : prev.filter((member) => member !== id),
      );
    },
    [clearSaveOutcome],
  );

  const scopeCount = useMemo(() => {
    if (scopeMode === "all") return hosts.length;
    if (scopeMode === "groups") {
      return hosts.filter((host) => {
        const groupId = host.group_id;
        return groupId !== null && scopeMemberIds.includes(groupId);
      }).length;
    }
    return hosts.filter((host) => scopeMemberIds.includes(host.id)).length;
  }, [scopeMode, scopeMemberIds, hosts]);

  const scopeSelection = useMemo(() => {
    const valid = scopeMode === "groups" ? groups.map((g) => g.id) : hosts.map((h) => h.id);
    return scopeMemberIds.filter((id) => valid.includes(id));
  }, [scopeMode, scopeMemberIds, groups, hosts]);

  const scopeError =
    scopeMode !== "all" && scopeSelection.length === 0
      ? scopeMode === "groups"
        ? "Choose at least one group, or switch the scope back to all hosts."
        : "Choose at least one host, or switch the scope back to all hosts."
      : null;

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setFormError("Give the dataset a name so you can tell it apart later.");
      return;
    }
    if (passphrase.length < MIN_DATASET_PASSPHRASE) {
      setFormError(`Use at least ${MIN_DATASET_PASSPHRASE} characters for the dataset passphrase.`);
      return;
    }
    if (useKey && !endpoint.keyPath.trim()) {
      setFormError("Enter the path to the private key this dataset connects with.");
      return;
    }
    if (role !== "member" && scopeError) return;
    setFormError(null);
    const effectiveScopeMode: SyncScopeMode = role === "member" ? "all" : scopeMode;
    const input: SyncDatasetInput = {
      name: name.trim(),
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      remotePath: endpoint.remotePath,
      contentFlags,
      scopeMode: effectiveScopeMode,
      scopeMemberIds: effectiveScopeMode === "all" ? [] : scopeSelection,
      ...(endpoint.keyPath ? { keyPath: endpoint.keyPath } : {}),
      ...(editing
        ? {
            id: editing.id,
            role,
            autoSync: editing.autoSync,
            pullIntervalSecs: editing.pullIntervalSecs,
            pushDebounceSecs: editing.pushDebounceSecs,
          }
        : {
            role,
            autoSync: false,
            pullIntervalSecs: 0,
            pushDebounceSecs: 0,
          }),
    };
    const secrets: SyncDatasetSecrets = {
      passphrase,
      ...(useKey ? { keyPassphrase } : { password }),
    };
    try {
      await saveDataset(input, secrets);
      await loadDatasets();
      toast.success(editing ? "Dataset updated." : "Dataset saved.");
      setPassword("");
      setPassphrase("");
      setKeyPassphrase("");
    } catch {
      /* the dataset card renders the failure */
    }
  }, [
    name,
    passphrase,
    endpoint,
    useKey,
    contentFlags,
    password,
    keyPassphrase,
    editing,
    saveDataset,
    loadDatasets,
    role,
    scopeMode,
    scopeSelection,
    scopeError,
  ]);

  const handleCancelEdit = useCallback(() => {
    onCancelEdit?.();
    setName("");
    setContentFlags({ ...DEFAULT_SYNC_CONTENT_FLAGS });
    setScopeMode(DEFAULT_SYNC_SCOPE_MODE);
    setScopeMemberIds([]);
    setUseKey(false);
    setRole("owner");
    setPassword("");
    setPassphrase("");
    setKeyPassphrase("");
    setFormError(null);
    clearSaveOutcome();
    setEndpoint({ ...DEFAULT_SYNC_ENDPOINT });
  }, [onCancelEdit, clearSaveOutcome, setEndpoint]);

  const passphraseTooShort = passphrase.length > 0 && passphrase.length < MIN_DATASET_PASSPHRASE;

  const modalFooter = (
    <>
      {editing ? (
        <button
          type="button"
          data-testid="settings-sync-cancel-edit"
          onClick={handleCancelEdit}
          disabled={saving}
          className={BTN_SECONDARY}
        >
          Cancel edit
        </button>
      ) : (
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className={BTN_SECONDARY}
        >
          {saveOutcome ? "Close" : "Cancel"}
        </button>
      )}
      <button
        type="button"
        data-testid="settings-sync-save"
        onClick={() => void handleSave()}
        disabled={saving}
        className={BTN_PRIMARY}
      >
        {saving ? (
          <RefreshCw size={13} strokeWidth={2} className="animate-spin shrink-0" />
        ) : (
          <Save size={13} strokeWidth={2} className="shrink-0" />
        )}
        <span className="whitespace-nowrap">
          {saving ? "Saving…" : editing ? "Update dataset" : "Save dataset"}
        </span>
      </button>
    </>
  );

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={editing ? `Edit “${editing.name}”` : "Add Dataset"}
      subtitle={
        editing
          ? "Update connection endpoint, role, scope, or syncable contents."
          : "Synchronize your hosts and settings across computers via an SFTP server."
      }
      icon={editing ? Pencil : RefreshCw}
      maxWidth="4xl"
      scrollable={true}
      busy={saving}
      footer={modalFooter}
    >
      <div className="space-y-5 text-[length:var(--text-sm)]">
        {saveOutcome && (
          <SyncSaveReport outcome={saveOutcome} />
        )}

        {editing && (
          <p
            data-testid="settings-sync-editing"
            className="flex items-start gap-1.5 px-3 py-2 rounded-lg bg-status-connecting/10 border border-status-connecting/30 text-[length:var(--text-xs)] text-text-secondary"
          >
            <Pencil size={13} strokeWidth={2} className="text-status-connecting shrink-0 mt-0.5" />
            <span>
              Editing “{editing.name}” — it is saved as this dataset’s new settings, and whatever is
              already published on the server is left as it is.
            </span>
          </p>
        )}

        {/* ── Section 1: Server Connection ── */}
        <div className="px-4 py-3.5 rounded-xl bg-bg-surface/50 border border-border/60 space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b border-border/40">
            <Server size={14} className="text-accent" />
            <h3 className={LABEL_CLASS}>1. Server Connection (SFTP)</h3>
          </div>

          <p className={DESC_CLASS}>
            OmniSSH publishes your hosts as a single encrypted file on a server you control.
          </p>

          <div className="grid grid-cols-[1fr_6.5rem] gap-3 pt-1">
            <div>
              <label className={FIELD_LABEL_CLASS} htmlFor="sync-host">
                Server address
              </label>
              <input
                id="sync-host"
                data-testid="settings-sync-host"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="10.0.0.9 or sync.example.com"
                value={endpoint.host}
                onChange={(e) => setEndpoint({ host: e.target.value })}
                className={TEXT_INPUT_CLASS}
              />
            </div>
            <div>
              <label className={FIELD_LABEL_CLASS} htmlFor="sync-port">
                Port
              </label>
              <input
                id="sync-port"
                data-testid="settings-sync-port"
                type="number"
                min={1}
                max={65535}
                value={endpoint.port}
                onChange={(e) => setEndpoint({ port: Number(e.target.value) || 22 })}
                className={TEXT_INPUT_CLASS}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={FIELD_LABEL_CLASS} htmlFor="sync-username">
                Username
              </label>
              <input
                id="sync-username"
                data-testid="settings-sync-username"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={endpoint.username}
                onChange={(e) => setEndpoint({ username: e.target.value })}
                className={TEXT_INPUT_CLASS}
              />
            </div>
            <div>
              <label className={FIELD_LABEL_CLASS} htmlFor="sync-path">
                Remote path
              </label>
              <input
                id="sync-path"
                data-testid="settings-sync-path"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="/srv/omnissh/my-hosts"
                value={endpoint.remotePath}
                onChange={(e) => setEndpoint({ remotePath: e.target.value })}
                className={TEXT_INPUT_CLASS}
              />
            </div>
          </div>

          <div className="pt-2 border-t border-border/40">
            <div className="flex items-center gap-4 mb-2">
              <span className={FIELD_LABEL_CLASS}>Authentication</span>
              <label className="flex items-center gap-1.5 text-[length:var(--text-xs)] text-text-secondary cursor-pointer">
                <input
                  type="radio"
                  name="sync-auth"
                  data-testid="settings-sync-auth-password"
                  checked={!useKey}
                  onChange={() => {
                    setUseKey(false);
                    setEndpoint({ keyPath: "" });
                  }}
                />
                Password
              </label>
              <label className="flex items-center gap-1.5 text-[length:var(--text-xs)] text-text-secondary cursor-pointer">
                <input
                  type="radio"
                  name="sync-auth"
                  data-testid="settings-sync-auth-key"
                  checked={useKey}
                  onChange={() => {
                    setUseKey(true);
                    setPassword("");
                  }}
                />
                Private key
              </label>
            </div>

            {useKey ? (
              <div className="grid grid-cols-2 gap-3">
                <input
                  data-testid="settings-sync-key-path"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="~/.ssh/id_ed25519"
                  value={endpoint.keyPath}
                  onChange={(e) => setEndpoint({ keyPath: e.target.value })}
                  className={TEXT_INPUT_CLASS}
                  aria-label="Private key path"
                />
                <input
                  data-testid="settings-sync-key-passphrase"
                  type="password"
                  autoComplete="off"
                  placeholder="Key passphrase (optional)"
                  value={keyPassphrase}
                  onChange={(e) => setKeyPassphrase(e.target.value)}
                  className={TEXT_INPUT_CLASS}
                  aria-label="Private key passphrase"
                />
              </div>
            ) : (
              <input
                data-testid="settings-sync-password"
                type="password"
                autoComplete="off"
                placeholder="Server password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={TEXT_INPUT_CLASS}
                aria-label="Server password"
              />
            )}
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              data-testid="settings-sync-test"
              onClick={() => void runTest()}
              disabled={testing}
              className={BTN_ACTION_SECONDARY}
            >
              <RefreshCw
                size={13}
                strokeWidth={2}
                className={`shrink-0 ${testing ? "animate-spin" : ""}`}
              />
              <span>{testing ? "Testing…" : "Test connection"}</span>
            </button>
            <p className={DESC_CLASS}>Probes remote directory over SFTP without writing data.</p>
          </div>

          {error && (
            <p
              data-testid="settings-sync-test-error"
              className="flex items-start gap-1.5 mt-2 text-[length:var(--text-xs)] text-status-error"
            >
              <AlertCircle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
              <span>
                {error}
                {errorKind && SYNC_ERROR_HINTS[errorKind] ? ` ${SYNC_ERROR_HINTS[errorKind]}` : null}
              </span>
            </p>
          )}

          {testResult && (
            <div
              data-testid="settings-sync-test-result"
              className="mt-2 px-3 py-2.5 rounded-lg bg-bg-base border border-border/60 text-[length:var(--text-xs)] text-text-secondary"
            >
              <p className="flex items-center gap-1.5 text-status-success">
                <CheckCircle2 size={13} strokeWidth={2} /> Connected over SFTP.
              </p>
              <ul className="mt-1.5 space-y-1">
                <li>
                  {testResult.pathExists
                    ? "Remote path exists."
                    : "Remote path does not exist yet — it will be created on the first sync."}
                </li>
                <li>
                  {testResult.writable
                    ? "This account can write to it."
                    : "This account cannot write to it — you can pull from this dataset but not publish to it."}
                </li>
                {testResult.existingDataset ? (
                  <li data-testid="settings-sync-existing-dataset">
                    A dataset is already published here: generation{" "}
                    {testResult.existingDataset.generation}, updated{" "}
                    {testResult.existingDataset.updatedAt}
                    {testResult.existingDataset.signed ? ", signed by its owner" : ", unsigned"}.
                    Syncing with it needs that dataset’s passphrase.
                  </li>
                ) : (
                  <li>No dataset here yet.</li>
                )}
                {testResult.metadataError && (
                  <li className="text-status-error">{testResult.metadataError}</li>
                )}
              </ul>
            </div>
          )}
        </div>

        {/* ── Section 2: Security & Role ── */}
        <div className="px-4 py-3.5 rounded-xl bg-bg-surface/50 border border-border/60 space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b border-border/40">
            <KeyRound size={14} className="text-accent" />
            <h3 className={LABEL_CLASS}>2. Dataset Security & Role</h3>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-1">
            <div>
              <label className={FIELD_LABEL_CLASS} htmlFor="sync-name">
                Dataset name
              </label>
              <input
                id="sync-name"
                data-testid="settings-sync-name"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="Work Laptops"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setFormError(null);
                  clearSaveOutcome();
                }}
                className={TEXT_INPUT_CLASS}
              />
            </div>
            <div>
              <label className={FIELD_LABEL_CLASS} htmlFor="sync-passphrase">
                Dataset passphrase
              </label>
              <input
                id="sync-passphrase"
                data-testid="settings-sync-passphrase"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value);
                  setFormError(null);
                  clearSaveOutcome();
                }}
                className={TEXT_INPUT_CLASS}
              />
            </div>
          </div>

          <p className={DESC_CLASS}>
            The passphrase encrypts the dataset end-to-end on this device before leaving over SFTP.
          </p>

          {(passphraseTooShort || formError) && (
            <p
              data-testid="settings-sync-passphrase-error"
              className="mt-1 text-[length:var(--text-xs)] text-status-error"
            >
              {formError ??
                `Use at least ${MIN_DATASET_PASSPHRASE} characters for the dataset passphrase.`}
            </p>
          )}

          <div className="pt-2 border-t border-border/40">
            <p className={`${LABEL_CLASS} mb-2`}>Your role in this dataset</p>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Dataset role">
              {[
                {
                  value: "owner" as const,
                  label: "Owner — can publish",
                  hint: "Signs each generation; can push & pull.",
                },
                {
                  value: "member" as const,
                  label: "Member — pull only",
                  hint: "Join someone else's dataset; pull only.",
                },
              ].map(({ value, label, hint }) => (
                <label
                  key={value}
                  className={`flex items-start gap-2.5 p-2.5 rounded-lg border cursor-pointer transition-colors ${
                    role === value
                      ? "border-accent bg-accent/10"
                      : "border-border/60 bg-bg-base hover:border-border"
                  }`}
                >
                  <input
                    type="radio"
                    name="sync-role"
                    data-testid={`settings-sync-role-${value}`}
                    className="mt-0.5 w-3.5 h-3.5 shrink-0 border-border text-accent focus:ring-ring cursor-pointer"
                    checked={role === value}
                    onChange={() => {
                      setRole(value);
                      clearSaveOutcome();
                      clearDatasetError();
                    }}
                  />
                  <span className="text-[length:var(--text-xs)] text-text-secondary">
                    <span className="font-semibold text-text-primary block">{label}</span>
                    <span className="text-text-muted mt-0.5 block">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        {/* ── Section 3: Scope & Content ── */}
        <div className="px-4 py-3.5 rounded-xl bg-bg-surface/50 border border-border/60 space-y-3">
          <div className="flex items-center gap-2 pb-2 border-b border-border/40">
            <Layers size={14} className="text-accent" />
            <h3 className={LABEL_CLASS}>3. Scope & Content</h3>
          </div>

          {role === "member" ? (
            <p data-testid="settings-sync-member-note" className={DESC_CLASS}>
              Members pull what the owner published. Which hosts that is, and which content kinds
              are published, are the owner&apos;s call — so this form does not ask.
            </p>
          ) : (
            <div>
              <p className={`${LABEL_CLASS} mb-2`}>Which hosts this dataset carries</p>
              <div className="flex items-center gap-4 mb-2" role="radiogroup" aria-label="Dataset scope">
                {SCOPE_MODES.map(({ mode, label }) => (
                  <label key={mode} className="flex items-start gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="sync-scope"
                      data-testid={`settings-sync-scope-${mode}`}
                      className="mt-0.5 w-3.5 h-3.5 shrink-0 border-border text-accent focus:ring-ring cursor-pointer"
                      checked={scopeMode === mode}
                      onChange={() => chooseScopeMode(mode)}
                    />
                    <span className="text-[length:var(--text-xs)] text-text-secondary">
                      <span className="font-medium">{label}</span>
                    </span>
                  </label>
                ))}
              </div>

              {scopeMode === "groups" && (
                <ScopePicker
                  legend="Groups in this dataset"
                  items={groups.map((group) => ({ id: group.id, name: group.name }))}
                  selected={scopeMemberIds}
                  testidPrefix="groups"
                  onToggle={toggleScopeMember}
                />
              )}

              {scopeMode === "hosts" && (
                <ScopePicker
                  legend="Hosts in this dataset"
                  items={hosts.map((host) => ({ id: host.id, name: host.label || host.host }))}
                  selected={scopeMemberIds}
                  testidPrefix="hosts"
                  onToggle={toggleScopeMember}
                />
              )}

              <p
                data-testid="settings-sync-scope-count"
                aria-live="polite"
                className={`mt-2 text-[length:var(--text-xs)] ${
                  scopeError ? "text-status-error" : "text-text-muted"
                }`}
              >
                {scopeError
                  ? `This dataset needs a scope. ${scopeError}`
                  : `${scopeCount} host${scopeCount === 1 ? "" : "s"} in scope`}
              </p>
            </div>
          )}

          <div className="pt-3 border-t border-border/40 space-y-3">
            <div>
              <p className={LABEL_CLASS}>
                {role === "member" ? "What this machine pulls" : "What this dataset publishes"}
              </p>
              <p className={DESC_CLASS}>
                {role === "member"
                  ? "Select the content kinds this machine imports from the published dataset."
                  : "Pick which data items and associated credentials travel with this dataset."}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Group 1: SSH Hosts & Host Features (Parent + Children) */}
              <div className="p-3.5 rounded-xl border border-border/60 bg-bg-base/50 space-y-3">
                <label className="flex items-start gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    data-testid="settings-sync-content-hosts"
                    className="mt-0.5 w-4 h-4 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer"
                    checked={contentFlags.hosts}
                    onChange={(e) => toggleContent("hosts", e.target.checked)}
                  />
                  <div>
                    <span className="text-[length:var(--text-sm)] font-semibold text-text-primary block">
                      Hosts
                    </span>
                    <span className="text-[11px] text-text-muted block mt-0.5">
                      SSH host connection entries and port settings.
                    </span>
                  </div>
                </label>

                {/* Indented Children Sub-panel */}
                <div
                  className={`ml-4 pl-3.5 border-l-2 border-accent/40 space-y-2.5 transition-opacity ${
                    contentFlags.hosts ? "opacity-100" : "opacity-40 pointer-events-none"
                  }`}
                >
                  <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      data-testid="settings-sync-content-hostCredentials"
                      className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer disabled:cursor-not-allowed"
                      checked={contentFlags.hostCredentials}
                      disabled={!contentFlags.hosts}
                      onChange={(e) => toggleContent("hostCredentials", e.target.checked)}
                    />
                    <div>
                      <span className="text-[length:var(--text-xs)] font-medium text-text-primary block">
                        Saved host credentials
                      </span>
                      <span className="text-[11px] text-text-muted block mt-0.5">
                        Passwords and private keys stored for those hosts. Off by default — anyone holding the dataset passphrase can read them.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      data-testid="settings-sync-content-portForwards"
                      className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer disabled:cursor-not-allowed"
                      checked={contentFlags.portForwards}
                      disabled={!contentFlags.hosts}
                      onChange={(e) => toggleContent("portForwards", e.target.checked)}
                    />
                    <div>
                      <span className="text-[length:var(--text-xs)] font-medium text-text-primary block">
                        Port-forward rules
                      </span>
                      <span className="text-[11px] text-text-muted block mt-0.5">
                        Children of your hosts — they travel with the hosts they belong to.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      data-testid="settings-sync-content-hostPlugins"
                      className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer disabled:cursor-not-allowed"
                      checked={contentFlags.hostPlugins}
                      disabled={!contentFlags.hosts}
                      onChange={(e) => toggleContent("hostPlugins", e.target.checked)}
                    />
                    <div>
                      <span className="text-[length:var(--text-xs)] font-medium text-text-primary block">
                        Host plugins
                      </span>
                      <span className="text-[11px] text-text-muted block mt-0.5">
                        Children of your hosts — they travel with the hosts they belong to.
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              {/* Group 2: S3 Storage & Standalone Items */}
              <div className="space-y-3">
                {/* S3 Storage (Parent + Child) */}
                <div className="p-3.5 rounded-xl border border-border/60 bg-bg-base/50 space-y-3">
                  <label className="flex items-start gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      data-testid="settings-sync-content-s3Connections"
                      className="mt-0.5 w-4 h-4 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer"
                      checked={contentFlags.s3Connections}
                      onChange={(e) => toggleContent("s3Connections", e.target.checked)}
                    />
                    <div>
                      <span className="text-[length:var(--text-sm)] font-semibold text-text-primary block">
                        S3 connections
                      </span>
                      <span className="text-[11px] text-text-muted block mt-0.5">
                        S3 storage connection endpoints and buckets.
                      </span>
                    </div>
                  </label>

                  {/* S3 Child Sub-panel */}
                  <div
                    className={`ml-4 pl-3.5 border-l-2 border-accent/40 space-y-2.5 transition-opacity ${
                      contentFlags.s3Connections ? "opacity-100" : "opacity-40 pointer-events-none"
                    }`}
                  >
                    <label className="flex items-start gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        data-testid="settings-sync-content-s3Credentials"
                        className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer disabled:cursor-not-allowed"
                        checked={contentFlags.s3Credentials}
                        disabled={!contentFlags.s3Connections}
                        onChange={(e) => toggleContent("s3Credentials", e.target.checked)}
                      />
                      <div>
                        <span className="text-[length:var(--text-xs)] font-medium text-text-primary block">
                          S3 access keys
                        </span>
                        <span className="text-[11px] text-text-muted block mt-0.5">
                          Access keys stored for those connections. Off by default.
                        </span>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Workspace Items 2x2 Grid */}
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-start gap-2 p-2.5 rounded-xl border border-border/60 bg-bg-base/50 cursor-pointer select-none hover:border-border transition-colors">
                    <input
                      type="checkbox"
                      data-testid="settings-sync-content-groups"
                      className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer"
                      checked={contentFlags.groups}
                      onChange={(e) => toggleContent("groups", e.target.checked)}
                    />
                    <div>
                      <span className="text-[length:var(--text-xs)] font-medium text-text-primary block">
                        Groups
                      </span>
                      <span className="text-[11px] text-text-muted block mt-0.5">
                        Host organization groups.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2 p-2.5 rounded-xl border border-border/60 bg-bg-base/50 cursor-pointer select-none hover:border-border transition-colors">
                    <input
                      type="checkbox"
                      data-testid="settings-sync-content-snippets"
                      className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer"
                      checked={contentFlags.snippets}
                      onChange={(e) => toggleContent("snippets", e.target.checked)}
                    />
                    <div>
                      <span className="text-[length:var(--text-xs)] font-medium text-text-primary block">
                        Snippets
                      </span>
                      <span className="text-[11px] text-text-muted block mt-0.5">
                        Reusable snippets.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2 p-2.5 rounded-xl border border-border/60 bg-bg-base/50 cursor-pointer select-none hover:border-border transition-colors">
                    <input
                      type="checkbox"
                      data-testid="settings-sync-content-snippetFolders"
                      className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer"
                      checked={contentFlags.snippetFolders}
                      onChange={(e) => toggleContent("snippetFolders", e.target.checked)}
                    />
                    <div>
                      <span className="text-[length:var(--text-xs)] font-medium text-text-primary block">
                        Snippet folders
                      </span>
                      <span className="text-[11px] text-text-muted block mt-0.5">
                        Folder hierarchies.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2 p-2.5 rounded-xl border border-border/60 bg-bg-base/50 cursor-pointer select-none hover:border-border transition-colors">
                    <input
                      type="checkbox"
                      data-testid="settings-sync-content-appSettings"
                      className="mt-0.5 w-3.5 h-3.5 shrink-0 rounded border-border text-accent focus:ring-ring cursor-pointer"
                      checked={contentFlags.appSettings}
                      onChange={(e) => toggleContent("appSettings", e.target.checked)}
                    />
                    <div>
                      <span className="text-[length:var(--text-xs)] font-medium text-text-primary block">
                        App settings
                      </span>
                      <span className="text-[11px] text-text-muted block mt-0.5">
                        Preferences only.
                      </span>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
