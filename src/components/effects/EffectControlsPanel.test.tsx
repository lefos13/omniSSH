/*
 * Tests for the generic effect controls panel.
 *
 * Exercises the shared panel through a real theme definition (Deep Sea) to cover
 * the behaviour every animated theme inherits: opening/closing, play/pause,
 * visibility, dimmer slider + presets, density, velocity, palette switching,
 * toggles, restore-defaults, and localStorage persistence with safe fallbacks.
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EffectTheme } from "./EffectTheme";
import { DEEPSEA_DEF } from "./deepsea/deepsea-def";
import { installCanvasMock } from "./canvasTestUtils";

beforeAll(installCanvasMock);

describe("EffectControlsPanel (via Deep Sea)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the canvas background and a collapsed controls trigger", () => {
    const { container } = render(<EffectTheme def={DEEPSEA_DEF} />);
    expect(container.querySelector("canvas")).toBeInTheDocument();

    const trigger = screen.getByTestId("deepsea-controls-toggle");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: /deep sea effect settings/i })).not.toBeInTheDocument();
  });

  it("opens and closes the controls panel", () => {
    render(<EffectTheme def={DEEPSEA_DEF} />);
    const trigger = screen.getByTestId("deepsea-controls-toggle");

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: /deep sea effect settings/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /close deepsea controls/i }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("toggles animation play and pause", () => {
    render(<EffectTheme def={DEEPSEA_DEF} />);
    fireEvent.click(screen.getByTestId("deepsea-controls-toggle"));

    const playPause = screen.getByTestId("deepsea-control-play-pause");
    expect(playPause).toHaveTextContent("Running");
    fireEvent.click(playPause);
    expect(playPause).toHaveTextContent("Paused");
    fireEvent.click(playPause);
    expect(playPause).toHaveTextContent("Running");
  });

  it("toggles effect visibility", () => {
    render(<EffectTheme def={DEEPSEA_DEF} />);
    fireEvent.click(screen.getByTestId("deepsea-controls-toggle"));

    const visibility = screen.getByTestId("deepsea-control-visibility");
    expect(visibility).toHaveAttribute("aria-label", "Hide Deep Sea");
    fireEvent.click(visibility);
    expect(visibility).toHaveAttribute("aria-label", "Show Deep Sea");
  });

  it("adjusts the dimmer via slider and presets and persists it", () => {
    render(<EffectTheme def={DEEPSEA_DEF} />);
    fireEvent.click(screen.getByTestId("deepsea-controls-toggle"));

    const slider = screen.getByTestId("deepsea-dimmer-slider");
    expect(slider).toHaveValue("0.3");

    fireEvent.change(slider, { target: { value: "0.8" } });
    expect(slider).toHaveValue("0.8");
    expect(window.localStorage.getItem("deepsea_theme_brightness")).toBe(JSON.stringify(0.8));

    fireEvent.click(screen.getByTestId("deepsea-dimmer-vivid"));
    expect(slider).toHaveValue("0.95");
    expect(window.localStorage.getItem("deepsea_theme_brightness")).toBe(JSON.stringify(0.95));

    // Out-of-range input is clamped by the slider's own floor (min=0.2).
    fireEvent.change(slider, { target: { value: "0.01" } });
    expect(window.localStorage.getItem("deepsea_theme_brightness")).toBe(JSON.stringify(0.2));
  });

  it("switches density, velocity and palette and persists each choice", () => {
    render(<EffectTheme def={DEEPSEA_DEF} />);
    fireEvent.click(screen.getByTestId("deepsea-controls-toggle"));

    fireEvent.click(screen.getByTestId("deepsea-density-high"));
    expect(window.localStorage.getItem("deepsea_theme_density")).toBe(JSON.stringify("high"));

    fireEvent.click(screen.getByTestId("deepsea-speed-1.6"));
    expect(window.localStorage.getItem("deepsea_theme_speed")).toBe(JSON.stringify(1.6));

    fireEvent.click(screen.getByTestId("deepsea-palette-twilight"));
    expect(window.localStorage.getItem("deepsea_theme_palette")).toBe(JSON.stringify("twilight"));
    expect(screen.getByTestId("deepsea-palette-twilight").className).toContain("font-semibold");
  });

  it("toggles individual effects and persists them", () => {
    render(<EffectTheme def={DEEPSEA_DEF} />);
    fireEvent.click(screen.getByTestId("deepsea-controls-toggle"));

    const bubbles = screen.getByTestId("deepsea-control-bubbles");
    expect(bubbles).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(bubbles);
    expect(bubbles).toHaveAttribute("aria-pressed", "false");
    expect(window.localStorage.getItem("deepsea_theme_bubbles")).toBe(JSON.stringify(false));

    const caustics = screen.getByTestId("deepsea-control-caustics");
    fireEvent.click(caustics);
    expect(window.localStorage.getItem("deepsea_theme_caustics")).toBe(JSON.stringify(false));
  });

  it("restores every setting to defaults", () => {
    window.localStorage.setItem("deepsea_theme_palette", JSON.stringify("coral"));
    window.localStorage.setItem("deepsea_theme_density", JSON.stringify("high"));
    window.localStorage.setItem("deepsea_theme_speed", JSON.stringify(0.6));
    window.localStorage.setItem("deepsea_theme_brightness", JSON.stringify(0.9));
    window.localStorage.setItem("deepsea_theme_bubbles", JSON.stringify(false));

    render(<EffectTheme def={DEEPSEA_DEF} />);
    fireEvent.click(screen.getByTestId("deepsea-controls-toggle"));
    fireEvent.click(screen.getByTestId("deepsea-restore-defaults"));

    expect(window.localStorage.getItem("deepsea_theme_palette")).toBe(JSON.stringify("abyss"));
    expect(window.localStorage.getItem("deepsea_theme_density")).toBe(JSON.stringify("medium"));
    expect(window.localStorage.getItem("deepsea_theme_speed")).toBe(JSON.stringify(1));
    expect(window.localStorage.getItem("deepsea_theme_brightness")).toBe(JSON.stringify(0.3));
    expect(window.localStorage.getItem("deepsea_theme_bubbles")).toBe(JSON.stringify(true));
    expect(screen.getByTestId("deepsea-palette-abyss").className).toContain("font-semibold");
    expect(screen.getByTestId("deepsea-control-bubbles")).toHaveAttribute("aria-pressed", "true");
  });

  it("falls back to defaults for unknown palette/density and malformed storage", () => {
    window.localStorage.setItem("deepsea_theme_palette", JSON.stringify("nonexistent"));
    window.localStorage.setItem("deepsea_theme_density", "{bad-json");
    window.localStorage.setItem("deepsea_theme_speed", JSON.stringify(3));

    render(<EffectTheme def={DEEPSEA_DEF} />);
    fireEvent.click(screen.getByTestId("deepsea-controls-toggle"));

    expect(screen.getByTestId("deepsea-palette-abyss").className).toContain("font-semibold");
    expect(screen.getByTestId("deepsea-density-medium").className).toContain("font-bold");
    expect(screen.getByTestId("deepsea-speed-1.0").className).toContain("font-bold");
  });
});
