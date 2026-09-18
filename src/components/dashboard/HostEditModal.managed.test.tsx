import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SavedHost } from "../../types";
import { HostEditModal } from "./HostEditModal";
import { useUiStore } from "../../stores/ui-store";

/* HostEditModal loads through a dynamic `import("@tauri-apps/api/core")`,
 * so the tests drive Tauri's own IPC hook like the credentials suite does. */
const invoke = vi.fn();

type TauriWindow = typeof window & {
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
};

function host(): SavedHost {
  return {
    id: "host-1",
    label: "Nova Web",
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
  };
}

/* A host claimed by one member dataset answers `sync_managed_by` with that
 * dataset; an unmanaged host answers with an empty list. */
function respondWith(managers: { datasetId: string; name: string }[]) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "get_host") return host();
    if (command === "vault_has_credential") return false;
    if (command === "local_vault_has_credential") return false;
    if (command === "list_ssh_keys") return [];
    if (command === "sync_managed_by") return managers;
    if (command === "sync_detach_host") return null;
    return [];
  });
}

function openModal() {
  useUiStore.getState().setEditingHostId("host-1");
  render(<HostEditModal />);
}

describe("HostEditModal — managed hosts", () => {
  beforeEach(() => {
    invoke.mockReset();
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
    };
    useUiStore.getState().setEditingHostId(null);
  });

  afterEach(() => {
    useUiStore.getState().setEditingHostId(null);
  });

  it("locks the synced details but keeps the credential editable", async () => {
    respondWith([{ datasetId: "ds-1", name: "NOVA" }]);
    openModal();

    const banner = await screen.findByTestId("host-modal-managed-banner");
    expect(banner).toHaveTextContent('Managed by “NOVA”');
    // The dataset owns these; a pull would overwrite any local edit.
    expect(screen.getByTestId("host-modal-label")).toBeDisabled();
    expect(screen.getByTestId("host-modal-host")).toBeDisabled();
    expect(screen.getByTestId("host-modal-username")).toBeDisabled();
    // The secret is machine-local, so it stays typable and Save writes it.
    expect(screen.getByTestId("host-modal-password")).not.toBeDisabled();
    const save = screen.getByTestId("host-modal-save");
    expect(save).not.toBeDisabled();
    expect(save).toHaveAttribute("title", "A managed host saves only its credential");
  });

  it("saves a managed host's credential without touching the synced row", async () => {
    respondWith([{ datasetId: "ds-1", name: "NOVA" }]);
    openModal();

    await screen.findByTestId("host-modal-managed-banner");
    fireEvent.change(screen.getByTestId("host-modal-password"), {
      target: { value: "typed-on-this-machine" },
    });
    fireEvent.click(screen.getByTestId("host-modal-save"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "vault_save_credential",
        expect.objectContaining({ hostId: "host-1" }),
      ),
    );
    // The row belongs to the dataset: the save must never rewrite it.
    expect(invoke).not.toHaveBeenCalledWith("save_host", expect.anything());
  });

  it("leaves an unmanaged host fully editable", async () => {
    respondWith([]);
    openModal();

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sync_managed_by", { hostId: "host-1" }));
    await waitFor(() => expect(screen.getByTestId("host-modal-save")).not.toBeDisabled());
    expect(screen.queryByTestId("host-modal-managed-banner")).not.toBeInTheDocument();
  });

  it("detaches behind a confirm and unlocks the editor", async () => {
    respondWith([{ datasetId: "ds-1", name: "NOVA" }]);
    openModal();

    await screen.findByTestId("host-modal-managed-banner");
    fireEvent.click(screen.getByTestId("host-modal-detach-ds-1"));
    fireEvent.click(screen.getByTestId("host-modal-detach-confirm-ds-1"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sync_detach_host", {
        datasetId: "ds-1",
        hostId: "host-1",
      }),
    );
  });

  it("blocks the save call even when the button is forced", async () => {
    respondWith([{ datasetId: "ds-1", name: "NOVA" }]);
    openModal();

    await screen.findByTestId("host-modal-managed-banner");
    expect(invoke).not.toHaveBeenCalledWith(
      "save_host",
      expect.anything(),
    );
  });
});
