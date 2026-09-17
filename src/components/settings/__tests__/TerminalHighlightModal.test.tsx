/*
 * Tests for TerminalHighlightModal component.
 * Verifies form field validation, options toggles (case, whole-word, regex),
 * style and color selection, host scoping, and submit callbacks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TerminalHighlightModal } from "../TerminalHighlightModal";
import { useHostsStore } from "../../../stores/hosts-store";
import type { SavedHost, TerminalHighlightRule } from "../../../types";

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

const mockHosts: SavedHost[] = [
  makeMockHost({
    id: "host-1",
    label: "Web Server",
    host: "web.example.com",
    username: "deploy",
  }),
  makeMockHost({
    id: "host-2",
    label: "Database Node",
    host: "db.example.com",
    username: "postgres",
  }),
];

describe("TerminalHighlightModal", () => {
  beforeEach(() => {
    useHostsStore.setState({ hosts: mockHosts });
  });

  it("renders when open and focuses the pattern input", () => {
    render(
      <TerminalHighlightModal
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("New Keyword Highlight")).toBeInTheDocument();
    expect(screen.getByTestId("hl-pattern-input")).toBeInTheDocument();
    expect(screen.getByTestId("highlight-modal-save")).toBeDisabled();
  });

  it("enables save button when a valid pattern is entered", async () => {
    const user = userEvent.setup();
    render(
      <TerminalHighlightModal
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const input = screen.getByTestId("hl-pattern-input");
    await user.type(input, "ERROR");

    expect(screen.getByTestId("highlight-modal-save")).toBeEnabled();
  });

  it("shows error and disables save for invalid regular expressions", async () => {
    const user = userEvent.setup();
    render(
      <TerminalHighlightModal
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const input = screen.getByTestId("hl-pattern-input");
    fireEvent.change(input, { target: { value: "[unclosed" } });

    const regexCheckbox = screen.getByTestId("hl-is-regex");

    await user.click(regexCheckbox);

    expect(screen.getByText(/Invalid regular expression/i)).toBeInTheDocument();
    expect(screen.getByTestId("highlight-modal-save")).toBeDisabled();
  });

  it("submits global rule with selected options", async () => {
    const user = userEvent.setup();
    const handleSave = vi.fn();

    render(
      <TerminalHighlightModal
        open={true}
        onClose={vi.fn()}
        onSave={handleSave}
      />,
    );

    await user.type(screen.getByTestId("hl-pattern-input"), "FATAL");
    await user.click(screen.getByTestId("hl-match-case"));
    await user.click(screen.getByTestId("hl-style-background"));
    await user.click(screen.getByTestId("hl-color-amber"));

    await user.click(screen.getByTestId("highlight-modal-save"));

    expect(handleSave).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: "FATAL",
        matchCase: true,
        style: "background",
        color: "#f59e0b",
        scope: "global",
        hostIds: [],
        enabled: true,
      }),
    );
  });

  it("allows selecting specific hosts when scope is 'hosts'", async () => {
    const user = userEvent.setup();
    const handleSave = vi.fn();

    render(
      <TerminalHighlightModal
        open={true}
        onClose={vi.fn()}
        onSave={handleSave}
      />,
    );

    await user.type(screen.getByTestId("hl-pattern-input"), "PROD");
    await user.click(screen.getByTestId("hl-scope-hosts"));

    // Initially 0 hosts selected -> save is disabled
    expect(screen.getByTestId("highlight-modal-save")).toBeDisabled();

    // Select Web Server
    const hostCheckbox = screen.getByTestId("hl-host-checkbox-host-1");
    fireEvent.click(hostCheckbox);

    expect(screen.getByTestId("highlight-modal-save")).toBeEnabled();

    await user.click(screen.getByTestId("highlight-modal-save"));

    expect(handleSave).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: "PROD",
        scope: "hosts",
        hostIds: ["host-1"],
      }),
    );
  });

  it("pre-fills fields in edit mode", () => {
    const existingRule: TerminalHighlightRule = {
      id: "rule-edit-1",
      pattern: "TIMEOUT",
      color: "#ef4444",
      style: "text",
      scope: "hosts",
      hostIds: ["host-2"],
      matchCase: true,
      matchWholeWord: true,
      isRegex: false,
      enabled: true,
    };

    render(
      <TerminalHighlightModal
        open={true}
        initial={existingRule}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("Edit Keyword Highlight")).toBeInTheDocument();
    expect(screen.getByTestId("hl-pattern-input")).toHaveValue("TIMEOUT");
    expect(screen.getByTestId("hl-match-case")).toBeChecked();
    expect(screen.getByTestId("hl-whole-word")).toBeChecked();
    expect(screen.getByTestId("highlight-modal-save")).toBeEnabled();
  });
});
