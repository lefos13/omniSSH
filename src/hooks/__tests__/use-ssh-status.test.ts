import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSshStatus } from "../use-ssh-status";
import { useSftpStore } from "../../stores/sftp-store";
import { pageTabId, useTabStore } from "../../stores/tab-store";
import type { SshStatusPayload } from "../../types";

/*
 * Exercise the global disconnect listener with real Zustand stores while
 * replacing only Tauri's event and IPC boundaries. This keeps the cleanup
 * assertions focused on the user-visible session and tab state.
 */

type StatusListener = (event: { payload: SshStatusPayload }) => void;

const { invoke, listen, unlisten } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

let statusListener: StatusListener | undefined;

function resetStores(): void {
  useSftpStore.setState({
    sessions: new Map(),
    activeSftpSessionId: null,
    clipboard: null,
  });
  useTabStore.setState({
    tabs: new Map([
      [pageTabId("hosts"), { type: "page", id: pageTabId("hosts"), label: "Hosts", page: "hosts" }],
    ]),
    tabOrder: [pageTabId("hosts")],
    activeTabId: pageTabId("hosts"),
  });
}

function emitStatus(sessionId: string, status: SshStatusPayload["status"]["status"]): void {
  statusListener?.({
    payload: {
      session_id: sessionId,
      status: { status },
    },
  });
}

describe("useSshStatus", () => {
  beforeEach(() => {
    statusListener = undefined;
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    unlisten.mockReset();
    listen.mockReset();
    listen.mockImplementation(async (_eventName: string, callback: StatusListener) => {
      statusListener = callback;
      return unlisten;
    });
    resetStores();
  });

  it("closes matching explorer sessions and removes their tabs on disconnect", async () => {
    useSftpStore.getState().openSession("sftp-1", "ssh-1", "host-1");
    useSftpStore.getState().openSession("sftp-2", "ssh-2", "host-2");
    useTabStore.getState().addTab({ type: "sftp", id: "sftp-1", label: "host-1" });
    useTabStore.getState().addTab({ type: "sftp", id: "sftp-2", label: "host-2" });

    renderHook(() => useSshStatus());
    await vi.waitFor(() => expect(statusListener).toBeDefined());

    await act(async () => {
      emitStatus("ssh-1", "Disconnected");
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp-1" }));
      await vi.waitFor(() => expect(useSftpStore.getState().sessions.has("sftp-1")).toBe(false));
    });

    expect(useSftpStore.getState().sessions.has("sftp-2")).toBe(true);
    expect(useTabStore.getState().tabs.has("sftp-1")).toBe(false);
    expect(useTabStore.getState().tabs.has("sftp-2")).toBe(true);
  });

  it("closes SCP fallback sessions through the SCP command", async () => {
    useSftpStore.getState().openSession("scp-1", "ssh-1", "host-1");
    useTabStore.getState().addTab({
      type: "sftp",
      id: "scp-1",
      label: "host-1",
      transport: "scp",
    });

    renderHook(() => useSshStatus());
    await vi.waitFor(() => expect(statusListener).toBeDefined());

    await act(async () => {
      emitStatus("ssh-1", "Disconnected");
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("scp_close", { scpSessionId: "scp-1" }));
      await vi.waitFor(() => expect(useSftpStore.getState().sessions.has("scp-1")).toBe(false));
    });

    expect(invoke).not.toHaveBeenCalledWith("sftp_close", { sftpSessionId: "scp-1" });
    expect(useTabStore.getState().tabs.has("scp-1")).toBe(false);
  });

  it("does not clean explorer sessions for Error events", async () => {
    useSftpStore.getState().openSession("sftp-1", "ssh-1", "host-1");
    useTabStore.getState().addTab({ type: "sftp", id: "sftp-1", label: "host-1" });

    renderHook(() => useSshStatus());
    await vi.waitFor(() => expect(statusListener).toBeDefined());

    act(() => emitStatus("ssh-1", "Error"));
    await Promise.resolve();

    expect(invoke).not.toHaveBeenCalled();
    expect(useSftpStore.getState().sessions.has("sftp-1")).toBe(true);
    expect(useTabStore.getState().tabs.has("sftp-1")).toBe(true);
  });
});
