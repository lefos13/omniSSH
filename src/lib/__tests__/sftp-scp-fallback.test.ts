/*
 * Tests for SFTP to SCP fallback mechanism and explorer transport dispatch.
 * Verifies that explorerInvoke routes commands to sftp_* and scp_* endpoints
 * with the correct session-id parameter keys, event channels, and store fallback state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { explorerInvoke, transferEventName } from "../explorer-transport";
import { useLinkedExplorerStore } from "../../stores/linked-explorer-store";
import { useSessionStore } from "../../stores/session-store";
import { useSftpStore } from "../../stores/sftp-store";
import type { HostConfig } from "../../types";

const fallbackHost: HostConfig = {
  host: "legacy-server.local",
  port: 22,
  username: "admin",
  auth_method: { type: "password", password: "pwd" },
};

describe("SFTP to SCP fallback and transport dispatch", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSessionStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      tabs: new Map(),
      activeTerminalTabId: null,
      zoomedPaneId: null,
    });
    useLinkedExplorerStore.setState({
      openTabIds: new Set(),
      bindings: new Map(),
      panelWidth: 340,
      followPath: true,
    });
    useSftpStore.setState({
      sessions: new Map(),
      activeSftpSessionId: null,
      clipboard: null,
    });
  });

  describe("explorerInvoke dispatcher", () => {
    it("returns correct transfer event names for sftp and scp", () => {
      expect(transferEventName("sftp")).toBe("sftp:transfer");
      expect(transferEventName("scp")).toBe("scp:transfer");
    });

    it("invokes SFTP commands with sftpSessionId key", async () => {
      invoke.mockResolvedValueOnce([{ name: "file.txt" }]);
      const res = await explorerInvoke("sftp", "list_dir", "sftp-123", { path: "/home" });

      expect(invoke).toHaveBeenCalledWith("sftp_list_dir", {
        sftpSessionId: "sftp-123",
        path: "/home",
      });
      expect(res).toEqual([{ name: "file.txt" }]);
    });

    it("invokes SCP commands with scpSessionId key", async () => {
      invoke.mockResolvedValueOnce(undefined);
      await explorerInvoke("scp", "create_file", "scp-456", { path: "/tmp/test.txt" });

      expect(invoke).toHaveBeenCalledWith("scp_create_file", {
        scpSessionId: "scp-456",
        path: "/tmp/test.txt",
      });
    });

    it("invokes production file operations (mkdir, delete, rename) with correct SCP signatures", async () => {
      invoke.mockResolvedValue(undefined);

      await explorerInvoke("scp", "mkdir", "scp-1", { path: "/dir" });
      expect(invoke).toHaveBeenCalledWith("scp_mkdir", { scpSessionId: "scp-1", path: "/dir" });

      await explorerInvoke("scp", "delete", "scp-1", { path: "/dir/a.txt", isDir: false });
      expect(invoke).toHaveBeenCalledWith("scp_delete", {
        scpSessionId: "scp-1",
        path: "/dir/a.txt",
        isDir: false,
      });

      await explorerInvoke("scp", "rename", "scp-1", { oldPath: "/dir/a.txt", newPath: "/dir/b.txt" });
      expect(invoke).toHaveBeenCalledWith("scp_rename", {
        scpSessionId: "scp-1",
        oldPath: "/dir/a.txt",
        newPath: "/dir/b.txt",
      });
    });
  });

  describe("linked explorer store fallback integration", () => {
    it("transparently falls back to SCP when sftp_open rejects and records transport='scp'", async () => {
      const sshSessionId = "ssh-fallback-01";
      const tabId = sshSessionId; // Owner tab ID matches initial SSH session

      useSessionStore.getState().addSession(sshSessionId, fallbackHost);
      useLinkedExplorerStore.getState().openLinkedExplorer(tabId);

      // sftp_open fails, scp_open succeeds
      invoke.mockRejectedValueOnce(new Error("SFTP subsystem disabled"));
      invoke.mockResolvedValueOnce("scp-chan-777");

      const binding = await useLinkedExplorerStore.getState().ensureConnected(tabId, sshSessionId);

      expect(binding).toBeDefined();
      expect(binding?.status).toBe("connected");
      expect(binding?.transport).toBe("scp");
      expect(binding?.sftpSessionId).toBe("scp-chan-777");

      // Verify registered in sftp-store with transport="scp"
      const sftpSession = useSftpStore.getState().sessions.get("scp-chan-777");
      expect(sftpSession).toBeDefined();
      expect(sftpSession?.transport).toBe("scp");
    });

    it("uses scp_close when closing an SCP-backed linked explorer session", async () => {
      const sshSessionId = "ssh-fallback-02";
      const tabId = sshSessionId;

      useSessionStore.getState().addSession(sshSessionId, fallbackHost);
      useLinkedExplorerStore.getState().openLinkedExplorer(tabId);

      invoke.mockRejectedValueOnce(new Error("SFTP subsystem disabled"));
      invoke.mockResolvedValueOnce("scp-chan-888");

      await useLinkedExplorerStore.getState().ensureConnected(tabId, sshSessionId);

      // Close the panel
      invoke.mockResolvedValueOnce(undefined);
      useLinkedExplorerStore.getState().closeLinkedExplorer(tabId);

      expect(invoke).toHaveBeenCalledWith("scp_close", { scpSessionId: "scp-chan-888" });
      expect(useSftpStore.getState().sessions.has("scp-chan-888")).toBe(false);
    });
  });
});
