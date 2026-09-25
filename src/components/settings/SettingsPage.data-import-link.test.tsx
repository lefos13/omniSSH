import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { useTabStore, pageTabId } from "../../stores/tab-store";
import { useUiStore } from "../../stores/ui-store";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

/* The Data section must clarify that a backup restore and the Hosts-tab host
 * import are different flows, and the deeplink must park a one-shot request
 * for the (currently unmounted) Hosts dashboard before switching tabs. */
describe("Settings → Data hosts import deeplink", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: () => ({ width: 0 }),
    } as unknown as CanvasRenderingContext2D);
    invokeMock.mockReset().mockResolvedValue(undefined);
    useUiStore.setState({ pendingHostsImport: null });
    useTabStore.getState().openPageTab("settings", "Settings");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useUiStore.setState({ pendingHostsImport: null });
  });

  it("explains the difference between backup restore and host import", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-data"));

    expect(screen.getByText("Import hosts from another app")).toBeInTheDocument();
    expect(screen.getByText(/backup import above restores a complete OmniSSH backup/i)).toBeInTheDocument();
    expect(screen.getByText(/use the import flow on the Hosts tab/i)).toBeInTheDocument();
  });

  it("parks the import request and switches to the Hosts tab", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-data"));
    fireEvent.click(screen.getByTestId("s-open-hosts-import"));

    expect(useUiStore.getState().pendingHostsImport).toBe("connections");
    expect(useTabStore.getState().activeTabId).toBe(pageTabId("hosts"));
  });

  it("switching tabs does not trigger any backup or import command", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-data"));
    fireEvent.click(screen.getByTestId("s-open-hosts-import"));

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
