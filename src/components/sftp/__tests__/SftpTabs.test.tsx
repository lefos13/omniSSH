import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SftpTabs } from "../SftpTabs";
import { useSftpStore, type SftpSession } from "../../../stores/sftp-store";
import { useTabStore, type UnifiedTab } from "../../../stores/tab-store";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const makeSession = (id: string, transport?: "sftp" | "scp"): SftpSession => ({
  sftpSessionId: id,
  sshSessionId: "ssh-1",
  label: id,
  username: "user",
  sudoMode: false,
  currentPath: "/",
  startDirectory: "",
  entries: [],
  loading: false,
  error: null,
  sortBy: "name",
  sortAsc: true,
  transport,
});

function seedSession(session: SftpSession, tab: UnifiedTab) {
  useSftpStore.setState({
    sessions: new Map([[session.sftpSessionId, session]]),
    activeSftpSessionId: session.sftpSessionId,
  });
  useTabStore.setState({
    tabs: new Map([[tab.id, tab]]),
    tabOrder: [tab.id],
    activeTabId: tab.id,
  });
}

describe("SftpTabs transport-aware close", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null });
    useTabStore.setState({ tabs: new Map(), tabOrder: [], activeTabId: null });
  });

  /* SftpTabs is also used by the fallback explorer surface, so its close
   * button must release the backend manager matching the unified tab transport. */
  it.each([
    ["sftp", "sftp_close", { sftpSessionId: "session-1" }],
    ["scp", "scp_close", { scpSessionId: "session-1" }],
  ] as const)("dispatches %s sessions to the matching close command", async (transport, command, args) => {
    const session = makeSession("session-1");
    seedSession(session, {
      type: "sftp",
      id: session.sftpSessionId,
      label: session.label,
      transport,
    });

    render(<SftpTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close session-1" }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith(command, args));
    expect(useSftpStore.getState().sessions.has(session.sftpSessionId)).toBe(false);
  });

  /* A session's transport is authoritative when a tab is stale or carries a
   * fallback value from an older render; the tab remains the compatibility
   * fallback for sessions created before transport metadata was stored. */
  it("prefers session transport metadata over the tab fallback", async () => {
    const session = makeSession("session-1", "scp");
    seedSession(session, {
      type: "sftp",
      id: session.sftpSessionId,
      label: session.label,
      transport: "sftp",
    });

    render(<SftpTabs />);
    fireEvent.click(screen.getByRole("button", { name: "Close session-1" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("scp_close", { scpSessionId: "session-1" }),
    );
    expect(invoke).not.toHaveBeenCalledWith("sftp_close", { sftpSessionId: "session-1" });
  });
});
