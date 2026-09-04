/*
 * Component tests for ExplorerPage dual-pane layout.
 * Verifies that:
 * 1. SFTP/SCP sessions render both the local pane and the remote pane with
 *    proper data attributes, accessible labels, and preserved remote metadata.
 * 2. S3 sessions render only the S3 browser without the local pane.
 * 3. Local navigation (e.g. double-clicking a directory or typing a path)
 *    updates directory contents.
 * 4. Inaccessible or invalid local paths render the error banner with
 *    `data-testid="local-explorer-error"` without crashing.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
type EventCallback<T = unknown> = (event: { payload: T }) => void;

const { invoke, eventListeners, listen } = vi.hoisted(() => {
  const eventListeners = new Map<string, Set<EventCallback<unknown>>>();
  const listen = vi.fn(async (eventName: string, handler: EventCallback<unknown>) => {
    let set = eventListeners.get(eventName);
    if (!set) {
      set = new Set();
      eventListeners.set(eventName, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  });
  return {
    invoke: vi.fn(),
    eventListeners,
    listen,
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { ExplorerPage } from "./ExplorerPage";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { useToastStore } from "../../stores/toast-store";
import type { LocalDirectoryListing } from "../../types/local-fs";
import type { SftpEntry } from "../../types";
const MOCK_HOME = "/home/testuser";

const MOCK_HOME_LISTING: LocalDirectoryListing = {
  path: "/home/testuser",
  parent: "/home",
  segments: [
    { label: "/", path: "/" },
    { label: "home", path: "/home" },
    { label: "testuser", path: "/home/testuser" },
  ],
  entries: [
    {
      name: "Documents",
      path: "/home/testuser/Documents",
      entry_type: "Directory",
      size: 0,
      modified: 1700000000,
      is_symlink: false,
      permissions: 0o755,
      permissions_display: "rwxr-xr-x",
    },
    {
      name: "notes.txt",
      path: "/home/testuser/notes.txt",
      entry_type: "File",
      size: 1234,
      modified: 1700000000,
      is_symlink: false,
      permissions: 0o644,
      permissions_display: "rw-r--r--",
    },
  ],
};

const MOCK_DOCS_LISTING: LocalDirectoryListing = {
  path: "/home/testuser/Documents",
  parent: "/home/testuser",
  segments: [
    { label: "/", path: "/" },
    { label: "home", path: "/home" },
    { label: "testuser", path: "/home/testuser" },
    { label: "Documents", path: "/home/testuser/Documents" },
  ],
  entries: [
    {
      name: "report.pdf",
      path: "/home/testuser/Documents/report.pdf",
      entry_type: "File",
      size: 5678,
      modified: 1700001000,
      is_symlink: false,
      permissions: 0o644,
      permissions_display: "rw-r--r--",
    },
  ],
};
const MOCK_REMOTE_FOLDER: SftpEntry = {
  name: "remote-folder",
  path: "/remote/home/remote-folder",
  entry_type: "Directory",
  size: 4096,
  modified: 1700000000,
  permissions: 0o755,
  permissions_display: "drwxr-xr-x",
  is_symlink: false,
};

const MOCK_REMOTE_FILE: SftpEntry = {
  name: "remote-file.txt",
  path: "/remote/home/remote-file.txt",
  entry_type: "File",
  size: 1024,
  modified: 1700000500,
  permissions: 0o644,
  permissions_display: "-rw-r--r--",
  is_symlink: false,
};

const MOCK_REMOTE_CONFLICT_FILE: SftpEntry = {
  name: "notes.txt",
  path: "/remote/home/notes.txt",
  entry_type: "File",
  size: 2048,
  modified: 1700000600,
  permissions: 0o644,
  permissions_display: "-rw-r--r--",
  is_symlink: false,
};

function emitTransferEvent(
  payload: {
    sftp_session_id?: string;
    scp_session_id?: string;
    direction: string;
    status: string;
  },
  eventName = "sftp:transfer",
): void {
  const listeners = eventListeners.get(eventName);
  if (listeners) {
    for (const fn of listeners) {
      fn({ payload });
    }
  }
}

function seedSftpSession(sessionId = "sftp-1", entries: SftpEntry[] = [], transport: "sftp" | "scp" = "sftp"): void {
  const store = useSftpStore.getState();
  store.openSession(sessionId, "ssh-1", "Remote Server", "user", false, undefined, transport);
  store.setEntries(sessionId, "/remote/home", entries);
}
function seedS3Session(sessionId = "s3-1"): void {
  const store = useS3Store.getState();
  store.openSession(sessionId, "S3 Storage");
  store.setBuckets(sessionId, []);
}

describe("ExplorerPage — dual-pane host explorer", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "local_home_dir") {
        return MOCK_HOME;
      }
      if (cmd === "local_list_dir") {
        const { path } = (args as { path: string }) || {};
        if (!path || path === "/home/testuser") {
          return MOCK_HOME_LISTING;
        }
        if (path === "/home/testuser/Documents") {
          return MOCK_DOCS_LISTING;
        }
        if (path === "/forbidden") {
          throw { kind: "permission_denied", message: "Permission denied" };
        }
        throw { kind: "not_found", message: "Path not found" };
      }
      if (cmd === "sftp_list_dir" || cmd === "scp_list_dir") {
        return [];
      }
      if (cmd === "s3_list_buckets") {
        return [];
      }
      return [];
    });

    useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
    useS3Store.setState({ sessions: new Map(), activeS3SessionId: null, clipboard: null });
    useToastStore.setState({ toasts: [] });
    eventListeners.clear();
    listen.mockClear();
  });
  it("renders both local and remote panes for an SFTP session", async () => {
    seedSftpSession("sftp-1");

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    // Local pane on the left with accessible section label
    const localSection = container.querySelector('[data-explorer-pane="local"]');
    expect(localSection).toBeInTheDocument();
    expect(localSection).toHaveAttribute("aria-label", "Local filesystem");

    // Remote pane on the right with preserved E2E attributes and accessible section label
    const remoteSection = container.querySelector('[data-explorer-pane="remote"]');
    expect(remoteSection).toBeInTheDocument();
    expect(remoteSection).toHaveAttribute("aria-label", "Remote filesystem");
    expect(remoteSection).toHaveAttribute("data-explorer-session-id", "sftp-1");
    expect(remoteSection).toHaveAttribute("data-explorer-transport", "sftp");

    // Local items loaded
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("Documents")).toBeInTheDocument();
  });

  it("renders only the S3 browser for an S3 session", async () => {
    seedS3Session("s3-1");

    const { container } = render(<ExplorerPage s3SessionId="s3-1" />);

    // S3 container exists
    const s3Container = container.querySelector('[data-explorer-session-id="s3-1"]');
    expect(s3Container).toBeInTheDocument();
    expect(s3Container).toHaveAttribute("data-explorer-transport", "s3");

    // No local or remote dual-pane wrappers
    expect(container.querySelector('[data-explorer-pane="local"]')).toBeNull();
    expect(container.querySelector('[data-explorer-pane="remote"]')).toBeNull();
  });

  it("navigates into folders and updates the local listing", async () => {
    seedSftpSession("sftp-1");

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    // Initial files in local pane
    const localSection = container.querySelector('[data-explorer-pane="local"]') as HTMLElement;
    expect(await within(localSection).findByText("notes.txt")).toBeInTheDocument();
    const docsFolder = within(localSection).getByTestId("explorer-entry-Documents");
    expect(docsFolder).toBeInTheDocument();

    // Double-click to navigate into Documents
    fireEvent.doubleClick(docsFolder);

    // New directory contents appear in local pane
    expect(await within(localSection).findByText("report.pdf")).toBeInTheDocument();
    expect(within(localSection).queryByText("notes.txt")).toBeNull();
  });

  it("displays the error banner with data-testid='local-explorer-error' when local navigation fails", async () => {
    seedSftpSession("sftp-1");

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    const localSection = container.querySelector('[data-explorer-pane="local"]') as HTMLElement;
    expect(await within(localSection).findByText("notes.txt")).toBeInTheDocument();

    // Begin editing path in local toolbar
    const breadcrumbBar = within(localSection).getByLabelText("Current path");
    fireEvent.click(breadcrumbBar);

    // Type forbidden path and hit Enter
    const pathInput = await within(localSection).findByTestId("explorer-path-input");
    fireEvent.change(pathInput, { target: { value: "/forbidden" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });
    fireEvent.blur(pathInput);

    // Error banner surfaces with the backend error message
    const errorBanner = await within(localSection).findByTestId("local-explorer-error");
    expect(errorBanner).toBeInTheDocument();
    expect(errorBanner).toHaveTextContent("Permission denied");
  });
  it("preserves independent local paths across two mounted host tabs", async () => {
    seedSftpSession("sftp-1");
    seedSftpSession("sftp-2");

    // Both tabs are mounted (simulating issue #17 keep-mounted tabs in AppShell)
    const { container, rerender } = render(
      <div>
        <div data-tab="1" style={{ display: "block" }}>
          <ExplorerPage sftpSessionId="sftp-1" isActive={true} />
        </div>
        <div data-tab="2" style={{ display: "none" }}>
          <ExplorerPage sftpSessionId="sftp-2" isActive={false} />
        </div>
      </div>,
    );

    const tab1 = container.querySelector('[data-tab="1"]') as HTMLElement;
    const tab2 = container.querySelector('[data-tab="2"]') as HTMLElement;

    const local1 = tab1.querySelector('[data-explorer-pane="local"]') as HTMLElement;
    const local2 = tab2.querySelector('[data-explorer-pane="local"]') as HTMLElement;

    expect(await within(local1).findByText("notes.txt")).toBeInTheDocument();
    expect(await within(local2).findByText("notes.txt")).toBeInTheDocument();

    // Navigate tab 1 into Documents
    const docs1 = within(local1).getByTestId("explorer-entry-Documents");
    fireEvent.doubleClick(docs1);
    expect(await within(local1).findByText("report.pdf")).toBeInTheDocument();

    // Switch active tab: hide tab 1, show tab 2
    rerender(
      <div>
        <div data-tab="1" style={{ display: "none" }}>
          <ExplorerPage sftpSessionId="sftp-1" isActive={false} />
        </div>
        <div data-tab="2" style={{ display: "block" }}>
          <ExplorerPage sftpSessionId="sftp-2" isActive={true} />
        </div>
      </div>,
    );

    // Tab 2 still shows its original directory (notes.txt), while Tab 1 retains Documents (report.pdf)
    expect(within(local2).getByText("notes.txt")).toBeInTheDocument();
    expect(within(local2).queryByText("report.pdf")).toBeNull();

    expect(within(local1).getByText("report.pdf")).toBeInTheDocument();
    expect(within(local1).queryByText("notes.txt")).toBeNull();
  });

  it("disables copy-to-remote button when no local entries are selected", async () => {
    seedSftpSession("sftp-1");

    render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    const copyBtn = screen.getByTestId("explorer-copy-to-remote");
    expect(copyBtn).toBeDisabled();
    expect(copyBtn).toHaveAttribute("aria-label", "Copy selected to remote (0 items)");
    expect(copyBtn).toHaveAttribute("title", "Copy selected to remote (0 items)");
  });

  it("enqueues upload once with exact { localPaths, remoteDir } for a mixed file+folder selection", async () => {
    seedSftpSession("sftp-1");

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    const localSection = container.querySelector('[data-explorer-pane="local"]') as HTMLElement;
    expect(await within(localSection).findByText("notes.txt")).toBeInTheDocument();

    const docsFolder = within(localSection).getByTestId("explorer-entry-Documents");
    const notesFile = within(localSection).getByTestId("explorer-entry-notes.txt");

    // Select folder
    fireEvent.click(docsFolder);
    // Multi-select file with meta key
    fireEvent.click(notesFile, { metaKey: true });

    const copyBtn = screen.getByTestId("explorer-copy-to-remote");
    expect(copyBtn).not.toBeDisabled();
    expect(copyBtn).toHaveAttribute("aria-label", "Copy selected to remote (2 items)");

    fireEvent.click(copyBtn);

    await waitFor(() => {
      const enqueueCall = invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_upload");
      expect(enqueueCall).toBeDefined();
      expect(enqueueCall?.[1]).toEqual({
        sftpSessionId: "sftp-1",
        localPaths: ["/home/testuser/Documents", "/home/testuser/notes.txt"],
        remoteDir: "/remote/home",
      });
    });

    const enqueueCalls = invoke.mock.calls.filter((c) => c[0] === "sftp_enqueue_upload");
    expect(enqueueCalls).toHaveLength(1);
  });

  it("shows overwrite dialog on conflict and enqueues only after confirmation", async () => {
    const mockConflictingEntry: SftpEntry = {
      name: "notes.txt",
      path: "/remote/home/notes.txt",
      entry_type: "File",
      size: 50,
      modified: 1234,
      permissions: 0o644,
      permissions_display: "-rw-r--r--",
      is_symlink: false,
    };

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") {
        return [mockConflictingEntry];
      }
      return [];
    });

    seedSftpSession("sftp-1");

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    const localSection = container.querySelector('[data-explorer-pane="local"]') as HTMLElement;
    expect(await within(localSection).findByText("notes.txt")).toBeInTheDocument();

    const notesFile = within(localSection).getByTestId("explorer-entry-notes.txt");
    fireEvent.click(notesFile);

    const copyBtn = screen.getByTestId("explorer-copy-to-remote");
    fireEvent.click(copyBtn);

    // Overwrite dialog appears
    const confirmDialog = await screen.findByTestId("explorer-overwrite-confirm");
    expect(confirmDialog).toBeInTheDocument();
    expect(screen.getByText("Overwrite item?")).toBeInTheDocument();

    // Not enqueued yet while dialog is open
    expect(invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_upload")).toBeUndefined();

    // Confirm overwrite
    const overwriteBtn = screen.getByTestId("explorer-overwrite-confirm-button");
    fireEvent.click(overwriteBtn);

    await waitFor(() => {
      const enqueueCall = invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_upload");
      expect(enqueueCall).toBeDefined();
      expect(enqueueCall?.[1]).toEqual({
        sftpSessionId: "sftp-1",
        localPaths: ["/home/testuser/notes.txt"],
        remoteDir: "/remote/home",
      });
    });

    expect(invoke.mock.calls.find((c) => c[0] === "sftp_rename")).toBeUndefined();
  });

  it("cancelling conflict dialog enqueues nothing", async () => {
    const mockConflictingEntry: SftpEntry = {
      name: "notes.txt",
      path: "/remote/home/notes.txt",
      entry_type: "File",
      size: 50,
      modified: 1234,
      permissions: 0o644,
      permissions_display: "-rw-r--r--",
      is_symlink: false,
    };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") return [mockConflictingEntry];
      return [];
    });

    seedSftpSession("sftp-1");

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    const localSection = container.querySelector('[data-explorer-pane="local"]') as HTMLElement;
    expect(await within(localSection).findByText("notes.txt")).toBeInTheDocument();

    const notesFile = within(localSection).getByTestId("explorer-entry-notes.txt");
    fireEvent.click(notesFile);

    const copyBtn = screen.getByTestId("explorer-copy-to-remote");
    fireEvent.click(copyBtn);

    await screen.findByTestId("explorer-overwrite-confirm");

    const cancelBtn = screen.getByTestId("explorer-overwrite-cancel");
    fireEvent.click(cancelBtn);

    expect(screen.queryByTestId("explorer-overwrite-confirm")).toBeNull();
    expect(invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_upload")).toBeUndefined();
  });

  it("renames existing files and enqueues upload when Backup & Copy is chosen", async () => {
    const mockConflictingEntry: SftpEntry = {
      name: "notes.txt",
      path: "/remote/home/notes.txt",
      entry_type: "File",
      size: 50,
      modified: 1234,
      permissions: 0o644,
      permissions_display: "-rw-r--r--",
      is_symlink: false,
    };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") return [mockConflictingEntry];
      return [];
    });

    seedSftpSession("sftp-1");

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    const localSection = container.querySelector('[data-explorer-pane="local"]') as HTMLElement;
    expect(await within(localSection).findByText("notes.txt")).toBeInTheDocument();

    const notesFile = within(localSection).getByTestId("explorer-entry-notes.txt");
    fireEvent.click(notesFile);

    fireEvent.click(screen.getByTestId("explorer-copy-to-remote"));

    const backupBtn = await screen.findByTestId("explorer-overwrite-backup-button");
    fireEvent.click(backupBtn);

    await waitFor(() => {
      const renameCall = invoke.mock.calls.find((c) => c[0] === "sftp_rename");
      expect(renameCall).toBeDefined();
      expect(renameCall?.[1]).toEqual({
        sftpSessionId: "sftp-1",
        oldPath: "/remote/home/notes.txt",
        newPath: expect.stringMatching(/^\/remote\/home\/notes\.txt\.\d{8}\.bak$/),
      });
    });

    await waitFor(() => {
      const enqueueCall = invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_upload");
      expect(enqueueCall).toBeDefined();
      expect(enqueueCall?.[1]).toEqual({
        sftpSessionId: "sftp-1",
        localPaths: ["/home/testuser/notes.txt"],
        remoteDir: "/remote/home",
      });
    });
  });

  it("surfaces an actionable toast error when enqueue fails", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") return [];
      if (cmd === "sftp_enqueue_upload") {
        throw { message: "Disk full" };
      }
      return [];
    });

    seedSftpSession("sftp-1");

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    const localSection = container.querySelector('[data-explorer-pane="local"]') as HTMLElement;
    expect(await within(localSection).findByText("notes.txt")).toBeInTheDocument();

    const notesFile = within(localSection).getByTestId("explorer-entry-notes.txt");
    fireEvent.click(notesFile);

    const copyBtn = screen.getByTestId("explorer-copy-to-remote");
    fireEvent.click(copyBtn);

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.length).toBeGreaterThan(0);
      expect(toasts.some((t) => t.kind === "error" && t.message.includes("Upload failed: Disk full"))).toBe(true);
    });
  });

  it("disables copy-to-local button when no remote entries are selected, when local dir is missing, or when busy", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") return [MOCK_REMOTE_FILE];
      return [];
    });

    seedSftpSession("sftp-1", [MOCK_REMOTE_FILE]);

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(await screen.findByText("remote-file.txt")).toBeInTheDocument();

    const copyToLocalBtn = screen.getByTestId("explorer-copy-to-local");
    // 1. Disabled with no remote selection
    expect(copyToLocalBtn).toBeDisabled();
    expect(copyToLocalBtn).toHaveAttribute("aria-label", "Copy selected to local (0 items)");
    expect(copyToLocalBtn).toHaveAttribute("title", "Copy selected to local (0 items)");

    // Select remote file
    const remoteSection = container.querySelector('[data-explorer-pane="remote"]') as HTMLElement;
    const remoteFileEntry = within(remoteSection).getByTestId("explorer-entry-remote-file.txt");
    fireEvent.click(remoteFileEntry);

    // Enabled with remote selection
    expect(copyToLocalBtn).not.toBeDisabled();
    expect(copyToLocalBtn).toHaveAttribute("aria-label", "Copy selected to local (1 item)");

    // 2. Disabled while busy
    let resolveEnqueue!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveEnqueue = resolve;
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") return [MOCK_REMOTE_FILE];
      if (cmd === "sftp_enqueue_download") {
        return promise;
      }
      return [];
    });
    fireEvent.click(copyToLocalBtn);

    // In flight: busy state disables both buttons
    await waitFor(() => {
      expect(copyToLocalBtn).toBeDisabled();
      expect(copyToLocalBtn).toHaveAttribute("aria-busy", "true");
      expect(screen.getByTestId("explorer-copy-to-remote")).toBeDisabled();
      expect(screen.getByTestId("explorer-copy-to-remote")).toHaveAttribute("aria-busy", "true");
    });
    resolveEnqueue();
    await waitFor(() => {
      expect(copyToLocalBtn).toHaveAttribute("aria-busy", "false");
    });
  });

  it("disables copy-to-local button when local directory is not known", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") throw new Error("No home");
      if (cmd === "sftp_list_dir") return [MOCK_REMOTE_FILE];
      return [];
    });

    seedSftpSession("sftp-1", [MOCK_REMOTE_FILE]);

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    const remoteSection = container.querySelector('[data-explorer-pane="remote"]') as HTMLElement;
    const remoteFileEntry = await within(remoteSection).findByTestId("explorer-entry-remote-file.txt");
    fireEvent.click(remoteFileEntry);

    const copyToLocalBtn = screen.getByTestId("explorer-copy-to-local");
    expect(copyToLocalBtn).toBeDisabled();
  });

  it("enqueues download once with exact { remotePaths, localDir } for a mixed file+folder selection", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") return [MOCK_REMOTE_FOLDER, MOCK_REMOTE_FILE];
      return [];
    });

    seedSftpSession("sftp-1", [MOCK_REMOTE_FOLDER, MOCK_REMOTE_FILE]);

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    const remoteSection = container.querySelector('[data-explorer-pane="remote"]') as HTMLElement;
    const folderEntry = await within(remoteSection).findByTestId("explorer-entry-remote-folder");
    const fileEntry = within(remoteSection).getByTestId("explorer-entry-remote-file.txt");

    // Select folder and file
    fireEvent.click(folderEntry);
    fireEvent.click(fileEntry, { metaKey: true });

    const copyBtn = screen.getByTestId("explorer-copy-to-local");
    expect(copyBtn).not.toBeDisabled();
    expect(copyBtn).toHaveAttribute("aria-label", "Copy selected to local (2 items)");

    fireEvent.click(copyBtn);

    await waitFor(() => {
      const enqueueCall = invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_download");
      expect(enqueueCall).toBeDefined();
      expect(enqueueCall?.[1]).toEqual({
        sftpSessionId: "sftp-1",
        remotePaths: ["/remote/home/remote-folder", "/remote/home/remote-file.txt"],
        localDir: "/home/testuser",
      });
    });

    const enqueueCalls = invoke.mock.calls.filter((c) => c[0] === "sftp_enqueue_download");
    expect(enqueueCalls).toHaveLength(1);
  });

  it("shows overwrite dialog on local-name conflict with NO backup button and enqueues only after confirm", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") return [MOCK_REMOTE_CONFLICT_FILE];
      return [];
    });

    seedSftpSession("sftp-1", [MOCK_REMOTE_CONFLICT_FILE]);

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    const remoteSection = container.querySelector('[data-explorer-pane="remote"]') as HTMLElement;
    const conflictEntry = await within(remoteSection).findByTestId("explorer-entry-notes.txt");
    fireEvent.click(conflictEntry);

    const copyBtn = screen.getByTestId("explorer-copy-to-local");
    fireEvent.click(copyBtn);

    // Overwrite dialog appears
    const confirmDialog = await screen.findByTestId("explorer-overwrite-confirm");
    expect(confirmDialog).toBeInTheDocument();
    expect(screen.getByText("Overwrite item?")).toBeInTheDocument();

    // NO backup button or backup text for download direction
    expect(screen.queryByTestId("explorer-overwrite-backup-button")).toBeNull();
    expect(screen.queryByText(/Backup & Copy/i)).toBeNull();

    // Not enqueued yet
    expect(invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_download")).toBeUndefined();

    // Confirm overwrite
    const overwriteBtn = screen.getByTestId("explorer-overwrite-confirm-button");
    fireEvent.click(overwriteBtn);

    await waitFor(() => {
      const enqueueCall = invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_download");
      expect(enqueueCall).toBeDefined();
      expect(enqueueCall?.[1]).toEqual({
        sftpSessionId: "sftp-1",
        remotePaths: ["/remote/home/notes.txt"],
        localDir: "/home/testuser",
      });
    });
  });

  it("cancelling conflict dialog enqueues nothing for download and leaves remote source intact", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") return [MOCK_REMOTE_CONFLICT_FILE];
      return [];
    });

    seedSftpSession("sftp-1", [MOCK_REMOTE_CONFLICT_FILE]);

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    const remoteSection = container.querySelector('[data-explorer-pane="remote"]') as HTMLElement;
    const conflictEntry = await within(remoteSection).findByTestId("explorer-entry-notes.txt");
    fireEvent.click(conflictEntry);

    const copyBtn = screen.getByTestId("explorer-copy-to-local");
    fireEvent.click(copyBtn);

    await screen.findByTestId("explorer-overwrite-confirm");

    const cancelBtn = screen.getByTestId("explorer-overwrite-cancel");
    fireEvent.click(cancelBtn);

    expect(screen.queryByTestId("explorer-overwrite-confirm")).toBeNull();
    expect(invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_download")).toBeUndefined();
    expect(invoke.mock.calls.find((c) => c[0] === "sftp_remove_file")).toBeUndefined();
    expect(invoke.mock.calls.find((c) => c[0] === "sftp_remove_dir")).toBeUndefined();
  });

  it("surfaces an actionable toast error when download enqueue fails", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "sftp_list_dir") return [MOCK_REMOTE_FILE];
      if (cmd === "sftp_enqueue_download") {
        throw { message: "Local filesystem read-only" };
      }
      return [];
    });

    seedSftpSession("sftp-1", [MOCK_REMOTE_FILE]);

    const { container } = render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    const remoteSection = container.querySelector('[data-explorer-pane="remote"]') as HTMLElement;
    const remoteFile = await within(remoteSection).findByTestId("explorer-entry-remote-file.txt");
    fireEvent.click(remoteFile);

    const copyBtn = screen.getByTestId("explorer-copy-to-local");
    fireEvent.click(copyBtn);

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.length).toBeGreaterThan(0);
      expect(
        toasts.some(
          (t) => t.kind === "error" && t.message.includes("Download failed: Local filesystem read-only"),
        ),
      ).toBe(true);
    });
  });

  it("refreshes local listing on Completed Download event for this session, but not for Failed event", async () => {
    seedSftpSession("sftp-1");

    render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    const initialCalls = invoke.mock.calls.filter((c) => c[0] === "local_list_dir").length;

    // Completed download event for this session triggers a local listing reload
    emitTransferEvent({
      sftp_session_id: "sftp-1",
      direction: "Download",
      status: "Completed",
    });

    await waitFor(() => {
      const calls = invoke.mock.calls.filter((c) => c[0] === "local_list_dir").length;
      expect(calls).toBe(initialCalls + 1);
    });

    // Failed download event does NOT trigger a reload
    emitTransferEvent({
      sftp_session_id: "sftp-1",
      direction: "Download",
      status: "Failed",
    });

    // Let any pending macro/microtasks run
    await new Promise((r) => setTimeout(r, 50));
    const finalCalls = invoke.mock.calls.filter((c) => c[0] === "local_list_dir").length;
    expect(finalCalls).toBe(initialCalls + 1);
  });

  it("ignores transfer events for a different session id", async () => {
    seedSftpSession("sftp-1");

    render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    const initialCalls = invoke.mock.calls.filter((c) => c[0] === "local_list_dir").length;

    emitTransferEvent({
      sftp_session_id: "sftp-different",
      direction: "Download",
      status: "Completed",
    });

    await new Promise((r) => setTimeout(r, 50));
    const finalCalls = invoke.mock.calls.filter((c) => c[0] === "local_list_dir").length;
    expect(finalCalls).toBe(initialCalls);
  });

  it("supports SCP transport for download enqueue and transfer completion", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "local_home_dir") return MOCK_HOME;
      if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
      if (cmd === "scp_list_dir") return [MOCK_REMOTE_FILE];
      if (cmd === "scp_enqueue_download") return [];
      return [];
    });

    seedSftpSession("scp-1", [MOCK_REMOTE_FILE], "scp");

    const { container } = render(<ExplorerPage sftpSessionId="scp-1" transport="scp" />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    const remoteSection = container.querySelector('[data-explorer-pane="remote"]') as HTMLElement;
    const remoteFile = await within(remoteSection).findByTestId("explorer-entry-remote-file.txt");
    fireEvent.click(remoteFile);

    const copyBtn = screen.getByTestId("explorer-copy-to-local");
    fireEvent.click(copyBtn);

    await waitFor(() => {
      const enqueueCall = invoke.mock.calls.find((c) => c[0] === "scp_enqueue_download");
      expect(enqueueCall).toBeDefined();
      expect(enqueueCall?.[1]).toEqual({
        scpSessionId: "scp-1",
        remotePaths: ["/remote/home/remote-file.txt"],
        localDir: "/home/testuser",
      });
    });

    const initialCalls = invoke.mock.calls.filter((c) => c[0] === "local_list_dir").length;

    emitTransferEvent(
      {
        scp_session_id: "scp-1",
        direction: "Download",
        status: "Completed",
      },
      "scp:transfer",
    );

    await waitFor(() => {
      const calls = invoke.mock.calls.filter((c) => c[0] === "local_list_dir").length;
      expect(calls).toBe(initialCalls + 1);
    });
  });

  it("does not react to download completion when explorer tab is hidden (isActive = false)", async () => {
    seedSftpSession("sftp-1");

    render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" isActive={false} />);

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    const initialCalls = invoke.mock.calls.filter((c) => c[0] === "local_list_dir").length;

    emitTransferEvent({
      sftp_session_id: "sftp-1",
      direction: "Download",
      status: "Completed",
    });

    await new Promise((r) => setTimeout(r, 50));
    const finalCalls = invoke.mock.calls.filter((c) => c[0] === "local_list_dir").length;
    expect(finalCalls).toBe(initialCalls);
  });

  describe("Task 4 — dual-pane scoping, focus management and keyboard accessibility", () => {
    beforeEach(() => {
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "local_home_dir") return MOCK_HOME;
        if (cmd === "local_list_dir") return MOCK_HOME_LISTING;
        if (cmd === "sftp_list_dir") return [MOCK_REMOTE_FILE, MOCK_REMOTE_FOLDER];
        return [];
      });
    });

    it("targets the remote table by default for __e2eExplorerSetSelection, __e2eExplorerStartRename, and __e2eExplorerChmod", async () => {
      seedSftpSession("sftp-1", [MOCK_REMOTE_FILE, MOCK_REMOTE_FOLDER]);
      render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" isActive />);

      expect(await screen.findByText("notes.txt")).toBeInTheDocument();
      expect(screen.getByText("remote-file.txt")).toBeInTheDocument();

      const localSection = screen.getByLabelText("Local filesystem");
      const remoteSection = screen.getByLabelText("Remote filesystem");

      const w = window as unknown as {
        __e2eExplorerSetSelection?: (names: string[], pane?: "remote" | "local") => void;
        __e2eExplorerSetSelectionLocal?: (names: string[]) => void;
        __e2eExplorerStartRename?: (name: string, newName?: string) => void;
        __e2eExplorerChmod?: (name: string, mode: number, recursive?: boolean) => Promise<unknown>;
      };

      // 1. __e2eExplorerSetSelection without pane defaults to remote
      w.__e2eExplorerSetSelection?.(["remote-file.txt"]);
      await waitFor(() => {
        const remoteRow = within(remoteSection).getByTestId("explorer-entry-remote-file.txt");
        expect(remoteRow).toHaveClass("bg-accent/10");
      });
      const localRow = within(localSection).getByTestId("explorer-entry-notes.txt");
      expect(localRow).not.toHaveClass("bg-accent/10");

      // 2. __e2eExplorerSetSelectionLocal selects in local pane
      w.__e2eExplorerSetSelectionLocal?.(["notes.txt"]);
      await waitFor(() => {
        expect(localRow).toHaveClass("bg-accent/10");
      });

      // 3. __e2eExplorerStartRename renames in remote table and never local
      w.__e2eExplorerStartRename?.("remote-file.txt", "remote-renamed.txt");
      await waitFor(() => {
        const renameCalls = invoke.mock.calls.filter((c) => c[0] === "sftp_rename");
        expect(renameCalls.length).toBeGreaterThan(0);
        expect(renameCalls[0][1]).toEqual({
          sftpSessionId: "sftp-1",
          oldPath: "/remote/home/remote-file.txt",
          newPath: "/remote/home/remote-renamed.txt",
        });
      });

      // Local entries cannot be renamed via the hook
      invoke.mockClear();
      w.__e2eExplorerStartRename?.("notes.txt", "local-renamed.txt");
      const localRenameCalls = invoke.mock.calls.filter((c) => c[0] === "sftp_rename" || c[0] === "local_rename");
      expect(localRenameCalls.length).toBe(0);

      // 4. __e2eExplorerChmod chmods in remote table
      await w.__e2eExplorerChmod?.("remote-file.txt", 0o777);
      const chmodCalls = invoke.mock.calls.filter((c) => c[0] === "sftp_chmod");
      expect(chmodCalls.length).toBeGreaterThan(0);
      expect(chmodCalls[0][1]).toEqual({
        sftpSessionId: "sftp-1",
        path: "/remote/home/remote-file.txt",
        mode: 0o777,
      });
    });

    it("focuses local search on Cmd+F when local pane holds focus, and remote search when remote holds focus", async () => {
      seedSftpSession("sftp-1", [MOCK_REMOTE_FILE]);
      render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" isActive />);

      expect(await screen.findByText("notes.txt")).toBeInTheDocument();
      expect(screen.getByText("remote-file.txt")).toBeInTheDocument();

      const localSection = screen.getByLabelText("Local filesystem");
      const remoteSection = screen.getByLabelText("Remote filesystem");

      const localSearchInput = within(localSection).getByTestId("explorer-search-input");
      const remoteSearchInput = within(remoteSection).getByTestId("explorer-search-input");

      // Focus an element in the local pane
      const localRow = within(localSection).getByTestId("explorer-entry-notes.txt");
      localRow.focus();
      expect(document.activeElement).toBe(localRow);

      // Fire Cmd+F
      fireEvent.keyDown(window, { key: "f", metaKey: true });

      // Local search input must receive focus, remote must not
      expect(document.activeElement).toBe(localSearchInput);
      expect(document.activeElement).not.toBe(remoteSearchInput);

      // Now focus an element in the remote pane
      const remoteRow = within(remoteSection).getByTestId("explorer-entry-remote-file.txt");
      remoteRow.focus();
      expect(document.activeElement).toBe(remoteRow);

      // Fire Cmd+F
      fireEvent.keyDown(window, { key: "f", metaKey: true });

      // Remote search input must receive focus, local must not
      expect(document.activeElement).toBe(remoteSearchInput);
      expect(document.activeElement).not.toBe(localSearchInput);
    });

    it("reaches only the remote pane when explorer:new-folder is dispatched", async () => {
      seedSftpSession("sftp-1", [MOCK_REMOTE_FILE]);
      render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" isActive />);

      expect(await screen.findByText("notes.txt")).toBeInTheDocument();
      expect(screen.getByText("remote-file.txt")).toBeInTheDocument();

      const localSection = screen.getByLabelText("Local filesystem");
      const remoteSection = screen.getByLabelText("Remote filesystem");

      // Dispatch document-level explorer:new-folder
      document.dispatchEvent(new CustomEvent("explorer:new-folder"));

      // Remote pane opens inline create folder row
      await waitFor(() => {
        expect(within(remoteSection).getByTestId("explorer-new-folder-input")).toBeInTheDocument();
      });

      // Local pane never receives or opens create folder row
      expect(within(localSection).queryByTestId("explorer-new-folder-input")).not.toBeInTheDocument();
    });

    it("exposes direction, item count, and busy states on transfer action buttons with visible focus rings", async () => {
      seedSftpSession("sftp-1", [MOCK_REMOTE_FILE]);
      render(<ExplorerPage sftpSessionId="sftp-1" transport="sftp" isActive />);

      expect(await screen.findByText("notes.txt")).toBeInTheDocument();
      expect(screen.getByText("remote-file.txt")).toBeInTheDocument();

      const copyToRemoteBtn = screen.getByTestId("explorer-copy-to-remote");
      const copyToLocalBtn = screen.getByTestId("explorer-copy-to-local");

      // Initially 0 items selected on both sides
      expect(copyToRemoteBtn).toHaveAttribute("aria-label", "Copy selected to remote (0 items)");
      expect(copyToLocalBtn).toHaveAttribute("aria-label", "Copy selected to local (0 items)");
      expect(copyToRemoteBtn).toBeDisabled();
      expect(copyToLocalBtn).toBeDisabled();

      // Has visible focus ring classes
      expect(copyToRemoteBtn).toHaveClass("focus-visible:ring-2");
      expect(copyToLocalBtn).toHaveClass("focus-visible:ring-2");

      // Select 1 local item
      const w = window as unknown as {
        __e2eExplorerSetSelectionLocal?: (names: string[]) => void;
      };
      w.__e2eExplorerSetSelectionLocal?.(["notes.txt"]);

      await waitFor(() => {
        expect(copyToRemoteBtn).toHaveAttribute("aria-label", "Copy selected to remote (1 item)");
        expect(copyToRemoteBtn).toBeEnabled();
      });
    });
  });
});
