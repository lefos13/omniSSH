/*
 * Sakura effect definition: cherry petals drifting down with a lateral sway and a
 * slow tumble, plus converging light shafts and occasional wind gusts.
 *
 * Shipped as two themes built from one factory:
 *  - `sakura`      — the light variant (petals over a soft off-white base).
 *  - `sakura-night` — the dark variant (pale petals, a moon disc and additive
 *    moonlight shafts over a near-black base).
 *
 * A palette only recolours the canvas; `color-scheme` and the UI tokens come from
 * the `data-theme` attribute. That is why the dark look is a separate theme id
 * (`createSakuraDefinition` is given a different `backgroundColor` and palette
 * set) rather than just another palette on the light theme.
 */

import { Flower2, Sun, Wind, Leaf, Moon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  ControlSpec,
  Density,
  EffectDefinition,
  FrameEnv,
  Palette,
  PaletteOption,
} from "../types";
import { DEFAULT_DIMMER_PRESETS, SPEED_PRESETS } from "../types";
import { drawLightShafts, type LightShaft } from "../lightShafts";

const TAU = Math.PI * 2;

const LIGHT_PALETTES: Record<string, Palette> = {
  blossom: {
    head: "#ffffff",
    glow: "rgba(255, 150, 190, 1)",
    lead: "#ffd6e6",
    mid: "#f7a8c4",
    deep: "#d98aa8",
    accent: "#ff8fb5",
    petal: "#ffb3cf",
    ray: "#f7a8c4",
  },
  ume: {
    head: "#ffffff",
    glow: "rgba(220, 60, 90, 1)",
    lead: "#ffd9e0",
    mid: "#e86a86",
    deep: "#b83b55",
    accent: "#dd4a6a",
    petal: "#f2879f",
    ray: "#e86a86",
  },
  yuzu: {
    head: "#ffffff",
    glow: "rgba(255, 190, 90, 1)",
    lead: "#ffe9c2",
    mid: "#e6b45c",
    deep: "#b8853a",
    accent: "#f2c14e",
    petal: "#f7d08a",
    ray: "#e6b45c",
  },
  momiji: {
    head: "#ffffff",
    glow: "rgba(230, 90, 60, 1)",
    lead: "#ffd6c2",
    mid: "#e0734f",
    deep: "#b04a2c",
    accent: "#e2603a",
    petal: "#ef8f6a",
    ray: "#e0734f",
  },
};

const NIGHT_PALETTES: Record<string, Palette> = {
  moon: {
    head: "#ffffff",
    glow: "rgba(255, 190, 220, 1)",
    lead: "#fff0f6",
    mid: "#e8b7cc",
    deep: "#4a2a3a",
    accent: "#ff9ec4",
    petal: "#ffd9e6",
    ray: "#c8b0d8",
  },
  yozakura: {
    head: "#ffffff",
    glow: "rgba(190, 120, 230, 1)",
    lead: "#e2c4ff",
    mid: "#9a5cc0",
    deep: "#2a1a3a",
    accent: "#b06ad8",
    petal: "#c98ad8",
    ray: "#8f6ab8",
  },
  lantern: {
    head: "#ffffff",
    glow: "rgba(255, 190, 110, 1)",
    lead: "#ffe9c2",
    mid: "#d99a4a",
    deep: "#3a2a12",
    accent: "#ffb85e",
    petal: "#ffcf8a",
    ray: "#c98a3a",
  },
  ash: {
    head: "#ffffff",
    glow: "rgba(180, 196, 220, 1)",
    lead: "#e6eaf2",
    mid: "#8a93a3",
    deep: "#22262f",
    accent: "#a8b2c4",
    petal: "#c9ced8",
    ray: "#7f8a9c",
  },
};

interface Petal {
  x: number;
  y: number;
  vy: number;
  sway: number;
  swayPhase: number;
  rot: number;
  spin: number;
  tumble: number;
  size: number;
  alpha: number;
  tint: number;
}

interface SakuraShaft extends LightShaft {
  phase: number;
  baseAlpha: number;
  shimmer: number;
}

interface SakuraScene {
  w: number;
  h: number;
  petals: Petal[];
  shafts: SakuraShaft[];
  wind: number;
  windPhase: number;
  gust: number;
}

function densityConfig(density: Density): { petals: number; shafts: number } {
  switch (density) {
    case "low":
      return { petals: 30, shafts: 4 };
    case "high":
      return { petals: 140, shafts: 7 };
    case "medium":
    default:
      return { petals: 70, shafts: 5 };
  }
}

interface SakuraVariant {
  id: string;
  label: string;
  icon: LucideIcon;
  backgroundColor: string;
  panelLabel: string;
  palettes: Record<string, Palette>;
  defaultPalette: string;
  paletteOptions: PaletteOption[];
  defaultBrightness: number;
  /** Icon/label for the light toggle — "Sun Rays" or "Moonlight". */
  raysIcon: LucideIcon;
  raysLabel: string;
  /** Palette role used for the shaft colour. */
  rayColorRole: string;
  /** Additive shafts for light-over-dark; source-over for the light theme. */
  rayAdditive: boolean;
  /** Base shaft opacity and the amplitude of its slow shimmer. */
  rayAlpha: number;
  rayShimmer: number;
  /** Draw a soft moon disc (dark variant only). */
  moon: boolean;
}

function createSakuraDefinition(cfg: SakuraVariant): EffectDefinition<SakuraScene> {
  const controls: ControlSpec = {
    palettes: cfg.paletteOptions,
    density: [
      { key: "low", label: "Low" },
      { key: "medium", label: "Medium" },
      { key: "high", label: "High" },
    ],
    toggles: [
      { key: "petals", label: "Petals", icon: Flower2 },
      { key: "rays", label: cfg.raysLabel, icon: cfg.raysIcon },
      { key: "gusts", label: "Gusts", icon: Wind },
    ],
    speedPresets: SPEED_PRESETS,
    dimmerPresets: DEFAULT_DIMMER_PRESETS,
  };

  function createScene(size: { w: number; h: number }, config: { density: Density }): SakuraScene {
    const { w, h } = size;
    const counts = densityConfig(config.density);

    const petals: Petal[] = [];
    for (let i = 0; i < counts.petals; i++) {
      petals.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vy: 0.4 + Math.random() * 0.85,
        sway: 0.3 + Math.random() * 0.9,
        swayPhase: Math.random() * TAU,
        rot: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 0.05,
        tumble: Math.random() * TAU,
        size: 4 + Math.random() * 7,
        alpha: 0.5 + Math.random() * 0.4,
        tint: Math.random(),
      });
    }

    // Light enters from a high corner and fans down across the frame.
    const originX = w * (cfg.moon ? 0.78 : 0.62);
    const originY = -h * 0.22;
    const shafts: SakuraShaft[] = [];
    for (let i = 0; i < counts.shafts; i++) {
      const spread = counts.shafts > 1 ? i / (counts.shafts - 1) : 0.5;
      shafts.push({
        x: originX,
        y: originY,
        angle: (spread - 0.5) * 0.85,
        length: h * 1.9 + Math.random() * h * 0.4,
        halfWidth: 70 + Math.random() * 150,
        alpha: cfg.rayAlpha,
        baseAlpha: cfg.rayAlpha,
        phase: Math.random() * TAU,
        shimmer: cfg.rayShimmer,
      });
    }

    return { w, h, petals, shafts, wind: 0, windPhase: Math.random() * TAU, gust: 0 };
  }

  function drawMoon(ctx: CanvasRenderingContext2D, scene: SakuraScene, env: FrameEnv) {
    const mx = scene.w * 0.78;
    const my = scene.h * 0.2;
    const radius = Math.min(scene.w, scene.h) * 0.13;
    const halo = ctx.createRadialGradient(mx, my, 0, mx, my, radius * 3.4);
    halo.addColorStop(0, env.palette.lead);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, 0.22 * env.brightness * 2);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(mx, my, radius * 3.4, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = Math.min(1, 0.75 * env.brightness * 2);
    ctx.fillStyle = env.palette.head;
    ctx.beginPath();
    ctx.arc(mx, my, radius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawPetals(ctx: CanvasRenderingContext2D, scene: SakuraScene, env: FrameEnv, speed: number) {
    const { palette, brightness } = env;
    const gust = scene.gust;

    for (const petal of scene.petals) {
      petal.swayPhase += 0.02 * speed;
      petal.tumble += 0.03 * speed;
      petal.rot += petal.spin * speed;
      petal.y += petal.vy * speed;
      petal.x += (Math.sin(petal.swayPhase) * petal.sway + scene.wind + gust) * speed;

      if (petal.y > scene.h + 20) {
        petal.y = -20;
        petal.x = Math.random() * scene.w;
      }
      if (petal.x > scene.w + 30) petal.x = -30;
      if (petal.x < -30) petal.x = scene.w + 30;

      // Scale the horizontal axis by |cos| to fake a 3D tumble.
      const flip = Math.abs(Math.cos(petal.tumble)) * 0.75 + 0.25;
      const color =
        petal.tint < 0.42 ? palette.petal : petal.tint < 0.78 ? palette.lead : palette.mid;

      ctx.save();
      ctx.translate(petal.x, petal.y);
      ctx.rotate(petal.rot);
      ctx.scale(petal.size * flip, petal.size);
      ctx.globalAlpha = Math.min(1, petal.alpha * brightness * 1.6);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -1);
      ctx.quadraticCurveTo(1, -0.2, 0, 1);
      ctx.quadraticCurveTo(-1, -0.2, 0, -1);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawRays(ctx: CanvasRenderingContext2D, scene: SakuraScene, env: FrameEnv) {
    for (const shaft of scene.shafts) {
      shaft.phase += 0.007;
      shaft.alpha =
        shaft.baseAlpha *
        (1 - shaft.shimmer + shaft.shimmer * (0.5 + 0.5 * Math.sin(shaft.phase)));
    }
    if (cfg.moon) drawMoon(ctx, scene, env);
    drawLightShafts(ctx, scene.shafts, {
      color: env.palette[cfg.rayColorRole],
      brightness: env.brightness,
      strips: 8,
      focus: 0.04,
      additive: cfg.rayAdditive,
    });
  }

  function draw(ctx: CanvasRenderingContext2D, scene: SakuraScene, env: FrameEnv) {
    const speed = env.speed;

    // Slow ambient wind plus occasional gusts (when enabled).
    scene.windPhase += 0.006 * speed;
    scene.wind = Math.sin(scene.windPhase) * 0.35;
    if (env.toggles.gusts !== false) {
      scene.gust = Math.max(0, Math.sin(scene.windPhase * 0.37) - 0.85) * 2.2;
    } else {
      scene.gust = 0;
    }

    if (env.toggles.rays !== false) drawRays(ctx, scene, env);
    if (env.toggles.petals !== false) drawPetals(ctx, scene, env, speed);
  }

  return {
    id: cfg.id,
    label: cfg.label,
    icon: cfg.icon,
    backgroundColor: cfg.backgroundColor,
    panelLabel: cfg.panelLabel,
    palettes: cfg.palettes,
    defaultPalette: cfg.defaultPalette,
    defaults: {
      speed: 1,
      brightness: cfg.defaultBrightness,
      density: "medium",
      toggles: { petals: true, rays: true, gusts: true },
    },
    fps: 30,
    controls,
    createScene,
    draw,
  };
}

export const SAKURA_DEF = createSakuraDefinition({
  id: "sakura",
  label: "Sakura",
  icon: Leaf,
  backgroundColor: "#fdf6f8",
  panelLabel: "Sakura effect settings",
  palettes: LIGHT_PALETTES,
  defaultPalette: "blossom",
  paletteOptions: [
    { key: "blossom", label: "Blossom", dot: "bg-pink-400" },
    { key: "ume", label: "Ume", dot: "bg-rose-500" },
    { key: "yuzu", label: "Yuzu", dot: "bg-amber-400" },
    { key: "momiji", label: "Momiji", dot: "bg-orange-500" },
  ],
  defaultBrightness: 0.65,
  raysIcon: Sun,
  raysLabel: "Sun Rays",
  rayColorRole: "ray",
  rayAdditive: false,
  rayAlpha: 0.22,
  rayShimmer: 0.3,
  moon: false,
});

export const SAKURA_NIGHT_DEF = createSakuraDefinition({
  id: "sakura-night",
  label: "Sakura Night",
  icon: Moon,
  backgroundColor: "#140a12",
  panelLabel: "Sakura Night effect settings",
  palettes: NIGHT_PALETTES,
  defaultPalette: "moon",
  paletteOptions: [
    { key: "moon", label: "Moon", dot: "bg-pink-200" },
    { key: "yozakura", label: "Yozakura", dot: "bg-purple-500" },
    { key: "lantern", label: "Lantern", dot: "bg-amber-500" },
    { key: "ash", label: "Ash", dot: "bg-slate-400" },
  ],
  defaultBrightness: 0.5,
  raysIcon: Moon,
  raysLabel: "Moonlight",
  rayColorRole: "ray",
  rayAdditive: true,
  rayAlpha: 0.18,
  rayShimmer: 0.4,
  moon: true,
});
