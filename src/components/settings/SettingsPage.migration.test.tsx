import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { useLocalVaultStore } from "../../stores/local-vault-store";
import { toast } from "../../stores/toast-store";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

describe("SettingsPage bulk credential migration to App Vault", () => {
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
      unlockVault: vi.fn().mockResolvedValue(undefined),
    });

    invokeMock.mockReset();
    vi.spyOn(toast, "success");
    vi.spyOn(toast, "error");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders migration card with correct count and details when migratable > 0", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_vault_migration_preflight") {
        return Promise.resolve({
          migratable: 3,
          alreadyInVault: 2,
          nonMigratable: 1,
        });
      }
      return Promise.resolve();
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-security"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("local_vault_migration_preflight");
    });

    const countLine = await screen.findByTestId("settings-vault-migrate-count");
    expect(countLine).toHaveTextContent("3 credentials on System Keychain · 2 already in App Vault.");
    expect(countLine).toHaveTextContent("1 host uses SSH keys and can’t be moved to the App Vault yet.");

    expect(screen.getByText(/Migrate Credentials to App Vault/i)).toBeInTheDocument();
    expect(screen.getByText(/macOS may request Keychain access once to authorize reading your credentials/i)).toBeInTheDocument();
    expect(screen.getByTestId("settings-vault-migrate")).toBeEnabled();
  });

  it("hides migration card and shows positive status row when migratable === 0 and alreadyInVault > 0", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_vault_migration_preflight") {
        return Promise.resolve({
          migratable: 0,
          alreadyInVault: 4,
          nonMigratable: 0,
        });
      }
      return Promise.resolve();
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-security"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("local_vault_migration_preflight");
    });

    expect(screen.queryByTestId("settings-vault-migrate")).not.toBeInTheDocument();
    const statusRow = await screen.findByTestId("settings-vault-migration-status");
    expect(statusRow).toHaveTextContent("All eligible credentials are stored in the App Vault.");
  });

  it("hides both migration card and status row when migratable === 0 and alreadyInVault === 0", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_vault_migration_preflight") {
        return Promise.resolve({
          migratable: 0,
          alreadyInVault: 0,
          nonMigratable: 0,
        });
      }
      return Promise.resolve();
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-security"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("local_vault_migration_preflight");
    });

    expect(screen.queryByTestId("settings-vault-migrate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-vault-migration-status")).not.toBeInTheDocument();
  });

  it("invokes migration command on click when unlocked, toasts success, and refreshes preflight", async () => {
    let preflightCalls = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_vault_migration_preflight") {
        preflightCalls += 1;
        if (preflightCalls === 1) {
          return Promise.resolve({
            migratable: 2,
            alreadyInVault: 1,
            nonMigratable: 0,
          });
        }
        return Promise.resolve({
          migratable: 0,
          alreadyInVault: 3,
          nonMigratable: 0,
        });
      }
      if (cmd === "local_vault_migrate_all_from_keychain") {
        return Promise.resolve({
          migrated: 2,
          skipped: 0,
          failed: [],
        });
      }
      return Promise.resolve();
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-security"));

    const migrateBtn = await screen.findByTestId("settings-vault-migrate");
    fireEvent.click(migrateBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("local_vault_migrate_all_from_keychain");
    });

    expect(toast.success).toHaveBeenCalledWith("Migrated 2 credentials to App Vault.");
    expect(await screen.findByTestId("settings-vault-migration-status")).toHaveTextContent(
      "All eligible credentials are stored in the App Vault."
    );
  });

  it("mentions skipped count in success toast when skipped > 0", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_vault_migration_preflight") {
        return Promise.resolve({
          migratable: 2,
          alreadyInVault: 0,
          nonMigratable: 0,
        });
      }
      if (cmd === "local_vault_migrate_all_from_keychain") {
        return Promise.resolve({
          migrated: 1,
          skipped: 1,
          failed: [],
        });
      }
      return Promise.resolve();
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-security"));

    const migrateBtn = await screen.findByTestId("settings-vault-migrate");
    fireEvent.click(migrateBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("local_vault_migrate_all_from_keychain");
    });

    expect(toast.success).toHaveBeenCalledWith(
      "Migrated 1 credential to App Vault (skipped 1 without keychain entries)."
    );
  });

  it("opens UnlockVaultDialog when vault is locked and runs migration upon successful unlock", async () => {
    const unlockVaultMock = vi.fn().mockResolvedValue(undefined);
    useLocalVaultStore.setState({
      configured: true,
      unlocked: false,
      loading: false,
      error: null,
      loadStatus: vi.fn().mockResolvedValue({ configured: true, unlocked: false }),
      lockVault: vi.fn().mockResolvedValue(undefined),
      unlockVault: unlockVaultMock,
    });

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_vault_migration_preflight") {
        return Promise.resolve({
          migratable: 2,
          alreadyInVault: 1,
          nonMigratable: 0,
        });
      }
      if (cmd === "local_vault_migrate_all_from_keychain") {
        return Promise.resolve({
          migrated: 2,
          skipped: 0,
          failed: [],
        });
      }
      return Promise.resolve();
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-security"));

    const migrateBtn = await screen.findByTestId("settings-vault-migrate");
    fireEvent.click(migrateBtn);

    // Migration IPC command should NOT be called yet
    expect(invokeMock).not.toHaveBeenCalledWith("local_vault_migrate_all_from_keychain");

    // Unlock dialog should be open
    expect(screen.getByTestId("local-vault-unlock-dialog")).toBeInTheDocument();

    // Fill in password and submit
    fireEvent.change(screen.getByTestId("local-vault-unlock-password"), {
      target: { value: "master-password-123" },
    });
    fireEvent.click(screen.getByTestId("local-vault-unlock-submit"));

    await waitFor(() => {
      expect(unlockVaultMock).toHaveBeenCalledWith("master-password-123");
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("local_vault_migrate_all_from_keychain");
    });

    expect(toast.success).toHaveBeenCalledWith("Migrated 2 credentials to App Vault.");
  });

  it("surfaces partial migration failure with host labels in error toast", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_vault_migration_preflight") {
        return Promise.resolve({
          migratable: 3,
          alreadyInVault: 0,
          nonMigratable: 0,
        });
      }
      if (cmd === "local_vault_migrate_all_from_keychain") {
        return Promise.resolve({
          migrated: 1,
          skipped: 0,
          failed: [
            { hostId: "h1", hostLabel: "prod-db", error: "OS keychain error" },
            { hostId: "h2", hostLabel: "staging-redis", error: "Item not found" },
          ],
        });
      }
      return Promise.resolve();
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-security"));

    const migrateBtn = await screen.findByTestId("settings-vault-migrate");
    fireEvent.click(migrateBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("local_vault_migrate_all_from_keychain");
    });

    expect(toast.error).toHaveBeenCalledWith(
      "Migrated 1 of 3 credentials. Failed: prod-db, staging-redis."
    );
  });

  it("surfaces hard failure in error toast when migration invoke rejects", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "local_vault_migration_preflight") {
        return Promise.resolve({
          migratable: 2,
          alreadyInVault: 0,
          nonMigratable: 0,
        });
      }
      if (cmd === "local_vault_migrate_all_from_keychain") {
        return Promise.reject(new Error("Keychain authorization denied"));
      }
      return Promise.resolve();
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-security"));

    const migrateBtn = await screen.findByTestId("settings-vault-migrate");
    fireEvent.click(migrateBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("local_vault_migrate_all_from_keychain");
    });

    expect(toast.error).toHaveBeenCalledWith("Keychain authorization denied");
  });
});
