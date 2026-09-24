/*
 * Tests for the MatrixBackground component.
 * Verifies canvas initialization, floating controls panel toggling,
 * animation play/pause, rain visibility toggling, color palette selection,
 * and velocity adjustment.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MatrixBackground } from "./MatrixBackground";

interface MockContext {
  fillStyle: string;
  shadowBlur: number;
  shadowColor: string;
  globalAlpha: number;
  font: string;
  textBaseline: string;
  fillRect: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  setTransform: ReturnType<typeof vi.fn>;
  scale: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
}

let latestMockCtx: MockContext | null = null;

beforeAll(() => {
  if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => {
      const ctx: MockContext = {
        fillStyle: "",
        shadowBlur: 0,
        shadowColor: "transparent",
        globalAlpha: 1,
        font: "",
        textBaseline: "alphabetic",
        fillRect: vi.fn(),
        clearRect: vi.fn(),
        fillText: vi.fn(),
        setTransform: vi.fn(),
        scale: vi.fn(),
        getImageData: vi.fn(() => ({ data: [0, 255, 102, 255] })),
      };
      latestMockCtx = ctx;
      return ctx;
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }
});

describe("MatrixBackground", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the canvas background and controls trigger", () => {
    const { container } = render(<MatrixBackground />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeInTheDocument();

    const trigger = screen.getByTestId("matrix-controls-toggle");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens and closes the matrix controls panel", () => {
    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");

    // Open controls
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: /matrix rain settings/i })).toBeInTheDocument();

    // Close controls via close button
    const closeBtn = screen.getByRole("button", { name: /close matrix controls/i });
    fireEvent.click(closeBtn);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles animation play and pause", () => {
    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    const playPauseBtn = screen.getByTestId("matrix-control-play-pause");
    expect(playPauseBtn).toHaveTextContent("Running");

    // Pause animation
    fireEvent.click(playPauseBtn);
    expect(playPauseBtn).toHaveTextContent("Paused");

    // Resume animation
    fireEvent.click(playPauseBtn);
    expect(playPauseBtn).toHaveTextContent("Running");
  });

  it("toggles rain visibility", () => {
    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    const visibilityBtn = screen.getByTestId("matrix-control-visibility");
    expect(visibilityBtn).toHaveAttribute("aria-label", "Hide Matrix rain");

    // Hide rain
    fireEvent.click(visibilityBtn);
    expect(visibilityBtn).toHaveAttribute("aria-label", "Show Matrix rain");

    // Show rain
    fireEvent.click(visibilityBtn);
    expect(visibilityBtn).toHaveAttribute("aria-label", "Hide Matrix rain");
  });

  it("switches color palettes and saves preference to localStorage", () => {
    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    const classicBtn = screen.getByTestId("matrix-palette-classic");
    fireEvent.click(classicBtn);
    expect(window.localStorage.getItem("matrix_theme_palette")).toBe(JSON.stringify("classic"));

    const cyanBtn = screen.getByTestId("matrix-palette-cyan");
    fireEvent.click(cyanBtn);
    expect(window.localStorage.getItem("matrix_theme_palette")).toBe(JSON.stringify("cyan"));
  });

  it("adjusts velocity multipliers and saves preference to localStorage", () => {
    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    const speed06 = screen.getByTestId("matrix-speed-0.6");
    fireEvent.click(speed06);
    expect(window.localStorage.getItem("matrix_theme_speed")).toBe(JSON.stringify(0.6));

    const speed16 = screen.getByTestId("matrix-speed-1.6");
    fireEvent.click(speed16);
    expect(window.localStorage.getItem("matrix_theme_speed")).toBe(JSON.stringify(1.6));
  });

  it("adjusts brightness dimmer via slider and presets and saves preference to localStorage", () => {
    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    // Default brightness is 30% (0.3)
    const slider = screen.getByTestId("matrix-dimmer-slider");
    expect(slider).toHaveValue("0.3");

    // Adjust via slider
    fireEvent.change(slider, { target: { value: "0.75" } });
    expect(window.localStorage.getItem("matrix_theme_brightness")).toBe(JSON.stringify(0.75));
    expect(slider).toHaveValue("0.75");

    // Adjust via presets
    const subtleBtn = screen.getByTestId("matrix-dimmer-subtle");
    fireEvent.click(subtleBtn);
    expect(window.localStorage.getItem("matrix_theme_brightness")).toBe(JSON.stringify(0.3));
    expect(slider).toHaveValue("0.3");

    const vividBtn = screen.getByTestId("matrix-dimmer-vivid");
    fireEvent.click(vividBtn);
    expect(window.localStorage.getItem("matrix_theme_brightness")).toBe(JSON.stringify(0.9));
    expect(slider).toHaveValue("0.9");

    const balancedBtn = screen.getByTestId("matrix-dimmer-balanced");
    fireEvent.click(balancedBtn);
    expect(window.localStorage.getItem("matrix_theme_brightness")).toBe(JSON.stringify(0.55));
    expect(slider).toHaveValue("0.55");
  });

  it("adjusts glyph size and saves preference to localStorage", () => {
    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    const smallBtn = screen.getByTestId("matrix-size-small");
    fireEvent.click(smallBtn);
    expect(window.localStorage.getItem("matrix_theme_size")).toBe(JSON.stringify("small"));

    const largeBtn = screen.getByTestId("matrix-size-large");
    fireEvent.click(largeBtn);
    expect(window.localStorage.getItem("matrix_theme_size")).toBe(JSON.stringify("large"));

    const mediumBtn = screen.getByTestId("matrix-size-medium");
    fireEvent.click(mediumBtn);
    expect(window.localStorage.getItem("matrix_theme_size")).toBe(JSON.stringify("medium"));
  });

  it("initializes with stored brightness and size preferences from localStorage", () => {
    window.localStorage.setItem("matrix_theme_brightness", JSON.stringify(0.25));
    window.localStorage.setItem("matrix_theme_size", JSON.stringify("large"));

    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    const slider = screen.getByTestId("matrix-dimmer-slider");
    expect(slider).toHaveValue("0.25");

    const largeBtn = screen.getByTestId("matrix-size-large");
    expect(largeBtn.className).toContain("font-bold");
  });

  it("adjusts first letter style (white, tinted, soft) and saves preference to localStorage", () => {
    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    const whiteBtn = screen.getByTestId("matrix-head-white");
    const tintedBtn = screen.getByTestId("matrix-head-tinted");
    const softBtn = screen.getByTestId("matrix-head-soft");

    // Default is soft
    expect(softBtn).toHaveAttribute("aria-pressed", "true");
    expect(softBtn.className).toContain("font-bold");
    expect(whiteBtn).toHaveAttribute("aria-pressed", "false");
    expect(tintedBtn).toHaveAttribute("aria-pressed", "false");

    // Select White
    fireEvent.click(whiteBtn);
    expect(window.localStorage.getItem("matrix_theme_head")).toBe(JSON.stringify("white"));
    expect(whiteBtn).toHaveAttribute("aria-pressed", "true");
    expect(whiteBtn.className).toContain("font-bold");
    expect(softBtn).toHaveAttribute("aria-pressed", "false");

    // Select Tinted
    fireEvent.click(tintedBtn);
    expect(window.localStorage.getItem("matrix_theme_head")).toBe(JSON.stringify("tinted"));
    expect(tintedBtn).toHaveAttribute("aria-pressed", "true");
    expect(tintedBtn.className).toContain("font-bold");
    expect(whiteBtn).toHaveAttribute("aria-pressed", "false");

    // Select Soft again
    fireEvent.click(softBtn);
    expect(window.localStorage.getItem("matrix_theme_head")).toBe(JSON.stringify("soft"));
    expect(softBtn).toHaveAttribute("aria-pressed", "true");
    expect(softBtn.className).toContain("font-bold");
  });

  it("initializes with stored first letter preference from localStorage and handles invalid value fallback", () => {
    window.localStorage.setItem("matrix_theme_head", JSON.stringify("tinted"));

    const { unmount } = render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    const tintedBtn = screen.getByTestId("matrix-head-tinted");
    expect(tintedBtn).toHaveAttribute("aria-pressed", "true");
    expect(tintedBtn.className).toContain("font-bold");

    unmount();

    // Invalid storage value should safely fall back to "soft"
    window.localStorage.setItem("matrix_theme_head", JSON.stringify("nonexistent_mode"));
    const { unmount: unmount2 } = render(<MatrixBackground />);
    const trigger2 = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger2);

    const softBtn = screen.getByTestId("matrix-head-soft");
    expect(softBtn).toHaveAttribute("aria-pressed", "true");
    expect(softBtn.className).toContain("font-bold");

    unmount2();

    // Malformed JSON should safely fall back to "soft"
    window.localStorage.setItem("matrix_theme_head", "{bad-json");
    render(<MatrixBackground />);
    const trigger3 = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger3);

    const softBtnAfterMalformed = screen.getByTestId("matrix-head-soft");
    expect(softBtnAfterMalformed).toHaveAttribute("aria-pressed", "true");
    expect(softBtnAfterMalformed.className).toContain("font-bold");
  });

  it("handles non-string types in localStorage safely and falls back to soft", () => {
    for (const badValue of [123, true, {}, [], ""]) {
      window.localStorage.setItem("matrix_theme_head", JSON.stringify(badValue));
      const { unmount } = render(<MatrixBackground />);
      const trigger = screen.getByTestId("matrix-controls-toggle");
      fireEvent.click(trigger);

      const softBtn = screen.getByTestId("matrix-head-soft");
      expect(softBtn).toHaveAttribute("aria-pressed", "true");
      expect(softBtn.className).toContain("font-bold");
      unmount();
    }
  });

  it("renders head glyphs on the canvas matching selected mode (white, tinted, soft)", () => {
    let capturedRafCb: ((time: number) => void) | null = null;
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      capturedRafCb = cb;
      return 42;
    });

    try {
      render(<MatrixBackground />);
      expect(latestMockCtx).not.toBeNull();
      expect(capturedRafCb).not.toBeNull();

      const draws: Array<{
        char: string;
        fillStyle: string;
        shadowBlur: number;
        shadowColor: string;
      }> = [];

      latestMockCtx!.fillText = vi.fn((char: string) => {
        draws.push({
          char,
          fillStyle: latestMockCtx!.fillStyle,
          shadowBlur: latestMockCtx!.shadowBlur,
          shadowColor: latestMockCtx!.shadowColor,
        });
      });

      // 1. Default Mode is "soft"
      let now = performance.now() + 100;
      capturedRafCb!(now);

      expect(draws.length).toBeGreaterThan(0);
      // In "soft" mode, all draws must have shadowBlur === 0 and shadowColor === transparent
      const drawsWithShadow = draws.filter((d) => d.shadowBlur > 0);
      expect(drawsWithShadow.length).toBe(0);
      const nonWhiteDraws = draws.filter((d) => d.fillStyle !== "#ffffff");
      expect(nonWhiteDraws.length).toBeGreaterThan(0);

      // 2. Switch to "white"
      const trigger = screen.getByTestId("matrix-controls-toggle");
      fireEvent.click(trigger);
      const whiteBtn = screen.getByTestId("matrix-head-white");
      fireEvent.click(whiteBtn);

      draws.length = 0;
      now += 100;
      capturedRafCb!(now);

      // In "white" mode, head character is bright white (#ffffff) with glow bloom
      const whiteHeadDraws = draws.filter((d) => d.fillStyle === "#ffffff");
      expect(whiteHeadDraws.length).toBeGreaterThan(0);
      expect(whiteHeadDraws[0].shadowBlur).toBeGreaterThan(0);
      expect(whiteHeadDraws[0].shadowColor).not.toBe("transparent");

      // 3. Switch to "tinted"
      const tintedBtn = screen.getByTestId("matrix-head-tinted");
      fireEvent.click(tintedBtn);

      draws.length = 0;
      now += 100;
      capturedRafCb!(now);

      // In "tinted" mode, head character is theme lead tint with softened bloom
      const tintedHeadDraws = draws.filter(
        (d) => d.shadowBlur > 0 && d.fillStyle !== "#ffffff"
      );
      expect(tintedHeadDraws.length).toBeGreaterThan(0);
      expect(tintedHeadDraws[0].shadowColor).not.toBe("transparent");
    } finally {
      rafSpy.mockRestore();
    }
  });

  it("restores all settings to default presets when restore defaults button is clicked", () => {
    render(<MatrixBackground />);
    const trigger = screen.getByTestId("matrix-controls-toggle");
    fireEvent.click(trigger);

    // 1. Modify multiple settings away from defaults
    // Change brightness to vivid 90%
    fireEvent.click(screen.getByTestId("matrix-dimmer-vivid"));
    // Change size to large
    fireEvent.click(screen.getByTestId("matrix-size-large"));
    // Change first letter to white
    fireEvent.click(screen.getByTestId("matrix-head-white"));
    // Change palette to classic
    fireEvent.click(screen.getByTestId("matrix-palette-classic"));
    // Change speed to 1.6x
    fireEvent.click(screen.getByTestId("matrix-speed-1.6"));

    // Verify settings were changed and saved
    expect(window.localStorage.getItem("matrix_theme_brightness")).toBe(JSON.stringify(0.9));
    expect(window.localStorage.getItem("matrix_theme_size")).toBe(JSON.stringify("large"));
    expect(window.localStorage.getItem("matrix_theme_head")).toBe(JSON.stringify("white"));
    expect(window.localStorage.getItem("matrix_theme_palette")).toBe(JSON.stringify("classic"));
    expect(window.localStorage.getItem("matrix_theme_speed")).toBe(JSON.stringify(1.6));

    // 2. Click Restore to Defaults
    const restoreBtn = screen.getByTestId("matrix-restore-defaults");
    expect(restoreBtn).toBeInTheDocument();
    fireEvent.click(restoreBtn);

    // 3. Verify all settings are restored to default (dimmer 30%, size medium, first letter soft, palette omnissh, speed 1.0x)
    const slider = screen.getByTestId("matrix-dimmer-slider");
    expect(slider).toHaveValue("0.3");

    const mediumBtn = screen.getByTestId("matrix-size-medium");
    expect(mediumBtn.className).toContain("font-bold");

    const softBtn = screen.getByTestId("matrix-head-soft");
    expect(softBtn).toHaveAttribute("aria-pressed", "true");
    expect(softBtn.className).toContain("font-bold");

    const classicBtn = screen.getByTestId("matrix-palette-classic");
    expect(classicBtn.className).not.toContain("font-semibold");
    const omnisshBtn = screen.getByTestId("matrix-palette-omnissh");
    expect(omnisshBtn.className).toContain("font-semibold");

    const speed10 = screen.getByTestId("matrix-speed-1.0");
    expect(speed10.className).toContain("font-bold");

    // Verify defaults were written to storage
    expect(window.localStorage.getItem("matrix_theme_brightness")).toBe(JSON.stringify(0.3));
    expect(window.localStorage.getItem("matrix_theme_size")).toBe(JSON.stringify("medium"));
    expect(window.localStorage.getItem("matrix_theme_head")).toBe(JSON.stringify("soft"));
    expect(window.localStorage.getItem("matrix_theme_palette")).toBe(JSON.stringify("omnissh"));
    expect(window.localStorage.getItem("matrix_theme_speed")).toBe(JSON.stringify(1));
  });

  it("does not spawn orphaned animation loops on repeated visible events", () => {
    let nextFrameId = 1;
    const activeFrames = new Map<number, FrameRequestCallback>();
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      activeFrames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
      activeFrames.delete(id);
    });

    try {
      const { unmount } = render(<MatrixBackground />);
      expect(activeFrames.size).toBe(1);

      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));

      unmount();

      expect(activeFrames.size).toBe(0);
    } finally {
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });
});


