import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { HostGroup, SavedHost, S3Connection } from "../../types";
import { HostGroupedView } from "./HostGroupedView";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function makeHost(overrides: Partial<SavedHost> & { id: string }): SavedHost {
  return {
    label: "",
    host: "example.com",
    port: 22,
    username: "u",
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
    ...overrides,
  } as SavedHost;
}

function makeGroup(overrides: Partial<HostGroup> & { id: string; name: string }): HostGroup {
  return {
    color: "#3b82f6",
    icon: null,
    sort_order: 0,
    default_username: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as HostGroup;
}

function makeS3(overrides: Partial<S3Connection> & { id: string }): S3Connection {
  return {
    label: "s3",
    provider: "minio",
    bucket: null,
    region: "",
    endpoint: "",
    path_style: false,
    group_id: null,
    color: null,
    environment: null,
    notes: null,
    sort_order: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as S3Connection;
}

const noop = () => {};

describe("HostGroupedView", () => {
  it("renders group sections in order with hosts and S3 under the right group", () => {
    const groups = [makeGroup({ id: "g1", name: "Alpha" }), makeGroup({ id: "g2", name: "Beta" })];
    const hostsByGroup = new Map<string | null, SavedHost[]>([
      ["g1", [makeHost({ id: "h1", label: "H1", group_id: "g1" })]],
      ["g2", [makeHost({ id: "h2", label: "H2", group_id: "g2" })]],
    ]);
    const s3ByGroup = new Map<string | null, S3Connection[]>([
      ["g1", [makeS3({ id: "s1", label: "Bucket1", group_id: "g1" })]],
    ]);
    render(
      <HostGroupedView
        groups={groups}
        hostsByGroup={hostsByGroup}
        s3ByGroup={s3ByGroup}
        onConnect={noop}
        onExplore={noop}
        onEdit={noop}
        onDelete={noop}
        onDuplicate={noop}
        onSplit={noop}
        onS3Connect={noop}
        onS3Edit={noop}
        onS3Duplicate={noop}
        onS3Delete={noop}
      />,
    );
    const sections = screen.getAllByTestId(/^group-section-(?!.*toggle)/);
    expect(sections.map((s) => s.getAttribute("id"))).toEqual([
      "group-section-g1",
      "group-section-g2",
    ]);
    expect(screen.getByTestId("group-section-g1")).toHaveTextContent("Alpha");
    expect(screen.getByTestId("group-section-g1")).toHaveTextContent("H1");
    expect(screen.getByTestId("group-section-g1")).toHaveTextContent("Bucket1");
    expect(screen.getByTestId("group-section-g2")).toHaveTextContent("H2");
    expect(screen.queryByTestId("group-section-__ungrouped__")).not.toBeInTheDocument();
  });

  it("renders an ungrouped section only when ungrouped items exist", () => {
    const renderWith = (hostsByGroup: Map<string | null, SavedHost[]>) =>
      render(
        <HostGroupedView
          groups={[]}
          hostsByGroup={hostsByGroup}
          s3ByGroup={new Map()}
          onConnect={noop}
          onExplore={noop}
          onEdit={noop}
          onDelete={noop}
          onDuplicate={noop}
          onSplit={noop}
          onS3Connect={noop}
          onS3Edit={noop}
          onS3Duplicate={noop}
          onS3Delete={noop}
        />,
      );
    const { unmount } = renderWith(new Map());
    expect(screen.queryByTestId("group-section-__ungrouped__")).not.toBeInTheDocument();
    unmount();
    renderWith(new Map([[null, [makeHost({ id: "h9", label: "Lone" })]]]));
    expect(screen.getByTestId("group-section-__ungrouped__")).toHaveTextContent("Lone");
  });

  it("collapses and expands a section", () => {
    const groups = [makeGroup({ id: "g1", name: "Alpha" })];
    render(
      <HostGroupedView
        groups={groups}
        hostsByGroup={new Map([["g1", [makeHost({ id: "h1", label: "H1", group_id: "g1" })]]])}
        s3ByGroup={new Map()}
        onConnect={noop}
        onExplore={noop}
        onEdit={noop}
        onDelete={noop}
        onDuplicate={noop}
        onSplit={noop}
        onS3Connect={noop}
        onS3Edit={noop}
        onS3Duplicate={noop}
        onS3Delete={noop}
      />,
    );
    const toggle = screen.getByTestId("group-section-g1-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("H1")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("H1")).not.toBeInTheDocument();
  });
});
