import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { useUiStore } from "../../stores/ui-store";
import { useTabStore } from "../../stores/tab-store";
import { useTransferStore } from "../../stores/transfer-store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("Sidebar component", () => {
  beforeEach(() => {
    useUiStore.setState({ sidebarExpanded: false });
    useTabStore.setState({ tabs: new Map(), activeTabId: null, tabOrder: [] });
    useTransferStore.setState({ transfers: new Map(), popoverOpen: false });
  });

  it("renders collapsed sidebar with elevated stacking z-index", () => {
    render(<Sidebar />);
    const nav = screen.getByTestId("sidebar");
    expect(nav).toHaveAttribute("data-sidebar-expanded", "false");
    expect(nav.className).toContain("relative");
    expect(nav.className).toContain("z-40");
  });

  it("shows hover label tooltip when hovering buttons in collapsed state", () => {
    render(<Sidebar />);

    // In collapsed mode, the tooltip is not visible initially
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    const hostsButton = screen.getByRole("button", { name: "Hosts" });
    fireEvent.mouseEnter(hostsButton);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent("Hosts");
    expect(tooltip.className).toContain("z-50");

    fireEvent.mouseLeave(hostsButton);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("does not render hover tooltip when expanded", () => {
    useUiStore.setState({ sidebarExpanded: true });
    render(<Sidebar />);

    const nav = screen.getByTestId("sidebar");
    expect(nav).toHaveAttribute("data-sidebar-expanded", "true");

    const tunnelsButton = screen.getByRole("button", { name: "Tunnels" });
    fireEvent.mouseEnter(tunnelsButton);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
