/*
 * Smoke tests for the five new special effect themes.
 *
 * Each theme mounts its canvas and controls pill through the shared framework;
 * these confirm the wiring is correct per theme (canvas present, pill collapsed,
 * default palette selected, and — for Erdtree — the watermark overlay toggle).
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ComponentType } from "react";
import { DeepSeaBackground } from "./deepsea";
import { StarfieldBackground } from "./starfield";
import { FogBackground } from "./fog";
import { SakuraBackground, SakuraNightBackground } from "./sakura";
import { ErdtreeBackground } from "./erdtree";
import { installCanvasMock } from "./canvasTestUtils";

beforeAll(installCanvasMock);

const THEMES: { id: string; label: string; Component: ComponentType; defaultPalette: string }[] = [
  { id: "deepsea", label: "Deep Sea", Component: DeepSeaBackground, defaultPalette: "abyss" },
  { id: "starfield", label: "Starfield", Component: StarfieldBackground, defaultPalette: "deepspace" },
  { id: "fog", label: "Fog", Component: FogBackground, defaultPalette: "silent" },
  { id: "sakura", label: "Sakura", Component: SakuraBackground, defaultPalette: "blossom" },
  {
    id: "sakura-night",
    label: "Sakura Night",
    Component: SakuraNightBackground,
    defaultPalette: "moon",
  },
  { id: "erdtree", label: "Erdtree", Component: ErdtreeBackground, defaultPalette: "erdtree" },
];

describe.each(THEMES)("$label theme", ({ id, Component, defaultPalette }) => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("mounts a canvas and a collapsed controls pill", () => {
    const { container } = render(<Component />);
    expect(container.querySelector("canvas")).toBeInTheDocument();
    expect(screen.getByTestId(`${id}-controls-toggle`)).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the panel with the default palette selected", () => {
    render(<Component />);
    fireEvent.click(screen.getByTestId(`${id}-controls-toggle`));
    expect(screen.getByTestId(`${id}-palette-${defaultPalette}`).className).toContain("font-semibold");
  });

  it("hides the canvas layer when the effect is toggled off", () => {
    const { container } = render(<Component />);
    fireEvent.click(screen.getByTestId(`${id}-controls-toggle`));
    fireEvent.click(screen.getByTestId(`${id}-control-visibility`));

    const layer = container.querySelector('div[aria-hidden="true"]');
    expect(layer?.className).toContain("opacity-0");
  });
});

describe("Erdtree theme specifics", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the tree watermark and removes it when the toggle is off", () => {
    render(<ErdtreeBackground />);
    expect(screen.getByTestId("erdtree-watermark")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("erdtree-controls-toggle"));
    fireEvent.click(screen.getByTestId("erdtree-control-tree"));
    expect(screen.queryByTestId("erdtree-watermark")).not.toBeInTheDocument();
  });
});
