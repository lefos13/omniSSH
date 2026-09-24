import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { AppShell } from "../AppShell";
import { useTabStore, pageTabId, type UnifiedTab } from "../../../stores/tab-store";
import { useSftpStore } from "../../../stores/sftp-store";

/*
 * Exercise AppShell's Cmd+W / Ctrl+W close shortcut to confirm it dispatches
 * explorer sessions to the matching transport close command (SFTP vs SCP)
 * and cleans up the active tab and session store entries.
 */

const invoke = vi.fn();
const listen = vi.fn();
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

let originalPlatform: string;

beforeEach(() => {
  originalPlatform = navigator.platform;
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });

  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "list_hosts" || cmd === "get_recent_connections" || cmd === "list_groups" || cmd === "list_connections" || cmd === "s3_list_connections") {
      return [];
    }
    return undefined;
  });
  listen.mockReset();
  unlisten.mockReset();

  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.scrollBy = vi.fn();

  useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null });
  useTabStore.setState({
    tabs: new Map<string, UnifiedTab>([
      [pageTabId("hosts"), { type: "page", id: pageTabId("hosts"), label: "Hosts", page: "hosts" }],
    ]),
    tabOrder: [pageTabId("hosts")],
    activeTabId: pageTabId("hosts"),
  });
});

afterEach(() => {
  Object.defineProperty(navigator, "platform", {
    value: originalPlatform,
    configurable: true,
  });
  vi.unstubAllGlobals();
});

function seedSftpTab(id: string, transport: "sftp" | "scp", sessionTransport?: "sftp" | "scp") {
  useSftpStore.getState().openSession(id, "ssh-1", id, "user", false, undefined, sessionTransport ?? transport);
  const tab: UnifiedTab = {
    type: "sftp",
    id,
    label: id,
    transport,
  };
  useTabStore.getState().addTab(tab);
  useTabStore.getState().setActiveTab(id);
}

function triggerCloseShortcut() {
  const isMac = navigator.platform.includes("Mac") || navigator.platform === "MacIntel";
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "w",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("AppShell close shortcut", () => {
  it("closes active SFTP tab via sftp_close on Cmd+W", async () => {
    seedSftpTab("sftp-1", "sftp");
    render(<AppShell />);

    triggerCloseShortcut();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp-1" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("scp_close", { scpSessionId: "sftp-1" });
    expect(useTabStore.getState().tabs.has("sftp-1")).toBe(false);
    expect(useSftpStore.getState().sessions.has("sftp-1")).toBe(false);
  });

  it("closes active SCP tab via scp_close on Cmd+W", async () => {
    seedSftpTab("scp-1", "scp");
    render(<AppShell />);

    triggerCloseShortcut();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("scp_close", { scpSessionId: "scp-1" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("sftp_close", { sftpSessionId: "scp-1" });
    expect(useTabStore.getState().tabs.has("scp-1")).toBe(false);
    expect(useSftpStore.getState().sessions.has("scp-1")).toBe(false);
  });

  it("prefers session transport metadata over the tab fallback on Cmd+W", async () => {
    // Session is SCP, but tab metadata says sftp
    seedSftpTab("session-1", "sftp", "scp");
    render(<AppShell />);

    triggerCloseShortcut();

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("scp_close", { scpSessionId: "session-1" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("sftp_close", { sftpSessionId: "session-1" });
    expect(useTabStore.getState().tabs.has("session-1")).toBe(false);
  });
});

/*
 * Exercise AppShell's Cmd+Shift+[ and Cmd+Shift+] shortcuts to confirm
 * they reorder tabs in tabOrder without changing activeTabId, respect
 * boundary and pinned Hosts constraints, and do not regress plain Cmd+[ / Cmd+].
 */
describe("AppShell tab reorder shortcuts", () => {
  const hostsId = pageTabId("hosts");
  const tabA = "tab-a";
  const tabB = "tab-b";
  const tabC = "tab-c";

  function seedTabs(order: string[] = [hostsId, tabA, tabB, tabC], activeId: string = tabB) {
    const tabs = new Map<string, UnifiedTab>([
      [hostsId, { type: "page", id: hostsId, label: "Hosts", page: "hosts" }],
      [tabA, { type: "page", id: tabA, label: "Tab A", page: "settings" }],
      [tabB, { type: "page", id: tabB, label: "Tab B", page: "settings" }],
      [tabC, { type: "page", id: tabC, label: "Tab C", page: "settings" }],
    ]);
    useTabStore.setState({
      tabs,
      tabOrder: [...order],
      activeTabId: activeId,
    });
  }

  function triggerKey(key: string, options: { shift?: boolean } = {}) {
    const isMac = navigator.platform.includes("Mac") || navigator.platform === "MacIntel";
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: isMac,
        ctrlKey: !isMac,
        shiftKey: options.shift ?? false,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  it("moves the active tab right by one using ']' and '}' without changing activeTabId", () => {
    seedTabs([hostsId, tabA, tabB, tabC], tabA);
    render(<AppShell />);

    // Test ']' moves tabA from index 1 to index 2
    triggerKey("]", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabB, tabA, tabC]);
    expect(useTabStore.getState().activeTabId).toBe(tabA);

    // Test '}' moves tabA from index 2 to index 3
    triggerKey("}", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabB, tabC, tabA]);
    expect(useTabStore.getState().activeTabId).toBe(tabA);
  });

  it("moves the active tab left by one using '[' and '{' without changing activeTabId", () => {
    seedTabs([hostsId, tabA, tabB, tabC], tabC);
    render(<AppShell />);

    // Test '[' moves tabC from index 3 to index 2
    triggerKey("[", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabA, tabC, tabB]);
    expect(useTabStore.getState().activeTabId).toBe(tabC);

    // Test '{' moves tabC from index 2 to index 1
    triggerKey("{", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabC, tabA, tabB]);
    expect(useTabStore.getState().activeTabId).toBe(tabC);
  });

  it("does not move the tab when at the right edge", () => {
    seedTabs([hostsId, tabA, tabB, tabC], tabC);
    render(<AppShell />);

    triggerKey("]", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabA, tabB, tabC]);
    expect(useTabStore.getState().activeTabId).toBe(tabC);

    triggerKey("}", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabA, tabB, tabC]);
    expect(useTabStore.getState().activeTabId).toBe(tabC);
  });

  it("does not move the tab left when at index 1 next to Hosts", () => {
    seedTabs([hostsId, tabA, tabB, tabC], tabA);
    render(<AppShell />);

    triggerKey("[", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabA, tabB, tabC]);
    expect(useTabStore.getState().activeTabId).toBe(tabA);

    triggerKey("{", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabA, tabB, tabC]);
    expect(useTabStore.getState().activeTabId).toBe(tabA);
  });

  it("does not move when Hosts is the active tab", () => {
    seedTabs([hostsId, tabA, tabB, tabC], hostsId);
    render(<AppShell />);

    triggerKey("]", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabA, tabB, tabC]);
    expect(useTabStore.getState().activeTabId).toBe(hostsId);

    triggerKey("[", { shift: true });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabA, tabB, tabC]);
    expect(useTabStore.getState().activeTabId).toBe(hostsId);
  });

  it("plain Cmd+] (no shift) still switches the active tab and does NOT change tabOrder", () => {
    seedTabs([hostsId, tabA, tabB, tabC], tabA);
    render(<AppShell />);

    triggerKey("]", { shift: false });
    expect(useTabStore.getState().tabOrder).toEqual([hostsId, tabA, tabB, tabC]);
    expect(useTabStore.getState().activeTabId).toBe(tabB);
  });
});

