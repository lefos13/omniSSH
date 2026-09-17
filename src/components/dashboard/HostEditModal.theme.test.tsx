/*
 * Tests for the per-host terminal theme picker in HostEditModal: the saved host
 * loads into the picker, selecting a scheme persists its id, and the "App theme"
 * option clears it back to null.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SavedHost } from "../../types";
import { HostEditModal } from "./HostEditModal";
import { useUiStore } from "../../stores/ui-store";

const invoke = vi.fn();

type TauriWindow = typeof window & {
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
};

function host(overrides: Partial<SavedHost> = {}): SavedHost {
  return {
    id: "host-1",
    label: "Example",
    host: "10.0.0.9",
    port: 22,
    username: "alice",
    auth_type: "password",
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

function respondWith(saved: SavedHost) {
  invoke.mockImplementation(async (command: string) => {
    if (command === "get_host") return saved;
    return [];
  });
}

function savedHostPayload(): SavedHost {
  const call = invoke.mock.calls.find(([cmd]) => cmd === "save_host");
  return (call?.[1] as { host: SavedHost }).host;
}

describe("HostEditModal — terminal theme picker", () => {
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

  it("loads the saved scheme and selects it", async () => {
    respondWith(host({ terminal_theme: "nord" }));
    render(<HostEditModal />);

    const nord = await screen.findByTestId("host-modal-theme-nord");
    expect(nord).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("host-modal-theme-app")).toHaveAttribute("aria-pressed", "false");
  });

  it("persists the selected scheme id on save", async () => {
    respondWith(host());
    render(<HostEditModal />);

    fireEvent.click(await screen.findByTestId("host-modal-theme-dracula"));
    fireEvent.click(screen.getByTestId("host-modal-save"));

    await waitFor(() => expect(savedHostPayload().terminal_theme).toBe("dracula"));
  });

  it("clears the scheme back to the app theme", async () => {
    respondWith(host({ terminal_theme: "dracula" }));
    render(<HostEditModal />);

    fireEvent.click(await screen.findByTestId("host-modal-theme-app"));
    fireEvent.click(screen.getByTestId("host-modal-save"));

    await waitFor(() => expect(savedHostPayload().terminal_theme).toBeNull());
  });
});
