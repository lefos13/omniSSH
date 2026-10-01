import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SavedHost } from "../types";
import { useHostsStore } from "./hosts-store";
import { useSettingsStore } from "./settings-store";

// The store reaches the backend via a dynamic `import("@tauri-apps/api/core")`,
// so we mock that module's `invoke`. Each test swaps the implementation.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function makeHost(id: string, label: string): SavedHost {
  return {
    id,
    label,
    host: `${label}.example.com`,
    port: 22,
    username: "root",
    auth_type: "password",
    group_id: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
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

const a = makeHost("a", "alpha");
const b = makeHost("b", "bravo");
const c = makeHost("c", "charlie");

describe("hosts-store reorderHosts", () => {
  beforeEach(() => {
    invoke.mockReset();
    useHostsStore.setState({ hosts: [a, b, c], error: null });
  });

  it("optimistically applies the new order and persists the id list", async () => {
    invoke.mockResolvedValue(undefined);
    const newOrder = [c, a, b];

    await useHostsStore.getState().reorderHosts(newOrder);

    expect(useHostsStore.getState().hosts).toEqual(newOrder);
    expect(invoke).toHaveBeenCalledWith("reorder_hosts", {
      orderedIds: ["c", "a", "b"],
    });
  });

  it("applies the new order immediately, before the backend resolves", async () => {
    let resolveInvoke: () => void = () => {};
    invoke.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInvoke = resolve;
      }),
    );

    const promise = useHostsStore.getState().reorderHosts([b, c, a]);

    // Optimistic update is visible synchronously, while invoke is still pending.
    expect(useHostsStore.getState().hosts.map((h) => h.id)).toEqual(["b", "c", "a"]);

    resolveInvoke();
    await promise;
  });

  it("reverts to the previous order and rethrows when persistence fails", async () => {
    invoke.mockRejectedValue(new Error("db locked"));

    await expect(
      useHostsStore.getState().reorderHosts([c, b, a]),
    ).rejects.toThrow("db locked");

    // Order rolled back to the pre-drag state.
    expect(useHostsStore.getState().hosts).toEqual([a, b, c]);
  });
});

describe("hosts-store deleteHost local dir map maintenance", () => {
  beforeEach(() => {
    invoke.mockReset();
    useHostsStore.setState({ hosts: [a, b], error: null });
    useSettingsStore.setState({
      explorerHostLocalDirs: { [a.id]: "/folder/a", [b.id]: "/folder/b" },
    });
  });

  it("removes the entry and persists when delete succeeds", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "delete_host") return undefined;
      if (cmd === "list_hosts") return [b];
      return undefined;
    });

    await useHostsStore.getState().deleteHost(a.id);

    expect(useSettingsStore.getState().explorerHostLocalDirs).toEqual({
      [b.id]: "/folder/b",
    });
    expect(invoke).toHaveBeenCalledWith("delete_host", { id: a.id });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_setting", {
        key: "explorer_host_local_dirs",
        value: JSON.stringify({ [b.id]: "/folder/b" }),
      }),
    );
  });

  it("keeps the entry when delete fails", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "delete_host") throw new Error("delete failed");
      return undefined;
    });

    await expect(useHostsStore.getState().deleteHost(a.id)).rejects.toThrow("delete failed");

    expect(useSettingsStore.getState().explorerHostLocalDirs).toEqual({
      [a.id]: "/folder/a",
      [b.id]: "/folder/b",
    });
    expect(
      invoke.mock.calls.some(
        (call) =>
          call[0] === "save_setting" &&
          (call[1] as { key?: string })?.key === "explorer_host_local_dirs",
      ),
    ).toBe(false);
  });

  it("does not call setHostLocalDir or persist if host had no entry", async () => {
    useSettingsStore.setState({ explorerHostLocalDirs: { [b.id]: "/folder/b" } });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "delete_host") return undefined;
      if (cmd === "list_hosts") return [b];
      return undefined;
    });

    await useHostsStore.getState().deleteHost(a.id);

    expect(useSettingsStore.getState().explorerHostLocalDirs).toEqual({
      [b.id]: "/folder/b",
    });
    expect(
      invoke.mock.calls.some(
        (call) =>
          call[0] === "save_setting" &&
          (call[1] as { key?: string })?.key === "explorer_host_local_dirs",
      ),
    ).toBe(false);
  });
});

describe("hosts-store duplicateHost local dir map maintenance", () => {
  beforeEach(() => {
    invoke.mockReset();
    useHostsStore.setState({ hosts: [a, b], error: null });
  });

  it("copies the entry to the new id and persists", async () => {
    useSettingsStore.setState({
      explorerHostLocalDirs: { [a.id]: "/folder/a" },
    });

    let currentHosts = [a, b];
    let savedDuplicate: SavedHost | null = null;
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_hosts") return currentHosts;
      if (cmd === "save_host") {
        savedDuplicate = (args as { host: SavedHost }).host;
        currentHosts = [...currentHosts, savedDuplicate];
        return undefined;
      }
      return undefined;
    });

    await useHostsStore.getState().duplicateHost(a.id);

    expect(savedDuplicate).not.toBeNull();
    const duplicateId = savedDuplicate!.id;
    expect(duplicateId).not.toBe(a.id);

    expect(useSettingsStore.getState().explorerHostLocalDirs).toEqual({
      [a.id]: "/folder/a",
      [duplicateId]: "/folder/a",
    });

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_setting", {
        key: "explorer_host_local_dirs",
        value: JSON.stringify({
          [a.id]: "/folder/a",
          [duplicateId]: "/folder/a",
        }),
      }),
    );
  });

  it("results in duplicate having no entry if source has none", async () => {
    useSettingsStore.setState({
      explorerHostLocalDirs: { [b.id]: "/folder/b" },
    });

    let currentHosts = [a, b];
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_hosts") return currentHosts;
      if (cmd === "save_host") {
        const dup = (args as { host: SavedHost }).host;
        currentHosts = [...currentHosts, dup];
        return undefined;
      }
      return undefined;
    });

    await useHostsStore.getState().duplicateHost(a.id);

    expect(useSettingsStore.getState().explorerHostLocalDirs).toEqual({
      [b.id]: "/folder/b",
    });
    expect(
      invoke.mock.calls.some(
        (call) =>
          call[0] === "save_setting" &&
          (call[1] as { key?: string })?.key === "explorer_host_local_dirs",
      ),
    ).toBe(false);
  });

  it("changing the duplicate's entry later leaves the source unchanged", async () => {
    useSettingsStore.setState({
      explorerHostLocalDirs: { [a.id]: "/folder/a" },
    });

    let currentHosts = [a, b];
    let savedDuplicate: SavedHost | null = null;
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_hosts") return currentHosts;
      if (cmd === "save_host") {
        savedDuplicate = (args as { host: SavedHost }).host;
        currentHosts = [...currentHosts, savedDuplicate];
        return undefined;
      }
      return undefined;
    });

    await useHostsStore.getState().duplicateHost(a.id);
    const duplicateId = savedDuplicate!.id;

    // Mutate duplicate's folder
    useSettingsStore.getState().setHostLocalDir(duplicateId, "/folder/a-modified");

    expect(useSettingsStore.getState().explorerHostLocalDirs[a.id]).toBe("/folder/a");
    expect(useSettingsStore.getState().explorerHostLocalDirs[duplicateId]).toBe("/folder/a-modified");

    // Clear duplicate's folder
    useSettingsStore.getState().setHostLocalDir(duplicateId, null);

    expect(useSettingsStore.getState().explorerHostLocalDirs[a.id]).toBe("/folder/a");
    expect(useSettingsStore.getState().explorerHostLocalDirs[duplicateId]).toBeUndefined();
  });
});
