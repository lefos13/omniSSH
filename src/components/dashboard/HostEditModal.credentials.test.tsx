import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { SavedHost } from "../../types";
import { HostEditModal } from "./HostEditModal";
import { useUiStore } from "../../stores/ui-store";

/* HostEditModal loads through a dynamic `import("@tauri-apps/api/core")`.
 * Driving the real module via Tauri's own IPC hook is more faithful than
 * replacing the module, and avoids the module-registry race that makes a
 * mocked dynamic import resolve inconsistently inside an async effect. */
const invoke = vi.fn();

type TauriWindow = typeof window & {
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
};

function host(overrides: Partial<SavedHost> = {}): SavedHost {
  return {
    id: "host-1",
    label: "Imported Host",
    host: "10.0.0.9",
    port: 22,
    username: "alice",
    auth_type: "password",
    credential_storage: "localVault",
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
    last_connected_at: null,
    connection_count: null,
    ...overrides,
  };
}

function respondWith(saved: SavedHost, credentialPresent: boolean) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "get_host") return saved;
    if (command === "local_vault_has_credential") return credentialPresent;
    if (command === "vault_has_credential") return credentialPresent;
    return [];
  });
}

describe("HostEditModal — missing credential notice", () => {
  beforeEach(() => {
    invoke.mockReset();
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
    };
    useUiStore.setState({ editingHostId: "host-1" });
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    useUiStore.setState({ editingHostId: null });
  });

  it("warns when a vault-marked host has no stored ciphertext", async () => {
    respondWith(host(), false);

    render(<HostEditModal />);

    // Presence comes from the database, never from a Keychain probe.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("local_vault_has_credential", { hostId: "host-1" })
    );
    expect(invoke).not.toHaveBeenCalledWith("vault_has_credential", expect.anything());

    expect(await screen.findByTestId("host-modal-missing-credential")).toHaveTextContent(
      /No credential stored for this host/i
    );
    expect(screen.queryByTestId("host-modal-reveal-password")).not.toBeInTheDocument();
  });

  it("shows the saved-credential row instead once ciphertext exists", async () => {
    respondWith(host(), true);

    render(<HostEditModal />);

    expect(await screen.findByTestId("host-modal-reveal-password")).toBeInTheDocument();
    expect(screen.queryByTestId("host-modal-missing-credential")).not.toBeInTheDocument();
  });

  it("probes the keychain for keychain-backed hosts", async () => {
    respondWith(host({ credential_storage: "keychain" }), false);

    render(<HostEditModal />);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("vault_has_credential", { hostId: "host-1" })
    );
    expect(await screen.findByTestId("host-modal-missing-credential")).toBeInTheDocument();
  });
});
