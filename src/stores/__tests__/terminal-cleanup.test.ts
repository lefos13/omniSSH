/*
 * Tests for terminal split, tab, and panel cleanup.
 * Verifies that split pane closures, whole-tab closures, and disconnect overlay
 * actions clean up xterm instances, layout trees, linked explorer bindings,
 * SFTP sessions, and generation tracking without leaving memory leaks or orphaned tabs.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useSessionStore } from "../session-store";
import { useLinkedExplorerStore, _testTabGenerations } from "../linked-explorer-store";
import { useSftpStore } from "../sftp-store";
import { useTabStore } from "../tab-store";
import { ensureTerminal, getTerminal } from "../terminal-instances";
import type { HostConfig } from "../../types";

const testHost: HostConfig = {
  host: "clean.local",
  port: 22,
  username: "cleanup",
  auth_method: { type: "password", password: "pwd" },
};

beforeAll(() => {
  // Mock JSDOM environment for xterm.js
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

describe("Terminal split/tab/panel cleanup", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSessionStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      tabs: new Map(),
      activeTerminalTabId: null,
      zoomedPaneId: null,
    });
    useLinkedExplorerStore.setState({
      openTabIds: new Set(),
      bindings: new Map(),
      panelWidth: 340,
      followPath: true,
    });
    useSftpStore.setState({
      sessions: new Map(),
      activeSftpSessionId: null,
      clipboard: null,
    });
    useTabStore.setState({
      tabs: new Map(),
      tabOrder: [],
      activeTabId: null,
    });
  });

  it("cleans up child session and disposes xterm instance when a split pane is closed", () => {
    const mainSessionId = "sess-main";
    const splitSessionId = "sess-split";
    // In session-store, tab ID equals initial mainSessionId
    const tabId = mainSessionId;

    useSessionStore.getState().addSession(mainSessionId, testHost);
    useTabStore.getState().addTab({
      type: "terminal",
      id: tabId,
      label: "cleanup@clean.local",
    });

    // Create split under the tab
    useSessionStore.getState().splitPane("horizontal", mainSessionId, splitSessionId);

    // Initialize xterm instances for both panes
    ensureTerminal(mainSessionId);
    ensureTerminal(splitSessionId);

    expect(getTerminal(mainSessionId)).toBeDefined();
    expect(getTerminal(splitSessionId)).toBeDefined();
    expect(useSessionStore.getState().sessions.size).toBe(2);

    // Close the split pane
    useSessionStore.getState().unsplitPane(splitSessionId);
    useSessionStore.getState().removeSession(splitSessionId);

    // session-store subscriber disposes the removed session's terminal instance
    expect(useSessionStore.getState().sessions.has(splitSessionId)).toBe(false);
    expect(useSessionStore.getState().sessions.has(mainSessionId)).toBe(true);
    expect(getTerminal(splitSessionId)).toBeUndefined();
    expect(getTerminal(mainSessionId)).toBeDefined();

    // Active session pivots to the surviving main session
    expect(useSessionStore.getState().activeSessionId).toBe(mainSessionId);
  });

  it("cleans up all child split panes, linked panels, and generations on whole tab close", async () => {
    const pane1Id = "pane-1";
    const pane2Id = "pane-2";
    // Tab ID equals initial pane1Id in session-store
    const tabId = pane1Id;
    const linkedSftpId = "sftp-linked-cleanup";

    // Setup session layout with 2 panes under tabId
    useSessionStore.getState().addSession(pane1Id, testHost);
    useTabStore.getState().addTab({ type: "terminal", id: tabId, label: "Multi Pane Tab" });
    useSessionStore.getState().splitPane("vertical", pane1Id, pane2Id);

    ensureTerminal(pane1Id);
    ensureTerminal(pane2Id);

    // Open linked explorer on this tab bound to pane2Id
    invoke.mockResolvedValueOnce(linkedSftpId);
    useLinkedExplorerStore.getState().openLinkedExplorer(tabId);
    await useLinkedExplorerStore.getState().ensureConnected(tabId, pane2Id);

    expect(useLinkedExplorerStore.getState().openTabIds.has(tabId)).toBe(true);
    expect(useLinkedExplorerStore.getState().bindings.has(tabId)).toBe(true);
    expect(useSftpStore.getState().sessions.has(linkedSftpId)).toBe(true);

    // Close the whole tab: remove both sessions and the unified tab
    invoke.mockResolvedValue(undefined);
    useSessionStore.getState().removeSession(pane1Id);
    useSessionStore.getState().removeSession(pane2Id);
    useTabStore.getState().removeTab(tabId);

    // Verify complete cleanup
    expect(getTerminal(pane1Id)).toBeUndefined();
    expect(getTerminal(pane2Id)).toBeUndefined();
    expect(useLinkedExplorerStore.getState().openTabIds.has(tabId)).toBe(false);
    expect(useLinkedExplorerStore.getState().bindings.has(tabId)).toBe(false);
    expect(useSftpStore.getState().sessions.has(linkedSftpId)).toBe(false);
    expect(_testTabGenerations.get(tabId)).toBeUndefined();
  });

  it("handles disconnect overlay removal cleanly without leaving orphaned tabs", () => {
    const sessionId = "sess-dropped";
    useSessionStore.getState().addSession(sessionId, testHost);
    useTabStore.getState().addTab({ type: "terminal", id: sessionId, label: "Dropped Session" });

    // Mark session as disconnected
    useSessionStore.getState().updateStatus(sessionId, "Disconnected", "Connection reset by peer");

    expect(useSessionStore.getState().sessions.get(sessionId)?.status).toBe("Disconnected");

    // Dismissal removes session and tab
    useSessionStore.getState().removeSession(sessionId);
    if (!useSessionStore.getState().tabs.get(sessionId)) {
      useTabStore.getState().removeTab(sessionId);
    }

    expect(useSessionStore.getState().sessions.has(sessionId)).toBe(false);
    expect(useTabStore.getState().tabs.has(sessionId)).toBe(false);
    expect(useTabStore.getState().activeTabId).toBe("page:hosts");
  });
});
