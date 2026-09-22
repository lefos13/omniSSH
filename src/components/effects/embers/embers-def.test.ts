/*
 * Unit tests for the Embers effect definition and simulation mechanics.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { EMBERS_DEF } from "./embers-def";
import { installCanvasMock } from "../canvasTestUtils";
import type { FrameEnv } from "../types";

beforeAll(installCanvasMock);

describe("EMBERS_DEF", () => {
  it("defines all four required palettes with complete color roles", () => {
    const requiredPalettes = ["forge", "apocalypse", "blue-flame", "ash"];
    for (const key of requiredPalettes) {
      const palette = EMBERS_DEF.palettes[key];
      expect(palette).toBeDefined();
      expect(palette.head).toBeDefined();
      expect(palette.glow).toBeDefined();
      expect(palette.lead).toBeDefined();
      expect(palette.mid).toBeDefined();
      expect(palette.deep).toBeDefined();
      expect(palette.accent).toBeDefined();
      expect(palette.ember).toBeDefined();
      expect(palette.soot).toBeDefined();
    }
  });

  it("scales ember and soot particle counts according to density", () => {
    const size = { w: 1000, h: 800 };
    const palette = EMBERS_DEF.palettes.forge;
    const toggles = { embers: true, glowLine: true, shimmer: true, soot: true };

    const lowScene = EMBERS_DEF.createScene(size, { density: "low", palette, toggles });
    const medScene = EMBERS_DEF.createScene(size, { density: "medium", palette, toggles });
    const highScene = EMBERS_DEF.createScene(size, { density: "high", palette, toggles });

    expect(lowScene.embers.length).toBeLessThan(medScene.embers.length);
    expect(medScene.embers.length).toBeLessThan(highScene.embers.length);

    expect(lowScene.soot.length).toBeLessThan(medScene.soot.length);
    expect(medScene.soot.length).toBeLessThan(highScene.soot.length);
  });

  it("executes draw cycle across frames with and without pointer proximity", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d")!;

    const scene = EMBERS_DEF.createScene({ w: 800, h: 600 }, {
      density: "medium",
      palette: EMBERS_DEF.palettes.forge,
      toggles: EMBERS_DEF.defaults.toggles,
    });

    const baseEnv: FrameEnv = {
      width: 800,
      height: 600,
      dt: 16.67,
      speed: 1,
      brightness: 0.5,
      density: "medium",
      toggles: { embers: true, glowLine: true, shimmer: true, soot: true },
      palette: EMBERS_DEF.palettes.forge,
      pointer: { x: 400, y: 300, active: true },
    };

    expect(() => {
      EMBERS_DEF.draw(ctx, scene, baseEnv);
    }).not.toThrow();

    // Toggle off everything
    const toggledOffEnv: FrameEnv = {
      ...baseEnv,
      toggles: { embers: false, glowLine: false, shimmer: false, soot: false },
      pointer: { x: -9999, y: -9999, active: false },
    };

    expect(() => {
      EMBERS_DEF.draw(ctx, scene, toggledOffEnv);
    }).not.toThrow();
  });

  it("sustains ember lifespan across hundreds of milliseconds without premature death", () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const scene = EMBERS_DEF.createScene({ w: 800, h: 600 }, {
      density: "low",
      palette: EMBERS_DEF.palettes.forge,
      toggles: EMBERS_DEF.defaults.toggles,
    });

    // Initialize all embers with life = 0
    for (const ember of scene.embers) {
      ember.life = 0;
      ember.y = 500;
    }

    const env: FrameEnv = {
      width: 800,
      height: 600,
      dt: 33.3, // 30 FPS frame duration in ms
      speed: 1,
      brightness: 0.5,
      density: "low",
      toggles: { embers: true, glowLine: true, shimmer: true, soot: false },
      palette: EMBERS_DEF.palettes.forge,
      pointer: { x: -9999, y: -9999, active: false },
    };

    // Run 15 frames (~500ms)
    for (let i = 0; i < 15; i++) {
      EMBERS_DEF.draw(ctx, scene, env);
    }

    // Every ember should still be alive because maxLife is 5000ms+
    for (const ember of scene.embers) {
      expect(ember.life).toBeGreaterThanOrEqual(490);
      expect(ember.life).toBeLessThan(ember.maxLife);
    }
  });

  it("damps lateral velocity after pointer interaction passes", () => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const scene = EMBERS_DEF.createScene({ w: 800, h: 600 }, {
      density: "low",
      palette: EMBERS_DEF.palettes.forge,
      toggles: EMBERS_DEF.defaults.toggles,
    });

    // Give the first ember an extreme lateral velocity as if violently pushed
    scene.embers[0].vx = 8.0;

    const envNoPointer: FrameEnv = {
      width: 800,
      height: 600,
      dt: 16.67,
      speed: 1,
      brightness: 0.5,
      density: "low",
      toggles: { embers: true, glowLine: false, shimmer: false, soot: false },
      palette: EMBERS_DEF.palettes.forge,
      pointer: { x: -9999, y: -9999, active: false },
    };

    // Run 30 frames without pointer
    for (let i = 0; i < 30; i++) {
      EMBERS_DEF.draw(ctx, scene, envNoPointer);
    }

    // Velocity should be substantially damped
    expect(scene.embers[0].vx).toBeLessThan(4.5);
  });
});
