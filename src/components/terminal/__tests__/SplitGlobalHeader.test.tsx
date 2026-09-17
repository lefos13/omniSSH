/*
 * Component tests for SplitGlobalHeader.
 * Verifies that the global split header displays session count and label,
 * provides the centralized parallel sync toggle and linked explorer toggle,
 * updates aria attributes on toggle, and shows the synced badge.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { SplitGlobalHeader } from "../SplitGlobalHeader";
import { useSessionStore } from "../../../stores/session-store";
import { useLinkedExplorerStore } from "../../../stores/linked-explorer-store";
import type { HostConfig, LayoutNode } from "../../../types";

const dummyHost1: HostConfig = {
  host: "10.0.0.1",
  port: 22,
  username: "alice",
  auth_method: { type: "password", password: "pwd" },
  label: "web-prod",
};

const dummyHost2: HostConfig = {
  host: "10.0.0.2",
  port: 22,
  username: "bob",
  auth_method: { type: "password", password: "pwd" },
  label: "db-prod",
};

const splitLayout: LayoutNode = {
  type: "split",
  direction: "horizontal",
  ratio: 0.5,
  children: [
    { type: "pane", sessionId: "ssh-1" },
    { type: "pane", sessionId: "ssh-2" },
  ],
};

describe("SplitGlobalHeader", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: new Map([
        ["ssh-1", { id: "ssh-1", hostConfig: dummyHost1, status: "Connected", label: "web-prod" }],
        ["ssh-2", { id: "ssh-2", hostConfig: dummyHost2, status: "Connected", label: "db-prod" }],
      ]),
      activeSessionId: "ssh-1",
      tabs: new Map([
        [
          "tab-1",
          {
            layout: splitLayout,
            label: "web-prod | db-prod",
          },
        ],
      ]),
      activeTerminalTabId: "tab-1",
      zoomedPaneId: null,
      syncedTabIds: new Set(),
    });

    useLinkedExplorerStore.setState({
      openTabIds: new Set(),
      panelWidth: 340,
      followPath: true,
      bindings: new Map(),
    });
  });

  it("renders global header with split sessions count and aggregated label", () => {
    render(<SplitGlobalHeader tabId="tab-1" layout={splitLayout} />);

    expect(screen.getByTestId("split-global-header")).toBeInTheDocument();
    expect(screen.getByText(/Split Sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/\(2\) · web-prod \| db-prod/i)).toBeInTheDocument();
  });

  it("toggles input synchronization on clicking the Link Input CTA", () => {
    const { rerender } = render(<SplitGlobalHeader tabId="tab-1" layout={splitLayout} />);

    const syncBtn = screen.getByTestId("pane-sync-toggle");
    expect(syncBtn).toBeInTheDocument();
    expect(syncBtn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Link Input")).toBeInTheDocument();
    expect(screen.queryByTestId("split-synced-badge")).not.toBeInTheDocument();

    // Toggle sync on
    fireEvent.click(syncBtn);
    expect(useSessionStore.getState().isTabSynced("tab-1")).toBe(true);

    rerender(<SplitGlobalHeader tabId="tab-1" layout={splitLayout} />);
    expect(screen.getByTestId("pane-sync-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Linked")).toBeInTheDocument();
    expect(screen.getByTestId("split-synced-badge")).toBeInTheDocument();

    // Toggle sync off
    fireEvent.click(screen.getByTestId("pane-sync-toggle"));
    expect(useSessionStore.getState().isTabSynced("tab-1")).toBe(false);

    rerender(<SplitGlobalHeader tabId="tab-1" layout={splitLayout} />);
    expect(screen.getByTestId("pane-sync-toggle")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("split-synced-badge")).not.toBeInTheDocument();
  });

  it("toggles linked explorer on clicking the Explorer CTA", () => {
    render(<SplitGlobalHeader tabId="tab-1" layout={splitLayout} />);

    const explorerBtn = screen.getByTestId("pane-linked-explorer-toggle");
    expect(explorerBtn).toBeInTheDocument();
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(false);

    fireEvent.click(explorerBtn);
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(true);

    fireEvent.click(explorerBtn);
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(false);
  });
});
