import { describe, it, expect, beforeEach, vi } from "vitest";
import { useRecentPathsStore, selectRecentPaths, MAX_RECENT_PATHS } from "./recent-paths-store";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("recent-paths-store", () => {
  beforeEach(() => {
    invoke.mockClear();
    useRecentPathsStore.setState({ byKey: new Map() });
  });

  it("records newest-first and de-duplicates re-visited paths", () => {
    const { record } = useRecentPathsStore.getState();
    record("host:a", "remote", "/one");
    record("host:a", "remote", "/two");
    record("host:a", "remote", "/one");

    expect(selectRecentPaths(useRecentPathsStore.getState(), "host:a", "remote")).toEqual([
      "/one",
      "/two",
    ]);
  });

  it(`caps the history at ${MAX_RECENT_PATHS} entries`, () => {
    const { record } = useRecentPathsStore.getState();
    for (let i = 1; i <= MAX_RECENT_PATHS + 3; i++) {
      record("host:a", "remote", `/dir/${i}`);
    }

    const paths = selectRecentPaths(useRecentPathsStore.getState(), "host:a", "remote");
    expect(paths).toHaveLength(MAX_RECENT_PATHS);
    expect(paths[0]).toBe(`/dir/${MAX_RECENT_PATHS + 3}`);
    expect(paths).not.toContain("/dir/1");
  });

  it("keeps hosts and scopes independent", () => {
    const { record } = useRecentPathsStore.getState();
    record("host:a", "remote", "/a");
    record("host:b", "remote", "/b");

    expect(selectRecentPaths(useRecentPathsStore.getState(), "host:a", "remote")).toEqual(["/a"]);
    expect(selectRecentPaths(useRecentPathsStore.getState(), "host:b", "remote")).toEqual(["/b"]);
  });

  it("persists each recorded path once, skipping a redundant re-record", async () => {
    const { record } = useRecentPathsStore.getState();
    record("host:a", "remote", "/keep");
    record("host:a", "remote", "/keep");

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("record_recent_path", {
      hostKey: "host:a",
      scope: "remote",
      path: "/keep",
    });
  });

  it("ignores blank input", () => {
    const { record } = useRecentPathsStore.getState();
    record("", "remote", "/x");
    record("host:a", "remote", "");

    expect(invoke).not.toHaveBeenCalled();
  });

  it("loads and replaces the cached list for a host", async () => {
    invoke.mockResolvedValueOnce(["/loaded/1", "/loaded/2"]);
    await useRecentPathsStore.getState().load("host:a", "remote");

    expect(invoke).toHaveBeenCalledWith("list_recent_paths", {
      hostKey: "host:a",
      scope: "remote",
      limit: MAX_RECENT_PATHS,
    });
    expect(selectRecentPaths(useRecentPathsStore.getState(), "host:a", "remote")).toEqual([
      "/loaded/1",
      "/loaded/2",
    ]);
  });
});
