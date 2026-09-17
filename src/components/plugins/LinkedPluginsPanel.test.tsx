/* The linked plugins panel follows the focused pane (like the linked
 * explorer) and blocks with the same message style while input sync is on. */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { LinkedPluginsPanel } from "./LinkedPluginsPanel";
import { useSessionStore } from "../../stores/session-store";
import { useSettingsStore } from "../../stores/settings-store";
import { usePluginConfigStore } from "../../stores/plugin-config-store";
import { execOnSession } from "../../lib/trackers";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
}));

vi.mock("../../lib/trackers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/trackers")>();
  return { ...actual, execOnSession: vi.fn(async () => ({ stdout: "log line", stderr: "", exitCode: 0 })) };
});

function seedTab(tabId: string, sessionIds: string[], activeSessionId: string | null, synced = false) {
  const sessions = new Map(
    sessionIds.map((id) => [id, {
      id,
      hostConfig: { host: "h", port: 22, username: "u", auth_method: { type: "password", password: "" }, savedHostId: "host-1" },
      status: "Connected",
      label: id,
    }]),
  );
  const layout = sessionIds.length === 1
    ? { type: "pane", sessionId: sessionIds[0] }
    : { type: "split", direction: "horizontal", children: sessionIds.map((s) => ({ type: "pane", sessionId: s })) };
  useSessionStore.setState({ sessions, tabs: new Map([[tabId, { id: tabId, layout }]]), activeSessionId, syncedTabIds: new Set(synced ? [tabId] : []) } as never);
}

describe("LinkedPluginsPanel", () => {
  beforeEach(() => {
    useSettingsStore.setState({ pluginsEnabled: true });
    usePluginConfigStore.setState({ byHostId: { "host-1": { cron: { enabled: true, config: {} } } } });
  });

  it("follows the focused pane session", () => {
    seedTab("tab-1", ["s1", "s2"], "s2");
    render(<LinkedPluginsPanel tabId="tab-1" isActive />);
    expect(screen.getByTestId("linked-plugins-panel")).toBeInTheDocument();
    expect(screen.getByTestId("tracker-cron")).toBeInTheDocument();
  });

  it("shows the synced blocking message in split+synced mode", () => {
    seedTab("tab-1", ["s1", "s2"], "s1", true);
    render(<LinkedPluginsPanel tabId="tab-1" isActive />);
    expect(screen.getByTestId("linked-plugins-synced-blocked")).toHaveTextContent("Plugins Unavailable");
    expect(screen.queryByTestId("tracker-cron")).not.toBeInTheDocument();
  });

  it("deep link enables the log viewer and primes it with the file path", async () => {
    seedTab("tab-1", ["s1"], "s1");
    vi.mocked(execOnSession).mockClear();
    const { useLinkedPluginsStore } = await import("../../stores/linked-plugins-store");
    useLinkedPluginsStore.setState({ openTabIds: new Set(["tab-1"]) });
    usePluginConfigStore.setState({ byHostId: {} });
    useLinkedPluginsStore.getState().openLogTail("tab-1", "/var/log/app.log");
    render(<LinkedPluginsPanel tabId="tab-1" isActive />);
    expect(screen.getByTestId("tracker-logs")).toBeInTheDocument();
    expect(screen.getByTestId("tracker-logs-path")).toHaveValue("/var/log/app.log");
    await waitFor(() => {
      expect(execOnSession).toHaveBeenCalledWith("s1", expect.stringContaining("/var/log/app.log"));
    });
    expect(await screen.findByTestId("tracker-logs-view")).toHaveTextContent("log line");
  });
});
