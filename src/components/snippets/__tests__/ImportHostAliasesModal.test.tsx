/*
 * Component tests for ImportHostAliasesModal.
 * Verifies scanning, filtering, selection, and batch snippet persistence.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { ImportHostAliasesModal } from "../ImportHostAliasesModal";
import { useSessionStore } from "../../../stores/session-store";
import { useSnippetsStore } from "../../../stores/snippets-store";
import { toast } from "../../../stores/toast-store";
import type { HostConfig, HostAlias } from "../../../types";

const dummyHost: HostConfig = {
  host: "prod.example.com",
  port: 22,
  username: "deploy",
  auth_method: { type: "password", password: "pwd" },
};

const mockAliases: HostAlias[] = [
  { name: "ll", command: "ls -alF" },
  { name: "gs", command: "git status" },
  { name: "k", command: "kubectl" },
];

describe("ImportHostAliasesModal", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "ssh_detect_aliases") {
        return Promise.resolve(mockAliases);
      }
      if (cmd === "list_snippet_folders") {
        return Promise.resolve([]);
      }
      if (cmd === "list_snippets") {
        return Promise.resolve([]);
      }
      if (cmd === "save_snippets") {
        return Promise.resolve();
      }
      if (cmd === "save_snippet_folder") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });

    useSessionStore.setState({
      sessions: new Map([
        [
          "sess-1",
          {
            id: "sess-1",
            hostConfig: dummyHost,
            status: "Connected",
            label: "deploy@prod.example.com",
          },
        ],
      ]),
      activeSessionId: "sess-1",
    });

    useSnippetsStore.setState({
      snippets: [],
      folders: [],
    });

    vi.spyOn(toast, "success");
    vi.spyOn(toast, "error");
  });

  it("scans and displays detected host aliases on mount", async () => {
    render(<ImportHostAliasesModal open={true} sessionId="sess-1" onClose={vi.fn()} />);

    expect(screen.getByText("Scanning shell environment for aliases…")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("ll")).toBeInTheDocument();
      expect(screen.getByText("ls -alF")).toBeInTheDocument();
      expect(screen.getByText("gs")).toBeInTheDocument();
      expect(screen.getByText("k")).toBeInTheDocument();
    });

    expect(screen.getByText("3 of 3 selected")).toBeInTheDocument();
    expect(screen.getByTestId("import-aliases-submit")).toHaveTextContent("Import 3 Snippets");
  });

  it("filters aliases based on search input", async () => {
    render(<ImportHostAliasesModal open={true} sessionId="sess-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("ll")).toBeInTheDocument();
    });

    const searchInput = screen.getByTestId("import-aliases-search");
    fireEvent.change(searchInput, { target: { value: "git" } });

    expect(screen.getByText("gs")).toBeInTheDocument();
    expect(screen.queryByText("ll")).not.toBeInTheDocument();
    expect(screen.queryByText("k")).not.toBeInTheDocument();
  });

  it("toggles individual and all selections", async () => {
    render(<ImportHostAliasesModal open={true} sessionId="sess-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("ll")).toBeInTheDocument();
    });

    // Deselect all
    const toggleAllBtn = screen.getByTestId("import-aliases-toggle-all");
    fireEvent.click(toggleAllBtn);

    expect(screen.getByText("0 of 3 selected")).toBeInTheDocument();
    expect(screen.getByTestId("import-aliases-submit")).toBeDisabled();

    // Select individual row
    const rowLl = screen.getByTestId("import-alias-row-ll");
    fireEvent.click(rowLl);

    expect(screen.getByText("1 of 3 selected")).toBeInTheDocument();
    expect(screen.getByTestId("import-aliases-submit")).not.toBeDisabled();
    expect(screen.getByTestId("import-aliases-submit")).toHaveTextContent("Import 1 Snippet");
  });

  it("submits selected snippets and shows success toast", async () => {
    const handleClose = vi.fn();
    const handleImported = vi.fn();

    render(
      <ImportHostAliasesModal
        open={true}
        sessionId="sess-1"
        onClose={handleClose}
        onImported={handleImported}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("ll")).toBeInTheDocument();
    });

    const submitBtn = screen.getByTestId("import-aliases-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_snippets", expect.objectContaining({
        snippets: expect.arrayContaining([
          expect.objectContaining({ name: "ll", command: "ls -alF" }),
          expect.objectContaining({ name: "gs", command: "git status" }),
          expect.objectContaining({ name: "k", command: "kubectl" }),
        ]),
      }));
    });

    expect(toast.success).toHaveBeenCalledWith("Imported 3 alias snippets.");
    expect(handleImported).toHaveBeenCalledWith(3);
    expect(handleClose).toHaveBeenCalled();
  });

  it("creates a new folder when create-folder option is checked", async () => {
    const handleClose = vi.fn();

    render(<ImportHostAliasesModal open={true} sessionId="sess-1" onClose={handleClose} />);

    await waitFor(() => {
      expect(screen.getByText("ll")).toBeInTheDocument();
    });

    const chk = screen.getByTestId("import-aliases-create-folder-chk");
    fireEvent.click(chk);

    const folderNameInput = screen.getByTestId("import-aliases-new-folder-name");
    fireEvent.change(folderNameInput, { target: { value: "Server Aliases" } });

    const submitBtn = screen.getByTestId("import-aliases-submit");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_snippet_folder", expect.objectContaining({
        folder: expect.objectContaining({ name: "Server Aliases" }),
      }));
      expect(invokeMock).toHaveBeenCalledWith("save_snippets", expect.anything());
    });
  });

  it("surfaces scan error with retry affordance", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "ssh_detect_aliases") {
        return Promise.reject(new Error("Connection reset by peer"));
      }
      return Promise.resolve([]);
    });

    render(<ImportHostAliasesModal open={true} sessionId="sess-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Could not scan aliases")).toBeInTheDocument();
      expect(screen.getByText("Connection reset by peer")).toBeInTheDocument();
      expect(screen.getByText("Retry")).toBeInTheDocument();
    });
  });

  it("handles empty alias detection gracefully", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "ssh_detect_aliases") {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    render(<ImportHostAliasesModal open={true} sessionId="sess-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No shell aliases detected")).toBeInTheDocument();
      expect(screen.getByText("Scan Again")).toBeInTheDocument();
    });
  });
});
