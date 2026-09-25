import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { HostGroup, SavedHost } from "../../types";
import { HostCard } from "./HostCard";
import { HostListRow } from "./HostListRow";
import { HostsDashboard } from "./HostsDashboard";
import { useHostsStore } from "../../stores/hosts-store";
import { useGroupsStore } from "../../stores/groups-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useS3Store } from "../../stores/s3-store";
import { useUiStore } from "../../stores/ui-store";

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
  terminal_theme: null,
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
  terminal_theme: null,
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
    useUiStore.setState({ pendingHostsImport: null });
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

      const row = screen.getByTestId("host-card-host-1");
      expect(row).toBeInTheDocument();
      expect(row.className).not.toContain("overflow-hidden");
      expect(screen.getByText("Production DB")).toBeInTheDocument();
      expect(screen.getByText("192.168.1.100:2222")).toBeInTheDocument();
      expect(screen.getByText("PROD")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("host-card-host-1-terminal"));
      expect(onConnect).toHaveBeenCalledWith(sampleHostWithLabel);

      fireEvent.click(screen.getByTestId("host-card-host-1-explorer"));
      expect(onExplore).toHaveBeenCalledWith(sampleHostWithLabel);
    });

    it("renders action button tooltips for ping, terminal, and explorer without overflow clipping", () => {
      render(
        <HostListRow
          host={sampleHostWithLabel}
          onConnect={() => {}}
          onExplore={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onDuplicate={() => {}}
        />,
      );

      expect(screen.getByText("Ping")).toBeInTheDocument();
      expect(screen.getByText("Terminal")).toBeInTheDocument();
      expect(screen.getByText("Explorer")).toBeInTheDocument();
    });
  });

  describe("HostsDashboard", () => {
    it("renders single Import button and Import Passwords button in toolbar", () => {
      render(<HostsDashboard />);

      expect(screen.getByTestId("import-ssh-config-button")).toBeInTheDocument();
      expect(screen.getByTestId("import-ssh-config-button")).toHaveTextContent("Import");
      expect(screen.getByTestId("import-passwords-button")).toBeInTheDocument();
      expect(screen.getByTestId("import-passwords-button")).toHaveTextContent("Import Passwords");
      expect(screen.queryByTestId("import-mobaxterm-button")).not.toBeInTheDocument();
      expect(screen.queryByTestId("import-termius-button")).not.toBeInTheDocument();
    });

    it("opens Import Passwords modal when clicking import-passwords-button", () => {
      render(<HostsDashboard />);

      fireEvent.click(screen.getByTestId("import-passwords-button"));
      expect(screen.getByRole("heading", { name: "Import Passwords" })).toBeInTheDocument();
    });

    /* Settings → Data parks a one-shot request before switching tabs; this
     * dashboard must consume it on mount and never reopen the modal later. */
    it("opens Import Connections from a pending Settings deeplink exactly once", () => {
      useUiStore.getState().requestHostsImport();

      const { unmount } = render(<HostsDashboard />);
      expect(screen.getByRole("heading", { name: "Import Connections" })).toBeInTheDocument();
      expect(useUiStore.getState().pendingHostsImport).toBeNull();

      unmount();
      render(<HostsDashboard />);
      expect(screen.queryByRole("heading", { name: "Import Connections" })).not.toBeInTheDocument();
    });

    it("stays closed on a normal mount without a pending deeplink", () => {
      render(<HostsDashboard />);

      expect(screen.queryByRole("heading", { name: "Import Connections" })).not.toBeInTheDocument();
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

    it("switches to the grouped tree view", () => {
      render(<HostsDashboard />);

      const groupedBtn = screen.getByTestId("hosts-view-grouped-button");
      expect(groupedBtn).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(groupedBtn);
      expect(useSettingsStore.getState().hostsViewMode).toBe("grouped");
      expect(groupedBtn).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("hosts-grouped-view")).toBeInTheDocument();
    });

    it("renders a resizable groups sidebar with persisted width", () => {
      window.localStorage.clear();
      render(<HostsDashboard />);

      const sidebar = screen.getByTestId("groups-sidebar");
      const handle = screen.getByTestId("groups-sidebar-resize-handle");
      expect(sidebar).toHaveStyle({ width: "224px" });
      expect(handle).toHaveAttribute("role", "separator");
      expect(handle).toHaveAttribute("aria-label", "Resize groups sidebar");
      expect(handle).toHaveAttribute("aria-valuenow", "224");

      fireEvent.keyDown(handle, { key: "ArrowRight" });
      expect(sidebar).toHaveStyle({ width: "244px" });
      expect(window.localStorage.getItem("anyscp_groups_sidebar_width")).toBe("244");

      fireEvent.keyDown(handle, { key: "Home" });
      expect(sidebar).toHaveStyle({ width: "160px" });
    });

    /* Regression coverage for grouped-view section navigation. jsdom has no
     * layout, so section positions and scroll metrics are stubbed and the tests
     * drive the scroll events a smooth scroll emits. */
    describe("grouped view scroll-spy", () => {
      const groups: HostGroup[] = ["alpha", "beta", "gamma"].map((name, sort_order) => ({
        id: `group-${name}`,
        name: name.toUpperCase(),
        color: "#3b82f6",
        icon: null,
        sort_order,
        default_username: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }));

      const groupedHosts: SavedHost[] = [
        { ...sampleHostWithLabel, id: "host-alpha", group_id: "group-alpha" },
        { ...sampleHostWithoutLabel, id: "host-beta", group_id: "group-beta" },
      ];

      const scrollArea = () => screen.getByTestId("hosts-scroll-area");
      const section = (id: string) => screen.getByTestId(`group-section-${id}`);
      const row = (id: string) => screen.getByTestId(`group-sidebar-item-${id}`);

      const stubRect = (el: Element, top: number) =>
        vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
          top,
          bottom: top + 40,
          height: 40,
          left: 0,
          right: 0,
          width: 0,
          x: 0,
          y: top,
          toJSON: () => ({}),
        } as DOMRect);

      const stubScroll = (
        root: HTMLElement,
        metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
      ) => {
        for (const [key, value] of Object.entries(metrics)) {
          Object.defineProperty(root, key, { value, writable: true, configurable: true });
        }
        const scrollTo = vi.fn();
        Object.defineProperty(root, "scrollTo", {
          value: scrollTo,
          writable: true,
          configurable: true,
        });
        return scrollTo;
      };

      const renderGrouped = async () => {
        render(<HostsDashboard />);
        expect(await screen.findByTestId("hosts-grouped-view")).toBeInTheDocument();
      };

      beforeEach(() => {
        invoke.mockImplementation(async (cmd: string) => {
          if (cmd === "list_hosts") return groupedHosts;
          if (cmd === "list_groups") return groups;
          if (cmd === "sync_managed_by") return [];
          if (cmd === "s3_list_connections") return [];
          if (cmd === "get_recent_connections") return [];
          return undefined;
        });
        useHostsStore.setState({ hosts: groupedHosts, recentConnections: [] });
        useGroupsStore.setState({ groups });
        useS3Store.setState({ connections: [] });
        useSettingsStore.setState({ hostsViewMode: "grouped" });
      });

      it("scrolls the clicked section to the spy line and highlights its row", async () => {
        await renderGrouped();
        const scrollTo = stubScroll(scrollArea(), {
          scrollTop: 0,
          clientHeight: 800,
          scrollHeight: 4000,
        });
        stubRect(section("group-beta"), 500);

        fireEvent.click(row("group-beta"));

        expect(scrollTo).toHaveBeenCalledWith({ top: 500 - 16, behavior: "smooth" });
        expect(row("group-beta")).toHaveAttribute("aria-pressed", "true");
      });

      it("keeps the clicked row highlighted while the smooth scroll passes other sections", async () => {
        await renderGrouped();
        const root = scrollArea();
        stubScroll(root, { scrollTop: 300, clientHeight: 800, scrollHeight: 4000 });
        stubRect(section("group-gamma"), 2000);

        fireEvent.click(row("group-gamma"));
        expect(row("group-gamma")).toHaveAttribute("aria-pressed", "true");

        // The animation sweeps over the earlier sections and emits scroll events.
        stubRect(section("group-alpha"), -300);
        stubRect(section("group-beta"), 4);
        fireEvent.scroll(root);

        expect(row("group-gamma")).toHaveAttribute("aria-pressed", "true");
        expect(row("group-beta")).toHaveAttribute("aria-pressed", "false");
      });

      it("resumes the spy on the next real scroll gesture", async () => {
        await renderGrouped();
        const root = scrollArea();
        stubScroll(root, { scrollTop: 300, clientHeight: 800, scrollHeight: 4000 });
        stubRect(section("group-gamma"), 2000);
        fireEvent.click(row("group-gamma"));

        stubRect(section("group-alpha"), -300);
        stubRect(section("group-beta"), 4);
        fireEvent.wheel(root);
        fireEvent.scroll(root);

        expect(row("group-beta")).toHaveAttribute("aria-pressed", "true");
        expect(row("group-gamma")).toHaveAttribute("aria-pressed", "false");
      });

      it("highlights the last section when the list cannot scroll any further", async () => {
        await renderGrouped();
        const root = scrollArea();
        stubScroll(root, { scrollTop: 3200, clientHeight: 800, scrollHeight: 4000 });
        stubRect(section("group-alpha"), -3200);
        stubRect(section("group-beta"), -800);
        // Short trailing section: its header never reaches the spy line.
        stubRect(section("group-gamma"), 200);

        fireEvent.scroll(root);

        expect(row("group-gamma")).toHaveAttribute("aria-pressed", "true");
        expect(row("group-beta")).toHaveAttribute("aria-pressed", "false");
      });

      it("keeps a short trailing group selected when it cannot reach the top", async () => {
        await renderGrouped();
        const root = scrollArea();
        stubScroll(root, { scrollTop: 3200, clientHeight: 800, scrollHeight: 4000 });
        stubRect(section("group-beta"), -800);
        stubRect(section("group-gamma"), 200);

        fireEvent.click(row("group-beta"));
        // The scroll clamps at the bottom and keeps emitting events, but the
        // click selection must survive them.
        fireEvent.scroll(root);

        expect(row("group-beta")).toHaveAttribute("aria-pressed", "true");
      });
    });
  });
});
