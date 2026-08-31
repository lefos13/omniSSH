import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function seedSessions(sessions: SftpSession[], tabs: UnifiedTab[], activeId: string) {
  useSftpStore.setState({
    sessions: new Map(sessions.map((session) => [session.sftpSessionId, session])),
    activeSftpSessionId: activeId,
  });
  useTabStore.setState({
    tabs: new Map(tabs.map((tab) => [tab.id, tab])),
    tabOrder: tabs.map((tab) => tab.id),
    activeTabId: activeId,
  });
}

describe("SftpTabs transport-aware close", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useSftpStore.setState({ sessions: new Map(), activeSftpSessionId: null });
    useTabStore.setState({ tabs: new Map(), tabOrder: [], activeTabId: null });
  });

  /* A tab must retain native button activation behavior after its close action
   * is split into a sibling control, and the DOM must never nest buttons. */
  it("activates tabs with click and Enter or Space, with separate controls", () => {
    const first = makeSession("session-1");
    const second = makeSession("session-2");
    seedSessions(
      [first, second],
      [
        { type: "sftp", id: first.sftpSessionId, label: first.label },
        { type: "sftp", id: second.sftpSessionId, label: second.label },
      ],
      first.sftpSessionId,
    );

    const { container } = render(<SftpTabs />);
    const secondTab = screen.getByTestId("sftp-tab-session-2");

    fireEvent.click(secondTab);
    expect(useSftpStore.getState().activeSftpSessionId).toBe("session-2");

    fireEvent.keyDown(secondTab, { key: "Enter" });
    expect(useSftpStore.getState().activeSftpSessionId).toBe("session-2");
    fireEvent.keyDown(screen.getByTestId("sftp-tab-session-1"), { key: " " });
    expect(useSftpStore.getState().activeSftpSessionId).toBe("session-1");

    expect(container.querySelectorAll("button button")).toHaveLength(0);
  });

  it("closes from the keyboard without activating its tab", async () => {
    const first = makeSession("session-1");
    const second = makeSession("session-2");
    seedSessions(
      [first, second],
      [
        { type: "sftp", id: first.sftpSessionId, label: first.label },
        { type: "sftp", id: second.sftpSessionId, label: second.label },
      ],
      first.sftpSessionId,
    );

    render(<SftpTabs />);
    const close = screen.getByTestId("sftp-tab-session-2-close");
    close.focus();
    expect(document.activeElement).toBe(close);
    await userEvent.setup().keyboard("{Enter}");

    await waitFor(() => expect(useSftpStore.getState().sessions.has("session-2")).toBe(false));
    expect(useSftpStore.getState().activeSftpSessionId).toBe("session-1");
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
