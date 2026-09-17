/*
 * Unit tests for multi-host split pane session store functionality.
 * Verifies that splitPane accepts distinct host configurations, updates the
 * aggregate tab label, handles pane closures cleanly, and preserves multi-host state.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore, computeTabLabel } from "../session-store";
import { useTabStore } from "../tab-store";
import type { HostConfig, LayoutNode } from "../../types";

const host1: HostConfig = {
  host: "10.0.0.1",
  port: 22,
  username: "alice",
  auth_method: { type: "password", password: "pwd" },
  label: "web-prod",
  savedHostId: "host-1",
};

const host2: HostConfig = {
  host: "10.0.0.2",
  port: 22,
  username: "bob",
  auth_method: { type: "password", password: "pwd" },
  label: "db-prod",
  savedHostId: "host-2",
};

describe("multi-host split screen sessions", () => {
  beforeEach(() => {
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
    });
  });

  it("computes tab labels for single vs multiple hosts", () => {
    const sessions = new Map([
      ["sess-1", { id: "sess-1", hostConfig: host1, status: "Connected" as const, label: "web-prod" }],
      ["sess-2", { id: "sess-2", hostConfig: host2, status: "Connected" as const, label: "db-prod" }],
    ]);

    const singleLayout: LayoutNode = { type: "pane", sessionId: "sess-1" };
    expect(computeTabLabel(singleLayout, sessions)).toBe("web-prod");

    const splitLayout: LayoutNode = {
      type: "split",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "pane", sessionId: "sess-1" },
        { type: "pane", sessionId: "sess-2" },
      ],
    };
    expect(computeTabLabel(splitLayout, sessions)).toBe("web-prod | db-prod");
  });

  it("splits a pane with a different host configuration", () => {
    // Start session 1 in tab 1
    useSessionStore.getState().addSession("sess-1", host1);
    useTabStore.getState().addTab({ type: "terminal", id: "sess-1", label: "web-prod" });

    // Split with host 2
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2", host2);

    const store = useSessionStore.getState();
    expect(store.sessions.get("sess-1")?.hostConfig.host).toBe("10.0.0.1");
    expect(store.sessions.get("sess-2")?.hostConfig.host).toBe("10.0.0.2");
    expect(store.sessions.get("sess-2")?.label).toBe("db-prod");
    expect(store.activeSessionId).toBe("sess-2");

    // Layout should be split
    const tab = store.tabs.get("sess-1");
    expect(tab?.layout.type).toBe("split");
    expect(tab?.label).toBe("web-prod | db-prod");

    // useTabStore label should also be updated
    expect(useTabStore.getState().tabs.get("sess-1")?.label).toBe("web-prod | db-prod");
  });

  it("updates tab label and active session when closing a multi-host pane", () => {
    useSessionStore.getState().addSession("sess-1", host1);
    useTabStore.getState().addTab({ type: "terminal", id: "sess-1", label: "web-prod" });
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2", host2);

    // Close session 2 (db-prod)
    useSessionStore.getState().removeSession("sess-2");

    const store = useSessionStore.getState();
    expect(store.sessions.has("sess-2")).toBe(false);
    expect(store.sessions.has("sess-1")).toBe(true);

    const tab = store.tabs.get("sess-1");
    expect(tab?.layout.type).toBe("pane");
    expect(tab?.label).toBe("web-prod");
    expect(useTabStore.getState().tabs.get("sess-1")?.label).toBe("web-prod");
    expect(store.activeSessionId).toBe("sess-1");
  });

  it("handles closing the original owner session while keeping the second host alive", () => {
    useSessionStore.getState().addSession("sess-1", host1);
    useTabStore.getState().addTab({ type: "terminal", id: "sess-1", label: "web-prod" });
    useSessionStore.getState().splitPane("horizontal", "sess-1", "sess-2", host2);

    // Close session 1 (the initial session that gave the tab its ID)
    useSessionStore.getState().removeSession("sess-1");

    const store = useSessionStore.getState();
    expect(store.sessions.has("sess-1")).toBe(false);
    expect(store.sessions.has("sess-2")).toBe(true);

    // Tab still exists with session 2
    const tab = store.tabs.get("sess-1");
    expect(tab?.layout.type).toBe("pane");
    expect(tab?.label).toBe("db-prod");
    expect(useTabStore.getState().tabs.get("sess-1")?.label).toBe("db-prod");
    expect(store.activeSessionId).toBe("sess-2");
  });
});
