/*
 * Tests for Terminal Keyword Highlighting section in SettingsPage.
 * Verifies rule list rendering, add rule modal trigger, toggle, and delete actions.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { useSettingsStore } from "../../stores/settings-store";
import { useHostsStore } from "../../stores/hosts-store";
import type { SavedHost } from "../../types";

function makeMockHost(overrides: Partial<SavedHost> & { id: string; label: string; host: string }): SavedHost {
  return {
    port: 22,
    username: "user",
    auth_type: "password",
    group_id: null,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
    key_path: null,
    color: null,
    notes: null,
    environment: null,
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
    connection_count: 0,
    ...overrides,
  };
}

describe("SettingsPage terminal keyword highlighting", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: () => ({ width: 0 }),
    } as unknown as CanvasRenderingContext2D);

    useHostsStore.setState({
      hosts: [
        makeMockHost({
          id: "host-1",
          label: "Prod Server",
          host: "prod.example.com",
          username: "admin",
        }),
      ],
    });

    useSettingsStore.setState({
      terminalHighlightRules: [
        {
          id: "rule-1",
          pattern: "CRITICAL",
          color: "#ef4444",
          style: "text",
          scope: "global",
          enabled: true,
        },
        {
          id: "rule-2",
          pattern: "ACCESS",
          color: "#22c55e",
          style: "background",
          scope: "hosts",
          hostIds: ["host-1"],
          enabled: true,
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders configured highlight rules under Terminal settings", () => {
    render(<SettingsPage />);

    // Navigate to Terminal settings
    fireEvent.click(screen.getByTestId("settings-nav-terminal"));

    expect(screen.getByText("Keyword Highlighting")).toBeInTheDocument();
    expect(screen.getByText("CRITICAL")).toBeInTheDocument();
    expect(screen.getByText("ACCESS")).toBeInTheDocument();
    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.getByText("Prod Server")).toBeInTheDocument();
  });

  it("toggles a rule on/off from the list row", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-terminal"));

    const toggle = screen.getByTestId("hl-toggle-rule-1");
    fireEvent.click(toggle);

    expect(useSettingsStore.getState().terminalHighlightRules[0].enabled).toBe(false);
  });

  it("deletes a rule from the list row", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-terminal"));

    const deleteBtn = screen.getByTestId("highlight-rule-delete-rule-1");
    fireEvent.click(deleteBtn);

    const rules = useSettingsStore.getState().terminalHighlightRules;
    expect(rules.find((r) => r.id === "rule-1")).toBeUndefined();
    expect(screen.queryByText("CRITICAL")).not.toBeInTheDocument();
  });

  it("opens modal when clicking 'Add highlight rule'", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-nav-terminal"));

    fireEvent.click(screen.getByTestId("add-highlight-rule-btn"));

    expect(screen.getByText("New Keyword Highlight")).toBeInTheDocument();
  });
});
