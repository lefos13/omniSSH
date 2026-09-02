import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportSshConfigModal } from "./ImportSshConfigModal";
import { useSettingsStore } from "../../stores/settings-store";
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

/* This test locks the MobaXterm IPC names, dialog filter, and shared payload
 * keys so frontend changes cannot silently drift from Rust registration. */
describe("ImportSshConfigModal — MobaXterm source", () => {

  it("defaults selector from useSettingsStore and sends credentialStorage: 'localVault'", async () => {
    useSettingsStore.setState({ defaultCredentialStorage: "localVault" });
    useLocalVaultStore.setState({
      loadStatus: vi.fn().mockResolvedValue({ configured: true, unlocked: true }),
      unlockVault: vi.fn().mockResolvedValue(undefined)
    });
    dialogOpen.mockResolvedValue("/tmp/MobaXterm.ini");
    render(<ImportSshConfigModal initialSource="mobaxterm" onClose={() => {}} onImported={() => {}} />);
    
    fireEvent.click(screen.getByRole("button", { name: "Browse for MobaXterm file" }));
    await screen.findByText(/web.example/); // wait for results
    
    expect(screen.getByTestId("import-file-credential-storage")).toHaveTextContent("Encrypted App Vault");
    
    fireEvent.click(screen.getByTestId("import-mobaxterm-submit"));
    
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_save_mobaxterm_hosts",
      expect.objectContaining({
        credentialStorage: "localVault",
      }),
    ));
  });

  const entry = {
    host_alias: "Production web",
    hostname: "web.example",
    user: "root",
    port: 22,
    identity_file: "C:\\keys\\web.ppk",
    proxy_jump: "jump@gateway.example:22",
    keep_alive_interval: null,
    is_pattern: false,
    already_exists: false,
    group_path: "Production / Web",
    startup_command: "sudo systemctl status web",
    notes: "Imported note",
    start_directory: "/srv/www",
    warnings: ["A gateway setting was not imported."],
  };

  beforeEach(() => {
    useSettingsStore.setState({ defaultCredentialStorage: "keychain" });
    invoke.mockReset();
    dialogOpen.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_parse_mobaxterm") return [entry];
      if (command === "import_save_mobaxterm_hosts") {
        return { imported: 1, skipped: 0, errors: [] };
      }
      return undefined;
    });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("browses, previews, and saves through the MobaXterm contract", async () => {
    dialogOpen.mockResolvedValue("/tmp/MobaXterm.ini");

    render(<ImportSshConfigModal initialSource="mobaxterm" onClose={() => {}} onImported={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Browse for MobaXterm file" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_parse_mobaxterm",
      { path: "/tmp/MobaXterm.ini" },
    ));
    expect(dialogOpen).toHaveBeenCalledWith(expect.objectContaining({
      filters: [{ name: "MobaXterm files", extensions: ["mxtsessions", "ini"] }],
    }));

    fireEvent.click(await screen.findByTestId("import-mobaxterm-submit"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_save_mobaxterm_hosts",
      {
        entries: [{
          host_alias: "Production web",
          hostname: "web.example",
          user: "root",
          port: 22,
          identity_file: "C:\\keys\\web.ppk",
          proxy_jump: "jump@gateway.example:22",
          keep_alive_interval: null,
          group_path: "Production / Web",
          startup_command: "sudo systemctl status web",
          notes: "Imported note",
          start_directory: "/srv/www",
        }],
        credentialStorage: "keychain",
      },
    ));
  });

  it("keeps the established OpenSSH command and submit test id", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_parse_ssh_config") return [entry];
      return undefined;
    });

    render(<ImportSshConfigModal onClose={() => {}} onImported={() => {}} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_parse_ssh_config",
      { path: null },
    ));
    expect(await screen.findByTestId("import-ssh-config-submit")).toBeInTheDocument();
  });

  it("selects one row when MobaXterm repeats a bookmark label", async () => {
    const secondEntry = {
      ...entry,
      hostname: "api.example",
      group_path: "Production / API",
    };
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_parse_mobaxterm") return [entry, secondEntry];
      if (command === "import_save_mobaxterm_hosts") {
        return { imported: 1, skipped: 0, errors: [] };
      }
      return undefined;
    });
    dialogOpen.mockResolvedValue("/tmp/MobaXterm.mxtsessions");

    render(<ImportSshConfigModal initialSource="mobaxterm" onClose={() => {}} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse for MobaXterm file" }));
    await screen.findByText(/web.example/);

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByTestId("import-mobaxterm-submit"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_save_mobaxterm_hosts",
      expect.objectContaining({
        entries: [expect.objectContaining({
          host_alias: "Production web",
          hostname: "api.example",
          group_path: "Production / API",
        })],
      }),
    ));
    const saveCall = invoke.mock.calls.find((call) => call[0] === "import_save_mobaxterm_hosts");
    expect((saveCall?.[1] as { entries: unknown[] }).entries).toHaveLength(1);
  });
});

/* Termius tests exercise the metadata-only default and the narrow IPC payload
 * so credentials cannot accidentally cross the React boundary during a UI
 * refactor. */
describe("ImportSshConfigModal — Termius source", () => {

  it("shows App Vault split counts and correct consent copy", async () => {
    const mixedPreview = {
      preview_token: "mixed-token",
      metadata_only: false,
      counts: { credential_available: 2 },
      warnings: [],
      hosts: [
        { id: "h1", credential_available: true, has_password: true, has_private_key: false, warnings: [] },
        { id: "h2", credential_available: true, has_password: false, has_private_key: true, warnings: [] },
        { id: "h3", credential_available: true, has_password: true, has_private_key: true, warnings: [] }
      ]
    };
    invoke.mockImplementation(async (c: string) => c === "import_preview_termius" ? mixedPreview : undefined);
    
    useSettingsStore.setState({ defaultCredentialStorage: "keychain" });
    render(<ImportSshConfigModal initialSource="termius" onClose={() => {}} onImported={() => {}} />);
    
    await screen.findByTestId("import-termius-host-h1");
    fireEvent.click(screen.getByTestId("import-termius-credentials"));
    
    // Default keychain wording
    expect(screen.getByText("I understand that selected credentials will be stored in the System Keychain.")).toBeInTheDocument();
    
    // Switch to localVault
    fireEvent.click(screen.getByTestId("import-termius-credential-storage"));
    fireEvent.click(screen.getByRole("option", { name: "Encrypted App Vault" }));
    
    expect(screen.getByText("I understand that selected credentials will be stored in the encrypted App Vault.")).toBeInTheDocument();
    expect(screen.getByText(/2 passwords → App Vault/)).toBeInTheDocument();
    expect(screen.getByText(/2 key credentials → System Keychain/)).toBeInTheDocument();
  });

  it("halts commit to open UnlockVaultDialog when locked, then proceeds on success", async () => {
    useSettingsStore.setState({ defaultCredentialStorage: "localVault" });
    const mockLoadStatus = vi.fn().mockResolvedValue({ configured: true, unlocked: false });
    useLocalVaultStore.setState({
      loadStatus: mockLoadStatus,
      unlockVault: vi.fn().mockResolvedValue(undefined)
    });
    
    render(<ImportSshConfigModal initialSource="termius" onClose={() => {}} onImported={() => {}} />);
    await screen.findByTestId("import-termius-host-opaque-host-1");
    
    fireEvent.click(screen.getByTestId("import-termius-credentials"));
    fireEvent.click(screen.getByTestId("import-termius-credentials-confirm"));
    fireEvent.click(screen.getByTestId("import-termius-submit"));
    
    // Dialog should appear
    expect(await screen.findByTestId("local-vault-unlock-dialog")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("import_commit_termius", expect.anything());
    
    // Now simulate successful unlock
    mockLoadStatus.mockResolvedValue({ configured: true, unlocked: true });
    fireEvent.change(screen.getByPlaceholderText("Enter master password"), { target: { value: "pass" } });
    
    const origInvoke = invoke.getMockImplementation();
    invoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "local_vault_verify") return true;
      if (origInvoke) return origInvoke(cmd, args);
      return undefined;
    });
    
    fireEvent.click(screen.getByRole("button", { name: "Unlock Vault" }));
    
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_commit_termius",
      expect.objectContaining({
        request: expect.objectContaining({
          credential_storage: "localVault"
        })
      })
    ));
  });

  const termiusPreview = {
    preview_token: "opaque-preview-token",
    metadata_only: true,
    hosts: [
      {
        id: "opaque-host-1",
        label: "Production",
        address: "prod.example",
        username: "alice",
        port: 22,
        group_id: "opaque-group-1",
        notes: "Deployment host",
        startup_command: null,
        start_directory: "/srv/app",
        key_path: "/Users/alice/.ssh/id_ed25519",
        proxy: null,
        credential_available: true,
        has_password: true,
        has_private_key: false,
        already_exists: false,
        warnings: [],
      },
      {
        id: "opaque-host-2",
        label: "Existing",
        address: "existing.example",
        username: "bob",
        port: 2222,
        group_id: null,
        notes: null,
        startup_command: null,
        start_directory: null,
        key_path: null,
        proxy: null,
        credential_available: false,
        has_password: false,
        has_private_key: false,
        already_exists: true,
        warnings: ["Proxy settings were preserved but not linked automatically"],
      },
    ],
    groups: [{ id: "opaque-group-1", name: "Production", host_count: 1 }],
    counts: { hosts: 2, groups: 1, credential_available: 1, already_exists: 1 },
    warnings: ["Some Termius records could not be read"],
  };

  beforeEach(() => {
    useSettingsStore.setState({ defaultCredentialStorage: "keychain" });
    invoke.mockReset();
    dialogOpen.mockReset();
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_preview_termius") return termiusPreview;
      if (command === "import_commit_termius") {
        return {
          imported_hosts: 1,
          imported_groups: 1,
          skipped_hosts: 0,
          credentials_stored: 0,
          warnings: [],
        };
      }
      return undefined;
    });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("defaults to metadata-only preview and auto-selects new opaque host ids", async () => {
    render(<ImportSshConfigModal initialSource="termius" onClose={() => {}} onImported={() => {}} />);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_preview_termius",
      { request: { source_path: null, metadata_only: true } },
    ));
    expect(screen.getByTestId("import-termius-host-opaque-host-1")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    expect(screen.getAllByRole("checkbox")[1]).not.toBeChecked();
    expect(screen.queryByText("fixture-password")).not.toBeInTheDocument();
    expect(screen.getByTestId("import-termius-source")).toHaveFocus();
  });

  it("requires explicit credential opt-in and confirmation before commit", async () => {
    render(<ImportSshConfigModal initialSource="termius" onClose={() => {}} onImported={() => {}} />);
    await screen.findByTestId("import-termius-host-opaque-host-1");
    const submit = screen.getByTestId("import-termius-submit");
    expect(submit).toBeEnabled();
    fireEvent.click(screen.getByTestId("import-termius-credentials"));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByTestId("import-termius-credentials-confirm"));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_commit_termius",
      {
        request: {
          preview_token: "opaque-preview-token",
          selected_ids: ["opaque-host-1"],
          include_credentials: true,
          credentials_confirmed: true,
          credential_storage: "keychain",
        },
      },
    ));
    expect(screen.getByTestId("import-result")).toHaveFocus();
  });

  it("keeps source and browse controls locked while a commit is pending", async () => {
    let resolveCommit!: (value: {
      imported_hosts: number;
      imported_groups: number;
      skipped_hosts: number;
      credentials_stored: number;
      warnings: string[];
    }) => void;
    invoke.mockImplementation((command: string) => {
      if (command === "import_preview_termius") return Promise.resolve(termiusPreview);
      if (command === "import_commit_termius") {
        return new Promise((resolve) => { resolveCommit = resolve; });
      }
      return Promise.resolve(undefined);
    });

    render(<ImportSshConfigModal initialSource="termius" onClose={() => {}} onImported={() => {}} />);
    await screen.findByTestId("import-termius-host-opaque-host-1");
    fireEvent.click(screen.getByTestId("import-termius-submit"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_commit_termius",
      expect.anything(),
    ));

    expect(screen.getByTestId("import-ssh-config-source")).toBeDisabled();
    expect(screen.getByTestId("import-mobaxterm-source")).toBeDisabled();
    expect(screen.getByTestId("import-termius-source")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Browse" })).toBeDisabled();

    resolveCommit({
      imported_hosts: 1,
      imported_groups: 1,
      skipped_hosts: 0,
      credentials_stored: 0,
      warnings: [],
    });
    await screen.findByTestId("import-result");
  });

  it("ignores a file dialog result after switching import sources", async () => {
    let resolveBrowse!: (value: string) => void;
    dialogOpen.mockImplementation(() => new Promise<string>((resolve) => {
      resolveBrowse = resolve;
    }));
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_preview_termius") return termiusPreview;
      return undefined;
    });

    render(<ImportSshConfigModal initialSource="mobaxterm" onClose={() => {}} onImported={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse for MobaXterm file" }));
    fireEvent.click(screen.getByTestId("import-termius-source"));
    await screen.findByTestId("import-termius-host-opaque-host-1");

    resolveBrowse("/tmp/stale-mobaxterm.ini");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(invoke).not.toHaveBeenCalledWith(
      "import_parse_mobaxterm",
      { path: "/tmp/stale-mobaxterm.ini" },
    );
  });

  it("commits selected opaque ids without any credential fields", async () => {
    render(<ImportSshConfigModal initialSource="termius" onClose={() => {}} onImported={() => {}} />);
    await screen.findByTestId("import-termius-host-opaque-host-1");
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByTestId("import-termius-submit"));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "import_commit_termius",
      {
        request: {
          preview_token: "opaque-preview-token",
          selected_ids: ["opaque-host-2"],
          include_credentials: false,
          credentials_confirmed: false,
          credential_storage: "keychain",
        },
      },
    ));
    const commitPayload = invoke.mock.calls.find((call) => call[0] === "import_commit_termius")?.[1] as Record<string, unknown>;
    const requestKeys = JSON.stringify(commitPayload).match(/"([^"\\]+)"\s*:/g) ?? [];
    expect(requestKeys.join(" ")).not.toMatch(/password|private_key|passphrase|secret/i);
  });

  it("clears an expired preview and asks the user to scan again", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_preview_termius") return termiusPreview;
      if (command === "import_commit_termius") throw { kind: "preview_expired", message: "Termius import preview expired" };
      return undefined;
    });
    render(<ImportSshConfigModal initialSource="termius" onClose={() => {}} onImported={() => {}} />);
    await screen.findByTestId("import-termius-host-opaque-host-1");
    fireEvent.click(screen.getByTestId("import-termius-submit"));

    expect(await screen.findByText(/preview expired/i)).toBeInTheDocument();
    expect(screen.queryByTestId("import-termius-host-opaque-host-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("import-termius-rescan")).toBeInTheDocument();
  });

  it("explains that Termius must be closed when the source is locked", async () => {
    invoke.mockRejectedValue({ kind: "source_running", message: "Termius must be closed before importing" });
    render(<ImportSshConfigModal initialSource="termius" onClose={() => {}} onImported={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/close Termius completely/i);
  });

  it("explains when Termius encrypted metadata cannot be decrypted", async () => {
    invoke.mockRejectedValue({
      kind: "metadata_unavailable",
      message: "Termius encrypted metadata could not be decrypted",
    });
    render(
      <ImportSshConfigModal
        initialSource="termius"
        onClose={() => {}}
        onImported={() => {}}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/encrypted metadata could not be decrypted/i);
  });
});
