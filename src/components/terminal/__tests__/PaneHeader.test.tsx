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
import type { HostConfig } from "../../../types";

const dummyHost: HostConfig = {
  host: "10.0.0.1",
  port: 22,
  username: "alice",
  auth_method: { type: "password", password: "pwd" },
};

describe("PaneHeader linked explorer toggle", () => {
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
});
