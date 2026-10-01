/*
 * Tests for Explorer section in SettingsPage.
 * Verifies default local folder display, dialog browse interaction,
 * and clear button functionality.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { useSettingsStore } from "../../stores/settings-store";

const invokeMock = vi.fn();
const openDialogMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialogMock(...args),
  save: vi.fn(),
}));

describe("SettingsPage Explorer default local folder setting", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: () => ({ width: 0 }),
    } as unknown as CanvasRenderingContext2D);
    invokeMock.mockReset().mockResolvedValue(undefined);
    openDialogMock.mockReset();
    useSettingsStore.setState({ explorerDefaultLocalDir: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders default local folder row with placeholder and disabled clear button", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-explorer"));

    expect(screen.getByText("Default local folder")).toBeInTheDocument();
    const input = screen.getByTestId("settings-default-local-dir");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Home folder");

    const clearBtn = screen.getByTestId("settings-default-local-dir-clear");
    expect(clearBtn).toBeDisabled();
  });

  it("Browse button opens folder dialog and sets default local folder", async () => {
    openDialogMock.mockResolvedValue("/Users/testuser/Documents/OmniSSH");

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-explorer"));

    const browseBtn = screen.getByTestId("settings-default-local-dir-browse");
    fireEvent.click(browseBtn);

    await waitFor(() => {
      expect(openDialogMock).toHaveBeenCalledWith({
        directory: true,
        multiple: false,
      });
      expect(useSettingsStore.getState().explorerDefaultLocalDir).toBe(
        "/Users/testuser/Documents/OmniSSH",
      );
    });

    const input = screen.getByTestId("settings-default-local-dir");
    expect(input).toHaveValue("/Users/testuser/Documents/OmniSSH");

    const clearBtn = screen.getByTestId("settings-default-local-dir-clear");
    expect(clearBtn).toBeEnabled();
  });

  it("Clear button empties the configured default folder", () => {
    useSettingsStore.setState({ explorerDefaultLocalDir: "/Users/testuser/CustomFolder" });

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-explorer"));

    const input = screen.getByTestId("settings-default-local-dir");
    expect(input).toHaveValue("/Users/testuser/CustomFolder");

    const clearBtn = screen.getByTestId("settings-default-local-dir-clear");
    expect(clearBtn).toBeEnabled();

    fireEvent.click(clearBtn);

    expect(useSettingsStore.getState().explorerDefaultLocalDir).toBe("");
    expect(input).toHaveValue("");
    expect(clearBtn).toBeDisabled();
  });
});
