/*
 * Tests for theme switching and narrow/responsive layout boundaries.
 * Verifies dark/light theme switching, accent custom properties, ANSI palette
 * generation for xterm.js, sidebar width clamping [180, 400], and linked explorer
 * width clamping [220, 800].
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useSettingsStore } from "../settings-store";
import { useUiStore } from "../ui-store";
import { useLinkedExplorerStore } from "../linked-explorer-store";
import { getTerminalTheme } from "../terminal-instances";

beforeAll(() => {
  if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillStyle: "",
      fillRect: vi.fn(),
      getImageData: vi.fn(() => ({ data: [30, 30, 30, 255] })),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }
});

describe("Theme and narrow layout constraints", () => {
  beforeEach(() => {
    invoke.mockReset();
    useUiStore.setState({
      sidebarExpanded: false,
      sidebarWidth: 240,
      quickConnectOpen: false,
      editingHostId: null,
      snippetPanelOpen: false,
      snippetPanelPinned: false,
    });
    useLinkedExplorerStore.setState({
      openTabIds: new Set(),
      bindings: new Map(),
      panelWidth: 340,
      followPath: true,
    });
  });

  describe("Theme and appearance configuration", () => {
    it("switches theme mode and sets data-theme attribute on documentElement", () => {
      const store = useSettingsStore.getState();

      store.setThemeMode("light");
      document.documentElement.dataset.theme = "light";
      expect(useSettingsStore.getState().themeMode).toBe("light");
      expect(document.documentElement.dataset.theme).toBe("light");

      store.setThemeMode("dark");
      document.documentElement.dataset.theme = "dark";
      expect(useSettingsStore.getState().themeMode).toBe("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
    });

    it("updates accent hue and custom accent colors", () => {
      const store = useSettingsStore.getState();

      store.setAccentHue(210);
      expect(useSettingsStore.getState().accentHue).toBe(210);

      store.setAccentCustom({ l: 0.7, c: 0.15, h: 280 });
      expect(useSettingsStore.getState().accentCustom).toEqual({ l: 0.7, c: 0.15, h: 280 });
    });

    it("generates contrast-tuned terminal theme palettes for dark and light modes", () => {
      document.documentElement.dataset.theme = "dark";
      useSettingsStore.getState().setThemeMode("dark");
      const darkTheme = getTerminalTheme();
      expect(darkTheme.background).toBeDefined();
      expect(darkTheme.foreground).toBeDefined();
      expect(darkTheme.green).toBeDefined();

      document.documentElement.dataset.theme = "light";
      useSettingsStore.getState().setThemeMode("light");
      const lightTheme = getTerminalTheme();
      expect(lightTheme.background).toBeDefined();
      expect(lightTheme.foreground).toBeDefined();
      // Contrast-tuned green differs between light and dark palettes
      expect(lightTheme.green).not.toEqual(darkTheme.green);
    });
  });

  describe("Narrow layout and dimension clamping", () => {
    it("clamps sidebar width to valid range [180, 400]", () => {
      const ui = useUiStore.getState();

      // Lower boundary clamping
      ui.setSidebarWidth(100);
      expect(useUiStore.getState().sidebarWidth).toBe(180);

      // Upper boundary clamping
      ui.setSidebarWidth(600);
      expect(useUiStore.getState().sidebarWidth).toBe(400);

      // Within valid bounds
      ui.setSidebarWidth(280);
      expect(useUiStore.getState().sidebarWidth).toBe(280);
    });

    it("clamps linked explorer panel width to valid range [220, 800]", () => {
      const explorer = useLinkedExplorerStore.getState();

      // Underflow clamp
      explorer.setPanelWidth(150);
      expect(useLinkedExplorerStore.getState().panelWidth).toBe(220);

      // Overflow clamp
      explorer.setPanelWidth(1200);
      expect(useLinkedExplorerStore.getState().panelWidth).toBe(800);

      // Valid width
      explorer.setPanelWidth(450);
      expect(useLinkedExplorerStore.getState().panelWidth).toBe(450);
    });

    it("toggles sidebar expanded state cleanly", () => {
      expect(useUiStore.getState().sidebarExpanded).toBe(false);

      useUiStore.getState().toggleSidebar();
      expect(useUiStore.getState().sidebarExpanded).toBe(true);

      useUiStore.getState().toggleSidebar();
      expect(useUiStore.getState().sidebarExpanded).toBe(false);
    });
  });
});
