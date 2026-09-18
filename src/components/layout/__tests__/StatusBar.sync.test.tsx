import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "../StatusBar";
import { useSyncStore } from "../../../stores/sync-store";
import { useSessionStore } from "../../../stores/session-store";
import type { SyncStatusSnapshot } from "../../../types/sync";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

/*
 * The status bar follows the scheduler's `sync:status` stream through the
 * store's real subscription path, so the mocked `listen` hands its handler back
 * to the tests instead of swallowing it.
 */
const syncStatusListeners = vi.hoisted(
  () => new Map<string, (event: { payload: SyncStatusSnapshot }) => void>(),
);
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: SyncStatusSnapshot }) => void) => {
    syncStatusListeners.set(name, handler);
    return () => { syncStatusListeners.delete(name); };
  },
}));

function snapshot(overrides: Partial<SyncStatusSnapshot>): SyncStatusSnapshot {
  return {
    datasetId: "ds-1",
    name: "NOVA",
    phase: "idle",
    autoSync: true,
    pullIntervalSecs: 900,
    pushDebounceSecs: 30,
    generation: 12,
    lastSyncedAt: null,
    pendingLocalChanges: false,
    message: null,
    kind: null,
    ...overrides,
  };
}

/** Reports the given phases from `sync_status`, the read made on mount. */
function reportStatus(snapshots: SyncStatusSnapshot[]) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "sync_status") return snapshots;
    return undefined;
  });
}

/** Pushes a `sync:status` event through the store's real subscription path. */
async function emitSyncStatus(event: SyncStatusSnapshot) {
  await waitFor(() => expect(syncStatusListeners.has("sync:status")).toBe(true));
  act(() => { syncStatusListeners.get("sync:status")?.({ payload: event }); });
}

describe("StatusBar dataset sync indicator", () => {
  beforeEach(() => {
    invoke.mockReset();
    reportStatus([]);
    useSessionStore.setState({ sessions: new Map(), activeSessionId: null });
    useSyncStore.setState({ statuses: {} });
  });

  it("shows no sync indicator while no dataset exists", async () => {
    render(<StatusBar />);

    // Let the on-mount status read settle: an empty report must paint nothing.
    await act(async () => {});
    expect(screen.queryByTestId("status-bar-sync")).not.toBeInTheDocument();
    expect(screen.getByText("No active session")).toBeInTheDocument();
  });

  it("shows a syncing indicator while a dataset is pulling", async () => {
    reportStatus([snapshot({ phase: "pulling" })]);
    render(<StatusBar />);

    const indicator = await screen.findByTestId("status-bar-sync");
    expect(indicator).toHaveTextContent("Pulling NOVA");
    expect(indicator).toHaveAccessibleName("Syncing: pulling dataset NOVA");
  });

  it("names the failing dataset in the error state", async () => {
    reportStatus([
      snapshot({
        datasetId: "ds-2",
        name: "Bank of Cyprus",
        phase: "error",
        message: "auth failed for this account",
        kind: "unreachable",
      }),
    ]);
    render(<StatusBar />);

    const indicator = await screen.findByTestId("status-bar-sync");
    expect(indicator).toHaveTextContent("Sync error");
    expect(indicator).toHaveAttribute("title", "Bank of Cyprus — auth failed for this account");
    expect(indicator).toHaveAccessibleName("Sync error for dataset Bank of Cyprus");
  });

  it("reports a failed status read without blocking the rest of the bar", async () => {
    invoke.mockRejectedValue(new Error("the scheduler is not running"));
    render(<StatusBar />);

    await act(async () => {});
    expect(screen.queryByTestId("status-bar-sync")).not.toBeInTheDocument();
    expect(screen.getByText("No active session")).toBeInTheDocument();
  });

  it("follows a sync:status event that this window did not start", async () => {
    render(<StatusBar />);
    await act(async () => {});

    await emitSyncStatus(snapshot({ phase: "pushing" }));

    const indicator = await screen.findByTestId("status-bar-sync");
    expect(indicator).toHaveTextContent("Pushing NOVA");
  });

  it("shows the most recent sync across datasets when everything is idle", async () => {
    const newer = new Date(Date.now() - 5 * 60_000 - 30_000);
    const older = new Date(Date.now() - 3 * 3_600_000);
    // The backend reports timestamps in both forms: the newer instant here is
    // SQLite UTC with no zone marker, the older one is RFC3339. Only comparing
    // instants picks the right one; string order would not.
    const newerSqlite = newer.toISOString().replace("T", " ").slice(0, 19);
    reportStatus([
      snapshot({ datasetId: "ds-1", lastSyncedAt: newerSqlite }),
      snapshot({ datasetId: "ds-2", name: "Bank of Cyprus", lastSyncedAt: older.toISOString() }),
    ]);
    render(<StatusBar />);

    const indicator = await screen.findByTestId("status-bar-sync");
    expect(indicator).toHaveTextContent("Synced 5m ago");
    expect(indicator).toHaveAccessibleName("Datasets synced 5m ago");
  });
});
