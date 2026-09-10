import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RevealPasswordDialog } from "./RevealPasswordDialog";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("RevealPasswordDialog", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("prompts for master password and reveals password masked by default", async () => {
    invoke.mockResolvedValue("unmasked-secret-ssh-pwd");

    render(
      <RevealPasswordDialog
        open
        onClose={() => {}}
        hostId="host-1"
        hostLabel="Production Web"
        storage="localVault"
      />
    );

    expect(screen.getByText(/Enter master password to reveal the password for Production Web/)).toBeInTheDocument();
    const input = screen.getByTestId("reveal-password-master-input");
    const submit = screen.getByTestId("reveal-password-submit");

    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "my-master-password" } });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("local_vault_reveal_password", {
        hostId: "host-1",
        masterPassword: "my-master-password",
      });
    });

    // Password is revealed but MASKED by default with bullets
    const valueEl = await screen.findByTestId("reveal-password-value");
    expect(valueEl).toHaveTextContent("••••••••");
    expect(valueEl).not.toHaveTextContent("unmasked-secret-ssh-pwd");

    // Clicking toggle mask reveals the plaintext
    const toggle = screen.getByTestId("reveal-password-toggle-mask");
    fireEvent.click(toggle);
    expect(valueEl).toHaveTextContent("unmasked-secret-ssh-pwd");

    // Copying writes to clipboard
    const copyBtn = screen.getByTestId("reveal-password-copy");
    fireEvent.click(copyBtn);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("unmasked-secret-ssh-pwd");
  });

  it("surfaces incorrect master password error inline", async () => {
    invoke.mockRejectedValue({ message: "Incorrect master password" });

    render(
      <RevealPasswordDialog
        open
        onClose={() => {}}
        hostId="host-1"
        hostLabel="Production Web"
        storage="localVault"
      />
    );

    const input = screen.getByTestId("reveal-password-master-input");
    fireEvent.change(input, { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByTestId("reveal-password-submit"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Incorrect master password");
  });

  it("explains keychain boundary and allows migration to App Vault", async () => {
    invoke.mockResolvedValue(undefined);
    const onMigrated = vi.fn();

    render(
      <RevealPasswordDialog
        open
        onClose={() => {}}
        hostId="host-keychain"
        hostLabel="Keychain Host"
        storage="keychain"
        onMigratedToVault={onMigrated}
      />
    );

    expect(screen.getByText(/Protected by System Keychain/)).toBeInTheDocument();
    expect(screen.getByText(/password revelation is only available for passwords stored in the Encrypted App Vault/)).toBeInTheDocument();

    const migrateBtn = screen.getByTestId("reveal-password-migrate-submit");
    fireEvent.click(migrateBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("local_vault_migrate_host_password", {
        hostId: "host-keychain",
      });
    });
    expect(onMigrated).toHaveBeenCalled();

    // After migration, dialog switches to master password entry
    expect(await screen.findByTestId("reveal-password-master-input")).toBeInTheDocument();
  });
});
