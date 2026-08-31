import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SavedHost } from "../../types";
import { HostCard } from "./HostCard";
import { HostListRow } from "./HostListRow";
import { HostsDashboard } from "./HostsDashboard";
import { useHostsStore } from "../../stores/hosts-store";
import { useGroupsStore } from "../../stores/groups-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useS3Store } from "../../stores/s3-store";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const sampleHostWithLabel: SavedHost = {
  id: "host-1",
  label: "Production DB",
  host: "192.168.1.100",
  port: 2222,
  username: "admin",
  auth_type: "password",
  group_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  key_path: null,
  color: "#3b82f6",
  notes: null,
  environment: "production",
  os_type: "linux",
  startup_command: null,
  proxy_jump: null,
  proxy_jump_host_id: null,
  start_directory: null,
  keep_alive_interval: null,
  default_shell: null,
  font_size: null,
  last_connected_at: null,
  connection_count: null,
};

const sampleHostWithoutLabel: SavedHost = {
  id: "host-2",
  label: "",
  host: "db.staging.internal",
  port: 22,
  username: "ubuntu",
  auth_type: "password",
  group_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  key_path: null,
  color: null,
  notes: null,
  environment: null,
  os_type: null,
  startup_command: null,
  proxy_jump: null,
  proxy_jump_host_id: null,
  start_directory: null,
  keep_alive_interval: null,
  default_shell: null,
  font_size: null,
  last_connected_at: null,
  connection_count: null,
};

/* Verifies card and list row host rendering, IP preview subtitle behavior,
 * and the dashboard view layout toggle. */
describe("Host UI enhancements", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_hosts") return [sampleHostWithLabel, sampleHostWithoutLabel];
      if (cmd === "list_groups") return [];
      if (cmd === "s3_list_connections") return [];
      if (cmd === "get_recent_connections") return [];
      return undefined;
    });
    useSettingsStore.setState({ hostsViewMode: "cards" });
    useHostsStore.setState({
      hosts: [sampleHostWithLabel, sampleHostWithoutLabel],
      recentConnections: [],
    });
    useGroupsStore.setState({ groups: [] });
    useS3Store.setState({ connections: [] });
  });

  describe("HostCard IP preview", () => {
    it("renders IP and port preview as subtitle when host has a label", () => {
      render(
        <HostCard
          host={sampleHostWithLabel}
          onConnect={() => {}}
          onExplore={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onDuplicate={() => {}}
        />,
      );

      expect(screen.getByText("Production DB")).toBeInTheDocument();
      expect(screen.getByText("192.168.1.100:2222")).toBeInTheDocument();
    });

    it("does not render separate IP preview when label is empty", () => {
      render(
        <HostCard
          host={sampleHostWithoutLabel}
          onConnect={() => {}}
          onExplore={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onDuplicate={() => {}}
        />,
      );

      expect(screen.getByText("db.staging.internal")).toBeInTheDocument();
      // Should not find duplicate text
      expect(screen.getAllByText("db.staging.internal")).toHaveLength(1);
    });
  });

  describe("HostListRow", () => {
    it("renders compact row with IP preview, action buttons, and host details", () => {
      const onConnect = vi.fn();
      const onExplore = vi.fn();

      render(
        <HostListRow
          host={sampleHostWithLabel}
          onConnect={onConnect}
          onExplore={onExplore}
          onEdit={() => {}}
          onDelete={() => {}}
          onDuplicate={() => {}}
        />,
      );

      expect(screen.getByTestId("host-card-host-1")).toBeInTheDocument();
      expect(screen.getByText("Production DB")).toBeInTheDocument();
      expect(screen.getByText("192.168.1.100:2222")).toBeInTheDocument();
      expect(screen.getByText("PROD")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("host-card-host-1-terminal"));
      expect(onConnect).toHaveBeenCalledWith(sampleHostWithLabel);

      fireEvent.click(screen.getByTestId("host-card-host-1-explorer"));
      expect(onExplore).toHaveBeenCalledWith(sampleHostWithLabel);
    });
  });

  describe("HostsDashboard", () => {
    it("renders single Import button in toolbar", () => {
      render(<HostsDashboard />);

      expect(screen.getByTestId("import-ssh-config-button")).toBeInTheDocument();
      expect(screen.getByTestId("import-ssh-config-button")).toHaveTextContent("Import");
      expect(screen.queryByTestId("import-mobaxterm-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("import-termius-button")).not.toBeInTheDocument();
    });

    it("toggles between cards view and list view", () => {
      render(<HostsDashboard />);

      const cardsBtn = screen.getByTestId("hosts-view-cards-button");
      const listBtn = screen.getByTestId("hosts-view-list-button");

      expect(cardsBtn).toHaveAttribute("aria-pressed", "true");
      expect(listBtn).toHaveAttribute("aria-pressed", "false");
      expect(useSettingsStore.getState().hostsViewMode).toBe("cards");

      fireEvent.click(listBtn);
      expect(useSettingsStore.getState().hostsViewMode).toBe("list");
      expect(cardsBtn).toHaveAttribute("aria-pressed", "false");
      expect(listBtn).toHaveAttribute("aria-pressed", "true");
    });
  });
});
