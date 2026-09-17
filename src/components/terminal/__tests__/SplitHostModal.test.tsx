/*
 * Component tests for SplitHostModal.
 * Verifies host search, keyboard navigation, split direction selection,
 * connection flow, error handling, and modal dismissal.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { SplitHostModal } from "../SplitHostModal";
import { useUiStore } from "../../../stores/ui-store";
import { useHostsStore } from "../../../stores/hosts-store";
import { useSessionStore } from "../../../stores/session-store";
import type { SavedHost } from "../../../types";

const mockHosts: SavedHost[] = [
  {
    id: "host-1",
    label: "Web Production",
    host: "web.example.com",
    port: 22,
    username: "deploy",
    auth_type: "password",
    group_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    key_path: null,
    color: "#3b82f6",
    notes: "frontend server",
    environment: "production",
    os_type: "linux",
    startup_command: null,
    proxy_jump: null,
    proxy_jump_host_id: null,
    start_directory: null,
    keep_alive_interval: null,
    default_shell: null,
    font_size: null,
    terminal_theme: null,
    last_connected_at: "2026-02-01T00:00:00Z",
    connection_count: 10,
  },
  {
    id: "host-2",
    label: "Database Staging",
    host: "db.stage.internal",
    port: 2222,
    username: "postgres",
    auth_type: "privateKey",
    group_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    key_path: "/Users/test/.ssh/id_rsa",
    color: "#22c55e",
    notes: "db server",
    environment: "staging",
    os_type: "linux",
    startup_command: null,
    proxy_jump: null,
    proxy_jump_host_id: null,
    start_directory: null,
    keep_alive_interval: null,
    default_shell: null,
    font_size: null,
    terminal_theme: null,
    last_connected_at: null,
    connection_count: 2,
  },
];

describe("SplitHostModal", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_hosts") return mockHosts;
      return undefined;
    });
    useHostsStore.setState({
      hosts: mockHosts,
      loading: false,
      error: null,
      recentConnections: [],
    });
    useSessionStore.setState({
      sessions: new Map([
        [
          "session-target",
          {
            id: "session-target",
            hostConfig: {
              host: "local.dev",
              port: 22,
              username: "dev",
              auth_method: { type: "password", password: "pwd" },
            },
            status: "Connected",
            label: "dev@local.dev",
          },
        ],
      ]),
      activeSessionId: "session-target",
      tabs: new Map([
        [
          "session-target",
          {
            layout: { type: "pane", sessionId: "session-target" },
            label: "dev@local.dev",
          },
        ],
      ]),
      activeTerminalTabId: "session-target",
      zoomedPaneId: null,
    });
    useUiStore.setState({
      splitModal: {
        open: false,
        targetSessionId: null,
        direction: "horizontal",
      },
    });
  });

  it("does not render when open is false", () => {
    render(<SplitHostModal />);
    expect(screen.queryByTestId("split-host-modal")).not.toBeInTheDocument();
  });

  it("renders with search input and saved hosts when open", () => {
    useUiStore.getState().openSplitModal("session-target", "horizontal");
    render(<SplitHostModal />);

    expect(screen.getByTestId("split-host-modal")).toBeInTheDocument();
    expect(screen.getByTestId("split-host-search")).toBeInTheDocument();
    expect(screen.getByText("Web Production")).toBeInTheDocument();
    expect(screen.getByText("Database Staging")).toBeInTheDocument();
  });

  it("filters hosts based on search query", () => {
    useUiStore.getState().openSplitModal("session-target", "horizontal");
    render(<SplitHostModal />);

    const searchInput = screen.getByTestId("split-host-search");
    fireEvent.change(searchInput, { target: { value: "database" } });

    expect(screen.queryByText("Web Production")).not.toBeInTheDocument();
    expect(screen.getByText("Database Staging")).toBeInTheDocument();
  });

  it("toggles split direction between horizontal and vertical", () => {
    useUiStore.getState().openSplitModal("session-target", "horizontal");
    render(<SplitHostModal />);

    const rightBtn = screen.getByTestId("split-host-dir-horizontal");
    const downBtn = screen.getByTestId("split-host-dir-vertical");

    expect(screen.getByText("Splitting Right")).toBeInTheDocument();

    fireEvent.click(downBtn);
    expect(screen.getByText("Splitting Down")).toBeInTheDocument();

    fireEvent.click(rightBtn);
    expect(screen.getByText("Splitting Right")).toBeInTheDocument();
  });

  it("connects and splits the session when a host is selected", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_hosts") return mockHosts;
      if (cmd === "connect_saved_host") return "new-split-session";
      return undefined;
    });

    useUiStore.getState().openSplitModal("session-target", "horizontal");
    render(<SplitHostModal />);

    const hostItem = screen.getByTestId("split-host-item-host-2");
    fireEvent.click(hostItem);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("connect_saved_host", expect.objectContaining({
        hostId: "host-2",
      }));
    });

    // Verify session store has the new split pane
    const sessionState = useSessionStore.getState();
    expect(sessionState.sessions.has("new-split-session")).toBe(true);
    expect(sessionState.sessions.get("new-split-session")?.hostConfig.host).toBe("db.stage.internal");
    expect(sessionState.activeSessionId).toBe("new-split-session");

    // Modal should close on success
    expect(useUiStore.getState().splitModal.open).toBe(false);
  });

  it("displays error message when connection fails", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "list_hosts") return mockHosts;
      if (cmd === "connect_saved_host") throw new Error("Authentication failed");
      return undefined;
    });

    useUiStore.getState().openSplitModal("session-target", "horizontal");
    render(<SplitHostModal />);

    const hostItem = screen.getByTestId("split-host-item-host-1");
    fireEvent.click(hostItem);

    await waitFor(() => {
      expect(screen.getByTestId("split-host-error")).toBeInTheDocument();
      expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    });

    // Modal should remain open to allow retry or selection of another host
    expect(useUiStore.getState().splitModal.open).toBe(true);
  });

  it("closes modal on Escape key", () => {
    useUiStore.getState().openSplitModal("session-target", "horizontal");
    render(<SplitHostModal />);

    const modal = screen.getByTestId("split-host-modal");
    fireEvent.keyDown(modal, { key: "Escape" });

    expect(useUiStore.getState().splitModal.open).toBe(false);
  });
});
