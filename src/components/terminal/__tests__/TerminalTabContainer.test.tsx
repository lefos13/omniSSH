/*
 * Component tests for TerminalTabContainer.
 * Tests container layout, conditional side panel rendering, and resize handle.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("../TerminalArea", () => ({
  TerminalArea: ({ tabId }: { tabId: string }) => (
    <div data-testid={`mock-terminal-area-${tabId}`}>Terminal Area</div>
  ),
}));
vi.mock("../LinkedExplorerPanel", () => ({
  LinkedExplorerPanel: ({ tabId }: { tabId: string }) => (
    <div data-testid={`mock-linked-explorer-${tabId}`}>Linked Explorer Panel</div>
  ),
}));

import { TerminalTabContainer } from "../TerminalTabContainer";
import { useLinkedExplorerStore } from "../../../stores/linked-explorer-store";

describe("TerminalTabContainer", () => {
  beforeEach(() => {
    useLinkedExplorerStore.setState({
      openTabIds: new Set(),
      panelWidth: 340,
      followPath: true,
      bindings: new Map(),
    });
  });

  it("renders only terminal area when linked explorer is closed", () => {
    render(
      <TerminalTabContainer
        tabId="tab-1"
        layout={{ type: "pane", sessionId: "ssh-1" }}
        isActive={true}
      />,
    );

    expect(screen.getByTestId("mock-terminal-area-tab-1")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-linked-explorer-tab-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("linked-explorer-resize-handle")).not.toBeInTheDocument();
  });

  it("renders terminal area, resize handle, and linked explorer when open", () => {
    useLinkedExplorerStore.setState({
      openTabIds: new Set(["tab-1"]),
    });

    render(
      <TerminalTabContainer
        tabId="tab-1"
        layout={{ type: "pane", sessionId: "ssh-1" }}
        isActive={true}
      />,
    );

    expect(screen.getByTestId("mock-terminal-area-tab-1")).toBeInTheDocument();
    expect(screen.getByTestId("mock-linked-explorer-tab-1")).toBeInTheDocument();
    expect(screen.getByTestId("linked-explorer-resize-handle")).toBeInTheDocument();
  });
});
