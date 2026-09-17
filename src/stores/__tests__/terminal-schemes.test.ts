/*
 * Tests for per-host terminal color resolution: the scheme/app fallback in
 * resolveTerminalTheme, and the session -> saved host -> scheme lookup used when
 * a terminal instance is created.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getTerminalScheme } from "../../lib/terminal-themes";
import { resolveTerminalTheme, terminalThemeForSession } from "../terminal-instances";
import { useHostsStore } from "../hosts-store";
import { useSessionStore } from "../session-store";
import type { SavedHost, Session } from "../../types";

function makeHost(overrides: Partial<SavedHost> = {}): SavedHost {
  return {
    id: "h1",
    label: "Host",
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
  };
}

function makeSession(id: string, savedHostId?: string): Session {
  return {
    id,
    hostConfig: {
      host: "example.com",
      port: 22,
      username: "u",
      auth_method: { type: "password", password: "x" },
      ...(savedHostId ? { savedHostId } : {}),
    },
    status: "Connected",
    label: "Host",
  };
}

beforeAll(() => {
  // getTerminalTheme() converts OKLCH CSS vars through a canvas; jsdom's
  // getContext returns null, so stub it to keep the fallback path non-throwing.
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    fillStyle: "",
    fillRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: [30, 30, 30, 255] })),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

beforeEach(() => {
  useHostsStore.setState({ hosts: [] });
  useSessionStore.setState({ sessions: new Map() });
});

describe("resolveTerminalTheme", () => {
  it("returns a bundled scheme's palette for its id", () => {
    expect(resolveTerminalTheme("dracula")).toEqual(getTerminalScheme("dracula")!.theme);
  });

  it("falls back to the app-derived theme for null and unknown ids", () => {
    const fallback = resolveTerminalTheme(null);
    expect(resolveTerminalTheme(undefined)).toEqual(fallback);
    expect(resolveTerminalTheme("does-not-exist")).toEqual(fallback);
    expect(fallback.background).toBeDefined();
  });
});

describe("terminalThemeForSession", () => {
  it("resolves the scheme from the session's saved host", () => {
    useHostsStore.setState({ hosts: [makeHost({ terminal_theme: "nord" })] });
    useSessionStore.setState({ sessions: new Map([["s1", makeSession("s1", "h1")]]) });

    expect(terminalThemeForSession("s1")).toEqual(getTerminalScheme("nord")!.theme);
  });

  it("uses the app theme when the saved host has no scheme", () => {
    useHostsStore.setState({ hosts: [makeHost({ terminal_theme: null })] });
    useSessionStore.setState({ sessions: new Map([["s1", makeSession("s1", "h1")]]) });

    expect(terminalThemeForSession("s1")).toEqual(resolveTerminalTheme(null));
  });

  it("uses the app theme for quick (unsaved) connections", () => {
    useSessionStore.setState({ sessions: new Map([["s1", makeSession("s1")]]) });

    expect(terminalThemeForSession("s1")).toEqual(resolveTerminalTheme(null));
  });
});
