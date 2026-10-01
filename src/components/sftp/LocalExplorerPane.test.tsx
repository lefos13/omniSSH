/*
 * Tests for LocalExplorerPane start folder resolution.
 * Verifies that:
 * 1. Without configuration, opens the local pane at user home.
 * 2. When a default folder is configured and readable, opens there without listing home.
 * 3. When the configured folder fails, falls back to home and emits a toast.
 * 4. Respects initialPath priority over configured folders.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { LocalExplorerPane } from "./LocalExplorerPane";
import { useSettingsStore } from "../../stores/settings-store";
import { toast } from "../../stores/toast-store";
import type { LocalDirectoryListing } from "../../types/local-fs";

const MOCK_HOME = "/home/testuser";

function makeMockListing(path: string): LocalDirectoryListing {
  const parts = path.split("/").filter(Boolean);
  return {
    path,
    parent: "/" + parts.slice(0, -1).join("/"),
    segments: [
      { label: "/", path: "/" },
      ...parts.map((p, idx) => ({
        label: p,
        path: "/" + parts.slice(0, idx + 1).join("/"),
      })),
    ],
    entries: [
      {
        name: "test-file.txt",
        path: `${path}/test-file.txt`,
        entry_type: "File",
        size: 100,
        modified: 1700000000,
        is_symlink: false,
        permissions: 0o644,
        permissions_display: "rw-r--r--",
      },
    ],
  };
}

describe("LocalExplorerPane start folder resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      explorerDefaultLocalDir: "",
      explorerHostLocalDirs: {},
    });
  });

  it("(a) no config → lists home", async () => {
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") {
        return makeMockListing(args?.path as string);
      }
      return undefined;
    });

    render(<LocalExplorerPane />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("local_home_dir");
      expect(invoke).toHaveBeenCalledWith("local_list_dir", { path: MOCK_HOME });
    });

    fireEvent.click(screen.getByLabelText("Current path"));
    expect(screen.getByTestId("explorer-path-input")).toHaveValue(MOCK_HOME);
  });

  it("(b) default set & listable → lists default, never lists home first", async () => {
    const defaultDir = "/Users/testuser/workspace";
    useSettingsStore.setState({ explorerDefaultLocalDir: defaultDir });

    const listDirCalls: string[] = [];
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") {
        const p = args?.path as string;
        listDirCalls.push(p);
        return makeMockListing(p);
      }
      return undefined;
    });

    render(<LocalExplorerPane />);

    await waitFor(() => {
      expect(listDirCalls).toContain(defaultDir);
    });

    expect(listDirCalls).not.toContain(MOCK_HOME);
    fireEvent.click(screen.getByLabelText("Current path"));
    expect(screen.getByTestId("explorer-path-input")).toHaveValue(defaultDir);
  });

  it("(c) default fails → lists home and toast shown", async () => {
    const defaultDir = "/nonexistent/folder";
    useSettingsStore.setState({ explorerDefaultLocalDir: defaultDir });
    const toastErrorSpy = vi.spyOn(toast, "error");

    const listDirCalls: string[] = [];
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") {
        const p = args?.path as string;
        listDirCalls.push(p);
        if (p === defaultDir) {
          throw new Error("Directory not found");
        }
        return makeMockListing(p);
      }
      return undefined;
    });

    render(<LocalExplorerPane />);

    await waitFor(() => {
      expect(listDirCalls).toContain(defaultDir);
      expect(listDirCalls).toContain(MOCK_HOME);
    });

    expect(listDirCalls[0]).toBe(defaultDir);
    expect(listDirCalls[1]).toBe(MOCK_HOME);
    fireEvent.click(screen.getByLabelText("Current path"));
    expect(screen.getByTestId("explorer-path-input")).toHaveValue(MOCK_HOME);

    expect(toastErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Local start folder not found: \/nonexistent\/folder\. Opened \/home\/testuser instead\./),
    );
  });

  it("respects initialPath priority over configured default", async () => {
    useSettingsStore.setState({ explorerDefaultLocalDir: "/Users/testuser/workspace" });

    const listDirCalls: string[] = [];
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") {
        const p = args?.path as string;
        listDirCalls.push(p);
        return makeMockListing(p);
      }
      return undefined;
    });

    render(<LocalExplorerPane initialPath="/custom/initial/path" />);

    await waitFor(() => {
      expect(listDirCalls).toContain("/custom/initial/path");
    });

    expect(listDirCalls).not.toContain("/Users/testuser/workspace");
    expect(listDirCalls).not.toContain(MOCK_HOME);
    fireEvent.click(screen.getByLabelText("Current path"));
    expect(screen.getByTestId("explorer-path-input")).toHaveValue("/custom/initial/path");
  });

  it("home lookup fails but configured candidate succeeds → listing shown, no error", async () => {
    const configuredDir = "/Users/testuser/configured";
    useSettingsStore.setState({ explorerDefaultLocalDir: configuredDir });

    const listDirCalls: string[] = [];
    invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "local_home_dir") {
        throw new Error("Local home directory lookup failed");
      }
      if (cmd === "local_list_dir") {
        const p = args?.path as string;
        listDirCalls.push(p);
        return makeMockListing(p);
      }
      return undefined;
    });

    render(<LocalExplorerPane />);

    await waitFor(() => {
      expect(listDirCalls).toContain(configuredDir);
    });

    expect(screen.queryByTestId("local-explorer-error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Current path"));
    expect(screen.getByTestId("explorer-path-input")).toHaveValue(configuredDir);
  });

  it("home lookup fails and configured candidate fails → errors out", async () => {
    const configuredDir = "/nonexistent/configured";
    useSettingsStore.setState({ explorerDefaultLocalDir: configuredDir });

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") {
        throw new Error("Local home directory lookup failed");
      }
      if (cmd === "local_list_dir") {
        throw new Error("Folder not found");
      }
      return undefined;
    });

    render(<LocalExplorerPane />);

    await waitFor(() => {
      expect(screen.getByTestId("local-explorer-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("local-explorer-error")).toHaveTextContent("Local home directory lookup failed");
  });
});
