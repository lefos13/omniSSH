import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import {
  DEFAULT_SYNC_CONTENT_FLAGS,
  DEFAULT_SYNC_ENDPOINT,
  useSyncStore,
} from "../../stores/sync-store";
import { useGroupsStore } from "../../stores/groups-store";
import { useHostsStore } from "../../stores/hosts-store";
import type { SavedHost, HostGroup } from "../../types";
import type {
  SyncConflictEntry,
  SyncConnectionTest,
  SyncDatasetSummary,
  SyncHistoryListing,
  SyncPullOutcome,
  SyncPushOutcome,
  SyncPushPreflight,
  SyncRollbackOutcome,
  SyncSaveOutcome,
  SyncStatusSnapshot,
} from "../../types/sync";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/* The section follows the scheduler's `sync:status` stream through the store's
 * real subscription path, so the mocked `listen` hands its handler back to the
 * tests instead of swallowing it. */
const syncStatusListeners = vi.hoisted(
  () => new Map<string, (event: { payload: SyncStatusSnapshot }) => void>(),
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: SyncStatusSnapshot }) => void) => {
    syncStatusListeners.set(name, handler);
    return () => { syncStatusListeners.delete(name); };
  },
}));

/* The Sync section lists the saved datasets when it mounts and reads the
 * current sync phase, so every test answers `sync_list_datasets` too. Handlers
 * keyed by command keep each test explicit about what it stubs, `commandCalls`
 * scopes assertions to the command under test instead of counting every IPC
 * round-trip, and an unstubbed status read reports "no dataset is syncing". */
function mockCommands(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    const handler = handlers[command];
    if (!handler) {
      if (command === "sync_status") return [];
      throw new Error(`unexpected invoke: ${command}`);
    }
    return handler(args);
  });
}

function commandCalls(command: string): unknown[][] {
  return invoke.mock.calls.filter((call) => call[0] === command);
}

function fillEndpoint() {
  fireEvent.change(screen.getByTestId("settings-sync-host"), { target: { value: "10.0.0.9" } });
  fireEvent.change(screen.getByTestId("settings-sync-port"), { target: { value: "2299" } });
  fireEvent.change(screen.getByTestId("settings-sync-username"), { target: { value: "testuser" } });
  fireEvent.change(screen.getByTestId("settings-sync-path"), {
    target: { value: "/config/omnissh-sync" },
  });
  fireEvent.change(screen.getByTestId("settings-sync-password"), {
    target: { value: "testpass" },
  });
}

/** Fills the endpoint and the dataset form the way a first save needs it. */
function fillDatasetForm(datasetName = "NOVA") {
  fillEndpoint();
  fireEvent.change(screen.getByTestId("settings-sync-name"), { target: { value: datasetName } });
  fireEvent.change(screen.getByTestId("settings-sync-passphrase"), {
    target: { value: PASSPHRASE },
  });
}

/** A host the scope pickers can list, with only the fields they read. */
function makeHost(id: string, label: string, groupId: string | null): SavedHost {
  return {
    id,
    label,
    host: `${label}.example.com`,
    port: 22,
    username: "root",
    auth_type: "password",
    group_id: groupId,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    key_path: null,
    color: null,
    notes: null,
    environment: null,
    os_type: null,
    startup_command: null,
    proxy_jump: null,
    proxy_jump_host_id: null,
    start_directory: null,
    keep_alive_interval: null,
    default_shell: null,
    font_size: null,
    terminal_theme: null,
    last_connected_at: null,
    connection_count: null,
  };
}

function makeGroup(id: string, name: string, sortOrder: number): HostGroup {
  return {
    id,
    name,
    color: "#6366f1",
    icon: null,
    sort_order: sortOrder,
    default_username: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };
}

/* Two groups, three hosts: g-nova holds two of them, g-bank one — enough for a
 * count that changes with the selection rather than with the host list. */
const scopeGroups: HostGroup[] = [
  makeGroup("g-nova", "NOVA", 0),
  makeGroup("g-bank", "Bank of Cyprus", 1),
];
const scopeHosts: SavedHost[] = [
  makeHost("h-1", "nova-web", "g-nova"),
  makeHost("h-2", "nova-db", "g-nova"),
  makeHost("h-3", "bank-core", "g-bank"),
];

/** Mounts Settings ▸ Sync and waits for the on-mount dataset listing to settle. */
async function openSyncSection() {
  render(<SettingsPage />);
  fireEvent.click(screen.getByTestId("settings-nav-sync"));
  await screen.findByTestId("settings-sync-name");
  await waitFor(() => expect(useSyncStore.getState().datasetsLoading).toBe(false));
}

const probe: SyncConnectionTest = {
  reachable: true,
  pathExists: true,
  writable: true,
  datasetPresent: false,
  existingDataset: null,
  metadataError: null,
};

const savedDataset: SyncDatasetSummary = {
  id: "ds-1",
  name: "NOVA",
  host: "10.0.0.9",
  port: 2299,
  username: "testuser",
  authType: "password",
  remotePath: "/config/omnissh-sync",
  role: "owner",
  contentFlags: { ...DEFAULT_SYNC_CONTENT_FLAGS },
  scopeMode: "all",
  scopeMemberIds: [],
  scopeHostCount: 12,
  autoSync: false,
  pullIntervalSecs: 0,
  pushDebounceSecs: 0,
  lastGeneration: 12,
  lastSyncedAt: new Date(Date.now() - 3_600_000).toISOString(),
  hasServerSecret: true,
  hasPassphrase: true,
};

/* A save that adopted the dataset already published at the path. */
const saveOutcome: SyncSaveOutcome = {
  dataset: savedDataset,
  joined: true,
  remoteGeneration: 12,
};

const preflight: SyncPushPreflight = {
  datasetId: "ds-1",
  includeCredentials: true,
  vaultLocked: false,
  hostsInScope: 12,
  credentialsReadable: 3,
  credentialsBlocked: 0,
  remoteWritable: true,
};

const outcome: SyncPushOutcome = {
  datasetId: "ds-1",
  generation: 13,
  hosts: 12,
  groups: 4,
  snippets: 7,
  snippetFolders: 2,
  portForwards: 3,
  s3Connections: 1,
  hostPlugins: 5,
  appSettings: true,
  tombstones: 2,
  scopeRemovals: 1,
  credentialsIncluded: 3,
};

/* A snapshot as the scheduler reports it: idle unless a test says otherwise. */
const statusSnapshot: SyncStatusSnapshot = {
  datasetId: "ds-1",
  name: "NOVA",
  phase: "idle",
  autoSync: false,
  pullIntervalSecs: 0,
  pushDebounceSecs: 0,
  generation: 12,
  lastSyncedAt: new Date(Date.now() - 3_600_000).toISOString(),
  pendingLocalChanges: false,
  message: null,
  kind: null,
};

/** Pushes a `sync:status` event through the store's real subscription path. */
async function emitSyncStatus(snapshot: SyncStatusSnapshot) {
  await waitFor(() => expect(syncStatusListeners.has("sync:status")).toBe(true));
  act(() => { syncStatusListeners.get("sync:status")?.({ payload: snapshot }); });
}

const PASSPHRASE = "correct horse battery staple";

const pullOutcome: SyncPullOutcome = {
  datasetId: "ds-1",
  generation: 14,
  publishedByAnotherMachine: false,
  applied: {
    hosts: 12,
    groups: 4,
    snippets: 0,
    snippetFolders: 0,
    portForwards: 0,
    s3Connections: 0,
    hostPlugins: 0,
    appSettings: false,
  },
  deleted: 2,
  keptLocal: 3,
  conflicts: 2,
  credentialsApplied: 5,
};

const conflictEntry: SyncConflictEntry = {
  id: 7,
  datasetId: "ds-1",
  entityType: "host",
  entityId: "h-nova-db",
  resolution: "kept the copy updated most recently",
  winnerUpdatedAt: "2026-09-18T12:00:00Z",
  loserUpdatedAt: "2026-09-17T09:30:00Z",
  detectedAt: "2026-09-18T12:00:05Z",
};

/* Two retained generations, one of them without the counts a generation
 * published by an older build does not carry, plus the generation published
 * now (which is never itself in history). */
const historyListing: SyncHistoryListing = {
  datasetId: "ds-1",
  currentGeneration: 12,
  entries: [
    {
      generation: 11,
      updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
      writerClientId: "client-b",
      recordCounts: {
        hosts: 11,
        groups: 4,
        snippets: 0,
        snippetFolders: 0,
        portForwards: 0,
        s3Connections: 0,
        hostPlugins: 0,
        appSettings: false,
        tombstones: 2,
        scopeRemovals: 0,
        credentialsIncluded: 3,
      },
      signed: true,
      ownerFingerprint: "a".repeat(64),
    },
    {
      generation: 9,
      updatedAt: null,
      writerClientId: null,
      recordCounts: null,
      signed: false,
      ownerFingerprint: null,
    },
  ],
};

const rollbackOutcome: SyncRollbackOutcome = {
  datasetId: "ds-1",
  rolledBackTo: 11,
  generation: 13,
  applied: {
    hosts: 4,
    groups: 1,
    snippets: 0,
    snippetFolders: 0,
    portForwards: 0,
    s3Connections: 0,
    hostPlugins: 0,
    appSettings: false,
  },
  deleted: 1,
  keptLocal: 2,
  conflicts: 1,
  credentialsApplied: 3,
  published: {
    datasetId: "ds-1",
    generation: 13,
    hosts: 12,
    groups: 4,
    snippets: 0,
    snippetFolders: 0,
    portForwards: 0,
    s3Connections: 0,
    hostPlugins: 0,
    appSettings: false,
    tombstones: 0,
    scopeRemovals: 0,
    credentialsIncluded: 3,
  },
};

/* A pull is followed by three reloads inside the store (dataset list, conflict
 * log, hosts and groups), so every pull test answers those commands as well —
 * otherwise the refresh cannot be distinguished from a failure. */
function mockPull(overrides: {
  outcome?: SyncPullOutcome;
  conflicts?: SyncConflictEntry[];
  datasets?: SyncDatasetSummary[];
  pullError?: unknown;
}) {
  mockCommands({
    sync_list_datasets: () => overrides.datasets ?? [savedDataset],
    sync_pull: () =>
      overrides.pullError === undefined
        ? (overrides.outcome ?? pullOutcome)
        : Promise.reject(overrides.pullError),
    sync_list_conflicts: () => overrides.conflicts ?? [],
    list_hosts: () => [],
    list_groups: () => [],
  });
}

describe("SettingsPage dataset sync", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: () => ({ width: 0 }),
    } as unknown as CanvasRenderingContext2D);
    invoke.mockReset();
    mockCommands({ sync_list_datasets: () => [] });
    /* The scope pickers read the shared hosts and groups stores, so a test that
     * populated them must not leak into the next one. */
    useHostsStore.setState({ hosts: [], loading: false, error: null });
    useGroupsStore.setState({ groups: [], loading: false, error: null });
    useSyncStore.setState({
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
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the entered endpoint and password to sync_test_connection", async () => {
    mockCommands({ sync_list_datasets: () => [], sync_test_connection: () => probe });
    await openSyncSection();

    fillEndpoint();
    fireEvent.click(screen.getByTestId("settings-sync-test"));

    await waitFor(() => expect(commandCalls("sync_test_connection")).toHaveLength(1));
    expect(commandCalls("sync_test_connection")[0][1]).toEqual({
      endpoint: {
        host: "10.0.0.9",
        port: 2299,
        username: "testuser",
        remotePath: "/config/omnissh-sync",
        password: "testpass",
      },
    });
    // The secret must not survive in shared state.
    expect(JSON.stringify(useSyncStore.getState().endpoint)).not.toContain("testpass");
  });

  it("reports a missing remote path and a read-only account instead of claiming success", async () => {
    mockCommands({
      sync_list_datasets: () => [],
      sync_test_connection: () => ({ ...probe, pathExists: false, writable: false }),
    });
    await openSyncSection();

    fillEndpoint();
    fireEvent.click(screen.getByTestId("settings-sync-test"));

    const result = await screen.findByTestId("settings-sync-test-result");
    expect(result).toHaveTextContent("will be created on the first sync");
    expect(result).toHaveTextContent("cannot write to it");
    expect(result).toHaveTextContent("No dataset here yet.");
  });

  it("surfaces an existing dataset so a path is never silently taken over", async () => {
    mockCommands({
      sync_list_datasets: () => [],
      sync_test_connection: () => ({
        ...probe,
        datasetPresent: true,
        existingDataset: {
          datasetId: "ds-nova",
          generation: 12,
          updatedAt: "2026-09-18T10:00:00Z",
          signed: true,
          ownerFingerprint: "SHA256:abc",
        },
      }),
    });
    await openSyncSection();

    fillEndpoint();
    fireEvent.click(screen.getByTestId("settings-sync-test"));

    const existing = await screen.findByTestId("settings-sync-existing-dataset");
    expect(existing).toHaveTextContent("generation 12");
    expect(existing).toHaveTextContent("signed by its owner");
    expect(existing).toHaveTextContent("passphrase");
  });

  it("renders a backend failure with its actionable hint", async () => {
    mockCommands({
      sync_list_datasets: () => [],
      sync_test_connection: () =>
        Promise.reject({
          kind: "sftpUnavailable",
          message: "this server does not provide SFTP, which dataset sync requires: timeout",
        }),
    });
    await openSyncSection();

    fillEndpoint();
    fireEvent.click(screen.getByTestId("settings-sync-test"));

    const error = await screen.findByTestId("settings-sync-test-error");
    expect(error).toHaveTextContent("does not provide SFTP");
    expect(error).toHaveTextContent("SFTP subsystem enabled");
    expect(screen.queryByTestId("settings-sync-test-result")).not.toBeInTheDocument();
  });

  it("switching to key auth sends the key path instead of the password", async () => {
    mockCommands({ sync_list_datasets: () => [], sync_test_connection: () => probe });
    await openSyncSection();

    fillEndpoint();
    fireEvent.click(screen.getByTestId("settings-sync-auth-key"));
    fireEvent.change(screen.getByTestId("settings-sync-key-path"), {
      target: { value: "/home/me/.ssh/id_ed25519" },
    });
    fireEvent.click(screen.getByTestId("settings-sync-test"));

    await waitFor(() => expect(commandCalls("sync_test_connection")).toHaveLength(1));
    const payload = commandCalls("sync_test_connection")[0][1] as {
      endpoint: Record<string, unknown>;
    };
    expect(payload.endpoint.keyPath).toBe("/home/me/.ssh/id_ed25519");
    expect(payload.endpoint.password).toBeUndefined();
  });

  it("discards a stale result when the endpoint is edited", async () => {
    mockCommands({ sync_list_datasets: () => [], sync_test_connection: () => probe });
    await openSyncSection();

    fillEndpoint();
    fireEvent.click(screen.getByTestId("settings-sync-test"));
    await screen.findByTestId("settings-sync-test-result");

    fireEvent.change(screen.getByTestId("settings-sync-host"), {
      target: { value: "10.0.0.10" },
    });
    expect(screen.queryByTestId("settings-sync-test-result")).not.toBeInTheDocument();
  });

  it("saves the dataset with its content flags and keeps no secret in the store", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      // `sync_save_dataset` now resolves to the outcome, not to a bare row.
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();

    fillEndpoint();
    fireEvent.change(screen.getByTestId("settings-sync-name"), { target: { value: "  NOVA  " } });
    fireEvent.change(screen.getByTestId("settings-sync-passphrase"), {
      target: { value: PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId("settings-sync-content-hostCredentials"));
    fireEvent.click(screen.getByTestId("settings-sync-save"));

    await waitFor(() => expect(commandCalls("sync_save_dataset")).toHaveLength(1));
    expect(commandCalls("sync_save_dataset")[0][1]).toEqual({
      dataset: {
        name: "NOVA",
        host: "10.0.0.9",
        port: 2299,
        username: "testuser",
        remotePath: "/config/omnissh-sync",
        role: "owner",
        contentFlags: { ...DEFAULT_SYNC_CONTENT_FLAGS, hostCredentials: true },
        // A new dataset carries every host until the user narrows it.
        scopeMode: "all",
        scopeMemberIds: [],
        // Saving must never switch automatic sync on for the user.
        autoSync: false,
        pullIntervalSecs: 0,
        pushDebounceSecs: 0,
      },
      secrets: { passphrase: PASSPHRASE, password: "testpass" },
    });

    // Neither the dataset passphrase nor the server password may land in shared state.
    const state = JSON.stringify(useSyncStore.getState());
    expect(state).not.toContain(PASSPHRASE);
    expect(state).not.toContain("testpass");

    // The persisted dataset is listed and its secret fields are cleared.
    expect(await screen.findByTestId("settings-sync-dataset-ds-1")).toHaveTextContent("NOVA");
    await waitFor(() => expect(screen.getByTestId("settings-sync-passphrase")).toHaveValue(""));
    expect(screen.getByTestId("settings-sync-password")).toHaveValue("");
  });

  it("reports a save that joined a published dataset, with the generation it found", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();

    fillDatasetForm();
    fireEvent.click(screen.getByTestId("settings-sync-save"));

    const report = await screen.findByTestId("settings-sync-save-outcome");
    expect(report).toHaveTextContent("Joined the dataset published at this path (generation 12)");
    expect(report).toHaveTextContent("Press Pull now to bring it in");
    expect(report).not.toHaveTextContent("No dataset is published at this path yet");
  });

  it("reports a save that created a new dataset and claims no generation for it", async () => {
    mockCommands({
      sync_list_datasets: () => [],
      sync_save_dataset: () => ({
        dataset: { ...savedDataset, lastGeneration: 0, lastSyncedAt: null },
        joined: false,
        remoteGeneration: 0,
      }),
    });
    await openSyncSection();

    fillDatasetForm();
    fireEvent.click(screen.getByTestId("settings-sync-save"));

    const report = await screen.findByTestId("settings-sync-save-outcome");
    expect(report).toHaveTextContent(
      "No dataset is published at this path yet, so a new one was created.",
    );
    expect(report).toHaveTextContent("Press Push now to publish it");
    expect(report).not.toHaveTextContent("Joined the dataset published at this path");
    expect(report).not.toHaveTextContent("generation");
  });

  it("drops the save report once the form that produced it is edited", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();

    fillDatasetForm();
    fireEvent.click(screen.getByTestId("settings-sync-save"));
    await screen.findByTestId("settings-sync-save-outcome");

    fireEvent.change(screen.getByTestId("settings-sync-path"), {
      target: { value: "/srv/somewhere-else" },
    });
    expect(screen.queryByTestId("settings-sync-save-outcome")).not.toBeInTheDocument();
  });

  it("prefills the form from a saved row and updates that row instead of saving a second one", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-edit"));

    // The row's own values, not whatever the form held for a new dataset.
    expect(screen.getByTestId("settings-sync-name")).toHaveValue("NOVA");
    expect(screen.getByTestId("settings-sync-host")).toHaveValue("10.0.0.9");
    expect(screen.getByTestId("settings-sync-port")).toHaveValue(2299);
    expect(screen.getByTestId("settings-sync-username")).toHaveValue("testuser");
    expect(screen.getByTestId("settings-sync-path")).toHaveValue("/config/omnissh-sync");
    expect(screen.getByTestId("settings-sync-content-portForwards")).toBeChecked();
    expect(screen.getByTestId("settings-sync-content-hostCredentials")).not.toBeChecked();
    expect(screen.getByTestId("settings-sync-editing")).toHaveTextContent("Editing “NOVA”");
    expect(screen.getByTestId("settings-sync-save")).toHaveTextContent("Update dataset");
    // Secrets are never handed back to the frontend, so the save asks again.
    expect(screen.getByTestId("settings-sync-passphrase")).toHaveValue("");
    expect(screen.getByTestId("settings-sync-password")).toHaveValue("");

    // The typo the user actually made: the published dataset lives at /tmp.
    fireEvent.change(screen.getByTestId("settings-sync-path"), { target: { value: "/tmp" } });
    fireEvent.change(screen.getByTestId("settings-sync-passphrase"), {
      target: { value: PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId("settings-sync-password"), {
      target: { value: "testpass" },
    });
    fireEvent.click(screen.getByTestId("settings-sync-save"));

    await waitFor(() => expect(commandCalls("sync_save_dataset")).toHaveLength(1));
    expect(commandCalls("sync_save_dataset")[0][1]).toEqual({
      dataset: {
        id: "ds-1",
        name: "NOVA",
        host: "10.0.0.9",
        port: 2299,
        username: "testuser",
        remotePath: "/tmp",
        contentFlags: { ...DEFAULT_SYNC_CONTENT_FLAGS },
        // The scope the row was saved with travels back unchanged.
        scopeMode: "all",
        scopeMemberIds: [],
        // The fields the form does not collect travel back unchanged.
        role: "owner",
        autoSync: false,
        pullIntervalSecs: 0,
        pushDebounceSecs: 0,
      },
      secrets: { passphrase: PASSPHRASE, password: "testpass" },
    });
    // An update replaces the row; it must never leave two datasets behind.
    await waitFor(() => expect(commandCalls("sync_list_datasets")).toHaveLength(2));
    expect(screen.getAllByTestId("settings-sync-dataset-ds-1")).toHaveLength(1);
  });

  it("keeps a member dataset's role and cadence when it is edited", async () => {
    const memberDataset: SyncDatasetSummary = {
      ...savedDataset,
      role: "member",
      autoSync: true,
      pullIntervalSecs: 900,
      pushDebounceSecs: 30,
    };
    mockCommands({
      sync_list_datasets: () => [memberDataset],
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-edit"));
    fireEvent.change(screen.getByTestId("settings-sync-passphrase"), {
      target: { value: PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId("settings-sync-password"), {
      target: { value: "testpass" },
    });
    fireEvent.click(screen.getByTestId("settings-sync-save"));

    await waitFor(() => expect(commandCalls("sync_save_dataset")).toHaveLength(1));
    expect(commandCalls("sync_save_dataset")[0][1]).toMatchObject({
      dataset: {
        id: "ds-1",
        role: "member",
        autoSync: true,
        pullIntervalSecs: 900,
        pushDebounceSecs: 30,
      },
    });
  });

  it("returns the form to a new dataset when the edit is cancelled", async () => {
    mockCommands({ sync_list_datasets: () => [savedDataset] });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-edit"));
    expect(screen.getByTestId("settings-sync-save")).toHaveTextContent("Update dataset");

    fireEvent.click(screen.getByTestId("settings-sync-cancel-edit"));

    expect(screen.queryByTestId("settings-sync-editing")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-sync-save")).toHaveTextContent("Save dataset");
    expect(screen.queryByTestId("settings-sync-cancel-edit")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-sync-name")).toHaveValue("");
    expect(screen.getByTestId("settings-sync-host")).toHaveValue("");
    expect(screen.getByTestId("settings-sync-username")).toHaveValue("");
    expect(screen.getByTestId("settings-sync-path")).toHaveValue("");
    // Cancelling is not a save.
    expect(commandCalls("sync_save_dataset")).toHaveLength(0);
  });

  it("says so on the row when nothing is published at its path yet", async () => {
    mockCommands({
      sync_list_datasets: () => [
        { ...savedDataset, id: "ds-3", name: "Typo", lastGeneration: 0, lastSyncedAt: null },
      ],
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-3");
    const note = within(row).getByTestId("settings-sync-unpublished-ds-3");
    expect(note).toHaveTextContent("/config/omnissh-sync");
    expect(note).toHaveTextContent("press Push now");
    // A dataset that has published something says nothing extra.
    expect(screen.queryByTestId("settings-sync-unpublished-ds-1")).not.toBeInTheDocument();
  });

  it("names exactly which of a restored dataset's secrets are missing", async () => {
    mockCommands({
      sync_list_datasets: () => [
        { ...savedDataset, id: "ds-none", name: "Both missing", hasServerSecret: false, hasPassphrase: false },
        { ...savedDataset, id: "ds-pass", name: "No passphrase", hasPassphrase: false },
        {
          ...savedDataset,
          id: "ds-server",
          name: "No endpoint secret",
          authType: "privateKey",
          hasServerSecret: false,
        },
        { ...savedDataset, id: "ds-ok", name: "Complete" },
      ],
    });
    await openSyncSection();

    /* A backup carries no secrets, so a dataset restored on another machine
     * comes back with keychain entries missing; the row must say which ones
     * instead of leaving the next push to fail on an invisible lookup. */
    const both = await screen.findByTestId("settings-sync-needs-secret-ds-none");
    expect(both).toHaveTextContent("its server password and its dataset passphrase");
    expect(both).toHaveTextContent("A backup carries no secrets");
    expect(both).toHaveTextContent("open Edit");
    expect(screen.getByTestId("settings-sync-needs-secret-ds-pass")).toHaveTextContent(
      "its dataset passphrase",
    );
    const keyAuth = screen.getByTestId("settings-sync-needs-secret-ds-server");
    expect(keyAuth).toHaveTextContent("its private-key passphrase");
    expect(keyAuth).not.toHaveTextContent("server password");
    // A dataset that holds both secrets says nothing on its row.
    expect(screen.queryByTestId("settings-sync-needs-secret-ds-ok")).not.toBeInTheDocument();
  });

  it("renders a notFound failure exactly once, without a hint that repeats it", async () => {
    mockPull({
      pullError: {
        kind: "notFound",
        message: "nothing has been published to this dataset yet",
      },
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));

    const error = await screen.findByTestId("settings-sync-dataset-error");
    const text = error.textContent ?? "";
    expect(text).toContain("nothing has been published to this dataset yet");
    /* The hint used to be appended to the backend's message, which printed the
     * same sentence twice on one line with no space between the two copies. */
    expect(
      text.match(/nothing has been published to this dataset yet/gi) ?? [],
    ).toHaveLength(1);
    expect(text).not.toContain("yetNothing");
  });

  it("refuses a short dataset passphrase without invoking the backend", async () => {
    await openSyncSection();

    fillEndpoint();
    fireEvent.change(screen.getByTestId("settings-sync-name"), { target: { value: "NOVA" } });
    fireEvent.change(screen.getByTestId("settings-sync-passphrase"), {
      target: { value: "too-short" },
    });
    fireEvent.click(screen.getByTestId("settings-sync-save"));

    const message = await screen.findByTestId("settings-sync-passphrase-error");
    expect(message).toHaveTextContent("at least 12 characters");
    expect(commandCalls("sync_save_dataset")).toHaveLength(0);
  });

  it("disables a credential toggle until its parent content kind is on", async () => {
    await openSyncSection();

    const hostCredentials = screen.getByTestId("settings-sync-content-hostCredentials");
    const s3Credentials = screen.getByTestId("settings-sync-content-s3Credentials");
    expect(hostCredentials).not.toBeDisabled();
    expect(hostCredentials).not.toBeChecked();
    expect(s3Credentials).not.toBeChecked();
    expect(screen.getByTestId("settings-sync-content-portForwards")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("settings-sync-content-s3Connections"));
    expect(s3Credentials).toBeDisabled();

    fireEvent.click(screen.getByTestId("settings-sync-content-hosts"));
    expect(hostCredentials).toBeDisabled();
    expect(screen.getByTestId("settings-sync-content-portForwards")).toBeDisabled();
    expect(screen.getByTestId("settings-sync-content-hostPlugins")).toBeDisabled();
  });

  it("renders a saved dataset with its generation and last sync time", async () => {
    const neverSynced: SyncDatasetSummary = {
      ...savedDataset,
      id: "ds-2",
      name: "Bank of Cyprus",
      role: "member",
      lastGeneration: 4,
      lastSyncedAt: null,
    };
    mockCommands({ sync_list_datasets: () => [savedDataset, neverSynced] });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    expect(row).toHaveTextContent("NOVA");
    expect(row).toHaveTextContent("testuser@10.0.0.9:2299");
    expect(row).toHaveTextContent("/config/omnissh-sync");
    expect(row).toHaveTextContent("Owner — can publish");
    expect(row).toHaveTextContent("generation 12");
    expect(row).toHaveTextContent("last synced 1h ago");

    const second = screen.getByTestId("settings-sync-dataset-ds-2");
    expect(second).toHaveTextContent("Bank of Cyprus");
    expect(second).toHaveTextContent("Member — pull only");
    expect(second).toHaveTextContent("never synced");

    // What the dataset carries, from the summary rather than from the form.
    expect(within(row).getByTestId("settings-sync-scope-summary-ds-1")).toHaveTextContent(
      "Scope: all hosts · 12 hosts in scope",
    );
  });

  it("counts the hosts a selection resolves to and sends it with the dataset", async () => {
    mockCommands({
      sync_list_datasets: () => [],
      list_groups: () => scopeGroups,
      list_hosts: () => scopeHosts,
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();

    fillDatasetForm();
    // `all` counts every host without asking for a selection.
    await waitFor(() =>
      expect(screen.getByTestId("settings-sync-scope-count")).toHaveTextContent("3 hosts in scope"),
    );
    expect(screen.queryByTestId("settings-sync-scope-picker-groups")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-sync-scope-groups"));
    const picker = await screen.findByTestId("settings-sync-scope-picker-groups");
    // An empty selection is refused before the backend is asked.
    expect(screen.getByTestId("settings-sync-scope-count")).toHaveTextContent(
      "This dataset needs a scope.",
    );
    fireEvent.click(screen.getByTestId("settings-sync-save"));
    expect(commandCalls("sync_save_dataset")).toHaveLength(0);

    fireEvent.click(await within(picker).findByTestId("settings-sync-scope-groups-g-nova"));
    await waitFor(() =>
      expect(screen.getByTestId("settings-sync-scope-count")).toHaveTextContent("2 hosts in scope"),
    );
    fireEvent.click(screen.getByTestId("settings-sync-save"));
    await waitFor(() => expect(commandCalls("sync_save_dataset")).toHaveLength(1));
    expect(commandCalls("sync_save_dataset")[0][1]).toMatchObject({
      dataset: { scopeMode: "groups", scopeMemberIds: ["g-nova"] },
    });
  });

  it("narrows a dataset to explicit hosts and back to all of them", async () => {
    mockCommands({
      sync_list_datasets: () => [],
      list_groups: () => scopeGroups,
      list_hosts: () => scopeHosts,
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();

    fillDatasetForm();
    fireEvent.click(screen.getByTestId("settings-sync-scope-hosts"));
    const picker = await screen.findByTestId("settings-sync-scope-picker-hosts");
    fireEvent.click(await within(picker).findByTestId("settings-sync-scope-hosts-h-3"));
    expect(screen.getByTestId("settings-sync-scope-count")).toHaveTextContent("1 host in scope");

    /* Switching back to `all` drops the selection: a stale host id must never
     * be sent as the scope of a dataset that carries everything. */
    fireEvent.click(screen.getByTestId("settings-sync-scope-all"));
    expect(screen.queryByTestId("settings-sync-scope-picker-hosts")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-sync-scope-count")).toHaveTextContent("3 hosts in scope");
    fireEvent.click(screen.getByTestId("settings-sync-save"));
    await waitFor(() => expect(commandCalls("sync_save_dataset")).toHaveLength(1));
    expect(commandCalls("sync_save_dataset")[0][1]).toMatchObject({
      dataset: { scopeMode: "all", scopeMemberIds: [] },
    });
  });

  it("preloads the saved scope for editing and counts it against this machine's hosts", async () => {
    const scopedDataset: SyncDatasetSummary = {
      ...savedDataset,
      scopeMode: "groups",
      scopeMemberIds: ["g-nova"],
      scopeHostCount: 2,
    };
    mockCommands({
      sync_list_datasets: () => [scopedDataset],
      list_groups: () => scopeGroups,
      list_hosts: () => scopeHosts,
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();

    expect(
      within(await screen.findByTestId("settings-sync-dataset-ds-1")).getByTestId(
        "settings-sync-scope-summary-ds-1",
      ),
    ).toHaveTextContent("Scope: selected groups · 2 hosts in scope");

    const row = screen.getByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-edit"));

    expect(screen.getByTestId("settings-sync-scope-groups")).toBeChecked();
    expect(screen.getByTestId("settings-sync-scope-all")).not.toBeChecked();
    expect(screen.getByTestId("settings-sync-role-owner")).toBeChecked();
    const picker = await screen.findByTestId("settings-sync-scope-picker-groups");
    expect(await within(picker).findByTestId("settings-sync-scope-groups-g-nova")).toBeChecked();
    expect(within(picker).getByTestId("settings-sync-scope-groups-g-bank")).not.toBeChecked();
    await waitFor(() =>
      expect(screen.getByTestId("settings-sync-scope-count")).toHaveTextContent("2 hosts in scope"),
    );

    // The edited selection travels with the update.
    fireEvent.click(within(picker).getByTestId("settings-sync-scope-groups-g-bank"));
    fireEvent.change(screen.getByTestId("settings-sync-passphrase"), {
      target: { value: PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId("settings-sync-password"), {
      target: { value: "testpass" },
    });
    fireEvent.click(screen.getByTestId("settings-sync-save"));

    await waitFor(() => expect(commandCalls("sync_save_dataset")).toHaveLength(1));
    expect(commandCalls("sync_save_dataset")[0][1]).toMatchObject({
      dataset: { id: "ds-1", scopeMode: "groups", scopeMemberIds: ["g-nova", "g-bank"] },
    });
  });

  it("drops a selected record that no longer exists instead of saving a dead scope", async () => {
    const stale: SyncDatasetSummary = {
      ...savedDataset,
      scopeMode: "hosts",
      scopeMemberIds: ["h-1", "h-deleted"],
      scopeHostCount: 1,
    };
    mockCommands({
      sync_list_datasets: () => [stale],
      list_groups: () => scopeGroups,
      list_hosts: () => scopeHosts,
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();

    fireEvent.click(
      within(await screen.findByTestId("settings-sync-dataset-ds-1")).getByTestId(
        "settings-sync-edit",
      ),
    );
    // Only the host that still exists is counted, so the save is allowed.
    await waitFor(() =>
      expect(screen.getByTestId("settings-sync-scope-count")).toHaveTextContent("1 host in scope"),
    );

    fireEvent.change(screen.getByTestId("settings-sync-passphrase"), {
      target: { value: PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId("settings-sync-password"), {
      target: { value: "testpass" },
    });
    fireEvent.click(screen.getByTestId("settings-sync-save"));

    await waitFor(() => expect(commandCalls("sync_save_dataset")).toHaveLength(1));
    expect(commandCalls("sync_save_dataset")[0][1]).toMatchObject({
      dataset: { scopeMode: "hosts", scopeMemberIds: ["h-1"] },
    });
  });
  it("hides the scope section for a member and restores it for an owner", async () => {
    mockCommands({ sync_list_datasets: () => [] });
    await openSyncSection();
    fillDatasetForm();
    // The owner form carries the push-oriented scope section.
    expect(screen.getByTestId("settings-sync-scope-all")).toBeInTheDocument();
    expect(screen.getByTestId("settings-sync-scope-count")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-sync-member-note")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("settings-sync-role-member"));
    // A member never pushes, so the scope section gives way to the explainer.
    expect(screen.queryByTestId("settings-sync-scope-all")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-sync-scope-count")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-sync-member-note")).toHaveTextContent(
      "are the owner's call",
    );
    // Content kinds stay: a pull applies only the kinds this machine enables.
    expect(screen.getByTestId("settings-sync-content-hosts")).toBeInTheDocument();
    // The role picker, endpoint, passphrase, and save stay on the form.
    expect(screen.getByTestId("settings-sync-role-member")).toBeChecked();
    expect(screen.getByTestId("settings-sync-name")).toBeInTheDocument();
    expect(screen.getByTestId("settings-sync-passphrase")).toBeInTheDocument();
    expect(screen.getByTestId("settings-sync-save")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("settings-sync-role-owner"));
    // Switching back restores the scope section and drops the explainer.
    expect(screen.getByTestId("settings-sync-scope-all")).toBeInTheDocument();
    expect(screen.getByTestId("settings-sync-scope-count")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-sync-member-note")).not.toBeInTheDocument();
  });

  it("sends content flags and an all scope with a member save", async () => {
    mockCommands({
      sync_list_datasets: () => [],
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();
    fillDatasetForm();
    fireEvent.click(screen.getByTestId("settings-sync-role-member"));
    fireEvent.click(screen.getByTestId("settings-sync-save"));
    await waitFor(() => expect(commandCalls("sync_save_dataset")).toHaveLength(1));
    expect(commandCalls("sync_save_dataset")[0][1]).toMatchObject({
      dataset: {
        name: "NOVA",
        role: "member",
        scopeMode: "all",
        scopeMemberIds: [],
        contentFlags: { ...DEFAULT_SYNC_CONTENT_FLAGS },
      },
    });
  });

  it("never sends a hidden scope with a member save", async () => {
    mockCommands({
      sync_list_datasets: () => [],
      list_groups: () => scopeGroups,
      list_hosts: () => scopeHosts,
      sync_save_dataset: () => saveOutcome,
    });
    await openSyncSection();
    fillDatasetForm();
    /* An empty group selection refuses an owner save — and the member switch
     * then hides the picker the user can no longer fix. The member save must
     * therefore travel as `all` instead of a stale, empty selection. */
    fireEvent.click(screen.getByTestId("settings-sync-scope-groups"));
    expect(screen.getByTestId("settings-sync-scope-count")).toHaveTextContent(
      "This dataset needs a scope.",
    );
    fireEvent.click(screen.getByTestId("settings-sync-role-member"));
    fireEvent.click(screen.getByTestId("settings-sync-save"));
    await waitFor(() => expect(commandCalls("sync_save_dataset")).toHaveLength(1));
    expect(commandCalls("sync_save_dataset")[0][1]).toMatchObject({
      dataset: { role: "member", scopeMode: "all", scopeMemberIds: [] },
    });
  });

  it("pushes a dataset and renders the outcome counts", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_push_preflight: () => preflight,
      sync_push: () => outcome,
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-push"));

    const result = await within(row).findByTestId("settings-sync-push-result");
    expect(result).toHaveTextContent("Pushed generation 13");
    expect(result).toHaveTextContent("12 hosts");
    expect(result).toHaveTextContent("3 credentials");
    expect(result).toHaveTextContent("2 deletions");
    /* A host leaving the scope is named apart from a deletion, because nothing
     * was deleted on the other machine. */
    expect(result).toHaveTextContent("1 host left the scope");
    expect(result).toHaveTextContent("app settings");
    expect(commandCalls("sync_push")[0][1]).toEqual({ datasetId: "ds-1" });
  });

  it("blocks the push while the App Vault is locked", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_push_preflight: () => ({
        ...preflight,
        vaultLocked: true,
        credentialsReadable: 0,
        credentialsBlocked: 3,
      }),
      sync_push: () => outcome,
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-push"));

    const warning = await within(row).findByTestId("settings-sync-preflight-warning");
    expect(warning).toHaveTextContent("Unlock the App Vault to include credentials");
    expect(screen.queryByTestId("settings-sync-push-result")).not.toBeInTheDocument();
    expect(commandCalls("sync_push")).toHaveLength(0);
  });

  it("tells the user to pull first when another machine published a newer generation", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_push_preflight: () => preflight,
      sync_push: () =>
        Promise.reject({
          kind: "conflict",
          message: "the remote dataset is on generation 14, this machine's base is 12",
        }),
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-push"));

    const error = await screen.findByTestId("settings-sync-dataset-error");
    expect(error).toHaveTextContent("the remote dataset is on generation 14");
    expect(error).toHaveTextContent("Another machine published first — pull before pushing.");
    expect(screen.queryByTestId("settings-sync-push-result")).not.toBeInTheDocument();
  });

  it("pulls the row's dataset and renders what the merge applied", async () => {
    mockPull({ conflicts: [conflictEntry] });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));

    const result = await within(row).findByTestId("settings-sync-pull-result");
    expect(commandCalls("sync_pull")[0][1]).toEqual({ datasetId: "ds-1" });
    expect(result).toHaveTextContent("Pulled generation 14");
    expect(result).toHaveTextContent("12 hosts");
    expect(result).toHaveTextContent("4 groups");
    expect(result).toHaveTextContent("2 deletions");
    expect(result).toHaveTextContent("5 credentials");
    expect(result).toHaveTextContent("kept 3 local edits");
    expect(result).toHaveTextContent("2 conflicts");
    // A push summary must not appear from a pull.
    expect(within(row).queryByTestId("settings-sync-push-result")).not.toBeInTheDocument();
  });

  it("says so when the pulled generation was published by another computer", async () => {
    mockPull({ outcome: { ...pullOutcome, publishedByAnotherMachine: true } });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));

    const result = await within(row).findByTestId("settings-sync-pull-result");
    expect(within(result).getByTestId("settings-sync-other-writer")).toHaveTextContent(
      "This update came from another computer.",
    );
  });

  it("claims no other computer when this machine published the generation", async () => {
    // The default outcome reports the flag as false: a local push of our own.
    mockPull({});
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));

    const result = await within(row).findByTestId("settings-sync-pull-result");
    expect(within(result).queryByTestId("settings-sync-other-writer")).not.toBeInTheDocument();
  });

  it("lists only the content kinds the pull actually changed", async () => {
    mockPull({
      outcome: {
        ...pullOutcome,
        applied: { ...pullOutcome.applied, hosts: 2, groups: 0 },
        keptLocal: 0,
        conflicts: 0,
        credentialsApplied: 0,
      },
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));

    const result = await within(row).findByTestId("settings-sync-pull-result");
    expect(result).toHaveTextContent("2 hosts");
    expect(result).not.toHaveTextContent("groups");
    expect(result).not.toHaveTextContent("snippets");
    expect(result).not.toHaveTextContent("plugins");
    expect(result).not.toHaveTextContent("app settings");
    expect(result).not.toHaveTextContent("credentials");
    expect(result).not.toHaveTextContent("kept 0 local edits");
    expect(screen.queryByTestId("settings-sync-conflicts")).not.toBeInTheDocument();
  });

  it("reloads the dataset list, the conflict log, and the hosts and groups after a pull", async () => {
    mockPull({ conflicts: [conflictEntry] });
    await openSyncSection();
    expect(commandCalls("sync_list_datasets")).toHaveLength(1);

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));
    await within(row).findByTestId("settings-sync-pull-result");

    // The generation moved, so the row is re-read rather than patched.
    await waitFor(() => expect(commandCalls("sync_list_datasets")).toHaveLength(2));
    expect(commandCalls("sync_list_conflicts")[0][1]).toEqual({ datasetId: "ds-1", limit: 20 });
    // A pull rewrites hosts and groups, so the stores the rest of the app reads
    // must be reloaded without a restart. The scope pickers already loaded both
    // stores once on mount, so the pull reload is the second read.
    await waitFor(() => expect(commandCalls("list_hosts")).toHaveLength(2));
    expect(commandCalls("list_groups")).toHaveLength(2);
  });

  it("renders each conflict with its resolution and both timestamps", async () => {
    mockPull({ conflicts: [conflictEntry] });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));

    const log = await within(row).findByTestId("settings-sync-conflicts");
    expect(log).toHaveTextContent("the newer copy was kept");
    expect(log).toHaveTextContent("Nothing was discarded silently");

    const entry = within(log).getByTestId("settings-sync-conflict-7");
    expect(entry).toHaveTextContent("host h-nova-db");
    expect(entry).toHaveTextContent("kept the copy updated most recently");
    expect(entry).toHaveTextContent("2026-09-18T12:00:00Z");
    expect(entry).toHaveTextContent("2026-09-17T09:30:00Z");
  });

  it("explains a wrong dataset passphrase instead of showing a pull outcome", async () => {
    mockPull({
      pullError: {
        kind: "decrypt",
        message: "the dataset key could not be unwrapped",
      },
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));

    const error = await screen.findByTestId("settings-sync-dataset-error");
    expect(error).toHaveTextContent("the dataset key could not be unwrapped");
    expect(error).toHaveTextContent(
      "Wrong dataset passphrase — re-save the dataset with the correct passphrase.",
    );
    expect(screen.queryByTestId("settings-sync-pull-result")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-sync-conflicts")).not.toBeInTheDocument();
  });

  it("shows the backend's newer-format message verbatim", async () => {
    mockPull({
      pullError: {
        kind: "version",
        message:
          "this dataset was published by a newer version of OmniSSH — update OmniSSH first",
      },
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));

    const error = await screen.findByTestId("settings-sync-dataset-error");
    expect(error).toHaveTextContent(
      "this dataset was published by a newer version of OmniSSH — update OmniSSH first",
    );
    expect(error).not.toHaveTextContent("Wrong dataset passphrase");
  });

  it("keeps both cadence fields disabled until automatic sync is switched on", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_update_schedule: () => savedDataset,
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    const toggle = within(row).getByTestId("settings-sync-auto");
    const pull = within(row).getByTestId("settings-sync-pull-interval");
    const push = within(row).getByTestId("settings-sync-push-debounce");

    // A saved dataset starts with automatic sync off, and says so.
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(row).toHaveTextContent("Off — this dataset only syncs when you press Pull now or Push now.");
    expect(pull).toBeDisabled();
    expect(push).toBeDisabled();
    expect(within(row).getByTestId("settings-sync-phase-ds-1")).toHaveTextContent("Last synced 1h ago");

    fireEvent.click(toggle);

    await waitFor(() => expect(commandCalls("sync_update_schedule")).toHaveLength(1));
    expect(commandCalls("sync_update_schedule")[0][1]).toEqual({
      datasetId: "ds-1",
      autoSync: true,
      pullIntervalSecs: 0,
      pushDebounceSecs: 0,
    });
    expect(pull).not.toBeDisabled();
    expect(push).not.toBeDisabled();
    // On with nothing to trigger it is a state worth naming, not a silent no-op.
    expect(within(row).getByTestId("settings-sync-manual-only")).toHaveTextContent(
      "both cadences are 0",
    );
  });

  it("cautions about edits made elsewhere only on the rows that sync automatically", async () => {
    const autoDataset: SyncDatasetSummary = {
      ...savedDataset,
      id: "ds-2",
      name: "AUTO",
      autoSync: true,
      pullIntervalSecs: 300,
      pushDebounceSecs: 30,
    };
    mockCommands({ sync_list_datasets: () => [savedDataset, autoDataset] });
    await openSyncSection();

    // The caution is per dataset: a row that only syncs when asked cannot be
    // surprised by another machine's edit, so it does not carry the note.
    const manual = await screen.findByTestId("settings-sync-dataset-ds-1");
    const auto = await screen.findByTestId("settings-sync-dataset-ds-2");
    expect(within(manual).queryByTestId("settings-sync-multi-writer-note")).not.toBeInTheDocument();

    const note = within(auto).getByTestId("settings-sync-multi-writer-note");
    // The two facts a user has to know before editing the same host twice.
    expect(note).toHaveTextContent("the newer edit wins");
    expect(note).toHaveTextContent("listed under Conflicts");
    expect(note).toHaveTextContent("merged record by record");
    expect(note).toHaveTextContent("pull first");
  });

  it("refuses an out-of-range cadence and never saves it", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_update_schedule: () => savedDataset,
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-auto"));
    await waitFor(() => expect(commandCalls("sync_update_schedule")).toHaveLength(1));

    const pull = within(row).getByTestId("settings-sync-pull-interval");
    for (const value of ["0.5", "1441"]) {
      fireEvent.change(pull, { target: { value } });
      fireEvent.blur(pull);
      expect(within(row).getByTestId("settings-sync-pull-interval-error")).toHaveTextContent(
        "whole number of minutes from 1 to 1440",
      );
    }

    const push = within(row).getByTestId("settings-sync-push-debounce");
    for (const value of ["2", "3601"]) {
      fireEvent.change(push, { target: { value } });
      fireEvent.blur(push);
      expect(within(row).getByTestId("settings-sync-push-debounce-error")).toHaveTextContent(
        "whole number of seconds from 5 to 3600",
      );
    }

    // Only the switch itself was saved; no rejected cadence reached the backend.
    expect(commandCalls("sync_update_schedule")).toHaveLength(1);
  });

  it("saves a valid cadence change as whole seconds", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_update_schedule: () => savedDataset,
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-auto"));
    await waitFor(() => expect(commandCalls("sync_update_schedule")).toHaveLength(1));

    const pull = within(row).getByTestId("settings-sync-pull-interval");
    fireEvent.change(pull, { target: { value: "15" } });
    fireEvent.blur(pull);
    await waitFor(() => expect(commandCalls("sync_update_schedule")).toHaveLength(2));
    expect(commandCalls("sync_update_schedule")[1][1]).toEqual({
      datasetId: "ds-1",
      autoSync: true,
      pullIntervalSecs: 900,
      pushDebounceSecs: 0,
    });

    const push = within(row).getByTestId("settings-sync-push-debounce");
    fireEvent.change(push, { target: { value: "30" } });
    fireEvent.blur(push);
    await waitFor(() => expect(commandCalls("sync_update_schedule")).toHaveLength(3));
    expect(commandCalls("sync_update_schedule")[2][1]).toEqual({
      datasetId: "ds-1",
      autoSync: true,
      pullIntervalSecs: 900,
      pushDebounceSecs: 30,
    });
  });

  it("renders the live phase, its message, and the changes waiting to publish", async () => {
    mockCommands({ sync_list_datasets: () => [savedDataset] });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");

    await emitSyncStatus({
      ...statusSnapshot,
      phase: "error",
      message: "10.0.0.9 refused the connection",
      kind: "unreachable",
    });
    const phase = within(row).getByTestId("settings-sync-phase-ds-1");
    expect(phase).toHaveTextContent("10.0.0.9 refused the connection");
    expect(phase).toHaveTextContent("The server could not be reached");
    expect(phase).not.toHaveTextContent("Pulling");

    await emitSyncStatus({ ...statusSnapshot, pendingLocalChanges: true });
    expect(within(row).getByTestId("settings-sync-pending-ds-1")).toHaveTextContent(
      "Changes waiting to publish",
    );
  });

  it("shows a pull in flight that this window did not start", async () => {
    mockCommands({ sync_list_datasets: () => [savedDataset] });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    await emitSyncStatus({ ...statusSnapshot, phase: "pulling" });

    expect(within(row).getByTestId("settings-sync-phase-ds-1")).toHaveTextContent(
      "Pulling changes from the server",
    );
  });

  it("routes a push and its outcome to the selected dataset row", async () => {
    const secondDataset: SyncDatasetSummary = {
      ...savedDataset,
      id: "ds-2",
      name: "Bank of Cyprus",
      remotePath: "/config/ds-b",
    };
    mockCommands({
      sync_list_datasets: () => [savedDataset, secondDataset],
      sync_push_preflight: () => ({ ...preflight, datasetId: "ds-2" }),
      sync_push: () => ({ ...outcome, datasetId: "ds-2", generation: 5 }),
    });
    await openSyncSection();

    const first = await screen.findByTestId("settings-sync-dataset-ds-1");
    const second = screen.getByTestId("settings-sync-dataset-ds-2");
    fireEvent.click(within(second).getByTestId("settings-sync-push"));

    expect(await within(second).findByTestId("settings-sync-push-result")).toHaveTextContent(
      "Pushed generation 5",
    );
    expect(commandCalls("sync_push")[0][1]).toEqual({ datasetId: "ds-2" });
    expect(within(first).queryByTestId("settings-sync-push-result")).not.toBeInTheDocument();
  });

  it("offers no push affordance on a member row", async () => {
    const memberDataset: SyncDatasetSummary = { ...savedDataset, role: "member" };
    mockCommands({ sync_list_datasets: () => [memberDataset] });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    expect(within(row).queryByTestId("settings-sync-push")).not.toBeInTheDocument();
    expect(within(row).getByTestId("settings-sync-pull")).toBeInTheDocument();
    expect(row).toHaveTextContent("Member — pull only");
  });
  it("warns when a member dataset's remote is still writable", async () => {
    const memberDataset: SyncDatasetSummary = { ...savedDataset, role: "member" };
    mockCommands({
      sync_list_datasets: () => [memberDataset],
      sync_pull: () => pullOutcome,
      sync_list_conflicts: () => [],
      list_hosts: () => [],
      list_groups: () => [],
      sync_push_preflight: () => preflight,
    });
    await openSyncSection();

    const row = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(row).getByTestId("settings-sync-pull"));
    await within(row).findByTestId("settings-sync-pull-result");

    /* A pull on a member row probes writability, so the row can say when the
     * server is not enforcing the pull-only role. */
    const warning = await within(row).findByTestId("settings-sync-member-writable-warning");
    expect(warning).toHaveTextContent("read-only SSH account");
  });

  it("removes only the selected dataset and exits stale edit mode", async () => {
    const secondDataset: SyncDatasetSummary = {
      ...savedDataset,
      id: "ds-2",
      name: "Bank of Cyprus",
      remotePath: "/config/ds-b",
    };
    mockCommands({
      sync_list_datasets: () => [savedDataset, secondDataset],
      sync_delete_dataset: () => null,
    });
    await openSyncSection();

    const first = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(first).getByTestId("settings-sync-edit"));
    expect(screen.getByTestId("settings-sync-editing")).toHaveTextContent("Editing “NOVA”");
    fireEvent.click(within(first).getByTestId("settings-sync-remove"));

    const dialog = await screen.findByRole("dialog", { name: "Remove this dataset?" });
    expect(dialog).toHaveTextContent("Your local hosts are kept");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(screen.queryByTestId("settings-sync-dataset-ds-1")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("settings-sync-dataset-ds-2")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-sync-editing")).not.toBeInTheDocument();
    expect(screen.getByTestId("settings-sync-save")).toHaveTextContent("Save dataset");
    expect(screen.getByTestId("settings-sync-name")).toHaveValue("");
    expect(commandCalls("sync_delete_dataset")[0][1]).toEqual({ datasetId: "ds-1" });
    expect(commandCalls("delete_host")).toHaveLength(0);
  });

  /*
   * Retained generations (Task 11). The listing is metadata only, so the row
   * must be able to show it without a passphrase ever being involved, and a
   * rollback must be confirmed with what it will change before it publishes.
   */
  it("lists the retained generations from metadata alone, newest first", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_list_history: () => historyListing,
    });
    await openSyncSection();

    const card = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(card).getByTestId("settings-sync-history-toggle"));

    /* No passphrase is sent: the listing reads the plaintext metadata copies. */
    await waitFor(() => expect(commandCalls("sync_list_history")).toHaveLength(1));
    expect(commandCalls("sync_list_history")[0][1]).toEqual({ datasetId: "ds-1" });

    const newest = await within(card).findByTestId("settings-sync-history-11");
    expect(card).toHaveTextContent("Generation 12 is published now");
    expect(newest).toHaveTextContent("11 hosts");
    expect(newest).toHaveTextContent("2 deletions");
    expect(newest).toHaveTextContent("3 credentials");
    expect(newest).toHaveTextContent("signed by the owner");
    expect(newest).toHaveTextContent("written by client-b");
    // Newest first, and the older generation is still offered.
    const older = within(card).getByTestId("settings-sync-history-9");
    expect(older).toHaveTextContent("record counts were not recorded for it");
    expect(older).toHaveTextContent("publish time unknown");
    expect(
      newest.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(card).getByTestId("settings-sync-rollback-11")).toBeInTheDocument();
  });

  it("confirms what a rollback will change and reports the generation it published", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_list_history: () => historyListing,
      sync_rollback: () => rollbackOutcome,
      sync_list_conflicts: () => [],
      list_hosts: () => [],
      list_groups: () => [],
    });
    await openSyncSection();

    const card = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(card).getByTestId("settings-sync-history-toggle"));
    fireEvent.click(await within(card).findByTestId("settings-sync-rollback-11"));

    const dialog = await screen.findByRole("dialog", { name: "Roll this dataset back?" });
    // The dialog names the target's contents and what rolling back does not do.
    expect(dialog).toHaveTextContent("generation 11");
    expect(dialog).toHaveTextContent("11 hosts · 4 groups · 3 credentials · 2 deletions");
    expect(dialog).toHaveTextContent("Records you created or changed since then are kept");
    expect(dialog).toHaveTextContent("generation 12 stays on the server");
    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back" }));

    await waitFor(() => expect(commandCalls("sync_rollback")).toHaveLength(1));
    expect(commandCalls("sync_rollback")[0][1]).toEqual({ datasetId: "ds-1", generation: 11 });
    const result = await within(card).findByTestId("settings-sync-rollback-result");
    expect(result).toHaveTextContent("Rolled back to generation 11 and published generation 13");
    expect(result).toHaveTextContent("12 hosts");
    // What the merge kept and what it resolved, reported like a pull's outcome.
    expect(result).toHaveTextContent("kept 2 local edits · 1 conflict");
    /* A rollback merges and publishes, so the listing is re-read: the new
     * generation is on the server now, and the one it replaced is archived. */
    await waitFor(() => expect(commandCalls("sync_list_history")).toHaveLength(2));
  });

  it("reports a history read that failed without pretending the list is empty", async () => {
    mockCommands({
      sync_list_datasets: () => [savedDataset],
      sync_list_history: () => {
        throw { kind: "unreachable", message: "sync endpoint unreachable" };
      },
    });
    await openSyncSection();

    const card = await screen.findByTestId("settings-sync-dataset-ds-1");
    fireEvent.click(within(card).getByTestId("settings-sync-history-toggle"));

    const error = await screen.findByTestId("settings-sync-dataset-error");
    expect(error).toHaveTextContent("sync endpoint unreachable");
    expect(within(card).queryByTestId("settings-sync-history-11")).not.toBeInTheDocument();
  });

  it("offers no generation history on a member row, which cannot publish a rollback", async () => {
    mockCommands({ sync_list_datasets: () => [{ ...savedDataset, role: "member" }] });
    await openSyncSection();

    const card = await screen.findByTestId("settings-sync-dataset-ds-1");
    expect(within(card).queryByTestId("settings-sync-history")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("settings-sync-history-toggle")).not.toBeInTheDocument();
  });
});
