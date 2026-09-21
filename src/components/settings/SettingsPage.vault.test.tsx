import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { useLocalVaultStore } from "../../stores/local-vault-store";
import { useSettingsStore } from "../../stores/settings-store";

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
    useSettingsStore.setState({ defaultCredentialStorage: "keychain" });
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

  it("offers to create the vault when none is set up", () => {
    useLocalVaultStore.setState({
      configured: false,
      unlocked: false,
      loading: false,
      error: null,
      loadStatus: vi.fn().mockResolvedValue({ configured: false, unlocked: false }),
    });
    render(<SettingsPage />);

    fireEvent.click(screen.getByTestId("settings-nav-security"));

    // The panel used to only point at the host editor; it now creates it here.
    fireEvent.click(screen.getByTestId("settings-vault-create"));
    expect(screen.getByTestId("create-vault-dialog")).toBeInTheDocument();
  });

  it("offers the App Vault as the default storage right after creating it", async () => {
    useLocalVaultStore.setState({
      configured: false,
      unlocked: false,
      loading: false,
      error: null,
      loadStatus: vi.fn().mockResolvedValue({ configured: false, unlocked: false }),
      setupVault: vi.fn().mockImplementation(async () => {
        useLocalVaultStore.setState({ configured: true, unlocked: true, loading: false });
      }),
    });
    render(<SettingsPage />);

    fireEvent.click(screen.getByTestId("settings-nav-security"));
    fireEvent.click(screen.getByTestId("settings-vault-create"));
    fireEvent.change(screen.getByTestId("local-vault-master-password"), {
      target: { value: "master-password-123" },
    });
    fireEvent.change(screen.getByTestId("local-vault-confirm-password"), {
      target: { value: "master-password-123" },
    });
    fireEvent.click(screen.getByTestId("local-vault-submit"));

    const prompt = await screen.findByTestId("vault-default-storage-dialog");
    expect(prompt).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("vault-default-storage-accept"));
    expect(useSettingsStore.getState().defaultCredentialStorage).toBe("localVault");
  });
});
