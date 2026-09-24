/* Unit tests for PasswordFileImport component.
 *
 * Covers file browsing with text filter, preview parsing, status/storage badges,
 * keyAuth row exclusion, bulk selection helpers, overwrite confirmation gating,
 * vault guard interaction, save execution with exact host IDs, error and success
 * reporting, delete hint, and keyboard Tab order. */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordFileImport } from "./PasswordFileImport";
import { useLocalVaultStore } from "../../stores/local-vault-store";

const { invoke, dialogOpen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  dialogOpen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpen(...args),
}));

describe("PasswordFileImport", () => {
  const passwordPreview = {
    matches: [
      { host_id: "h-new", host_label: "Alpha", username: "root", host: "alpha.example", port: 22, storage: "keychain", status: "new" },
      { host_id: "h-replace", host_label: "Bravo", username: "root", host: "bravo.example", port: 2222, storage: "localVault", status: "replaces" },
      { host_id: "h-key", host_label: "Charlie", username: "root", host: "charlie.example", port: 22, storage: "keychain", status: "keyAuth" },
    ],
    unmatched_entries: 2,
    conflicts: 1,
    malformed_lines: 1,
  };

  beforeEach(() => {
    useLocalVaultStore.setState({
      loadStatus: vi.fn().mockResolvedValue({ configured: true, unlocked: true }),
      unlockVault: vi.fn().mockResolvedValue(undefined),
    });
    invoke.mockReset();
    dialogOpen.mockReset();
    dialogOpen.mockResolvedValue("/tmp/passwords.txt");
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_preview_password_file") return passwordPreview;
      if (command === "import_save_password_file") {
        return { stored_in_keychain: 1, stored_in_vault: 0, skipped: 0, failed: [] };
      }
      return undefined;
    });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("previews the chosen file through the txt-filtered dialog", async () => {
    render(<PasswordFileImport heading={<p>Step 2</p>} description={<p>Choose file</p>} />);

    expect(screen.getByText("Step 2")).toBeInTheDocument();
    expect(screen.getByText("Choose file")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("password-file-import-browse"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_preview_password_file",
      { path: "/tmp/passwords.txt" },
    ));
    expect(dialogOpen).toHaveBeenLastCalledWith({
      title: "Select password file",
      multiple: false,
      filters: [{ name: "Text files", extensions: ["txt"] }],
    });
    expect(screen.getByTestId("password-file-import-card")).toBeInTheDocument();
  });

  it("renders storage and status badges plus the skipped-entry counts", async () => {
    render(<PasswordFileImport />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));

    const replacesRow = await screen.findByTestId("password-file-import-row-h-replace");
    expect(screen.getByTestId("password-file-import-preview")).toHaveTextContent("Bravo");
    expect(replacesRow).toHaveTextContent("Bravo");
    expect(replacesRow).toHaveTextContent("root@bravo.example:2222");
    expect(replacesRow).toHaveTextContent("App Vault");
    expect(replacesRow).toHaveTextContent("replaces saved password");

    const newRow = screen.getByTestId("password-file-import-row-h-new");
    expect(newRow).toHaveTextContent("Keychain");
    expect(newRow).not.toHaveTextContent("replaces saved password");

    expect(screen.getByTestId("password-file-import-counts")).toHaveTextContent(
      "2 entries matched no saved host · 1 conflicting entry skipped · 1 unreadable line",
    );
  });

  it("keeps key-auth rows unticked and disabled while others start ticked", async () => {
    render(<PasswordFileImport />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));

    await screen.findByTestId("password-file-import-row-h-key");
    const keyRow = screen.getByTestId("password-file-import-row-h-key");
    expect(keyRow).toHaveTextContent("key login");
    expect(screen.getByLabelText("Include Charlie")).toBeDisabled();
    expect(screen.getByLabelText("Include Charlie")).not.toBeChecked();
    expect(screen.getByLabelText("Include Alpha")).toBeChecked();
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
  });

  it("tracks untick, All, and None against selectable rows only", async () => {
    render(<PasswordFileImport />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));
    await screen.findByTestId("password-file-import-row-h-new");

    fireEvent.click(screen.getByLabelText("Include Alpha"));
    expect(screen.getByText("1 of 2 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("password-file-import-none"));
    expect(screen.getByText("0 of 2 selected")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("password-file-import-all"));
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();
    expect(screen.getByLabelText("Include Charlie")).not.toBeChecked();
  });

  it("reports a file that matches no saved host", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_preview_password_file") {
        return { matches: [], unmatched_entries: 3, conflicts: 0, malformed_lines: 0 };
      }
      return undefined;
    });
    render(<PasswordFileImport emptyMessage="Custom empty message" />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));

    expect(await screen.findByTestId("password-file-import-empty")).toHaveTextContent(
      "Custom empty message",
    );
    expect(screen.queryByTestId("password-file-import-row-h-new")).not.toBeInTheDocument();
  });

  it("surfaces a read failure in an alert", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_preview_password_file") {
        throw { kind: "io_error", message: "Password file is too large" };
      }
      return undefined;
    });
    render(<PasswordFileImport />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Password file is too large");
  });

  it("saves exactly the ticked hosts and reports what was stored", async () => {
    const onSaved = vi.fn();
    render(<PasswordFileImport onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));
    await screen.findByTestId("password-file-import-row-h-new");

    /* Untick the replacing App Vault row, so the Keychain row is all that is
     * left to write and no acknowledgement is required. */
    fireEvent.click(screen.getByLabelText("Include Bravo"));
    expect(screen.queryByTestId("password-file-import-confirm")).not.toBeInTheDocument();

    invoke.mockImplementation(async (command: string) => {
      if (command === "import_save_password_file") {
        return {
          stored_in_keychain: 1,
          stored_in_vault: 0,
          skipped: 1,
          failed: [{ host_id: "h-failed", host_label: "Delta", error: "Keychain error: denied" }],
        };
      }
      return undefined;
    });

    fireEvent.click(screen.getByTestId("password-file-import-save"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_save_password_file",
      { path: "/tmp/passwords.txt", hostIds: ["h-new"] },
    ));
    const summary = await screen.findByTestId("password-file-import-result");
    expect(summary).toHaveFocus();
    expect(summary).toHaveTextContent("1 password saved: 1 to Keychain");
    expect(summary).toHaveTextContent("1 skipped");
    expect(summary).toHaveTextContent("Delta: Keychain error: denied");
    expect(screen.getByTestId("password-file-import-delete-hint")).toHaveTextContent(
      "Your password file is plaintext. Delete it now that the passwords are stored.",
    );
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({
      stored_in_keychain: 1,
    }));
  });

  it("reports the App Vault share of a mixed save", async () => {
    render(<PasswordFileImport />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));
    await screen.findByTestId("password-file-import-row-h-replace");

    fireEvent.click(screen.getByTestId("password-file-import-confirm"));
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_save_password_file") {
        return { stored_in_keychain: 1, stored_in_vault: 1, skipped: 0, failed: [] };
      }
      return undefined;
    });
    fireEvent.click(screen.getByTestId("password-file-import-save"));

    const summary = await screen.findByTestId("password-file-import-result");
    expect(summary).toHaveTextContent("2 passwords saved: 1 to App Vault, 1 to Keychain");
    expect(screen.getByTestId("password-file-import-delete-hint")).toBeInTheDocument();
  });

  it("asks the vault guard only while a vault row is ticked, and keeps the preview when cancelled", async () => {
    const loadStatus = vi.fn().mockResolvedValue({ configured: true, unlocked: false });
    useLocalVaultStore.setState({ loadStatus });

    render(<PasswordFileImport />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));
    await screen.findByTestId("password-file-import-row-h-replace");
    fireEvent.click(screen.getByTestId("password-file-import-confirm"));

    /* Bravo targets the App Vault, so the vault must be unlocked first. */
    fireEvent.click(screen.getByTestId("password-file-import-save"));
    expect(await screen.findByTestId("local-vault-unlock-dialog")).toBeInTheDocument();
    expect(loadStatus).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("import_save_password_file", expect.anything());

    /* Cancelling the unlock must not discard the file, the matches, or the ticks. */
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("password-file-import-preview")).toHaveTextContent("Bravo");
    expect(screen.getByText("2 of 2 selected")).toBeInTheDocument();

    /* An all-Keychain selection saves without touching the vault at all. */
    fireEvent.click(screen.getByLabelText("Include Bravo"));
    fireEvent.click(screen.getByTestId("password-file-import-save"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_save_password_file",
      { path: "/tmp/passwords.txt", hostIds: ["h-new"] },
    ));
    expect(loadStatus).toHaveBeenCalledTimes(1);
  });

  it("gates the save behind confirmation only while a ticked row replaces a password", async () => {
    render(<PasswordFileImport />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));
    await screen.findByTestId("password-file-import-row-h-replace");

    const confirm = screen.getByTestId("password-file-import-confirm");
    expect(confirm.closest("label")).toHaveTextContent(
      "I understand saved passwords on 1 host will be replaced.",
    );
    expect(screen.getByTestId("password-file-import-save")).toBeDisabled();

    /* Bravo is the only replacing row, so unticking it drops the requirement. */
    fireEvent.click(screen.getByLabelText("Include Bravo"));
    expect(screen.queryByTestId("password-file-import-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("password-file-import-save")).toBeEnabled();
    expect(screen.getByTestId("password-file-import-save")).toHaveTextContent("Save 1 password");

    /* Ticking it again restores the gate, and the confirmation starts unchecked. */
    fireEvent.click(screen.getByLabelText("Include Bravo"));
    expect(screen.getByTestId("password-file-import-confirm")).not.toBeChecked();
    expect(screen.getByTestId("password-file-import-save")).toBeDisabled();
  });

  it("disables the save button once nothing is ticked", async () => {
    render(<PasswordFileImport />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));
    await screen.findByTestId("password-file-import-row-h-new");

    fireEvent.click(screen.getByTestId("password-file-import-none"));

    const save = screen.getByTestId("password-file-import-save");
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent("Save 0 passwords");
  });

  it("reaches every control by Tab in reading order", async () => {
    const user = userEvent.setup();
    render(<PasswordFileImport />);
    fireEvent.click(screen.getByTestId("password-file-import-browse"));
    await screen.findByTestId("password-file-import-row-h-replace");

    const browse = screen.getByTestId("password-file-import-browse");
    /* The overwrite consent is required first, or Save stays disabled and tab
     * order correctly skips it. */
    fireEvent.click(screen.getByTestId("password-file-import-confirm"));
    browse.focus();
    expect(browse).toHaveFocus();

    /* Row ticks come first, then the bulk helpers, the overwrite consent, and
     * Save; the disabled key-auth row is never in the sequence. */
    const order = [
      screen.getByLabelText("Include Alpha"),
      screen.getByLabelText("Include Bravo"),
      screen.getByTestId("password-file-import-all"),
      screen.getByTestId("password-file-import-none"),
      screen.getByTestId("password-file-import-confirm"),
      screen.getByTestId("password-file-import-save"),
    ];
    for (const control of order) {
      await user.tab();
      expect(control).toHaveFocus();
    }
  });
});
