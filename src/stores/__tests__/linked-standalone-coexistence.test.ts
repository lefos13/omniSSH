/*
 * Tests for linked explorer and standalone explorer coexistence.
 * Verifies that a linked terminal explorer panel and a standalone explorer tab can
 * run concurrently on the same host or distinct hosts, maintaining independent
 * session IDs, directories, selection states, and tab lifecycles without collisions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useSessionStore } from "../session-store";
import { useLinkedExplorerStore } from "../linked-explorer-store";
import { useSftpStore } from "../sftp-store";
import { useTabStore } from "../tab-store";
import type { HostConfig } from "../../types";

const sampleHost: HostConfig = {
  host: "node.cluster.local",
  port: 22,
  username: "admin",
  auth_method: { type: "password", password: "pwd" },
};

describe("Linked and standalone explorer coexistence", () => {
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
    useTabStore.setState({
      tabs: new Map(),
      tabOrder: [],
      activeTabId: null,
    });
  });

  it("manages distinct SFTP sessions and separate directories for linked and standalone explorers", async () => {
    const termSessionId = "ssh-sess-1";
    const termTabId = termSessionId;
    const standaloneSftpId = "sftp-standalone-100";
    const linkedSftpId = "sftp-linked-200";

    // 1. Create terminal session and tab
    useSessionStore.getState().addSession(termSessionId, sampleHost);
    useTabStore.getState().addTab({
      type: "terminal",
      id: termTabId,
      label: "admin@node.cluster.local",
    });

    // 2. Create standalone explorer tab
    useSftpStore.getState().openSession(
      standaloneSftpId,
      "ssh-standalone-source",
      "Standalone Explorer",
      "admin",
      false,
      "/etc",
    );
    useTabStore.getState().addTab({
      type: "sftp",
      id: standaloneSftpId,
      label: "Standalone Explorer",
    });

    // 3. Open linked explorer in terminal tab
    invoke.mockResolvedValueOnce(linkedSftpId); // sftp_open
    useLinkedExplorerStore.getState().openLinkedExplorer(termTabId);
    const binding = await useLinkedExplorerStore
      .getState()
      .ensureConnected(termTabId, termSessionId);

    expect(binding?.sftpSessionId).toBe(linkedSftpId);

    // 4. Verify both sessions exist independently in sftp-store
    const sftpStore = useSftpStore.getState();
    expect(sftpStore.sessions.size).toBe(2);
    expect(sftpStore.sessions.has(standaloneSftpId)).toBe(true);
    expect(sftpStore.sessions.has(linkedSftpId)).toBe(true);

    // 5. Navigate standalone explorer to /etc/nginx
    sftpStore.setEntries(standaloneSftpId, "/etc/nginx", []);
    // Navigate linked explorer to /var/log
    sftpStore.setEntries(linkedSftpId, "/var/log", []);

    const updatedStandalone = useSftpStore.getState().sessions.get(standaloneSftpId);
    const updatedLinked = useSftpStore.getState().sessions.get(linkedSftpId);

    expect(updatedStandalone?.currentPath).toBe("/etc/nginx");
    expect(updatedLinked?.currentPath).toBe("/var/log");

    // 6. Switching active tabs synchronizes active session without mutating paths
    useTabStore.getState().setActiveTab(termTabId);
    expect(useSessionStore.getState().activeTerminalTabId).toBe(termTabId);
    expect(useLinkedExplorerStore.getState().openTabIds.has(termTabId)).toBe(true);

    useTabStore.getState().setActiveTab(standaloneSftpId);
    expect(useSftpStore.getState().activeSftpSessionId).toBe(standaloneSftpId);

    // 7. Closing linked explorer does not close or mutate standalone explorer
    invoke.mockResolvedValueOnce(undefined); // sftp_close for linked
    useLinkedExplorerStore.getState().closeLinkedExplorer(termTabId);

    expect(useLinkedExplorerStore.getState().openTabIds.has(termTabId)).toBe(false);
    expect(useSftpStore.getState().sessions.has(linkedSftpId)).toBe(false);
    expect(useSftpStore.getState().sessions.has(standaloneSftpId)).toBe(true);
    expect(useTabStore.getState().tabs.has(standaloneSftpId)).toBe(true);

    // 8. Closing standalone explorer tab leaves terminal tab intact
    invoke.mockResolvedValueOnce(undefined); // sftp_close for standalone
    useSftpStore.getState().closeSession(standaloneSftpId);
    useTabStore.getState().removeTab(standaloneSftpId);

    expect(useSftpStore.getState().sessions.has(standaloneSftpId)).toBe(false);
    expect(useTabStore.getState().tabs.has(termTabId)).toBe(true);
    expect(useSessionStore.getState().sessions.has(termSessionId)).toBe(true);
  });
});
