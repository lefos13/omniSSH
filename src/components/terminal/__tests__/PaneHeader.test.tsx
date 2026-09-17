/*
 * Component tests for PaneHeader linked explorer toggle.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { PaneHeader } from "../PaneHeader";
import { useSessionStore } from "../../../stores/session-store";
import { useLinkedExplorerStore } from "../../../stores/linked-explorer-store";
import { useUiStore } from "../../../stores/ui-store";
import type { HostConfig } from "../../../types";

const dummyHost: HostConfig = {
  host: "10.0.0.1",
  port: 22,
  username: "alice",
  auth_method: { type: "password", password: "pwd" },
};

describe("PaneHeader linked explorer and split controls", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: new Map([
        [
          "ssh-1",
          {
            id: "ssh-1",
            hostConfig: dummyHost,
            status: "Connected",
            label: "alice@10.0.0.1",
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
      openTabIds: new Set(),
      panelWidth: 340,
      followPath: true,
      bindings: new Map(),
    });

    useUiStore.setState({
      splitModal: {
        open: false,
        targetSessionId: null,
        direction: "horizontal",
      },
    });
  });

  it("renders linked explorer toggle button with proper label", () => {
    render(<PaneHeader sessionId="ssh-1" tabId="tab-1" />);

    const toggleBtn = screen.getByTestId("pane-linked-explorer-toggle");
    expect(toggleBtn).toBeInTheDocument();
    expect(toggleBtn).toHaveAttribute("aria-label", "Open file explorer");
  });

  it("toggles linked explorer state in store on click", () => {
    render(<PaneHeader sessionId="ssh-1" tabId="tab-1" />);

    const toggleBtn = screen.getByTestId("pane-linked-explorer-toggle");
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(false);

    fireEvent.click(toggleBtn);
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(true);

    fireEvent.click(toggleBtn);
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(false);
  });

  it("opens split host modal when clicking pane-split-with-host button", () => {
    render(<PaneHeader sessionId="ssh-1" tabId="tab-1" />);

    const splitHostBtn = screen.getByTestId("pane-split-with-host");
    expect(splitHostBtn).toBeInTheDocument();

    fireEvent.click(splitHostBtn);
    const modalState = useUiStore.getState().splitModal;
    expect(modalState.open).toBe(true);
    expect(modalState.targetSessionId).toBe("ssh-1");
    expect(modalState.direction).toBe("horizontal");
  });

  it("opens split host modal when alt-clicking horizontal or vertical split buttons", () => {
    render(<PaneHeader sessionId="ssh-1" tabId="tab-1" />);

    const splitRightBtn = screen.getByTestId("pane-split-horizontal");
    fireEvent.click(splitRightBtn, { altKey: true });

    let modalState = useUiStore.getState().splitModal;
    expect(modalState.open).toBe(true);
    expect(modalState.targetSessionId).toBe("ssh-1");
    expect(modalState.direction).toBe("horizontal");

    useUiStore.getState().closeSplitModal();

    const splitDownBtn = screen.getByTestId("pane-split-vertical");
    fireEvent.click(splitDownBtn, { altKey: true });

    modalState = useUiStore.getState().splitModal;
    expect(modalState.open).toBe(true);
    expect(modalState.targetSessionId).toBe("ssh-1");
    expect(modalState.direction).toBe("vertical");
  });

  it("does not show sync toggle button on single-pane tabs", () => {
    render(<PaneHeader sessionId="ssh-1" tabId="tab-1" />);

    expect(screen.queryByTestId("pane-sync-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pane-synced-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("pane-linked-explorer-toggle")).toBeInTheDocument();
  });

  it("omits duplicate tab-level CTAs (explorer toggle and sync toggle) on split panes", () => {
    // Add second pane to create a split
    useSessionStore.setState((s) => ({
      sessions: new Map([
        ...s.sessions,
        ["ssh-2", { id: "ssh-2", hostConfig: dummyHost, status: "Connected", label: "alice@10.0.0.1" }],
      ]),
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
            label: "alice@10.0.0.1",
          },
        ],
      ]),
    }));

    const { rerender } = render(<PaneHeader sessionId="ssh-1" tabId="tab-1" />);

    // In split mode, the tab-level CTAs are omitted from individual pane headers
    expect(screen.queryByTestId("pane-linked-explorer-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pane-sync-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pane-synced-badge")).not.toBeInTheDocument();

    // Still retains pane-specific split buttons
    expect(screen.getByTestId("pane-split-horizontal")).toBeInTheDocument();
    expect(screen.getByTestId("pane-split-vertical")).toBeInTheDocument();
    expect(screen.getByTestId("pane-split-with-host")).toBeInTheDocument();

    // When synced, displays the synced badge on the pane header
    useSessionStore.getState().toggleSyncPanes("tab-1");
    rerender(<PaneHeader sessionId="ssh-1" tabId="tab-1" />);

    expect(screen.getByTestId("pane-synced-badge")).toBeInTheDocument();
  });
});
