/*
 * Component tests for TerminalTabContainer.
 * Tests container layout, conditional side panel rendering, and keyboard/mouse resize handle.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

  it("renders terminal area, resize handle with separator semantics, and linked explorer when open", () => {
    useLinkedExplorerStore.setState({
      openTabIds: new Set(["tab-1"]),
      panelWidth: 360,
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

    const handle = screen.getByTestId("linked-explorer-resize-handle");
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute("role", "separator");
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-orientation", "vertical");
    expect(handle).toHaveAttribute("aria-valuenow", "360");
    expect(handle).toHaveAttribute("aria-valuemin", "220");
    expect(handle).toHaveAttribute("aria-valuemax", "800");
  });

  it("supports keyboard resizing via ArrowLeft and ArrowRight keys", () => {
    useLinkedExplorerStore.setState({
      openTabIds: new Set(["tab-1"]),
      panelWidth: 340,
    });

    render(
      <TerminalTabContainer
        tabId="tab-1"
        layout={{ type: "pane", sessionId: "ssh-1" }}
        isActive={true}
      />,
    );

    const handle = screen.getByTestId("linked-explorer-resize-handle");

    // ArrowLeft expands the right-docked panel by 20px
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useLinkedExplorerStore.getState().panelWidth).toBe(360);

    // ArrowRight shrinks the right-docked panel by 20px
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useLinkedExplorerStore.getState().panelWidth).toBe(340);

    // Home jumps to max width 800
    fireEvent.keyDown(handle, { key: "Home" });
    expect(useLinkedExplorerStore.getState().panelWidth).toBe(800);

    // End jumps to min width 220
    fireEvent.keyDown(handle, { key: "End" });
    expect(useLinkedExplorerStore.getState().panelWidth).toBe(220);
  });
});
