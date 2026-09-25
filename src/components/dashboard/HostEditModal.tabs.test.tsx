/*
 * Tests for the tabbed layout of HostEditModal: the editor opens on General,
 * arrow keys move between tabs, a validation failure on a hidden field switches
 * to the tab that owns it, and tabs holding non-default settings carry a mark.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { SavedHost } from "../../types";
import { HostEditModal, NEW_HOST_ID } from "./HostEditModal";
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
    if (command === "vault_has_credential") return false;
    return [];
  });
}

describe("HostEditModal — tabs", () => {
  beforeEach(() => {
    invoke.mockReset();
    (window as TauriWindow).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
    };
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    useUiStore.setState({ editingHostId: null });
  });

  it("opens on General with the other panels hidden", async () => {
    respondWith(host());
    useUiStore.setState({ editingHostId: NEW_HOST_ID });
    render(<HostEditModal />);

    expect(await screen.findByTestId("host-modal-tab-general")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("host-modal-panel-general")).toBeVisible();
    expect(screen.getByTestId("host-modal-panel-connection")).not.toBeVisible();
  });

  it("moves between tabs with the arrow keys", async () => {
    respondWith(host());
    useUiStore.setState({ editingHostId: NEW_HOST_ID });
    render(<HostEditModal />);

    const general = await screen.findByTestId("host-modal-tab-general");
    fireEvent.keyDown(general, { key: "ArrowRight" });
    expect(screen.getByTestId("host-modal-tab-connection")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("host-modal-tab-connection")).toHaveFocus();
    expect(screen.getByTestId("host-modal-panel-connection")).toBeVisible();

    fireEvent.keyDown(screen.getByTestId("host-modal-tab-connection"), { key: "End" });
    expect(screen.getByTestId("host-modal-tab-plugins")).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByTestId("host-modal-tab-plugins"), { key: "ArrowRight" });
    expect(screen.getByTestId("host-modal-tab-general")).toHaveAttribute("aria-selected", "true");
  });

  it("switches to the tab owning a failed field", async () => {
    respondWith(host());
    useUiStore.setState({ editingHostId: NEW_HOST_ID });
    render(<HostEditModal />);

    fireEvent.change(await screen.findByTestId("host-modal-host"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByTestId("host-modal-username"), { target: { value: "root" } });
    fireEvent.click(screen.getByTestId("host-modal-tab-connection"));
    fireEvent.change(screen.getByLabelText(/Keep Alive/), { target: { value: "-5" } });
    fireEvent.click(screen.getByTestId("host-modal-tab-general"));

    fireEvent.click(screen.getByTestId("host-modal-save"));

    expect(await screen.findByTestId("host-modal-error")).toHaveTextContent("Keep Alive");
    expect(screen.getByTestId("host-modal-tab-connection")).toHaveAttribute("aria-selected", "true");
    expect(invoke).not.toHaveBeenCalledWith("save_host", expect.anything());
    await waitFor(() => expect(screen.getByLabelText(/Keep Alive/)).toHaveFocus());
  });

  it("returns to General when a required field is missing", async () => {
    respondWith(host());
    useUiStore.setState({ editingHostId: NEW_HOST_ID });
    render(<HostEditModal />);

    fireEvent.click(await screen.findByTestId("host-modal-tab-appearance"));
    fireEvent.click(screen.getByTestId("host-modal-save"));

    expect(await screen.findByTestId("host-modal-error")).toHaveTextContent("Host is required");
    expect(screen.getByTestId("host-modal-panel-general")).toBeVisible();
    await waitFor(() => expect(screen.getByTestId("host-modal-host")).toHaveFocus());
  });

  it("marks tabs that hold non-default settings", async () => {
    respondWith(host({ startup_command: "uptime", notes: "db box" }));
    useUiStore.setState({ editingHostId: "host-1" });
    render(<HostEditModal />);

    await waitFor(() =>
      expect(screen.getByTestId("host-modal-tab-connection")).toHaveTextContent("(configured)"),
    );
    expect(screen.getByTestId("host-modal-tab-notes")).toHaveTextContent("(configured)");
    expect(screen.getByTestId("host-modal-tab-appearance")).not.toHaveTextContent("(configured)");
  });

  it("previews the connection target under the title", async () => {
    respondWith(host({ port: 2222 }));
    useUiStore.setState({ editingHostId: "host-1" });
    render(<HostEditModal />);

    expect(await screen.findByText("alice@10.0.0.9:2222")).toBeInTheDocument();
  });
});
