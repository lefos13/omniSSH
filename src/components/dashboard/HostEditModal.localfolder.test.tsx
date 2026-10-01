/*
 * Tests for HostEditModal machine-local start folder field.
 * Verifies that:
 * 1. Browse then Save persists the chosen folder for an existing host.
 * 2. Browse then Save persists the chosen folder for a new host under the generated ID.
 * 3. Clear then Save removes the host's entry from settings.
 * 4. Browse then Cancel does not persist changes to settings.
 * 5. A locked/managed host can configure and save the local start folder
 *    without modifying the synced host record in SQLite.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SavedHost } from "../../types";
import { HostEditModal, NEW_HOST_ID } from "./HostEditModal";
import { useUiStore } from "../../stores/ui-store";
import { useSettingsStore } from "../../stores/settings-store";

const invoke = vi.fn();
const mockOpen = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => mockOpen(...args),
}));

type TauriWindow = typeof window & {
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
};

function makeHost(overrides: Partial<SavedHost> = {}): SavedHost {
  return {
    id: "host-1",
    label: "Web Server",
    host: "10.0.0.9",
    port: 22,
    username: "alice",
    auth_type: "password",
    credential_storage: "keychain",
    group_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    key_path: null,
    color: null,
    notes: null,
    environment: null,
    os_type: null,
    startup_command: null,
    proxy_jump: null,
    proxy_jump_host_id: null,
    start_directory: null,
    keep_alive_interval: null,
    default_shell: null,
    font_size: null,
    terminal_theme: null,
    last_connected_at: null,
    connection_count: null,
    ...overrides,
  };
}

describe("HostEditModal — local start folder", () => {
  beforeEach(() => {
    invoke.mockReset();
    mockOpen.mockReset();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: () => ({ width: 0 }),
    } as unknown as CanvasRenderingContext2D);

    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
    };

    useUiStore.setState({ editingHostId: null });
    useSettingsStore.setState({
      explorerDefaultLocalDir: "",
      explorerHostLocalDirs: {},
    });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    useUiStore.setState({ editingHostId: null });
  });

  it("Browse then Save persists the chosen folder for an existing host", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_host") return makeHost();
      if (cmd === "vault_has_credential") return false;
      if (cmd === "sync_managed_by") return [];
      if (cmd === "save_host") return null;
      return [];
    });

    useUiStore.setState({ editingHostId: "host-1" });
    render(<HostEditModal />);

    // Switch to Connection tab
    fireEvent.click(await screen.findByTestId("host-modal-tab-connection"));

    const input = screen.getByTestId("host-modal-local-start-folder");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Uses the default local folder");

    mockOpen.mockResolvedValue("/Users/testuser/my-project");
    fireEvent.click(screen.getByTestId("host-modal-local-start-folder-browse"));

    await waitFor(() => {
      expect(input).toHaveValue("/Users/testuser/my-project");
    });

    fireEvent.click(screen.getByTestId("host-modal-save"));

    await waitFor(() => {
      expect(useSettingsStore.getState().explorerHostLocalDirs["host-1"]).toBe(
        "/Users/testuser/my-project",
      );
    });
  });

  it("Browse then Save persists the chosen folder for a new host under the generated ID", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_ssh_keys") return [];
      if (cmd === "sync_managed_by") return [];
      if (cmd === "save_host") return null;
      return [];
    });

    useUiStore.setState({ editingHostId: NEW_HOST_ID });
    render(<HostEditModal />);

    fireEvent.change(await screen.findByTestId("host-modal-host"), {
      target: { value: "192.168.1.100" },
    });
    fireEvent.change(screen.getByTestId("host-modal-username"), {
      target: { value: "bob" },
    });

    fireEvent.click(screen.getByTestId("host-modal-tab-connection"));

    mockOpen.mockResolvedValue("/Users/testuser/new-project");
    fireEvent.click(screen.getByTestId("host-modal-local-start-folder-browse"));

    await waitFor(() => {
      expect(screen.getByTestId("host-modal-local-start-folder")).toHaveValue(
        "/Users/testuser/new-project",
      );
    });

    fireEvent.click(screen.getByTestId("host-modal-save"));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("save_host", expect.anything());
    });

    const savedHostCall = invoke.mock.calls.find(([cmd]) => cmd === "save_host")?.[1] as {
      host: SavedHost;
    };
    expect(savedHostCall?.host?.id).toBeTruthy();
    const newHostId = savedHostCall.host.id;
    expect(useSettingsStore.getState().explorerHostLocalDirs[newHostId]).toBe(
      "/Users/testuser/new-project",
    );
  });

  it("Clear then Save removes the host's folder entry", async () => {
    useSettingsStore.setState({
      explorerHostLocalDirs: { "host-1": "/Users/testuser/existing-folder" },
    });

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_host") return makeHost();
      if (cmd === "vault_has_credential") return false;
      if (cmd === "sync_managed_by") return [];
      if (cmd === "save_host") return null;
      return [];
    });

    useUiStore.setState({ editingHostId: "host-1" });
    render(<HostEditModal />);

    fireEvent.click(await screen.findByTestId("host-modal-tab-connection"));

    const input = screen.getByTestId("host-modal-local-start-folder");
    expect(input).toHaveValue("/Users/testuser/existing-folder");

    const clearBtn = screen.getByTestId("host-modal-local-start-folder-clear");
    expect(clearBtn).not.toBeDisabled();
    fireEvent.click(clearBtn);

    expect(input).toHaveValue("");
    expect(clearBtn).toBeDisabled();

    fireEvent.click(screen.getByTestId("host-modal-save"));

    await waitFor(() => {
      expect(useSettingsStore.getState().explorerHostLocalDirs["host-1"]).toBeUndefined();
    });
  });

  it("Browse then Cancel does not persist any changes", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_host") return makeHost();
      if (cmd === "vault_has_credential") return false;
      if (cmd === "sync_managed_by") return [];
      return [];
    });

    useUiStore.setState({ editingHostId: "host-1" });
    render(<HostEditModal />);

    fireEvent.click(await screen.findByTestId("host-modal-tab-connection"));

    mockOpen.mockResolvedValue("/Users/testuser/discarded-folder");
    fireEvent.click(screen.getByTestId("host-modal-local-start-folder-browse"));

    await waitFor(() => {
      expect(screen.getByTestId("host-modal-local-start-folder")).toHaveValue(
        "/Users/testuser/discarded-folder",
      );
    });

    fireEvent.click(screen.getByTestId("host-modal-cancel"));

    expect(useSettingsStore.getState().explorerHostLocalDirs["host-1"]).toBeUndefined();
  });

  it("allows locked/managed host to configure and save local folder without altering host record", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_host") return makeHost();
      if (cmd === "vault_has_credential") return false;
      if (cmd === "local_vault_has_credential") return false;
      if (cmd === "list_ssh_keys") return [];
      if (cmd === "sync_managed_by") return [{ datasetId: "ds-1", name: "TEAM-DATASET" }];
      return [];
    });

    useUiStore.setState({ editingHostId: "host-1" });
    render(<HostEditModal />);

    // Verify host is managed and synced fields are locked
    await screen.findByTestId("host-modal-managed-banner");
    expect(screen.getByTestId("host-modal-label")).toBeDisabled();

    fireEvent.click(screen.getByTestId("host-modal-tab-connection"));

    // Remote start folder is locked for managed host
    expect(screen.getByTestId("host-modal-start-directory")).toBeDisabled();

    // Local start folder row is NOT disabled by fieldsLocked
    const localInput = screen.getByTestId("host-modal-local-start-folder");
    const browseBtn = screen.getByTestId("host-modal-local-start-folder-browse");
    expect(browseBtn).not.toBeDisabled();

    mockOpen.mockResolvedValue("/Users/testuser/managed-local");
    fireEvent.click(browseBtn);

    await waitFor(() => {
      expect(localInput).toHaveValue("/Users/testuser/managed-local");
    });

    const saveBtn = screen.getByTestId("host-modal-save");
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    // Persisted to local settings
    await waitFor(() => {
      expect(useSettingsStore.getState().explorerHostLocalDirs["host-1"]).toBe(
        "/Users/testuser/managed-local",
      );
    });

    // Managed host must never call save_host (host record unaltered)
    expect(invoke).not.toHaveBeenCalledWith("save_host", expect.anything());
  });
});
