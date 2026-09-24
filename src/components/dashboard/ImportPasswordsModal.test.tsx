/* Unit tests for ImportPasswordsModal component.
 *
 * Verifies format documentation, empty state when no saved hosts exist,
 * delegation to PasswordFileImport when hosts exist, and propagation of onSaved. */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ImportPasswordsModal } from "./ImportPasswordsModal";
import { useHostsStore } from "../../stores/hosts-store";
import type { SavedHost } from "../../types";

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

const mockHost: SavedHost = {
  id: "host-1",
  label: "Production DB",
  host: "10.0.0.5",
  port: 22,
  username: "deploy",
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
};

describe("ImportPasswordsModal", () => {
  beforeEach(() => {
    invoke.mockReset();
    dialogOpen.mockReset();
    useHostsStore.setState({ hosts: [] });
  });

  it("renders format explanation and code example", () => {
    render(<ImportPasswordsModal onClose={() => {}} onSaved={() => {}} />);

    expect(screen.getByText("Password File Format")).toBeInTheDocument();
    const example = screen.getByTestId("import-passwords-format-example");
    expect(example).toHaveTextContent("deploy@10.0.0.5 = s3cret");
    expect(example).toHaveTextContent("root@db.example.com = hunter2");
  });

  it("shows zero-hosts empty state and hides browse control when no hosts exist", () => {
    useHostsStore.setState({ hosts: [] });
    render(<ImportPasswordsModal onClose={() => {}} onSaved={() => {}} />);

    expect(screen.getByTestId("import-passwords-zero-hosts")).toBeInTheDocument();
    expect(screen.getByText(/Add or import hosts first/)).toBeInTheDocument();
    expect(screen.queryByTestId("password-file-import-browse")).not.toBeInTheDocument();
  });

  it("renders browse control when saved hosts exist", () => {
    useHostsStore.setState({ hosts: [mockHost] });
    render(<ImportPasswordsModal onClose={() => {}} onSaved={() => {}} />);

    expect(screen.queryByTestId("import-passwords-zero-hosts")).not.toBeInTheDocument();
    expect(screen.getByTestId("password-file-import-browse")).toBeInTheDocument();
  });

  it("calls onSaved when save completes in PasswordFileImport", async () => {
    useHostsStore.setState({ hosts: [mockHost] });
    dialogOpen.mockResolvedValue("/tmp/passwords.txt");
    invoke.mockImplementation(async (command: string) => {
      if (command === "import_preview_password_file") {
        return {
          matches: [
            {
              host_id: "host-1",
              host_label: "Production DB",
              username: "deploy",
              host: "10.0.0.5",
              port: 22,
              storage: "keychain",
              status: "new",
            },
          ],
          unmatched_entries: 0,
          conflicts: 0,
          malformed_lines: 0,
        };
      }
      if (command === "import_save_password_file") {
        return { stored_in_keychain: 1, stored_in_vault: 0, skipped: 0, failed: [] };
      }
      return undefined;
    });

    const onSaved = vi.fn();
    render(<ImportPasswordsModal onClose={() => {}} onSaved={onSaved} />);

    fireEvent.click(screen.getByTestId("password-file-import-browse"));
    await screen.findByTestId("password-file-import-row-host-1");

    fireEvent.click(screen.getByTestId("password-file-import-save"));
    await screen.findByTestId("password-file-import-result");

    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking Done or pressing Escape", () => {
    const onClose = vi.fn();
    render(<ImportPasswordsModal onClose={onClose} onSaved={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
