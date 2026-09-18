/*
 * Wire types for encrypted dataset sync.
 *
 * These mirror `src-tauri/src/sync/{commands,meta}.rs` exactly. The endpoint
 * secret (`password` / `keyPassphrase`) is passed straight into an invoke and
 * is never kept in a store or persisted through `save_setting`.
 */

/** Endpoint fields as entered in Settings. Supply `password` or `keyPath`. */
export interface SyncEndpointInput {
  host: string;
  port?: number;
  username: string;
  password?: string;
  keyPath?: string;
  keyPassphrase?: string;
  remotePath: string;
}

/** Summary of a dataset already published at a probed remote path. */
export interface ExistingDataset {
  datasetId: string;
  generation: number;
  updatedAt: string;
  /** Owner-role datasets sign each published generation. */
  signed: boolean;
  ownerFingerprint: string | null;
}

/** Result of `sync_test_connection` — nothing on the remote is modified. */
export interface SyncConnectionTest {
  reachable: boolean;
  pathExists: boolean;
  /** This account can create and remove files in the remote path. */
  writable: boolean;
  datasetPresent: boolean;
  existingDataset: ExistingDataset | null;
  /** Set when a dataset is present but its metadata could not be read. */
  metadataError: string | null;
}

/** Discriminants of the Rust `SyncError`, serialized as `{ kind, message }`. */
export type SyncErrorKind =
  | "format"
  | "crypto"
  | "decrypt"
  | "version"
  | "serialization"
  | "unreachable"
  | "transport"
  | "sftpUnavailable"
  | "locked"
  /** The remote generation moved on: another client published first. */
  | "conflict"
  /** A member-role dataset attempted a publish, which only owners may do. */
  | "roleDenied"
  /** A secret could not be read because the App Vault is locked. */
  | "vault"
  | "notFound"
  | "database";

export interface SyncErrorPayload {
  kind: SyncErrorKind;
  message: string;
}

/* ─── Datasets ──────────────────────────────────────────────────────────────
 * A dataset is one published host set on one server. `contentFlags` selects
 * what a push publishes; the credential sub-toggles (`hostCredentials`,
 * `s3Credentials`) are separate because they decide whether secrets travel in
 * the encrypted payload at all (AD-6/AD-11). */

export type SyncContentKind =
  | "hosts"
  | "hostCredentials"
  | "groups"
  | "snippets"
  | "snippetFolders"
  | "portForwards"
  | "s3Connections"
  | "s3Credentials"
  | "hostPlugins"
  | "appSettings";

export type SyncContentFlags = Record<SyncContentKind, boolean>;

export type SyncRole = "owner" | "member";

export type SyncScopeMode = "all" | "groups" | "hosts";

/** A saved dataset row as returned by `sync_list_datasets` / `sync_save_dataset`. */
export interface SyncDatasetSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  /*
   * Key-auth datasets only. The backend keeps it beside the credential, not in
   * the row, and reports it here when it has one; an endpoint opened for edit
   * falls back to asking for the path again if the summary does not carry it.
   */
  keyPath?: string | null;
  remotePath: string;
  role: SyncRole;
  contentFlags: SyncContentFlags;
  scopeMode: SyncScopeMode;
  /**
   * The group ids (`groups` mode) or host ids (`hosts` mode) the dataset
   * selects; empty for `all`. Prefills the editor.
   */
  scopeMemberIds: string[];
  /**
   * How many of this machine's hosts the dataset carries right now, computed
   * from the current hosts, groups, and selection.
   */
  scopeHostCount: number;
  /** Master switch. Off unless the user turned automatic sync on for this dataset. */
  autoSync: boolean;
  /** How often automatic sync pulls, in seconds. `0` = never on its own. */
  pullIntervalSecs: number;
  /** How long a local change waits before automatic sync pushes, in seconds. */
  pushDebounceSecs: number;
  lastGeneration: number;
  lastSyncedAt: string | null;
  /** The endpoint secret is stored locally; these report whether it exists. */
  hasServerSecret: boolean;
  hasPassphrase: boolean;
}

/** Dataset fields as entered in Settings. `id` present means "update this row". */
export interface SyncDatasetInput {
  id?: string | null;
  name: string;
  host: string;
  port?: number;
  username: string;
  keyPath?: string;
  remotePath: string;
  role?: SyncRole;
  contentFlags: SyncContentFlags;
  /** `all` unless the dataset is limited to groups or to explicit hosts. */
  scopeMode: SyncScopeMode;
  /**
   * Group ids when `scopeMode` is `groups`, host ids when it is `hosts`. Must
   * name at least one existing record for those modes; `all` ignores it.
   */
  scopeMemberIds: string[];
  /** Omitted cadences keep the stored values; a new dataset starts at `0` (manual only). */
  autoSync?: boolean;
  pullIntervalSecs?: number;
  pushDebounceSecs?: number;
}

/**
 * Dataset secrets for one call. They are handed straight to the invoke: they are
 * never written to a store, `app_settings`, or the DB.
 */
export interface SyncDatasetSecrets {
  password?: string;
  keyPassphrase?: string;
  /** Encrypts the dataset key. Required on every machine that joins. */
  passphrase: string;
}

/*
 * Result of `sync_save_dataset`. The stored row alone cannot tell "adopted the
 * dataset already published at this path" from "created an empty one here" —
 * the difference that decides whether the next step is Pull now or Push now —
 * so the save reports it explicitly.
 */
export interface SyncSaveOutcome {
  dataset: SyncDatasetSummary;
  /** true when the save adopted a dataset already published at that path. */
  joined: boolean;
  /** Generation found on the server at save time; 0 when nothing is published there. */
  remoteGeneration: number;
}
/** What a push would publish, answered before anything is written remotely. */
export interface SyncPushPreflight {
  datasetId: string;
  /** Any credential sub-toggle is on, so secrets would travel in the payload. */
  includeCredentials: boolean;
  vaultLocked: boolean;
  hostsInScope: number;
  credentialsReadable: number;
  credentialsBlocked: number;
  /* Whether this account can create and remove files at the remote path. A
   * member dataset on a writable remote means the server is not enforcing the
   * read-only role, so the row warns with the server-side fix. */
  remoteWritable: boolean;
}

/** Result of republishing a dataset under a new passphrase (owner only). */
export interface SyncRotateOutcome {
  datasetId: string;
  generation: number;
}

/** Counts from one successful push, mirrored into `sync_record_state`. */
export interface SyncPushOutcome {
  datasetId: string;
  generation: number;
  hosts: number;
  groups: number;
  snippets: number;
  snippetFolders: number;
  portForwards: number;
  s3Connections: number;
  hostPlugins: number;
  appSettings: boolean;
  tombstones: number;
  /** Hosts that left this dataset's scope with this push. Not deletions. */
  scopeRemovals: number;
  credentialsIncluded: number;
}

/* ─── Pull + conflict log ───────────────────────────────────────────────────
 * A pull reports what the merge engine wrote, not what the dataset contains:
 * `applied` counts the records that landed locally (a kind that did not change
 * is zero), `deleted` and `keptLocal` count tombstones and local edits the
 * merge deliberately did not overwrite, and every both-changed record is logged
 * as a conflict row naming the winner and the loser. */

/** Counts from one successful pull, per content kind. */
export interface SyncAppliedCounts {
  hosts: number;
  groups: number;
  snippets: number;
  snippetFolders: number;
  portForwards: number;
  s3Connections: number;
  hostPlugins: number;
  appSettings: boolean;
}

/** Result of `sync_pull` — one merge applied inside a single transaction. */
export interface SyncPullOutcome {
  datasetId: string;
  generation: number;
  /** The generation just pulled was published by a different installation. */
  publishedByAnotherMachine: boolean;
  applied: SyncAppliedCounts;
  deleted: number;
  /** Local edits the merge kept instead of overwriting with an older remote copy. */
  keptLocal: number;
  conflicts: number;
  credentialsApplied: number;
}
/** One member dataset claiming a host as read-only (Task 10). */
export interface SyncManagedBy {
  datasetId: string;
  name: string;
}

/** One both-changed record resolved by last-writer-wins (AD-5). */
export interface SyncConflictEntry {
  id: number;
  datasetId: string;
  entityType: string;
  entityId: string;
  /** Human-readable explanation of which copy won and why. */
  resolution: string;
  /** `updated_at` of the copy that was kept / overwritten; null when unknown. */
  winnerUpdatedAt: string | null;
  loserUpdatedAt: string | null;
  detectedAt: string;
}

/* ─── Live status ───────────────────────────────────────────────────────────
 * The backend owns sync state: the scheduler knows when a run starts, what it
 * left behind, and whether local edits are still waiting for their debounce.
 * `sync_status` returns one snapshot per dataset, and the `sync:status` event
 * carries a single snapshot whenever a dataset's phase changes — so the UI
 * never has to guess a phase from a button click it did not make.
 *
 * `message` and `kind` are set only while `phase` is `error`; the kind is what
 * turns a raw failure into an instruction ("pull before pushing"). */

export type SyncPhase = "idle" | "pulling" | "pushing" | "error";

export interface SyncStatusSnapshot {
  datasetId: string;
  /** Copied from the dataset row so a badge can name the failing dataset. */
  name: string;
  phase: SyncPhase;
  autoSync: boolean;
  pullIntervalSecs: number;
  pushDebounceSecs: number;
  generation: number;
  lastSyncedAt: string | null;
  /** Local edits waiting for the push debounce to elapse. */
  pendingLocalChanges: boolean;
  /** Set when `phase` is `error`. */
  message: string | null;
  /** Set when `phase` is `error`. */
  kind: SyncErrorKind | null;
}
