import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSftpStore } from "../sftp-store";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function reset() {
  invoke.mockClear();
  useSftpStore.setState({
    sessions: new Map(),
    leftPane: new Map(),
    activeSftpSessionId: null,
    clipboard: null,
  });
}

describe("sftp-store left pane", () => {
  beforeEach(reset);

  it("binds, re-keys on session swap, and releases a remote left pane", async () => {
    const store = useSftpStore.getState();
    store.openSession("tab-1", "ssh-tab-1", "Right host", "root");
    store.openSession("left-1", "ssh-left-1", "Left host", "admin");

    store.setLeftPane("tab-1", {
      kind: "remote",
      sftpSessionId: "left-1",
      transport: "sftp",
      label: "Left host",
      hostId: "host-left",
    });
    expect(useSftpStore.getState().leftPane.get("tab-1")).toMatchObject({
      kind: "remote",
      sftpSessionId: "left-1",
    });

    // A sudo toggle re-keys the tab; the left binding must follow it.
    useSftpStore.getState().swapSession("tab-1", "tab-2", true);
    expect(useSftpStore.getState().leftPane.has("tab-1")).toBe(false);
    expect(useSftpStore.getState().leftPane.get("tab-2")).toMatchObject({
      sftpSessionId: "left-1",
    });

    // Closing the owning tab also releases the remote left session.
    useSftpStore.getState().closeSession("tab-2");
    await vi.waitFor(() => {
      expect(useSftpStore.getState().leftPane.has("tab-2")).toBe(false);
      expect(useSftpStore.getState().sessions.has("left-1")).toBe(false);
    });
  });

  it("falls back to local without touching sessions when the pane is already local", async () => {
    const store = useSftpStore.getState();
    store.openSession("tab-3", "ssh-tab-3", "Right host");

    // closeLeftPane with no binding is a no-op for the session map.
    await useSftpStore.getState().closeLeftPane("tab-3");
    expect(useSftpStore.getState().sessions.has("tab-3")).toBe(true);
  });
});
