import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Tauri module mocks ───────────────────────────────────────────────────────
// ExplorerView imports `invoke` at module level and lazily imports the dialog
// plugin, the event channel, and the drag-drop webview API. Mock them all so
// the component mounts in jsdom without a real Tauri runtime.

type DragDropPayload = {
  type: "enter" | "over" | "drop" | "leave";
  paths: string[];
  position?: { x: number; y: number };
};
type DragDropCallback = (event: { payload: DragDropPayload }) => void;

const { invoke, dialogOpen, dropListeners } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => [] as unknown),
  dialogOpen: vi.fn(),
  dropListeners: { current: null as DragDropCallback | null },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpen }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: vi.fn(async (cb: DragDropCallback) => {
      dropListeners.current = cb;
      return () => {
        dropListeners.current = null;
      };
    }),
  }),
}));

import { ExplorerView } from "./ExplorerView";
import { useSftpStore } from "../../stores/sftp-store";
import type { SftpEntry } from "../../types";
const SESSION_ID = "sess-1";
const CURRENT_PATH = "/home/user";

function seedSession(): void {
  const store = useSftpStore.getState();
  store.openSession(SESSION_ID, "ssh-1", "Test host", "user");
  // Drive currentPath to a non-root dir so we can assert remoteDir precisely.
  store.setEntries(SESSION_ID, CURRENT_PATH, []);
}

const MOCK_FILE_ENTRY: SftpEntry = {
  name: "oldfilename.jpeg",
  path: `${CURRENT_PATH}/oldfilename.jpeg`,
  entry_type: "File",
  size: 1024,
  permissions: 0o644,
  permissions_display: "-rw-r--r--",
  modified: 1700000000,
  is_symlink: false,
};

/** Find the enqueue_upload invoke call, if any. */
function enqueueCall(): unknown[] | undefined {
  return invoke.mock.calls.find((c) => c[0] === "sftp_enqueue_upload");
}

describe("ExplorerView — upload button", () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockResolvedValue([]);
    dialogOpen.mockReset();
    // Fresh store between tests.
    useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
    seedSession();
  });

  it("opens the native file picker and enqueues the selected files (issue #69)", async () => {
    dialogOpen.mockResolvedValue(["/local/a.txt", "/local/b.txt"]);

    render(<ExplorerView sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByTestId("explorer-upload"));

    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    expect(dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: true }),
    );

    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toEqual({
      sftpSessionId: SESSION_ID,
      localPaths: ["/local/a.txt", "/local/b.txt"],
      remoteDir: CURRENT_PATH,
    });
  });

  it("normalizes a single-path selection into a one-element array", async () => {
    dialogOpen.mockResolvedValue("/local/only.txt");

    render(<ExplorerView sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByTestId("explorer-upload"));

    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toMatchObject({
      localPaths: ["/local/only.txt"],
      remoteDir: CURRENT_PATH,
    });
  });

  it("enqueues nothing when the picker is cancelled", async () => {
    dialogOpen.mockResolvedValue(null);

    render(<ExplorerView sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByTestId("explorer-upload"));

    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    // Give any (incorrect) follow-up invoke a chance to fire before asserting.
    await Promise.resolve();
    expect(enqueueCall()).toBeUndefined();
  });

  it("opens the folder picker in directory mode and enqueues the selected folders", async () => {
    dialogOpen.mockResolvedValue(["/local/projects", "/local/assets"]);

    render(<ExplorerView sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByTestId("explorer-upload-folder"));

    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    expect(dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: true }),
    );

    // A picked folder is handed to the same enqueue path as files; the backend
    // recreates it remotely and walks it recursively.
    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toEqual({
      sftpSessionId: SESSION_ID,
      localPaths: ["/local/projects", "/local/assets"],
      remoteDir: CURRENT_PATH,
    });
  });

  it("enqueues nothing when the folder picker is cancelled", async () => {
    dialogOpen.mockResolvedValue(null);

    render(<ExplorerView sessionId={SESSION_ID} />);
    fireEvent.click(await screen.findByTestId("explorer-upload-folder"));

    await waitFor(() => expect(dialogOpen).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(enqueueCall()).toBeUndefined();
  });
});

describe("ExplorerView — drag-and-drop upload and conflict handling", () => {
  beforeEach(() => {
    invoke.mockClear();
    invoke.mockResolvedValue([]);
    dialogOpen.mockReset();
    dropListeners.current = null;
    useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null, clipboard: null });
    seedSession();
  });

  it("enqueues dropped files directly when there are no conflicting names", async () => {
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === "sftp_list_dir") return [];
      return [];
    });

    render(<ExplorerView sessionId={SESSION_ID} isActive />);
    await waitFor(() => expect(dropListeners.current).not.toBeNull());

    dropListeners.current!({
      payload: { type: "drop", paths: ["/local/newfile.txt"] },
    });

    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toEqual({
      sftpSessionId: SESSION_ID,
      localPaths: ["/local/newfile.txt"],
      remoteDir: CURRENT_PATH,
    });
    expect(screen.queryByTestId("explorer-overwrite-confirm")).not.toBeInTheDocument();
  });

  it("shows overwrite dialog with Backup & Copy option when files conflict", async () => {
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === "sftp_list_dir") {
        return [MOCK_FILE_ENTRY];
      }
      return [];
    });

    render(<ExplorerView sessionId={SESSION_ID} isActive />);
    await waitFor(() => expect(dropListeners.current).not.toBeNull());

    dropListeners.current!({
      payload: { type: "drop", paths: ["/local/oldfilename.jpeg"] },
    });

    expect(await screen.findByTestId("explorer-overwrite-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("explorer-overwrite-backup-button")).toBeInTheDocument();
    expect(screen.getByTestId("explorer-overwrite-confirm-button")).toBeInTheDocument();
    expect(enqueueCall()).toBeUndefined();
  });

  it("cancels drop without uploading or renaming when Cancel is clicked", async () => {
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === "sftp_list_dir") {
        return [MOCK_FILE_ENTRY];
      }
      return [];
    });

    render(<ExplorerView sessionId={SESSION_ID} isActive />);
    await waitFor(() => expect(dropListeners.current).not.toBeNull());

    dropListeners.current!({
      payload: { type: "drop", paths: ["/local/oldfilename.jpeg"] },
    });

    const cancelBtn = await screen.findByTestId("explorer-overwrite-cancel");
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("explorer-overwrite-confirm")).not.toBeInTheDocument();
    });
    expect(enqueueCall()).toBeUndefined();
    expect(invoke.mock.calls.find((c) => c[0] === "sftp_rename")).toBeUndefined();
  });

  it("overwrites directly without renaming when Overwrite is clicked", async () => {
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === "sftp_list_dir") {
        return [MOCK_FILE_ENTRY];
      }
      return [];
    });

    render(<ExplorerView sessionId={SESSION_ID} isActive />);
    await waitFor(() => expect(dropListeners.current).not.toBeNull());

    dropListeners.current!({
      payload: { type: "drop", paths: ["/local/oldfilename.jpeg"] },
    });

    const overwriteBtn = await screen.findByTestId("explorer-overwrite-confirm-button");
    fireEvent.click(overwriteBtn);

    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toEqual({
      sftpSessionId: SESSION_ID,
      localPaths: ["/local/oldfilename.jpeg"],
      remoteDir: CURRENT_PATH,
    });
    expect(invoke.mock.calls.find((c) => c[0] === "sftp_rename")).toBeUndefined();
  });

  it("renames existing files to .YYYYMMDD.bak and uploads when Backup & Copy is clicked", async () => {
    invoke.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === "sftp_list_dir") {
        return [MOCK_FILE_ENTRY];
      }
      return [];
    });

    render(<ExplorerView sessionId={SESSION_ID} isActive />);
    await waitFor(() => expect(dropListeners.current).not.toBeNull());

    dropListeners.current!({
      payload: { type: "drop", paths: ["/local/oldfilename.jpeg"] },
    });

    const backupBtn = await screen.findByTestId("explorer-overwrite-backup-button");
    fireEvent.click(backupBtn);

    await waitFor(() => {
      const renameCall = invoke.mock.calls.find((c) => c[0] === "sftp_rename");
      expect(renameCall).toBeDefined();
      expect(renameCall?.[1]).toEqual({
        sftpSessionId: SESSION_ID,
        oldPath: `${CURRENT_PATH}/oldfilename.jpeg`,
        newPath: expect.stringMatching(new RegExp(`^${CURRENT_PATH}/oldfilename\\.jpeg\\.\\d{8}\\.bak$`)),
      });
    });

    await waitFor(() => expect(enqueueCall()).toBeDefined());
    expect(enqueueCall()?.[1]).toEqual({
      sftpSessionId: SESSION_ID,
      localPaths: ["/local/oldfilename.jpeg"],
      remoteDir: CURRENT_PATH,
    });
  });

  it("ignores drops outside the remote pane subtree when position hit-test fails", async () => {
    const externalDiv = document.createElement("div");
    externalDiv.setAttribute("data-explorer-pane", "local");
    document.body.appendChild(externalDiv);

    const origElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => externalDiv);

    try {
      render(<ExplorerView sessionId={SESSION_ID} isActive />);
      await waitFor(() => expect(dropListeners.current).not.toBeNull());

      dropListeners.current!({
        payload: {
          type: "drop",
          paths: ["/local/file-over-local-pane.txt"],
          position: { x: 150, y: 200 },
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(enqueueCall()).toBeUndefined();
      expect(screen.queryByTestId("explorer-overwrite-confirm")).not.toBeInTheDocument();
    } finally {
      document.elementFromPoint = origElementFromPoint;
      document.body.removeChild(externalDiv);
    }
  });
});
