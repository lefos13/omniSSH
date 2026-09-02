import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { useLocalVaultStore } from "../../stores/local-vault-store";

const invokeMock = vi.fn();
const saveMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
  open: vi.fn(),
}));

describe("SettingsPage backup preflight and export credential selection", () => {
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

    invokeMock.mockReset();
    saveMock.mockReset();

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_preflight") {
        return Promise.resolve({
          keychainHostCandidates: 3,
          localVaultHosts: 2,
          s3Candidates: 1,
        });
      }
      if (cmd === "backup_export") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    saveMock.mockResolvedValue("/tmp/test-backup.ascpbak");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes backup_preflight, renders counts, and shows macOS keychain warning", async () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByTestId("settings-nav-data"));
    fireEvent.click(screen.getByTestId("s-export-backup"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("backup_preflight");
    });

    // Check preflight summary and warning
    expect(await screen.findByTestId("backup-include-credentials")).toBeChecked();
    expect(screen.getByTestId("backup-skip-credentials")).not.toBeChecked();

    // Warning text indicates up to 4 potential keychain prompts (3 hosts + 1 s3)
    expect(screen.getByText(/macOS may request Keychain access up to 4 times/i)).toBeInTheDocument();
    expect(screen.getByText(/3 host candidates/i)).toBeInTheDocument();
    expect(screen.getByText(/1 S3 candidate/i)).toBeInTheDocument();
  });

  it("allows switching to skip System Keychain credentials and removes keychain warning", async () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByTestId("settings-nav-data"));
    fireEvent.click(screen.getByTestId("s-export-backup"));

    const skipRadio = await screen.findByTestId("backup-skip-credentials");
    fireEvent.click(skipRadio);

    expect(skipRadio).toBeChecked();
    expect(screen.getByTestId("backup-include-credentials")).not.toBeChecked();

    // Warning for keychain prompts should no longer be present
    expect(screen.queryByText(/macOS may request Keychain access/i)).not.toBeInTheDocument();
    // Explanation about App Vault protection should be visible
    expect(screen.getByText(/Encrypted App Vault credentials/i)).toBeInTheDocument();
    expect(screen.getByText(/Includes 2 App Vault hosts/i)).toBeInTheDocument();
  });

  it("submits backup_export with includeCredentials: false when skipped", async () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByTestId("settings-nav-data"));
    fireEvent.click(screen.getByTestId("s-export-backup"));

    const skipRadio = await screen.findByTestId("backup-skip-credentials");
    fireEvent.click(skipRadio);

    const pwInput = screen.getByTestId("backup-password");
    const confirmInput = screen.getByTestId("backup-password-confirm");

    fireEvent.change(pwInput, { target: { value: "strongpassword123" } });
    fireEvent.change(confirmInput, { target: { value: "strongpassword123" } });

    const submitBtn = screen.getByTestId("backup-submit");
    expect(submitBtn).toBeEnabled();

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("backup_export", {
        password: "strongpassword123",
        path: "/tmp/test-backup.ascpbak",
        includeCredentials: false,
      });
    });
  });

  it("submits backup_export with includeCredentials: true by default", async () => {
    render(<SettingsPage />);

    fireEvent.click(screen.getByTestId("settings-nav-data"));
    fireEvent.click(screen.getByTestId("s-export-backup"));

    await screen.findByTestId("backup-include-credentials");

    const pwInput = screen.getByTestId("backup-password");
    const confirmInput = screen.getByTestId("backup-password-confirm");

    fireEvent.change(pwInput, { target: { value: "strongpassword123" } });
    fireEvent.change(confirmInput, { target: { value: "strongpassword123" } });

    const submitBtn = screen.getByTestId("backup-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("backup_export", {
        password: "strongpassword123",
        path: "/tmp/test-backup.ascpbak",
        includeCredentials: true,
      });
    });
  });

  it("gracefully falls back when backup_preflight fails without blocking export", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "backup_preflight") {
        return Promise.reject(new Error("Preflight DB lock error"));
      }
      if (cmd === "backup_export") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    render(<SettingsPage />);

    fireEvent.click(screen.getByTestId("settings-nav-data"));
    fireEvent.click(screen.getByTestId("s-export-backup"));

    expect(await screen.findByTestId("backup-include-credentials")).toBeInTheDocument();
    expect(screen.getByText("Couldn’t inspect credential counts.")).toBeInTheDocument();
    expect(screen.queryByText("Preflight DB lock error")).not.toBeInTheDocument();

    const pwInput = screen.getByTestId("backup-password");
    const confirmInput = screen.getByTestId("backup-password-confirm");

    fireEvent.change(pwInput, { target: { value: "strongpassword123" } });
    fireEvent.change(confirmInput, { target: { value: "strongpassword123" } });

    const submitBtn = screen.getByTestId("backup-submit");
    expect(submitBtn).toBeEnabled();
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("backup_export", {
        password: "strongpassword123",
        path: "/tmp/test-backup.ascpbak",
        includeCredentials: true,
      });
    });
  });
});
