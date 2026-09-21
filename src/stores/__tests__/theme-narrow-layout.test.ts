/*
 * Tests for theme switching and narrow/responsive layout boundaries.
 * Verifies dark/light/matrix/berserk theme switching, accent custom properties,
 * ANSI palette generation for xterm.js, sidebar width clamping [180, 400], and
 * linked explorer width clamping [220, 800].
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useSettingsStore } from "../settings-store";
import type { ThemeMode } from "../settings-store";
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
    it("switches theme mode and updates store state", () => {
      const store = useSettingsStore.getState();

      store.setThemeMode("light");
      expect(useSettingsStore.getState().themeMode).toBe("light");

      store.setThemeMode("dark");
      expect(useSettingsStore.getState().themeMode).toBe("dark");

      store.setThemeMode("matrix");
      expect(useSettingsStore.getState().themeMode).toBe("matrix");
      expect(useSettingsStore.getState().accentHue).toBe(150);

      // Berserk applies its own signature accent only from the untouched default
      store.setAccentHue(250);
      store.setThemeMode("berserk");
      expect(useSettingsStore.getState().themeMode).toBe("berserk");
      expect(useSettingsStore.getState().accentHue).toBe(25);
    });

    it("applies the signature accent hue for every special theme from the default accent", () => {
      const expected: Record<ThemeMode, number | null> = {
        dark: null,
        light: null,
        matrix: 150,
        berserk: 25,
        deepsea: 205,
        starfield: 245,
        fog: 145,
        sakura: 350,
        "sakura-night": 320,
        erdtree: 85,
      };

      for (const [mode, hue] of Object.entries(expected) as [ThemeMode, number | null][]) {
        // Reset to the untouched default accent so the signature hue is eligible.
        useSettingsStore.getState().setAccentHue(250);
        useSettingsStore.getState().setThemeMode(mode);

        expect(useSettingsStore.getState().themeMode).toBe(mode);
        expect(useSettingsStore.getState().accentHue).toBe(hue ?? 250);
      }
    });

    it("updates accent hue and custom accent colors", () => {
      const store = useSettingsStore.getState();

      store.setAccentHue(210);
      expect(useSettingsStore.getState().accentHue).toBe(210);

      store.setAccentCustom({ l: 0.7, c: 0.15, h: 280 });
      expect(useSettingsStore.getState().accentCustom).toEqual({ l: 0.7, c: 0.15, h: 280 });
    });

    it("generates contrast-tuned terminal theme palettes for dark, light, matrix, and berserk modes", () => {
      document.documentElement.dataset.theme = "dark";
      const darkTheme = getTerminalTheme();
      expect(darkTheme.background).toBeDefined();
      expect(darkTheme.foreground).toBeDefined();
      expect(darkTheme.green).toBeDefined();

      document.documentElement.dataset.theme = "light";
      const lightTheme = getTerminalTheme();
      expect(lightTheme.background).toBeDefined();
      expect(lightTheme.foreground).toBeDefined();
      // Contrast-tuned green differs between light and dark palettes
      expect(lightTheme.green).not.toEqual(darkTheme.green);

      document.documentElement.dataset.theme = "matrix";
      const matrixTheme = getTerminalTheme();
      expect(matrixTheme.background).toBeDefined();
      expect(matrixTheme.foreground).toBeDefined();
      expect(matrixTheme.green).toBe("#00ff66");
      expect(matrixTheme.green).not.toEqual(darkTheme.green);
      expect(matrixTheme.green).not.toEqual(lightTheme.green);

      document.documentElement.dataset.theme = "berserk";
      const berserkTheme = getTerminalTheme();
      expect(berserkTheme.background).toBeDefined();
      expect(berserkTheme.foreground).toBeDefined();
      expect(berserkTheme.red).toBe("#c1121f");
      expect(berserkTheme.red).not.toEqual(matrixTheme.red);
      expect(berserkTheme.red).not.toEqual(darkTheme.red);
    });

    it("generates a distinct terminal palette for each new special theme", () => {
      document.documentElement.dataset.theme = "dark";
      const darkGreen = getTerminalTheme().green;

      const expectedGreens: [string, string][] = [
        ["deepsea", "#2fd8bd"],
        ["starfield", "#4fe0a0"],
        ["fog", "#8aa06a"],
        ["sakura", "#116329"],
        ["sakura-night", "#8ad8a8"],
        ["erdtree", "#9aa84c"],
      ];

      const seen = new Set<string>(["#0dbc79"]);
      for (const [theme, green] of expectedGreens) {
        document.documentElement.dataset.theme = theme;
        const palette = getTerminalTheme();
        expect(palette.background).toBeDefined();
        expect(palette.foreground).toBeDefined();
        expect(palette.green).toBe(green);
        expect(palette.green).not.toBe(darkGreen);
        seen.add(green);
      }
      // Every theme resolves to its own palette rather than reusing another's.
      expect(seen.size).toBe(expectedGreens.length + 1);
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
