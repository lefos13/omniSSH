import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { useLocalVaultStore } from "../../stores/local-vault-store";

describe("SettingsPage encrypted vault controls", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: () => ({ width: 0 }),
    } as unknown as CanvasRenderingContext2D);
    useLocalVaultStore.setState({
      configured: true,
      unlocked: true,
      loading: false,
      error: null,
      loadStatus: vi.fn().mockResolvedValue({ configured: true, unlocked: true }),
      lockVault: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes master password changes from Security & Vault settings", () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByTestId("settings-nav-security"));

    expect(screen.getByTestId("settings-vault-status")).toHaveTextContent("Unlocked");
    expect(screen.getByTestId("settings-vault-change-master-password")).toBeEnabled();
  });
});
