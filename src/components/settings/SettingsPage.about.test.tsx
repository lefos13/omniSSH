/*
 * Tests for the Support card on the About & Updates page.
 * Verifies both links are rendered and hand the exact URL to the opener plugin.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

const openUrlMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

describe("SettingsPage About support links", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: () => ({ width: 0 }),
    } as unknown as CanvasRenderingContext2D);
    openUrlMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the coffee and sponsor pages in the system browser", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-about"));

    fireEvent.click(screen.getByTestId("about-coffee"));
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://buymeacoffee.com/lefterisev2"));

    fireEvent.click(screen.getByTestId("about-sponsor"));
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("https://github.com/sponsors/lefos13"));
  });
});
