/*
 * Unit tests for linked terminal explorer store.
 * Verifies panel toggling, width clamping, followPath state, SFTP/SCP connection lifecycle,
 * per-tab binding, idempotency, stale connection cleanup, and terminal disconnect hooks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useLinkedExplorerStore, _testTabGenerations } from "./linked-explorer-store";
import { useSessionStore } from "./session-store";
import { useSftpStore } from "./sftp-store";
import type { HostConfig } from "../types";

const dummyHost: HostConfig = {
  host: "10.0.0.1",
  port: 22,
  username: "root",
  auth_method: { type: "password", password: "pwd" },
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("linked-explorer-store", () => {
  beforeEach(() => {
    invoke.mockReset();
    useLinkedExplorerStore.setState({
      openTabIds: new Set(),
      panelWidth: 340,
      followPath: true,
      bindings: new Map(),
    });
    useSessionStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      tabs: new Map(),
      activeTerminalTabId: null,
      zoomedPaneId: null,
    });
    useSftpStore.setState({
      sessions: new Map(),
      activeSftpSessionId: null,
      clipboard: null,
    });
  });

  it("toggles and tracks open tabs correctly", () => {
    const store = useLinkedExplorerStore.getState();

    store.toggleLinkedExplorer("tab-1");
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(true);

    store.toggleLinkedExplorer("tab-1");
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(false);

    store.openLinkedExplorer("tab-2");
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-2")).toBe(true);

    store.closeLinkedExplorer("tab-2");
    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-2")).toBe(false);
  });

  it("clamps panel width to valid range [220, 800]", () => {
    const store = useLinkedExplorerStore.getState();

    store.setPanelWidth(100);
    expect(useLinkedExplorerStore.getState().panelWidth).toBe(220);

    store.setPanelWidth(1000);
    expect(useLinkedExplorerStore.getState().panelWidth).toBe(800);

    store.setPanelWidth(450);
    expect(useLinkedExplorerStore.getState().panelWidth).toBe(450);
  });

  it("toggles followPath setting", () => {
    const store = useLinkedExplorerStore.getState();

    store.setFollowPath(false);
    expect(useLinkedExplorerStore.getState().followPath).toBe(false);

    store.setFollowPath(true);
    expect(useLinkedExplorerStore.getState().followPath).toBe(true);
  });

  it("connects SFTP session, records transport metadata, and registers in sftp-store", async () => {
    useSessionStore.getState().addSession("ssh-1", dummyHost);
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "sftp_open") return "sftp-100";
      throw new Error(`Unexpected command ${cmd}`);
    });

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");
    const binding = await useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-1");

    expect(binding).not.toBeNull();
    expect(binding?.status).toBe("connected");
    expect(binding?.transport).toBe("sftp");
    expect(binding?.sftpSessionId).toBe("sftp-100");

    // Session must be in sftp-store with transport="sftp"
    const sftpSession = useSftpStore.getState().sessions.get("sftp-100");
    expect(sftpSession).toBeDefined();
    expect(sftpSession?.sshSessionId).toBe("ssh-1");
    expect(sftpSession?.transport).toBe("sftp");
  });

  it("falls back to SCP and records transport='scp' when SFTP open fails", async () => {
    useSessionStore.getState().addSession("ssh-2", dummyHost);
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "sftp_open") throw new Error("SFTP subsystem disabled");
      if (cmd === "scp_open") return "scp-200";
      throw new Error(`Unexpected command ${cmd}`);
    });

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");
    const binding = await useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-2");

    expect(binding).not.toBeNull();
    expect(binding?.status).toBe("connected");
    expect(binding?.transport).toBe("scp");
    expect(binding?.sftpSessionId).toBe("scp-200");

    const sftpSession = useSftpStore.getState().sessions.get("scp-200");
    expect(sftpSession).toBeDefined();
    expect(sftpSession?.transport).toBe("scp");
  });

  it("handles both SFTP and SCP failure gracefully", async () => {
    useSessionStore.getState().addSession("ssh-3", dummyHost);
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "sftp_open") throw new Error("SFTP unavailable");
      if (cmd === "scp_open") throw new Error("SCP unavailable");
      throw new Error(`Unexpected command ${cmd}`);
    });

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");
    const binding = await useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-3");

    expect(binding).not.toBeNull();
    expect(binding?.status).toBe("error");
    expect(binding?.error).toBe("SFTP unavailable");
  });

  it("closing linked explorer cleans up SFTP channel without disconnecting terminal SSH", async () => {
    useSessionStore.getState().addSession("ssh-1", dummyHost);
    invoke.mockResolvedValue("sftp-1");

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");
    await useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-1");

    expect(useSftpStore.getState().sessions.has("sftp-1")).toBe(true);
    expect(useLinkedExplorerStore.getState().bindings.has("tab-1")).toBe(true);

    // Close panel
    useLinkedExplorerStore.getState().closeLinkedExplorer("tab-1");

    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-1")).toBe(false);
    expect(useLinkedExplorerStore.getState().bindings.has("tab-1")).toBe(false);
    expect(useSftpStore.getState().sessions.has("sftp-1")).toBe(false);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp-1" }),
    );

    // Terminal SSH session remains connected and untouched
    expect(useSessionStore.getState().sessions.has("ssh-1")).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith("ssh_disconnect", expect.anything());
  });

  it("rebinding to another active pane cleans up previous pane's binding and channel", async () => {
    useSessionStore.getState().addSession("ssh-pane-1", dummyHost);
    useSessionStore.getState().addSession("ssh-pane-2", { ...dummyHost, host: "10.0.0.2" });

    invoke.mockImplementation(async (cmd, args) => {
      if (
        cmd === "sftp_open" &&
        args &&
        typeof args === "object" &&
        "sessionId" in args &&
        args.sessionId === "ssh-pane-1"
      ) {
        return "sftp-pane-1";
      }
      if (
        cmd === "sftp_open" &&
        args &&
        typeof args === "object" &&
        "sessionId" in args &&
        args.sessionId === "ssh-pane-2"
      ) {
        return "sftp-pane-2";
      }
      return undefined;
    });

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");

    // Connect first pane
    await useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-pane-1");
    expect(useSftpStore.getState().sessions.has("sftp-pane-1")).toBe(true);
    expect(useLinkedExplorerStore.getState().bindings.get("tab-1")?.sshSessionId).toBe("ssh-pane-1");

    // Rebind to second pane
    await useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-pane-2");

    // Previous channel closed and removed from sftp-store
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp-pane-1" }),
    );
    expect(useSftpStore.getState().sessions.has("sftp-pane-1")).toBe(false);

    // New binding active
    expect(useLinkedExplorerStore.getState().bindings.get("tab-1")?.sshSessionId).toBe("ssh-pane-2");
    expect(useSftpStore.getState().sessions.has("sftp-pane-2")).toBe(true);
  });

  it("is idempotent: concurrent calls to ensureConnected reuse in-flight connection", async () => {
    useSessionStore.getState().addSession("ssh-idem", dummyHost);

    const { promise, resolve } = createDeferred<string>();
    invoke.mockImplementation((cmd) => {
      if (cmd === "sftp_open") return promise;
      return Promise.resolve(undefined);
    });

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");

    // Fire two ensureConnected calls concurrently
    const p1 = useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-idem");
    const p2 = useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-idem");

    // Only one sftp_open invocation started
    expect(invoke).toHaveBeenCalledTimes(1);

    resolve("sftp-idem-1");

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2);
    expect(r1?.sftpSessionId).toBe("sftp-idem-1");
  });

  it("closes stale connection if panel is closed while connection was in-flight", async () => {
    useSessionStore.getState().addSession("ssh-stale", dummyHost);

    const { promise, resolve } = createDeferred<string>();
    invoke.mockImplementation((cmd) => {
      if (cmd === "sftp_open") return promise;
      return Promise.resolve(undefined);
    });

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");
    const connectPromise = useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-stale");

    // User closes panel before connection completes
    useLinkedExplorerStore.getState().closeLinkedExplorer("tab-1");

    // Connection finishes late
    resolve("sftp-stale-late");

    const result = await connectPromise;
    expect(result).toBeNull();

    // Late channel was immediately closed on the backend and NOT registered in sftp-store
    expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp-stale-late" });
    expect(useSftpStore.getState().sessions.has("sftp-stale-late")).toBe(false);
  });

  it("closes stale connection and uses fresh connection when panel is closed and immediately reopened before old connection completes", async () => {
    useSessionStore.getState().addSession("ssh-race", dummyHost);

    const d1 = createDeferred<string>();
    const d2 = createDeferred<string>();

    let callCount = 0;
    invoke.mockImplementation((cmd) => {
      if (cmd === "sftp_open") {
        callCount++;
        return callCount === 1 ? d1.promise : d2.promise;
      }
      return Promise.resolve(undefined);
    });

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");
    const p1 = useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-race");

    // Close panel mid-flight
    useLinkedExplorerStore.getState().closeLinkedExplorer("tab-1");

    // Immediately reopen panel and connect again
    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");
    const p2 = useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-race");

    // Resolve old connect late
    d1.resolve("sftp-stale-old");
    const r1 = await p1;
    expect(r1).toBeNull();
    // Old channel closed on backend, not registered in sftp-store
    expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp-stale-old" });
    expect(useSftpStore.getState().sessions.has("sftp-stale-old")).toBe(false);

    // While fresh connect is still pending, call ensureConnected a third time
    const p3 = useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-race");
    expect(p3).toBe(p2);
    expect(callCount).toBe(2); // no third sftp_open

    // Resolve new connect
    d2.resolve("sftp-fresh-new");
    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2).not.toBeNull();
    expect(r2?.sftpSessionId).toBe("sftp-fresh-new");
    expect(r3?.sftpSessionId).toBe("sftp-fresh-new");
    expect(r2?.status).toBe("connected");
    expect(useSftpStore.getState().sessions.has("sftp-fresh-new")).toBe(true);
    expect(useLinkedExplorerStore.getState().bindings.get("tab-1")?.sftpSessionId).toBe("sftp-fresh-new");
  });
  it("automatically cleans up linked session when terminal session is removed", async () => {
    useSessionStore.getState().addSession("ssh-auto", dummyHost);
    invoke.mockResolvedValue("sftp-auto");

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-1");
    await useLinkedExplorerStore.getState().ensureConnected("tab-1", "ssh-auto");
    expect(useLinkedExplorerStore.getState().bindings.has("tab-1")).toBe(true);

    // Remove the owning terminal session
    useSessionStore.getState().removeSession("ssh-auto");

    // Subscription cleans up linked explorer binding and closes session
    expect(useLinkedExplorerStore.getState().bindings.has("tab-1")).toBe(false);
    expect(useSftpStore.getState().sessions.has("sftp-auto")).toBe(false);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp-auto" }),
    );
  });

  it("atomically closes linked panels and bindings when a remote SSH transport drops", async () => {
    useSessionStore.getState().addSession("ssh-drop", dummyHost);
    invoke.mockImplementation(async (command) => {
      if (command === "sftp_open") return "sftp-drop";
      return undefined;
    });

    useLinkedExplorerStore.getState().openLinkedExplorer("tab-drop");
    await useLinkedExplorerStore.getState().ensureConnected("tab-drop", "ssh-drop");

    const cleanup = useLinkedExplorerStore
      .getState()
      .disconnectBindingsForSshSession("ssh-drop");

    expect(useLinkedExplorerStore.getState().openTabIds.has("tab-drop")).toBe(false);
    expect(useLinkedExplorerStore.getState().bindings.has("tab-drop")).toBe(false);
    expect(useSftpStore.getState().sessions.has("sftp-drop")).toBe(false);
    expect(useSessionStore.getState().sessions.has("ssh-drop")).toBe(true);

    await cleanup;
    expect(invoke).toHaveBeenCalledWith("sftp_close", { sftpSessionId: "sftp-drop" });
    expect(invoke).not.toHaveBeenCalledWith("ssh_disconnect", expect.anything());
  });

  it("cleans up openTabIds when a terminal tab is removed (even with no binding established)", () => {
    useSessionStore.getState().addSession("ssh-open-only", dummyHost);
    useLinkedExplorerStore.getState().openLinkedExplorer("ssh-open-only");
    expect(useLinkedExplorerStore.getState().openTabIds.has("ssh-open-only")).toBe(true);

    // Remove session/tab
    useSessionStore.getState().removeSession("ssh-open-only");

    // openTabIds must be cleaned up
    expect(useLinkedExplorerStore.getState().openTabIds.has("ssh-open-only")).toBe(false);
  });

  it("clears a pre-binding panel on SSH disconnect without closing another session", async () => {
    useSessionStore.getState().addSession("ssh-open-only", dummyHost);
    useSessionStore.getState().addSession("ssh-other", dummyHost);
    useLinkedExplorerStore.getState().openLinkedExplorer("ssh-open-only");
    useLinkedExplorerStore.getState().openLinkedExplorer("ssh-other");

    await useLinkedExplorerStore.getState().disconnectBindingsForSshSession("ssh-open-only");

    expect(useLinkedExplorerStore.getState().openTabIds).toEqual(new Set(["ssh-other"]));
    expect(useLinkedExplorerStore.getState().bindings.size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions.has("ssh-open-only")).toBe(true);
    expect(useSessionStore.getState().sessions.get("ssh-open-only")?.status).not.toBe("Disconnected");
  });

  it("prunes generation entries when a terminal tab is removed after its panel was closed", async () => {
    useSessionStore.getState().addSession("ssh-gen-prune", dummyHost);
    invoke.mockResolvedValue("sftp-gen-prune");

    useLinkedExplorerStore.getState().openLinkedExplorer("ssh-gen-prune");
    await useLinkedExplorerStore.getState().ensureConnected("ssh-gen-prune", "ssh-gen-prune");

    // Close panel while terminal tab is still alive
    useLinkedExplorerStore.getState().closeLinkedExplorer("ssh-gen-prune");

    // Later remove the terminal tab
    useSessionStore.getState().removeSession("ssh-gen-prune");

    // Subscription must prune generation state for the removed tab
    expect(_testTabGenerations.get("ssh-gen-prune")).toBeUndefined();
  });
});
