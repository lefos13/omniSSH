/* Tracker view renders only enabled plugins for a connected session and
 * stays hidden otherwise (global switch off, disconnected, none enabled). */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PluginTrackersView } from "./PluginTrackersView";
import { useSettingsStore } from "../../stores/settings-store";
import { useSessionStore } from "../../stores/session-store";
import { usePluginConfigStore } from "../../stores/plugin-config-store";
import { execOnSession } from "../../lib/trackers";

vi.mock("../../lib/trackers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/trackers")>();
  return { ...actual, execOnSession: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })) };
});

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function seedSession(status: string, savedHostId?: string) {
  useSessionStore.setState({
    sessions: new Map([
      ["sess-1", {
        id: "sess-1",
        hostConfig: {
          host: "example.com", port: 22, username: "u",
          auth_method: { type: "password", password: "" },
          ...(savedHostId ? { savedHostId } : {}),
        },
        status: status as never,
        label: "prod-1",
      }],
    ]),
  } as never);
}

describe("PluginTrackersView", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    vi.mocked(execOnSession).mockReset();
    vi.mocked(execOnSession).mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    useSettingsStore.setState({ pluginsEnabled: true });
    usePluginConfigStore.setState({ byHostId: {} });
  });

  it("renders enabled tracker cards and skips disabled ones", () => {
    seedSession("Connected", "host-1");
    usePluginConfigStore.setState({
      byHostId: { "host-1": { docker: { enabled: true, config: {} }, pm2: { enabled: false, config: {} } } },
    });
    render(<PluginTrackersView sessionId="sess-1" />);
    expect(screen.getByTestId("plugin-trackers-view")).toBeInTheDocument();
    expect(screen.getByTestId("tracker-docker")).toBeInTheDocument();
    expect(screen.queryByTestId("tracker-pm2")).not.toBeInTheDocument();
  });

  it("hides when the global switch is off", () => {
    useSettingsStore.setState({ pluginsEnabled: false });
    seedSession("Connected", "host-1");
    usePluginConfigStore.setState({ byHostId: { "host-1": { docker: { enabled: true, config: {} } } } });
    const { container } = render(<PluginTrackersView sessionId="sess-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("hides when disconnected or when nothing is enabled", () => {
    seedSession("Disconnected", "host-1");
    usePluginConfigStore.setState({ byHostId: { "host-1": { docker: { enabled: true, config: {} } } } });
    expect(render(<PluginTrackersView sessionId="sess-1" />).container).toBeEmptyDOMElement();

    seedSession("Connected", "host-1");
    usePluginConfigStore.setState({ byHostId: { "host-1": {} } });
    expect(render(<PluginTrackersView sessionId="sess-1" />).container).toBeEmptyDOMElement();
  });

  it("kill action shows the exact interpolated command in the verification modal", async () => {
    seedSession("Connected", "host-1");
    usePluginConfigStore.setState({ byHostId: { "host-1": { health: { enabled: true, config: {} } } } });
    const { fireEvent } = await import("@testing-library/react");
    render(<PluginTrackersView sessionId="sess-1" />);
    fireEvent.change(screen.getByTestId("tracker-health-pid"), { target: { value: "1234" } });
    fireEvent.click(screen.getByTestId("tracker-health-kill"));
    expect(screen.getByTestId("action-verification-command")).toHaveTextContent("kill '1234'");
  });

  it("auto-tails when an initial log path is provided", async () => {
    seedSession("Connected", "host-1");
    vi.mocked(execOnSession).mockResolvedValue({ stdout: "line1\nline2", stderr: "", exitCode: 0 });
    usePluginConfigStore.setState({ byHostId: { "host-1": { logs: { enabled: true, config: {} } } } });
    render(<PluginTrackersView sessionId="sess-1" initialLogPath="/var/log/app.log" />);
    expect(screen.getByTestId("tracker-logs-path")).toHaveValue("/var/log/app.log");
    await waitFor(() => {
      expect(execOnSession).toHaveBeenCalledWith("sess-1", expect.stringContaining("/var/log/app.log"));
    });
    expect(await screen.findByTestId("tracker-logs-view")).toHaveTextContent("line1");
  });

  it("opens and closes the log viewer fullscreen overlay", async () => {
    seedSession("Connected", "host-1");
    vi.mocked(execOnSession).mockResolvedValue({ stdout: "hello", stderr: "", exitCode: 0 });
    usePluginConfigStore.setState({ byHostId: { "host-1": { logs: { enabled: true, config: {} } } } });
    render(<PluginTrackersView sessionId="sess-1" />);
    fireEvent.change(screen.getByTestId("tracker-logs-path"), { target: { value: "/var/log/app.log" } });
    fireEvent.click(screen.getByTestId("tracker-logs-tail"));
    expect(await screen.findByTestId("tracker-logs-view")).toHaveTextContent("hello");
    expect(screen.queryByTestId("tracker-logs-fullscreen")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tracker-logs-expand"));
    expect(screen.getByTestId("tracker-logs-fullscreen")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tracker-logs-fullscreen-close"));
    expect(screen.queryByTestId("tracker-logs-fullscreen")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tracker-logs-expand"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("tracker-logs-fullscreen")).not.toBeInTheDocument();
  });
});
