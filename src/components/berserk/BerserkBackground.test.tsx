/*
 * Tests for the BerserkBackground component.
 * Verifies canvas initialization, floating controls panel toggling, animation
 * play/pause, rain visibility, palette / velocity / brightness / density
 * preferences, ember and brand-sigil toggles, and localStorage persistence.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BerserkBackground } from "./BerserkBackground";

beforeAll(() => {
  if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillStyle: "",
      strokeStyle: "",
      globalAlpha: 1,
      shadowBlur: 0,
      shadowColor: "",
      lineWidth: 1,
      lineCap: "butt",
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      stroke: vi.fn(),
      setTransform: vi.fn(),
      scale: vi.fn(),
      getImageData: vi.fn(() => ({ data: [193, 18, 31, 255] })),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }
});

describe("BerserkBackground", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the canvas background and controls trigger", () => {
    const { container } = render(<BerserkBackground />);
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeInTheDocument();

    const trigger = screen.getByTestId("berserk-controls-toggle");
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens and closes the berserk controls panel", () => {
    render(<BerserkBackground />);
    const trigger = screen.getByTestId("berserk-controls-toggle");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: /berserk rain settings/i })).toBeInTheDocument();

    const closeBtn = screen.getByRole("button", { name: /close berserk controls/i });
    fireEvent.click(closeBtn);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles animation play and pause", () => {
    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    const playPauseBtn = screen.getByTestId("berserk-control-play-pause");
    expect(playPauseBtn).toHaveTextContent("Running");

    fireEvent.click(playPauseBtn);
    expect(playPauseBtn).toHaveTextContent("Paused");

    fireEvent.click(playPauseBtn);
    expect(playPauseBtn).toHaveTextContent("Running");
  });

  it("toggles rain visibility", () => {
    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    const visibilityBtn = screen.getByTestId("berserk-control-visibility");
    expect(visibilityBtn).toHaveAttribute("aria-label", "Hide blood rain");

    fireEvent.click(visibilityBtn);
    expect(visibilityBtn).toHaveAttribute("aria-label", "Show blood rain");

    fireEvent.click(visibilityBtn);
    expect(visibilityBtn).toHaveAttribute("aria-label", "Hide blood rain");
  });

  it("switches color palettes and saves preference to localStorage", () => {
    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    fireEvent.click(screen.getByTestId("berserk-palette-eclipse"));
    expect(window.localStorage.getItem("berserk_theme_palette")).toBe(JSON.stringify("eclipse"));

    fireEvent.click(screen.getByTestId("berserk-palette-behelit"));
    expect(window.localStorage.getItem("berserk_theme_palette")).toBe(JSON.stringify("behelit"));
  });

  it("adjusts velocity multipliers and saves preference to localStorage", () => {
    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    fireEvent.click(screen.getByTestId("berserk-speed-0.6"));
    expect(window.localStorage.getItem("berserk_theme_speed")).toBe(JSON.stringify(0.6));

    fireEvent.click(screen.getByTestId("berserk-speed-1.6"));
    expect(window.localStorage.getItem("berserk_theme_speed")).toBe(JSON.stringify(1.6));
  });

  it("adjusts brightness dimmer via slider and presets and saves preference to localStorage", () => {
    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    // Default brightness is 30% (0.30)
    const slider = screen.getByTestId("berserk-dimmer-slider");
    expect(slider).toHaveValue("0.3");

    fireEvent.change(slider, { target: { value: "0.8" } });
    expect(window.localStorage.getItem("berserk_theme_brightness")).toBe(JSON.stringify(0.8));
    expect(slider).toHaveValue("0.8");

    fireEvent.click(screen.getByTestId("berserk-dimmer-subtle"));
    expect(window.localStorage.getItem("berserk_theme_brightness")).toBe(JSON.stringify(0.3));
    expect(slider).toHaveValue("0.3");

    fireEvent.click(screen.getByTestId("berserk-dimmer-vivid"));
    expect(window.localStorage.getItem("berserk_theme_brightness")).toBe(JSON.stringify(0.95));
    expect(slider).toHaveValue("0.95");

    fireEvent.click(screen.getByTestId("berserk-dimmer-balanced"));
    expect(window.localStorage.getItem("berserk_theme_brightness")).toBe(JSON.stringify(0.65));
    expect(slider).toHaveValue("0.65");
  });

  it("adjusts density and saves preference to localStorage", () => {
    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    fireEvent.click(screen.getByTestId("berserk-density-low"));
    expect(window.localStorage.getItem("berserk_theme_density")).toBe(JSON.stringify("low"));

    fireEvent.click(screen.getByTestId("berserk-density-high"));
    expect(window.localStorage.getItem("berserk_theme_density")).toBe(JSON.stringify("high"));

    fireEvent.click(screen.getByTestId("berserk-density-medium"));
    expect(window.localStorage.getItem("berserk_theme_density")).toBe(JSON.stringify("medium"));
  });

  it("toggles embers and brand sigil and saves preferences to localStorage", () => {
    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    const embersBtn = screen.getByTestId("berserk-control-embers");
    expect(embersBtn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(embersBtn);
    expect(window.localStorage.getItem("berserk_theme_embers")).toBe(JSON.stringify(false));
    expect(embersBtn).toHaveAttribute("aria-pressed", "false");

    const brandBtn = screen.getByTestId("berserk-control-brand");
    expect(brandBtn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(brandBtn);
    expect(window.localStorage.getItem("berserk_theme_brand")).toBe(JSON.stringify(false));
    expect(brandBtn).toHaveAttribute("aria-pressed", "false");
  });

  it("hides the brand sigil watermark when disabled", () => {
    render(<BerserkBackground />);
    expect(screen.queryByTestId("berserk-brand-sigil")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));
    fireEvent.click(screen.getByTestId("berserk-control-brand"));
    expect(screen.queryByTestId("berserk-brand-sigil")).not.toBeInTheDocument();
  });

  it("initializes with stored preferences from localStorage", () => {
    window.localStorage.setItem("berserk_theme_brightness", JSON.stringify(0.3));
    window.localStorage.setItem("berserk_theme_density", JSON.stringify("high"));
    window.localStorage.setItem("berserk_theme_palette", JSON.stringify("eclipse"));

    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    expect(screen.getByTestId("berserk-dimmer-slider")).toHaveValue("0.3");
    expect(screen.getByTestId("berserk-density-high").className).toContain("font-bold");
    expect(screen.getByTestId("berserk-palette-eclipse").className).toContain("font-semibold");
  });

  it("falls back to defaults for invalid or malformed stored preferences", () => {
    // Unknown palette + density values should safely fall back to defaults
    window.localStorage.setItem("berserk_theme_palette", JSON.stringify("nonexistent"));
    window.localStorage.setItem("berserk_theme_density", "{bad-json");

    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    expect(screen.getByTestId("berserk-palette-berserk").className).toContain("font-semibold");
    expect(screen.getByTestId("berserk-density-high").className).toContain("font-bold");
  });

  it("restores all settings to defaults when the restore button is clicked", () => {
    window.localStorage.setItem("berserk_theme_palette", JSON.stringify("eclipse"));
    window.localStorage.setItem("berserk_theme_brightness", JSON.stringify(0.9));
    window.localStorage.setItem("berserk_theme_density", JSON.stringify("high"));
    window.localStorage.setItem("berserk_theme_speed", JSON.stringify(1.6));
    window.localStorage.setItem("berserk_theme_embers", JSON.stringify(false));
    window.localStorage.setItem("berserk_theme_brand", JSON.stringify(false));

    render(<BerserkBackground />);
    fireEvent.click(screen.getByTestId("berserk-controls-toggle"));

    // Brand starts disabled, so the sigil watermark is absent
    expect(screen.queryByTestId("berserk-brand-sigil")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("berserk-restore-defaults"));

    // Persisted values return to defaults
    expect(window.localStorage.getItem("berserk_theme_palette")).toBe(JSON.stringify("berserk"));
    expect(window.localStorage.getItem("berserk_theme_brightness")).toBe(JSON.stringify(0.3));
    expect(window.localStorage.getItem("berserk_theme_density")).toBe(JSON.stringify("high"));
    expect(window.localStorage.getItem("berserk_theme_speed")).toBe(JSON.stringify(1));
    expect(window.localStorage.getItem("berserk_theme_embers")).toBe(JSON.stringify(true));
    expect(window.localStorage.getItem("berserk_theme_brand")).toBe(JSON.stringify(true));

    // UI reflects the restored defaults
    expect(screen.getByTestId("berserk-dimmer-slider")).toHaveValue("0.3");
    expect(screen.getByTestId("berserk-density-high").className).toContain("font-bold");
    expect(screen.getByTestId("berserk-palette-berserk").className).toContain("font-semibold");
    expect(screen.getByTestId("berserk-control-embers")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("berserk-control-brand")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("berserk-brand-sigil")).toBeInTheDocument();
  });
});
