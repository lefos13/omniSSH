/*
 * Unit tests for the Lava effect definition and simulation mechanics.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { LAVA_DEF, triggerLavaBurst, resetActiveLavaScene } from "./lava-def";
import { installCanvasMock } from "../canvasTestUtils";
import type { FrameEnv } from "../types";

beforeAll(installCanvasMock);

describe("LAVA_DEF", () => {
  it("defines all four required palettes with complete color roles", () => {
    const requiredPalettes = ["magma", "caldera", "brimstone", "cryovolcano"];
    for (const key of requiredPalettes) {
      const palette = LAVA_DEF.palettes[key];
      expect(palette).toBeDefined();
      expect(palette.head).toBeDefined();
      expect(palette.glow).toBeDefined();
      expect(palette.lead).toBeDefined();
      expect(palette.mid).toBeDefined();
      expect(palette.deep).toBeDefined();
      expect(palette.accent).toBeDefined();
      expect(palette.crust).toBeDefined();
      expect(palette.spark).toBeDefined();
    }
  });

  it("scales noise buffer resolution according to density", () => {
    const size = { w: 1000, h: 800 };
    const palette = LAVA_DEF.palettes.magma;
    const toggles = { fissures: true, sparks: true, heatPulse: true };

    const lowScene = LAVA_DEF.createScene(size, { density: "low", palette, toggles });
    const medScene = LAVA_DEF.createScene(size, { density: "medium", palette, toggles });
    const highScene = LAVA_DEF.createScene(size, { density: "high", palette, toggles });

    expect(lowScene.bufW).toBeGreaterThan(0);
    expect(lowScene.bufH).toBeGreaterThan(0);
    expect(lowScene.bufW).toBeLessThan(medScene.bufW);
    expect(medScene.bufW).toBeLessThan(highScene.bufW);
    expect(medScene.imgData.width).toBe(medScene.bufW);
    expect(medScene.imgData.height).toBe(medScene.bufH);
  });

  it("executes draw cycle, renders the flow field, and processes spark bursts", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d")!;

    const scene = LAVA_DEF.createScene({ w: 800, h: 600 }, {
      density: "medium",
      palette: LAVA_DEF.palettes.magma,
      toggles: LAVA_DEF.defaults.toggles,
    });

    const env: FrameEnv = {
      width: 800,
      height: 600,
      dt: 16.67,
      speed: 1,
      brightness: 0.5,
      density: "medium",
      toggles: { fissures: true, sparks: true, heatPulse: true },
      palette: LAVA_DEF.palettes.magma,
      pointer: { x: 400, y: 300, active: true },
    };

    expect(() => {
      LAVA_DEF.draw(ctx, scene, env);
    }).not.toThrow();

    // The pixel pipeline must have written the whole noise buffer
    expect(Array.from(scene.imgData.data).some((v) => v !== 0)).toBe(true);
    // Hot-peak tracking used by periodic eruptions
    expect(scene.hotX).toBeGreaterThanOrEqual(0);
    expect(scene.hotY).toBeGreaterThanOrEqual(0);

    // Trigger interactive spark burst
    expect(() => {
      triggerLavaBurst(400, 300);
    }).not.toThrow();

    expect(scene.sparks.length).toBeGreaterThan(0);

    // Draw frame containing active sparks
    expect(() => {
      LAVA_DEF.draw(ctx, scene, env);
    }).not.toThrow();

    // Toggle off fissures and sparks
    const toggledOffEnv: FrameEnv = {
      ...env,
      toggles: { fissures: false, sparks: false, heatPulse: false },
      pointer: { x: -9999, y: -9999, active: false },
    };

    expect(() => {
      LAVA_DEF.draw(ctx, scene, toggledOffEnv);
    }).not.toThrow();

    // Sparks should be drained when toggled off
    expect(scene.sparks.length).toBe(0);
  });

  it("leaves the noise buffer untouched while fissures are toggled off", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d")!;

    const scene = LAVA_DEF.createScene({ w: 400, h: 300 }, {
      density: "low",
      palette: LAVA_DEF.palettes.magma,
      toggles: LAVA_DEF.defaults.toggles,
    });

    const env: FrameEnv = {
      width: 400,
      height: 300,
      dt: 16.67,
      speed: 1,
      brightness: 0.5,
      density: "low",
      toggles: { fissures: false, sparks: false, heatPulse: false },
      palette: LAVA_DEF.palettes.magma,
      pointer: { x: -9999, y: -9999, active: false },
    };

    LAVA_DEF.draw(ctx, scene, env);

    expect(Array.from(scene.imgData.data).every((v) => v === 0)).toBe(true);
    expect(scene.hotX).toBe(-1);
  });

  it("rebuilds the color ramp on recolor", () => {
    const scene = LAVA_DEF.createScene({ w: 400, h: 300 }, {
      density: "low",
      palette: LAVA_DEF.palettes.magma,
      toggles: LAVA_DEF.defaults.toggles,
    });

    const magmaHot = scene.ramp[240];
    // Hot end of the ramp must actually be incandescent (red channel decoded)
    expect(magmaHot & 0xff).toBeGreaterThan(100);
    // Cold end (crust) must stay dark
    expect(scene.ramp[10] & 0xff).toBeLessThan(60);
    LAVA_DEF.recolor?.(scene, LAVA_DEF.palettes.cryovolcano);
    expect(scene.ramp[240]).not.toBe(magmaHot);
    expect(scene.ramp[240]).not.toBe(0);
  });

  it("caps total sparks and allows clean reset of active scene reference", () => {
    const scene = LAVA_DEF.createScene({ w: 800, h: 600 }, {
      density: "medium",
      palette: LAVA_DEF.palettes.magma,
      toggles: LAVA_DEF.defaults.toggles,
    });

    // Trigger many spark bursts in rapid succession
    for (let i = 0; i < 20; i++) {
      triggerLavaBurst(200, 200);
    }
    // Sparks must stay bounded under 250
    expect(scene.sparks.length).toBeLessThanOrEqual(250);

    resetActiveLavaScene();

    const countBefore = scene.sparks.length;
    // Triggering burst now should have no effect on the detached scene
    triggerLavaBurst(200, 200);
    expect(scene.sparks.length).toBe(countBefore);
  });
});
