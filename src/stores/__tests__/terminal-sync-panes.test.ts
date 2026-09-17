/*
 * Unit tests for terminal split screen parallel execution and input synchronization.
 * Verifies that toggleSyncPanes enables/disables input broadcasting, automatically
 * cleans up when panes are unsplit or removed, broadcasts xterm onData across all
 * sessions in the tab (same host or different hosts), and handles disconnected sessions gracefully.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useSessionStore } from "../session-store";
import { useTabStore } from "../tab-store";
import { ensureTerminal } from "../terminal-instances";
import type { HostConfig } from "../../types";

const host1: HostConfig = {
  host: "10.0.0.1",
  port: 22,
  username: "alice",
  auth_method: { type: "password", password: "pwd" },
  label: "web-server",
  savedHostId: "h1",
};

const host2: HostConfig = {
  host: "10.0.0.2",
  port: 22,
  username: "bob",
  auth_method: { type: "password", password: "pwd" },
  label: "db-server",
  savedHostId: "h2",
};

beforeAll(() => {
  if (typeof window !== "undefined") {
    window.matchMedia =
      window.matchMedia ||
      (() => ({
        matches: false,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }));

    class FakeResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof FakeResizeObserver }).ResizeObserver =
      FakeResizeObserver;
  }
});

describe("Terminal split screen parallel execution and sync", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);

    useTabStore.setState({
      tabs: new Map(),
      tabOrder: [],
      activeTabId: null,
    });

    useSessionStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      tabs: new Map(),
      activeTerminalTabId: null,
      zoomedPaneId: null,
      syncedTabIds: new Set(),
    });
  });

  it("does not activate sync on a tab with only 1 pane", () => {
    useSessionStore.getState().addSession("sess-1", host1);
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(false);

    useSessionStore.getState().toggleSyncPanes("sess-1");
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(false);
    expect(useSessionStore.getState().syncedTabIds.has("sess-1")).toBe(false);
  });

  it("toggles sync on a split tab with multiple sessions of the same host", () => {
    useSessionStore.getState().addSession("sess-1", host1);
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2");

    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(false);

    useSessionStore.getState().toggleSyncPanes("sess-1");
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(true);
    expect(useSessionStore.getState().syncedTabIds.has("sess-1")).toBe(true);

    useSessionStore.getState().toggleSyncPanes("sess-1");
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(false);
  });

  it("toggles sync on a split tab with multiple sessions of different hosts", () => {
    useSessionStore.getState().addSession("sess-1", host1);
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2", host2);

    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(false);

    useSessionStore.getState().setSyncPanes("sess-1", true);
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(true);

    useSessionStore.getState().setSyncPanes("sess-1", false);
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(false);
  });

  it("automatically clears sync when panes are unsplit down to 1 pane", () => {
    useSessionStore.getState().addSession("sess-1", host1);
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2", host2);
    useSessionStore.getState().toggleSyncPanes("sess-1");
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(true);

    // Unsplit pane 2
    useSessionStore.getState().unsplitPane("sess-2");
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(false);
    expect(useSessionStore.getState().syncedTabIds.has("sess-1")).toBe(false);
  });

  it("automatically clears sync when a session is removed leaving 1 pane", () => {
    useSessionStore.getState().addSession("sess-1", host1);
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2", host2);
    useSessionStore.getState().toggleSyncPanes("sess-1");
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(true);

    // Remove session 2
    useSessionStore.getState().removeSession("sess-2");
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(false);
    expect(useSessionStore.getState().syncedTabIds.has("sess-1")).toBe(false);
  });

  it("broadcasts terminal input to all split sessions when synced, but only single session when unsynced", async () => {
    useSessionStore.getState().addSession("sess-1", host1);
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2", host2);

    const term1 = ensureTerminal("sess-1");
    ensureTerminal("sess-2");

    // Initially unsynced: input typed on sess-1 should only send to sess-1
    invoke.mockClear();
    // Simulate xterm onData
    const encoder = new TextEncoder();
    const commandText = "ls -la\n";
    (term1.term as unknown as { _core: { _onData: { fire: (d: string) => void } } })
      ._core?._onData?.fire?.(commandText);

    // Wait for async invoke inside onData
    await new Promise((r) => setTimeout(r, 20));

    expect(invoke).toHaveBeenCalledWith("ssh_send_input", {
      sessionId: "sess-1",
      data: Array.from(encoder.encode(commandText)),
    });
    expect(invoke).not.toHaveBeenCalledWith("ssh_send_input", {
      sessionId: "sess-2",
      data: expect.anything(),
    });

    // Now turn on sync
    useSessionStore.getState().toggleSyncPanes("sess-1");
    expect(useSessionStore.getState().isTabSynced("sess-1")).toBe(true);

    invoke.mockClear();
    const commandText2 = "uptime\n";
    (term1.term as unknown as { _core: { _onData: { fire: (d: string) => void } } })
      ._core?._onData?.fire?.(commandText2);

    await new Promise((r) => setTimeout(r, 20));

    // Both sessions should have received the command in parallel!
    expect(invoke).toHaveBeenCalledWith("ssh_send_input", {
      sessionId: "sess-1",
      data: Array.from(encoder.encode(commandText2)),
    });
    expect(invoke).toHaveBeenCalledWith("ssh_send_input", {
      sessionId: "sess-2",
      data: Array.from(encoder.encode(commandText2)),
    });
  });

  it("skips disconnected or errored sessions during broadcast without throwing", async () => {
    useSessionStore.getState().addSession("sess-1", host1);
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2", host2);
    useSessionStore.getState().toggleSyncPanes("sess-1");

    // Mark sess-2 as Disconnected
    useSessionStore.getState().updateStatus("sess-2", "Disconnected");

    const term1 = ensureTerminal("sess-1");

    invoke.mockClear();
    const encoder = new TextEncoder();
    const commandText = "whoami\n";
    (term1.term as unknown as { _core: { _onData: { fire: (d: string) => void } } })
      ._core?._onData?.fire?.(commandText);

    await new Promise((r) => setTimeout(r, 20));

    // Only sess-1 should receive input
    expect(invoke).toHaveBeenCalledWith("ssh_send_input", {
      sessionId: "sess-1",
      data: Array.from(encoder.encode(commandText)),
    });
    expect(invoke).not.toHaveBeenCalledWith("ssh_send_input", {
      sessionId: "sess-2",
      data: expect.anything(),
    });
  });
});

  it("broadcasts snippet execution across all sessions in a synced tab", async () => {
    useSessionStore.getState().addSession("sess-1", host1);
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2", host2);
    useSessionStore.getState().toggleSyncPanes("sess-1");

    invoke.mockClear();

    // Simulate executing snippet
    const store = useSessionStore.getState();
    const tabId = "sess-1";
    const tab = store.tabs.get(tabId)!;
    const { collectSessionIds } = await import("../session-store");
    const targetSessionIds = collectSessionIds(tab.layout);

    await Promise.allSettled(
      targetSessionIds.map(async (sessId, idx) => {
        const sess = store.sessions.get(sessId);
        if (sess && (sess.status === "Disconnected" || sess.status === "Error")) return;
        await invoke("snippet_execute", {
          sessionId: sessId,
          resolvedCommand: "git pull",
          snippetId: idx === 0 ? "snip-1" : undefined,
        });
      }),
    );

    expect(invoke).toHaveBeenCalledWith("snippet_execute", {
      sessionId: "sess-1",
      resolvedCommand: "git pull",
      snippetId: "snip-1",
    });
    expect(invoke).toHaveBeenCalledWith("snippet_execute", {
      sessionId: "sess-2",
      resolvedCommand: "git pull",
      snippetId: undefined,
    });
  });
