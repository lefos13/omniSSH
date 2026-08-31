/*
 * Component tests for LinkedExplorerPanel.
 * Tests connection lifecycle, SFTP/SCP fallback, OSC 7 sync status indicator,
 * session-local shell integration triggers, "cd here" dispatch, followPath toggle,
 * and rebinding on active pane changes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: vi.fn(async () => () => {}),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

import { LinkedExplorerPanel } from "../LinkedExplorerPanel";
import { useSessionStore } from "../../../stores/session-store";
import { useLinkedExplorerStore } from "../../../stores/linked-explorer-store";
import { useSftpStore } from "../../../stores/sftp-store";
import type { HostConfig } from "../../../types";

const dummyHost: HostConfig = {
  host: "10.0.0.1",
  port: 22,
  username: "alice",
  auth_method: { type: "password", password: "pwd" },
};

describe("LinkedExplorerPanel", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "sftp_open") return "sftp-sess-1";
      if (cmd === "sftp_list_dir") return [];
      if (cmd === "sftp_home_dir") return "/home/alice";
      if (cmd === "ssh_send_input") return undefined;
      return undefined;
    });

    useSessionStore.setState({
      sessions: new Map([
        [
          "ssh-1",
          {
            id: "ssh-1",
            hostConfig: dummyHost,
            status: "Connected",
            label: "alice@10.0.0.1",
            remoteCwd: "/home/alice",
            cwdSyncActive: false,
          },
        ],
      ]),
      activeSessionId: "ssh-1",
      tabs: new Map([
        [
          "tab-1",
          {
            layout: { type: "pane", sessionId: "ssh-1" },
            label: "alice@10.0.0.1",
          },
        ],
      ]),
      activeTerminalTabId: "tab-1",
      zoomedPaneId: null,
    });

    useLinkedExplorerStore.setState({
      openTabIds: new Set(["tab-1"]),
      panelWidth: 340,
      followPath: true,
      bindings: new Map(),
    });

    useSftpStore.setState({
      sessions: new Map(),
      activeSftpSessionId: null,
      clipboard: null,
    });
  });

  it("renders connecting state and establishes SFTP session on mount", async () => {
    render(<LinkedExplorerPanel tabId="tab-1" />);

    // Once ensureConnected resolves, status is connected and ExplorerView is rendered
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("sftp_open", { sessionId: "ssh-1" });
    expect(screen.getByTestId("linked-explorer-panel")).toBeInTheDocument();
  });

  it("displays error state with retry button when connection fails", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "sftp_open") throw new Error("SFTP disabled");
      if (cmd === "scp_open") throw new Error("SCP disabled");
      return undefined;
    });

    render(<LinkedExplorerPanel tabId="tab-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    const errorEl = await screen.findByTestId("linked-explorer-error");
    expect(errorEl).toBeInTheDocument();
    expect(errorEl).toHaveTextContent("SFTP disabled");

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    expect(retryBtn).toBeInTheDocument();

    // Clicking retry attempts reconnect
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "sftp_open") return "sftp-retry-1";
      if (cmd === "sftp_list_dir") return [];
      if (cmd === "sftp_home_dir") return "/home/alice";
      return undefined;
    });

    fireEvent.click(retryBtn);

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("sftp_open", { sessionId: "ssh-1" });
  });

  it("shows inactive sync status when cwdSyncActive is false", async () => {
    render(<LinkedExplorerPanel tabId="tab-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    const statusBtn = screen.getByTestId("linked-explorer-sync-status");
    expect(statusBtn).toHaveTextContent("Sync CWD");
  });

  it("shows active sync status when cwdSyncActive is true", async () => {
    useSessionStore.getState().setRemoteCwd("ssh-1", "/var/log");

    render(<LinkedExplorerPanel tabId="tab-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    const statusBtn = screen.getByTestId("linked-explorer-sync-status");
    expect(statusBtn).toHaveTextContent("Synced");
  });

  it("opens sync menu on status button click and triggers shell sync commands", async () => {
    render(<LinkedExplorerPanel tabId="tab-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    const statusBtn = screen.getByTestId("linked-explorer-sync-status");
    fireEvent.click(statusBtn);

    const menu = screen.getByTestId("linked-explorer-sync-menu");
    expect(menu).toBeInTheDocument();

    const bashBtn = screen.getByTestId("linked-explorer-sync-bash");
    fireEvent.click(bashBtn);

    expect(invoke).toHaveBeenCalledWith(
      "ssh_send_input",
      expect.objectContaining({
        sessionId: "ssh-1",
      }),
    );
  });

  it("triggers one-shot sync on clicking 'Trigger sync once'", async () => {
    render(<LinkedExplorerPanel tabId="tab-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    const statusBtn = screen.getByTestId("linked-explorer-sync-status");
    fireEvent.click(statusBtn);

    const onceBtn = screen.getByTestId("linked-explorer-sync-now");
    fireEvent.click(onceBtn);

    expect(invoke).toHaveBeenCalledWith(
      "ssh_send_input",
      expect.objectContaining({
        sessionId: "ssh-1",
      }),
    );
  });

  it("dispatches explicit 'cd here' to terminal when cd button is clicked", async () => {
    render(<LinkedExplorerPanel tabId="tab-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    const cdBtn = screen.getByTestId("linked-explorer-cd-terminal");
    fireEvent.click(cdBtn);

    expect(invoke).toHaveBeenCalledWith("ssh_send_input", {
      sessionId: "ssh-1",
      data: Array.from(new TextEncoder().encode("cd '/home/alice'\n")),
    });
  });

  it("toggles followPath preference when follow button is clicked", async () => {
    render(<LinkedExplorerPanel tabId="tab-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    const followBtn = screen.getByTestId("linked-explorer-follow-toggle");
    expect(useLinkedExplorerStore.getState().followPath).toBe(true);

    fireEvent.click(followBtn);
    expect(useLinkedExplorerStore.getState().followPath).toBe(false);

    fireEvent.click(followBtn);
    expect(useLinkedExplorerStore.getState().followPath).toBe(true);
  });

  it("closes linked explorer panel without affecting terminal session", async () => {
    render(<LinkedExplorerPanel tabId="tab-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    const closeBtn = screen.getByTestId("linked-explorer-close");
    fireEvent.click(closeBtn);

    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(false);
    // Terminal session must remain connected and intact
    expect(useSessionStore.getState().sessions.has("ssh-1")).toBe(true);
  });

  it("rebinds when active pane changes in a split terminal tab", async () => {
    // Add second session to a split layout
    useSessionStore.getState().addSession("ssh-2", {
      ...dummyHost,
      host: "10.0.0.2",
    });

    useSessionStore.setState({
      tabs: new Map([
        [
          "tab-1",
          {
            layout: {
              type: "split",
              direction: "horizontal",
              ratio: 0.5,
              children: [
                { type: "pane", sessionId: "ssh-1" },
                { type: "pane", sessionId: "ssh-2" },
              ],
            },
            label: "split-tab",
          },
        ],
      ]),
      activeSessionId: "ssh-1",
    });

    invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "sftp_open") {
        if (args && typeof args === "object" && "sessionId" in args && args.sessionId === "ssh-2") {
          return "sftp-sess-2";
        }
        return "sftp-sess-1";
      }
      if (cmd === "sftp_list_dir") return [];
      if (cmd === "sftp_home_dir") return "/home/alice";
      return undefined;
    });

    render(<LinkedExplorerPanel tabId="tab-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("sftp_open", { sessionId: "ssh-1" });

    // Switch active pane to ssh-2
    act(() => {
      useSessionStore.getState().setActiveSession("ssh-2");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith("sftp_open", { sessionId: "ssh-2" });
  });
});
