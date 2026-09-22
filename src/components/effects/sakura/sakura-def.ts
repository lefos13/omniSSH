/*
 * Sakura effect definition: cherry petals drifting down with a lateral sway and a
 * slow tumble, plus occasional wind gusts.
 *
 * Shipped as two themes built from one factory:
 *  - `sakura`       — the light variant (petals over a soft off-white base).
 *  - `sakura-night` — the dark variant (pale petals and an optional moon disc
 *    over a near-black base).
 *
 * A palette only recolours the canvas; `color-scheme` and the UI tokens come from
 * the `data-theme` attribute. That is why the dark look is a separate theme id
 * (`createSakuraDefinition` is given a different `backgroundColor` and palette
 * set) rather than just another palette on the light theme.
 */

import { Flower2, Wind, Leaf, Moon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  ControlSpec,
  Density,
  EffectDefinition,
  FrameEnv,
  Palette,
  PaletteOption,
  ToggleOption,
} from "../types";
import { DEFAULT_DIMMER_PRESETS, SPEED_PRESETS } from "../types";

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
  },
  ume: {
    head: "#ffffff",
    glow: "rgba(220, 60, 90, 1)",
    lead: "#ffd9e0",
    mid: "#e86a86",
    deep: "#b83b55",
    accent: "#dd4a6a",
    petal: "#f2879f",
  },
  yuzu: {
    head: "#ffffff",
    glow: "rgba(255, 190, 90, 1)",
    lead: "#ffe9c2",
    mid: "#e6b45c",
    deep: "#b8853a",
    accent: "#f2c14e",
    petal: "#f7d08a",
  },
  momiji: {
    head: "#ffffff",
    glow: "rgba(230, 90, 60, 1)",
    lead: "#ffd6c2",
    mid: "#e0734f",
    deep: "#b04a2c",
    accent: "#e2603a",
    petal: "#ef8f6a",
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
  },
  yozakura: {
    head: "#ffffff",
    glow: "rgba(190, 120, 230, 1)",
    lead: "#e2c4ff",
    mid: "#9a5cc0",
    deep: "#2a1a3a",
    accent: "#b06ad8",
    petal: "#c98ad8",
  },
  lantern: {
    head: "#ffffff",
    glow: "rgba(255, 190, 110, 1)",
    lead: "#ffe9c2",
    mid: "#d99a4a",
    deep: "#3a2a12",
    accent: "#ffb85e",
    petal: "#ffcf8a",
  },
  ash: {
    head: "#ffffff",
    glow: "rgba(180, 196, 220, 1)",
    lead: "#e6eaf2",
    mid: "#8a93a3",
    deep: "#22262f",
    accent: "#a8b2c4",
    petal: "#c9ced8",
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

interface SakuraScene {
  w: number;
  h: number;
  petals: Petal[];
  wind: number;
  windPhase: number;
  gust: number;
}

function densityConfig(density: Density): { petals: number } {
  switch (density) {
    case "low":
      return { petals: 30 };
    case "high":
      return { petals: 140 };
    case "medium":
    default:
      return { petals: 70 };
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
  /** Offer a moon-disc toggle (dark variant only). */
  moon: boolean;
}

function createSakuraDefinition(cfg: SakuraVariant): EffectDefinition<SakuraScene> {
  const toggles: ToggleOption[] = [{ key: "petals", label: "Petals", icon: Flower2 }];
  if (cfg.moon) toggles.push({ key: "moon", label: "Moon", icon: Moon });
  toggles.push({ key: "gusts", label: "Gusts", icon: Wind });

  const defaultToggles: Record<string, boolean> = { petals: true, gusts: true };
  if (cfg.moon) defaultToggles.moon = true;

  const controls: ControlSpec = {
    palettes: cfg.paletteOptions,
    density: [
      { key: "low", label: "Low" },
      { key: "medium", label: "Medium" },
      { key: "high", label: "High" },
    ],
    toggles,
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

    return { w, h, petals, wind: 0, windPhase: Math.random() * TAU, gust: 0 };
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

  function drawPetals(
    ctx: CanvasRenderingContext2D,
    scene: SakuraScene,
    env: FrameEnv,
    speed: number
  ) {
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

    if (cfg.moon && env.toggles.moon !== false) drawMoon(ctx, scene, env);
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
      toggles: defaultToggles,
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
  moon: true,
});
