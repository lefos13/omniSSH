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

beforeEach(() => {
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
