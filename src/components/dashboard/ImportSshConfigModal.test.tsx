import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportSshConfigModal } from "./ImportSshConfigModal";

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
    warnings: ["A gateway setting was not imported."],
  };

  beforeEach(() => {
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
        }],
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
    await screen.findByText(/api\.example/);

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
