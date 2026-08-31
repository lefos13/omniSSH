/*
 * Tests for two protocol channels multiplexed over a single SSH connection.
 * Verifies that a single SSH session ID can support both an interactive terminal PTY
 * channel and a linked SFTP/SCP file transfer channel simultaneously, with isolated
 * lifecycles and reliable teardown upon SSH disconnect.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useSessionStore } from "../session-store";
import { useLinkedExplorerStore } from "../linked-explorer-store";
import { useSftpStore } from "../sftp-store";
import type { HostConfig } from "../../types";

const mockHost: HostConfig = {
  host: "ssh.example.com",
  port: 22,
  username: "tester",
  auth_method: { type: "password", password: "secret" },
};

describe("Two protocol channels over one SSH session", () => {
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

  it("opens an SFTP protocol channel over an existing active SSH terminal session", async () => {
    const sshSessionId = "ssh-conn-101";
    // In session-store, addSession creates a tab with tabId = sshSessionId
    const tabId = sshSessionId;

    // 1. Establish terminal session and verify layout tab exists
    useSessionStore.getState().addSession(sshSessionId, mockHost);
    expect(useSessionStore.getState().sessions.get(sshSessionId)?.status).toBe("Connected");
    expect(useSessionStore.getState().tabs.has(tabId)).toBe(true);

    // 2. Open linked explorer SFTP channel over the same SSH session
    invoke.mockResolvedValueOnce("sftp-chan-202"); // sftp_open response

    useLinkedExplorerStore.getState().openLinkedExplorer(tabId);
    const binding = await useLinkedExplorerStore.getState().ensureConnected(tabId, sshSessionId);

    expect(invoke).toHaveBeenCalledWith("sftp_open", { sessionId: sshSessionId });
    expect(binding).toBeDefined();
    expect(binding?.status).toBe("connected");
    expect(binding?.sftpSessionId).toBe("sftp-chan-202");
    expect(binding?.sshSessionId).toBe(sshSessionId);
    expect(binding?.transport).toBe("sftp");

    // 3. Both channels exist in their respective stores under the same SSH session
    expect(useSessionStore.getState().sessions.has(sshSessionId)).toBe(true);
    expect(useSftpStore.getState().sessions.has("sftp-chan-202")).toBe(true);
    expect(useSftpStore.getState().sessions.get("sftp-chan-202")?.sshSessionId).toBe(sshSessionId);
  });

  it("closing the SFTP protocol channel leaves the terminal SSH session fully connected", async () => {
    const sshSessionId = "ssh-conn-301";
    const tabId = sshSessionId;

    useSessionStore.getState().addSession(sshSessionId, mockHost);
    invoke.mockResolvedValueOnce("sftp-chan-302"); // sftp_open

    useLinkedExplorerStore.getState().openLinkedExplorer(tabId);
    await useLinkedExplorerStore.getState().ensureConnected(tabId, sshSessionId);

    // Close the linked explorer panel (SFTP channel)
    invoke.mockResolvedValueOnce(undefined); // sftp_close
    useLinkedExplorerStore.getState().closeLinkedExplorer(tabId);

    expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp-chan-302" });

    // SFTP session is removed from sftp-store
    expect(useSftpStore.getState().sessions.has("sftp-chan-302")).toBe(false);

    // Terminal SSH session is completely untouched and remains Connected
    const terminalSession = useSessionStore.getState().sessions.get(sshSessionId);
    expect(terminalSession).toBeDefined();
    expect(terminalSession?.status).toBe("Connected");
  });

  it("disconnecting the parent SSH session automatically closes and cleans up the linked protocol channel", async () => {
    const sshSessionId = "ssh-conn-401";
    const tabId = sshSessionId;

    useSessionStore.getState().addSession(sshSessionId, mockHost);
    invoke.mockResolvedValueOnce("sftp-chan-402"); // sftp_open

    useLinkedExplorerStore.getState().openLinkedExplorer(tabId);
    await useLinkedExplorerStore.getState().ensureConnected(tabId, sshSessionId);

    expect(useLinkedExplorerStore.getState().bindings.has(tabId)).toBe(true);
    expect(useSftpStore.getState().sessions.has("sftp-chan-402")).toBe(true);

    // Simulate SSH session removal in session-store (which removes the tab from session-store.tabs)
    invoke.mockResolvedValueOnce(undefined); // sftp_close cleanup
    useSessionStore.getState().removeSession(sshSessionId);

    // Linked binding and sftp-store session are cleaned up via session-store subscriber
    expect(useSessionStore.getState().sessions.has(sshSessionId)).toBe(false);
    expect(useLinkedExplorerStore.getState().bindings.has(tabId)).toBe(false);
    expect(useLinkedExplorerStore.getState().openTabIds.has(tabId)).toBe(false);
    expect(useSftpStore.getState().sessions.has("sftp-chan-402")).toBe(false);
  });

  it("remote transport drop dispatches disconnectBindingsForSshSession immediately", async () => {
    const sshSessionId = "ssh-conn-501";
    const tabId = sshSessionId;

    useSessionStore.getState().addSession(sshSessionId, mockHost);
    invoke.mockResolvedValueOnce("sftp-chan-502"); // sftp_open

    useLinkedExplorerStore.getState().openLinkedExplorer(tabId);
    await useLinkedExplorerStore.getState().ensureConnected(tabId, sshSessionId);

    // Trigger atomic remote transport drop cleanup
    await useLinkedExplorerStore.getState().disconnectBindingsForSshSession(sshSessionId);

    expect(useLinkedExplorerStore.getState().bindings.has(tabId)).toBe(false);
    expect(useLinkedExplorerStore.getState().openTabIds.has(tabId)).toBe(false);
    expect(useSftpStore.getState().sessions.has("sftp-chan-502")).toBe(false);
  });
});
