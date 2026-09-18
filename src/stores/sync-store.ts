/* Dataset-sync UI state.
 *
 * The store holds the non-secret endpoint draft the Settings form edits, the
 * saved datasets, and the outcome of the last connection test / push. Secrets
 * are deliberately excluded: the server password, key passphrase, and dataset
 * passphrase live in local component state, are handed to the invoke as
 * parameters, and are dropped — so a secret never reaches Zustand, devtools, or
 * `save_setting`. The backend persists them in the keychain / App Vault.
 *
 * The endpoint probe and the dataset operations render in different cards, so
 * their failures are tracked separately (`error` vs `datasetError`): a push that
 * could not reach the server must not appear next to "Test connection". */

import { create } from "zustand";
import { useGroupsStore } from "./groups-store";
import { useHostsStore } from "./hosts-store";
import type {
  SyncConflictEntry,
  SyncConnectionTest,
  SyncContentFlags,
  SyncDatasetInput,
  SyncDatasetSecrets,
  SyncDatasetSummary,
  SyncEndpointInput,
  SyncErrorPayload,
  SyncHistoryListing,
  SyncManagedBy,
  SyncPullOutcome,
  SyncPushOutcome,
  SyncPushPreflight,
  SyncRollbackOutcome,
  SyncRotateOutcome,
  SyncSaveOutcome,
  SyncScopeMode,
  SyncStatusSnapshot,
} from "../types/sync";

/** The part of an endpoint that is safe to keep in frontend state. */
export interface SyncEndpointDraft {
  host: string;
  port: number;
  username: string;
  remotePath: string;
  keyPath: string;
}

export const DEFAULT_SYNC_ENDPOINT: SyncEndpointDraft = {
  host: "",
  port: 22,
  username: "",
  remotePath: "",
  keyPath: "",
};

/* Everything syncs by default; only the credential sub-toggles start off, so a
 * dataset published to a shared server never leaks secrets by accident (AD-6). */
export const DEFAULT_SYNC_CONTENT_FLAGS: SyncContentFlags = {
  hosts: true,
  hostCredentials: false,
  groups: true,
  snippets: true,
  snippetFolders: true,
  portForwards: true,
  s3Connections: true,
  s3Credentials: false,
  hostPlugins: true,
  appSettings: true,
};

/* A new dataset carries every host on this machine until the user narrows it
 * (Task 8). `all` is also what a row saved before scopes existed means, so the
 * editor can round-trip such a row without inventing a selection. */
export const DEFAULT_SYNC_SCOPE_MODE: SyncScopeMode = "all";

/** Credential material for one call. Never stored. */
export interface SyncEndpointSecret {
  password?: string;
  keyPassphrase?: string;
}

/* The three automatic-sync fields of one dataset. `0` on a cadence means "never
 * on its own", so enabling the master switch alone cannot start syncing behind
 * the user's back. */
export interface SyncScheduleInput {
  autoSync: boolean;
  pullIntervalSecs: number;
  pushDebounceSecs: number;
}

/*
 * One `sync:status` listener per process. Settings and the status bar both want
 * the stream, and React mounts effects twice in development, so the listener is
 * shared: the first caller opens it, every caller receives the same unsubscribe
 * function, and the last one out closes it. A rejected `listen` (no webview, a
 * mocked test environment) clears the slot so the next caller can retry.
 */
let statusSubscription: { promise: Promise<() => void>; subscribers: number } | null = null;

/** Snapshots keyed by dataset id, for merging one event into the map. */
function byDataset(snapshots: SyncStatusSnapshot[]): Record<string, SyncStatusSnapshot> {
  const merged: Record<string, SyncStatusSnapshot> = {};
  for (const snapshot of snapshots) merged[snapshot.datasetId] = snapshot;
  return merged;
}

/* The backend serializes every sync failure as `{ kind, message }`, so one
 * narrowing keeps both fields together; anything else (a thrown string, an IPC
 * transport failure) falls back to the caller's wording. */
function syncFailure(
  error: unknown,
  fallback: string,
): { message: string; kind: SyncErrorPayload["kind"] | null } {
  if (error && typeof error === "object" && "message" in error && "kind" in error) {
    const payload = error as SyncErrorPayload;
    return { message: String(payload.message), kind: payload.kind };
  }
  return { message: fallback, kind: null };
}

/* Each dataset action replaces the previous failure, so a stale "generation
 * conflict" cannot sit next to a push that has since succeeded. */
const CLEAR_DATASET_ERROR = { datasetError: null, datasetErrorKind: null } as const;

/** Conflict rows a dataset row lists; the backend keeps the newest first (AD-5). */
export const CONFLICT_LIMIT = 20;

/* Any operation that moves the remote's generation (push, pull, rotation,
 * rollback) makes a loaded listing stale — including its "current generation" —
 * so the cached copy is dropped and the row asks the server again when the user
 * opens it. */
function withoutHistory(
  history: Record<string, SyncHistoryListing>,
  datasetId: string,
): Record<string, SyncHistoryListing> {
  const next = { ...history };
  delete next[datasetId];
  return next;
}

interface SyncState {
  endpoint: SyncEndpointDraft;
  testing: boolean;
  testResult: SyncConnectionTest | null;
  error: string | null;
  errorKind: SyncErrorPayload["kind"] | null;

  datasets: SyncDatasetSummary[];
  datasetsLoading: boolean;
  saving: boolean;
  /**
   * Result of the last successful save: which row was stored and whether the
   * save joined a published dataset or created an empty one. Cleared whenever
   * the form it describes is edited or the dataset it names is removed.
   */
  saveOutcome: SyncSaveOutcome | null;
  /** Dataset id with a preflight or push in flight, so its row can disable. */
  pushing: string | null;
  pushResult: SyncPushOutcome | null;
  preflight: SyncPushPreflight | null;
  /** Dataset id with a pull in flight; tracked apart from `pushing` so both
   * buttons can disable together while only one claim is in flight. */
  pulling: string | null;
  pullResult: SyncPullOutcome | null;
  /** Conflict log of the dataset pulled last, newest first. */
  conflicts: SyncConflictEntry[];
  /** Retained generations per dataset id, newest first. Read on demand: the
   * listing costs a connection, so it is not fetched for every saved row. */
  history: Record<string, SyncHistoryListing>;
  /** Dataset id whose history is being read. */
  historyLoading: string | null;
  /** Dataset id with a rollback in flight; its row disables every action. */
  rollingBack: string | null;
  /** Result of the last rollback, until another dataset action replaces it. */
  rollbackResult: SyncRollbackOutcome | null;
  /** Live phase per dataset, as last reported by the backend scheduler. */
  statuses: Record<string, SyncStatusSnapshot>;
  datasetError: string | null;
  datasetErrorKind: SyncErrorPayload["kind"] | null;

  setEndpoint: (patch: Partial<SyncEndpointDraft>) => void;
  resetTest: () => void;
  testConnection: (secret: SyncEndpointSecret) => Promise<SyncConnectionTest>;

  loadDatasets: () => Promise<SyncDatasetSummary[]>;
  saveDataset: (
    input: SyncDatasetInput,
    secrets: SyncDatasetSecrets,
  ) => Promise<SyncSaveOutcome>;
  /** Retires the save report, e.g. once its form has been edited. */
  clearSaveOutcome: () => void;
  /** Retires the dataset error, e.g. once the form changed so the failure may no longer apply. */
  clearDatasetError: () => void;
  /** Persists the automatic-sync switch and both cadences for one dataset. */
  updateDatasetSchedule: (datasetId: string, schedule: SyncScheduleInput) => Promise<void>;
  /** Reads the current phase of every dataset; never rejects. */
  loadStatus: () => Promise<void>;
  /** Subscribes to `sync:status`; resolves with the unsubscribe function. */
  subscribeSyncStatus: () => Promise<() => void>;
  deleteDataset: (datasetId: string) => Promise<void>;
  loadPreflight: (datasetId: string) => Promise<SyncPushPreflight>;
  push: (datasetId: string) => Promise<SyncPushOutcome>;
  pull: (datasetId: string) => Promise<SyncPullOutcome>;
  loadConflicts: (datasetId: string, limit?: number) => Promise<SyncConflictEntry[]>;
  /* Same probe without touching push state: a member row that can never push
   * still needs `remoteWritable` for the server-enforcement warning. */
  probeWritability: (datasetId: string) => Promise<void>;
  /* Republishes a dataset under a new passphrase (owner only); the row's stored
   * passphrase is replaced, so members on the old one get `decrypt` next pull. */
  rotatePassphrase: (datasetId: string, newPassphrase: string) => Promise<SyncRotateOutcome>;
  /* Which member datasets claim a host as managed (Task 10 badge/lock source). */
  managedBy: (hostId: string) => Promise<SyncManagedBy[]>;
  /* Drops one dataset's claim on a host, leaving it locally editable. */
  detachHost: (datasetId: string, hostId: string) => Promise<void>;
  /* Removes a detach opt-out so the next pull may manage the host again. */
  reattachHost: (datasetId: string, hostId: string) => Promise<void>;
  /* Reads the generations the server still retains, newest first. Metadata
   * only: it needs no passphrase and downloads no bundle. */
  loadHistory: (datasetId: string) => Promise<SyncHistoryListing>;
  /** Drops a loaded listing without asking the server again. */
  clearHistory: (datasetId: string) => void;
  /* Applies a retained generation as a normal merge, then publishes the merged
   * result as a new generation. Owner only; the backend refuses the rest. */
  rollback: (datasetId: string, generation: number) => Promise<SyncRollbackOutcome>;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  endpoint: { ...DEFAULT_SYNC_ENDPOINT },
  testing: false,
  testResult: null,
  error: null,
  errorKind: null,

  datasets: [],
  datasetsLoading: false,
  saving: false,
  saveOutcome: null,
  pushing: null,
  pushResult: null,
  preflight: null,
  pulling: null,
  pullResult: null,
  conflicts: [],
  history: {},
  historyLoading: null,
  rollingBack: null,
  rollbackResult: null,
  statuses: {},
  datasetError: null,
  datasetErrorKind: null,

  /* Editing any endpoint field invalidates the previous probe: a result shown
   * next to changed connection details would claim a path was reachable that
   * nobody ever tested. For the same reason it retires the save report, which
   * names the path the last save went to. */
  setEndpoint: (patch) =>
    set((state) => ({
      endpoint: { ...state.endpoint, ...patch },
      testResult: null,
      error: null,
      errorKind: null,
      saveOutcome: null,
    })),

  resetTest: () => set({ testResult: null, error: null, errorKind: null }),

  testConnection: async (secret) => {
    const { endpoint } = get();
    set({ testing: true, testResult: null, error: null, errorKind: null });
    try {
      // Loaded dynamically because the Tauri IPC module only exists inside the
      // webview: a static import breaks Vitest (and the store's own tests mock
      // this specifier). Repo-wide convention — see AGENTS.md.
      const { invoke } = await import("@tauri-apps/api/core");
      const payload: SyncEndpointInput = {
        host: endpoint.host,
        port: endpoint.port,
        username: endpoint.username,
        remotePath: endpoint.remotePath,
        ...(endpoint.keyPath ? { keyPath: endpoint.keyPath } : {}),
        ...(secret.password ? { password: secret.password } : {}),
        ...(secret.keyPassphrase ? { keyPassphrase: secret.keyPassphrase } : {}),
      };
      const result = await invoke<SyncConnectionTest>("sync_test_connection", {
        endpoint: payload,
      });
      set({ testing: false, testResult: result });
      return result;
    } catch (error) {
      const failure = syncFailure(error, "Could not reach the sync server");
      set({ testing: false, error: failure.message, errorKind: failure.kind });
      throw error;
    }
  },

  loadDatasets: async () => {
    set({ datasetsLoading: true, datasetError: null, datasetErrorKind: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const datasets = await invoke<SyncDatasetSummary[]>("sync_list_datasets");
      set({ datasetsLoading: false, datasets });
      return datasets;
    } catch (error) {
      const failure = syncFailure(error, "Could not load the saved datasets");
      set({
        datasetsLoading: false,
        datasetError: failure.message,
        datasetErrorKind: failure.kind,
      });
      throw error;
    }
  },

  /*
   * One save call resolves to an outcome, not to a bare row: the row says what
   * was stored, the outcome says what the save did to the remote path — joined
   * a published dataset or created an empty one. The report is held in
   * `saveOutcome` so the form can show it; the previous one is dropped first,
   * because a failure must never leave the last success on screen.
   */
  saveDataset: async (input, secrets) => {
    set({ saving: true, saveOutcome: null, datasetError: null, datasetErrorKind: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const outcome = await invoke<SyncSaveOutcome>("sync_save_dataset", {
        dataset: input,
        secrets,
      });
      set({ saving: false, saveOutcome: outcome });
      return outcome;
    } catch (error) {
      const failure = syncFailure(error, "Could not save the dataset");
      set({ saving: false, datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  clearSaveOutcome: () => set({ saveOutcome: null }),
  clearDatasetError: () => set({ ...CLEAR_DATASET_ERROR }),

  /*
   * The automatic-sync switch and both cadences persist through their own
   * command: `sync_save_dataset` needs the dataset passphrase, which is stored
   * in the keychain / App Vault and deliberately never kept in the frontend, so
   * re-sending the whole row would mean asking the user for a secret again just
   * to change a number. The row is mirrored locally because the backend stored
   * exactly what was sent; the authoritative live phase still comes from
   * `sync_status` / `sync:status`.
   */
  updateDatasetSchedule: async (datasetId, schedule) => {
    set({ ...CLEAR_DATASET_ERROR });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<unknown>("sync_update_schedule", { datasetId, ...schedule });
      set((state) => ({
        datasets: state.datasets.map((dataset) =>
          dataset.id === datasetId ? { ...dataset, ...schedule } : dataset,
        ),
      }));
    } catch (error) {
      const failure = syncFailure(error, "Could not save the sync schedule");
      set({ datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  /* A read that failed is not worth a red badge: this is an ambient surface, so
   * the map keeps whatever the last successful read or event produced. */
  loadStatus: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const snapshots = await invoke<SyncStatusSnapshot[]>("sync_status");
      /* Merged, never replaced: a read can race a UI-driven push, and a dataset
       * the scheduler has not reported yet must not lose its last snapshot. */
      if (Array.isArray(snapshots)) {
        set((state) => ({ statuses: { ...state.statuses, ...byDataset(snapshots) } }));
      }
    } catch { /* see above — the previous snapshots stay on screen */ }
  },

  subscribeSyncStatus: async () => {
    if (!statusSubscription) {
      const promise = (async () => {
        // Dynamic import for the same reason as every other Tauri call here.
        const { listen } = await import("@tauri-apps/api/event");
        return listen<SyncStatusSnapshot>("sync:status", (event) => {
          /* One dataset per event: merge it into the map instead of replacing
           * the map, so a snapshot for another dataset is never dropped and a
           * run started from the UI never fights the stream. */
          set((state) => ({
            statuses: { ...state.statuses, [event.payload.datasetId]: event.payload },
          }));
        });
      })();
      statusSubscription = { promise, subscribers: 0 };
    }
    const active = statusSubscription;
    active.subscribers += 1;

    let unlisten: () => void;
    try {
      unlisten = await active.promise;
    } catch (error) {
      /* Nothing was subscribed, so the shared slot must not stay poisoned. */
      if (statusSubscription === active) statusSubscription = null;
      throw error;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.subscribers -= 1;
      if (active.subscribers === 0 && statusSubscription === active) {
        statusSubscription = null;
        unlisten();
      }
    };
  },

  deleteDataset: async (datasetId) => {
    set({ datasetError: null, datasetErrorKind: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<void>("sync_delete_dataset", { datasetId });
      /* The backend confirmed the delete, so drop the row locally instead of
       * paying another round-trip; anything the removed dataset owned on the
       * remote stays untouched and the local hosts are never deleted. */
      set((state) => ({
        datasets: state.datasets.filter((dataset) => dataset.id !== datasetId),
        /* A report naming a row that no longer exists would describe a dataset
         * the list cannot show, so it goes with the row. */
        saveOutcome:
          state.saveOutcome?.dataset.id === datasetId ? null : state.saveOutcome,
        pushResult: state.pushResult?.datasetId === datasetId ? null : state.pushResult,
        preflight: state.preflight?.datasetId === datasetId ? null : state.preflight,
        /* The outcome and the conflict log describe a dataset that no longer
         * exists, so neither may outlive it in a row that cannot render them. */
        pullResult: state.pullResult?.datasetId === datasetId ? null : state.pullResult,
        conflicts: state.pullResult?.datasetId === datasetId ? [] : state.conflicts,
        /* Same for the retained-generation listing and the rollback report. */
        history: withoutHistory(state.history, datasetId),
        rollbackResult:
          state.rollbackResult?.datasetId === datasetId ? null : state.rollbackResult,
        /* The scheduler stops reporting a removed dataset, so its last snapshot
         * would otherwise leave a phantom badge in the status bar. */
        statuses: Object.fromEntries(
          Object.entries(state.statuses).filter(([id]) => id !== datasetId),
        ),
      }));
    } catch (error) {
      const failure = syncFailure(error, "Could not remove the dataset");
      set({ datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  /* Preflight and push share `pushing` so the row stays disabled across both
   * halves of one "Push now" click. */
  loadPreflight: async (datasetId) => {
    set({ pushing: datasetId, preflight: null, pushResult: null, ...CLEAR_DATASET_ERROR });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const preflight = await invoke<SyncPushPreflight>("sync_push_preflight", { datasetId });
      set({ pushing: null, preflight });
      return preflight;
    } catch (error) {
      const failure = syncFailure(error, "Could not check what a push would include");
      set({ pushing: null, datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  push: async (datasetId) => {
    set({ pushing: datasetId, pushResult: null, ...CLEAR_DATASET_ERROR });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const outcome = await invoke<SyncPushOutcome>("sync_push", { datasetId });
      /* A push archives the generation it replaced, so any listing on screen
       * no longer matches the server. */
      set((state) => ({
        pushing: null,
        pushResult: outcome,
        history: withoutHistory(state.history, datasetId),
      }));
      return outcome;
    } catch (error) {
      const failure = syncFailure(error, "Could not push the dataset");
      set({ pushing: null, datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  probeWritability: async (datasetId) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const preflight = await invoke<SyncPushPreflight>("sync_push_preflight", { datasetId });
      /* Keep only the writability answer: the full preflight belongs to a push
       * this row will never run, and caching it would arm the push warning. */
      set((state) => ({
        preflight: state.preflight?.datasetId === datasetId
          ? { ...state.preflight, remoteWritable: preflight.remoteWritable }
          : { ...preflight, includeCredentials: false, vaultLocked: false, credentialsBlocked: 0 },
      }));
    } catch { /* the pull already succeeded; a failed probe only hides the warning */ }
  },

  /* The conflict log of one dataset. A failure here is reported on the dataset
   * card but never masks a successful pull, so callers may swallow it. */
  loadConflicts: async (datasetId, limit = CONFLICT_LIMIT) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const conflicts = await invoke<SyncConflictEntry[]>("sync_list_conflicts", {
        datasetId,
        limit,
      });
      set({ conflicts });
      return conflicts;
    } catch (error) {
      const failure = syncFailure(error, "Could not load the conflict log");
      set({ datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  /*
   * Pull applies the remote merge locally, so everything derived from the
   * previous local state is stale afterwards: the dataset row (its generation
   * and last-sync time moved), the conflict log of this dataset, and the hosts
   * and groups the dashboard, sidebar, and host editor read. All three are
   * reloaded here rather than in the Settings component so the refresh belongs
   * to the operation — a later auto-sync trigger (T6) gets it without
   * duplicating the list of stores to invalidate, and no component has to know
   * which entities a pull can touch.
   */
  pull: async (datasetId) => {
    set({
      pulling: datasetId,
      pullResult: null,
      conflicts: [],
      ...CLEAR_DATASET_ERROR,
    });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const outcome = await invoke<SyncPullOutcome>("sync_pull", { datasetId });
      /* The pulled generation moved the remote's head, so a retained-generation
       * listing on screen describes a state that is no longer current. */
      set((state) => ({
        pulling: null,
        pullResult: outcome,
        history: withoutHistory(state.history, datasetId),
      }));
      /* The remote generation moved, so re-read the row instead of patching it;
       * then the conflict log, then the entity stores. The reloads are
       * best-effort: the pull itself already succeeded and its outcome is what
       * the user asked for, so a failed reload must not look like a failed pull. */
      await get().loadDatasets().catch(() => {});
      await get().loadConflicts(datasetId).catch(() => {});
      await Promise.all([
        useHostsStore.getState().loadHosts(),
        useGroupsStore.getState().loadGroups(),
      ]).catch(() => {});
      return outcome;
    } catch (error) {
      const failure = syncFailure(error, "Could not pull the dataset");
      set({ pulling: null, datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  /* Rotation republishes under a new passphrase, so the dataset row (new
   * generation) is re-read afterwards like after a pull. */
  rotatePassphrase: async (datasetId, newPassphrase) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const outcome = await invoke<SyncRotateOutcome>("sync_rotate_passphrase", {
        datasetId,
        newPassphrase,
      });
      /* Rotation publishes a new generation and archives the previous one. */
      set((state) => ({ history: withoutHistory(state.history, datasetId) }));
      await get().loadDatasets().catch(() => {});
      return outcome;
    } catch (error) {
      const failure = syncFailure(error, "Could not rotate the dataset passphrase");
      set({ datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  /* Detach bookkeeping touches one host, so there is no store slice to keep:
   * the modal re-reads `managedBy` for the host it shows. */
  managedBy: async (hostId) => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<SyncManagedBy[]>("sync_managed_by", { hostId });
  },

  detachHost: async (datasetId, hostId) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sync_detach_host", { datasetId, hostId });
    } catch (error) {
      const failure = syncFailure(error, "Could not detach the host from the dataset");
      set({ datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  reattachHost: async (datasetId, hostId) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("sync_reattach_host", { datasetId, hostId });
    } catch (error) {
      const failure = syncFailure(error, "Could not re-attach the host to the dataset");
      set({ datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  /*
   * The retained generations of one dataset. The read is metadata only — no
   * passphrase, no bundle — but it still opens a connection, so it happens when
   * the user asks for it rather than for every saved row when Settings opens.
   */
  loadHistory: async (datasetId) => {
    set({ historyLoading: datasetId, ...CLEAR_DATASET_ERROR });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const listing = await invoke<SyncHistoryListing>("sync_list_history", { datasetId });
      set((state) => ({
        historyLoading: null,
        history: { ...state.history, [datasetId]: listing },
      }));
      return listing;
    } catch (error) {
      const failure = syncFailure(error, "Could not read this dataset's history");
      set({ historyLoading: null, datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },

  /* Hiding the list is not a reason to reconnect, so the loaded listing stays
   * in the map and the row simply stops rendering it. */
  clearHistory: (datasetId) =>
    set((state) => ({ history: withoutHistory(state.history, datasetId) })),

  /*
   * Rollback applies a retained generation as a normal merge and publishes the
   * merged result as a new generation, so everything a pull refreshes is
   * refreshed here as well — plus the listing that named the generation, which
   * now has one more entry.
   */
  rollback: async (datasetId, generation) => {
    set({
      rollingBack: datasetId,
      rollbackResult: null,
      conflicts: [],
      ...CLEAR_DATASET_ERROR,
    });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const outcome = await invoke<SyncRollbackOutcome>("sync_rollback", {
        datasetId,
        generation,
      });
      set((state) => ({
        rollingBack: null,
        rollbackResult: outcome,
        history: withoutHistory(state.history, datasetId),
      }));
      /* Best-effort, like a pull: the rollback itself already succeeded and its
       * outcome is what the user asked for. */
      await get().loadDatasets().catch(() => {});
      await get().loadConflicts(datasetId).catch(() => {});
      await get().loadHistory(datasetId).catch(() => {});
      await Promise.all([
        useHostsStore.getState().loadHosts(),
        useGroupsStore.getState().loadGroups(),
      ]).catch(() => {});
      return outcome;
    } catch (error) {
      const failure = syncFailure(error, "Could not roll the dataset back");
      set({ rollingBack: null, datasetError: failure.message, datasetErrorKind: failure.kind });
      throw error;
    }
  },
}));
