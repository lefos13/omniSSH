/*
 * Erdtree effect definition: golden motes rising with a warm bloom, faint rune
 * glyphs fading in and out at random positions, and soft god-rays falling from
 * the top. A gnarled great-tree watermark is layered above the canvas by the
 * component (see ErdtreeBackground).
 */

import { Flame, Sparkles, TreeDeciduous, Sun } from "lucide-react";
import type { ControlSpec, Density, EffectDefinition, FrameEnv, Palette } from "../types";
import { DEFAULT_DIMMER_PRESETS, SPEED_PRESETS } from "../types";
import { drawLightShafts, type LightShaft } from "../lightShafts";

const TAU = Math.PI * 2;

const PALETTES: Record<string, Palette> = {
  erdtree: {
    head: "#fff6d8",
    glow: "rgba(255, 200, 80, 1)",
    lead: "#ffe9a8",
    mid: "#e0b040",
    deep: "#5a4310",
    accent: "#ffd45e",
    mote: "#ffcf6a",
    rune: "#f0c860",
    ray: "#e0b040",
  },
  grace: {
    head: "#fffdf0",
    glow: "rgba(255, 235, 170, 1)",
    lead: "#fff3cc",
    mid: "#e8d192",
    deep: "#6b5c30",
    accent: "#ffe9a0",
    mote: "#ffe7a8",
    rune: "#f5e2a8",
    ray: "#e8d192",
  },
  rot: {
    head: "#ffd9cf",
    glow: "rgba(200, 60, 50, 1)",
    lead: "#f2a894",
    mid: "#b8433a",
    deep: "#4a1512",
    accent: "#e2604f",
    mote: "#e07a5a",
    rune: "#c25a4a",
    ray: "#b8433a",
  },
  night: {
    head: "#eaf2ff",
    glow: "rgba(150, 180, 255, 1)",
    lead: "#cfe0ff",
    mid: "#8fa8e0",
    deep: "#2a3350",
    accent: "#a8c4ff",
    mote: "#bcd4ff",
    rune: "#9fc0ff",
    ray: "#8fa8e0",
  },
};

const CONTROLS: ControlSpec = {
  palettes: [
    { key: "erdtree", label: "Erdtree", dot: "bg-amber-400" },
    { key: "grace", label: "Grace", dot: "bg-yellow-200" },
    { key: "rot", label: "Rot", dot: "bg-red-800" },
    { key: "night", label: "Night", dot: "bg-blue-400" },
  ],
  density: [
    { key: "low", label: "Low" },
    { key: "medium", label: "Medium" },
    { key: "high", label: "High" },
  ],
  toggles: [
    { key: "motes", label: "Motes", icon: Flame },
    { key: "runes", label: "Runes", icon: Sparkles },
    { key: "tree", label: "Tree", icon: TreeDeciduous },
    { key: "rays", label: "God Rays", icon: Sun },
  ],
  speedPresets: SPEED_PRESETS,
  dimmerPresets: DEFAULT_DIMMER_PRESETS,
};

/*
 * Original rune-like glyphs expressed as unit-box line segments (0..1). Drawn
 * with strokes so they read as carved marks rather than text.
 */
const GLYPHS: number[][][] = [
  [[0.5, 0.05, 0.5, 0.95], [0.2, 0.35, 0.8, 0.35], [0.25, 0.7, 0.75, 0.7]],
  [[0.15, 0.5, 0.5, 0.05], [0.5, 0.05, 0.85, 0.5], [0.85, 0.5, 0.5, 0.95], [0.5, 0.95, 0.15, 0.5]],
  [[0.5, 0.05, 0.5, 0.95], [0.5, 0.3, 0.2, 0.6], [0.5, 0.3, 0.8, 0.6], [0.5, 0.6, 0.25, 0.9], [0.5, 0.6, 0.75, 0.9]],
  [[0.2, 0.1, 0.8, 0.1], [0.2, 0.1, 0.5, 0.5], [0.8, 0.1, 0.5, 0.5], [0.5, 0.5, 0.5, 0.95]],
  [[0.1, 0.2, 0.9, 0.2], [0.1, 0.8, 0.9, 0.8], [0.3, 0.2, 0.3, 0.8], [0.7, 0.2, 0.7, 0.8]],
];

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  flicker: number;
  life: number;
  maxLife: number;
}

interface Rune {
  x: number;
  y: number;
  glyph: number;
  scale: number;
  life: number;
  maxLife: number;
  rot: number;
}

interface ErdtreeShaft extends LightShaft {
  phase: number;
}

interface ErdtreeScene {
  w: number;
  h: number;
  motes: Mote[];
  runes: Rune[];
  shafts: ErdtreeShaft[];
}

function densityConfig(density: Density): { motes: number; runes: number; rays: number } {
  switch (density) {
    case "low":
      return { motes: 30, runes: 4, rays: 4 };
    case "high":
      return { motes: 150, runes: 14, rays: 7 };
    case "medium":
    default:
      return { motes: 70, runes: 8, rays: 5 };
  }
}

function createMote(scene: { w: number; h: number }, scatter: boolean): Mote {
  const maxLife = 180 + Math.random() * 260;
  return {
    x: Math.random() * scene.w,
    y: scatter ? Math.random() * scene.h : scene.h + Math.random() * 40,
    vx: (Math.random() - 0.5) * 0.35,
    vy: -(0.22 + Math.random() * 0.5),
    size: 1 + Math.random() * 2.1,
    alpha: 0.5 + Math.random() * 0.45,
    flicker: Math.random() * TAU,
    life: Math.random() * maxLife,
    maxLife,
  };
}

function createRune(scene: { w: number; h: number }): Rune {
  return {
    x: Math.random() * scene.w,
    y: Math.random() * scene.h,
    glyph: Math.floor(Math.random() * GLYPHS.length),
    scale: 16 + Math.random() * 26,
    life: 0,
    maxLife: 220 + Math.random() * 260,
    rot: (Math.random() - 0.5) * 0.6,
  };
}

function createScene(size: { w: number; h: number }, cfg: { density: Density }): ErdtreeScene {
  const { w, h } = size;
  const counts = densityConfig(cfg.density);
  const motes: Mote[] = [];
  for (let i = 0; i < counts.motes; i++) motes.push(createMote({ w, h }, true));
  const runes: Rune[] = [];
  for (let i = 0; i < counts.runes; i++) {
    const rune = createRune({ w, h });
    rune.life = Math.random() * rune.maxLife;
    runes.push(rune);
  }
  // God-rays converge from above the canopy rather than sitting as free shapes.
  const shafts: ErdtreeShaft[] = [];
  for (let i = 0; i < counts.rays; i++) {
    const spread = counts.rays > 1 ? i / (counts.rays - 1) : 0.5;
    shafts.push({
      x: w * (0.12 + spread * 0.76),
      y: -h * 0.42,
      angle: (spread - 0.5) * 0.5,
      length: h * 1.8 + Math.random() * h * 0.4,
      halfWidth: 60 + Math.random() * 120,
      alpha: 0.16 + Math.random() * 0.12,
      phase: Math.random() * TAU,
    });
  }
  return { w, h, motes, runes, shafts };
}

function drawShafts(ctx: CanvasRenderingContext2D, scene: ErdtreeScene, env: FrameEnv) {
  for (const shaft of scene.shafts) {
    shaft.phase += 0.006;
  }
  drawLightShafts(ctx, scene.shafts, {
    color: env.palette.ray,
    brightness: env.brightness,
    strips: 10,
    focus: 0.04,
    additive: true,
  });
}

function drawRunes(ctx: CanvasRenderingContext2D, scene: ErdtreeScene, env: FrameEnv) {
  const { palette, brightness } = env;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = palette.rune;
  ctx.lineWidth = 1.6;
  for (let i = 0; i < scene.runes.length; i++) {
    const rune = scene.runes[i];
    rune.life += 1;
    if (rune.life > rune.maxLife) {
      scene.runes[i] = createRune(scene);
      continue;
    }
    // Fade in and out across the rune's lifetime.
    const progress = rune.life / rune.maxLife;
    const fade = Math.sin(progress * Math.PI);
    ctx.globalAlpha = Math.min(1, fade * 0.5 * brightness * 2);
    ctx.save();
    ctx.translate(rune.x, rune.y);
    ctx.rotate(rune.rot);
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of GLYPHS[rune.glyph]) {
      ctx.moveTo((x1 - 0.5) * rune.scale, (y1 - 0.5) * rune.scale);
      ctx.lineTo((x2 - 0.5) * rune.scale, (y2 - 0.5) * rune.scale);
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawMotes(ctx: CanvasRenderingContext2D, scene: ErdtreeScene, env: FrameEnv, speed: number) {
  const { palette, brightness } = env;
  for (let i = 0; i < scene.motes.length; i++) {
    const mote = scene.motes[i];
    mote.life += 1;
    mote.flicker += 0.06;
    mote.x += mote.vx * speed + Math.sin(mote.flicker) * 0.35;
    mote.y += mote.vy * speed;

    if (mote.life > mote.maxLife || mote.y < -20 || mote.x < -20 || mote.x > scene.w + 20) {
      scene.motes[i] = createMote(scene, false);
      continue;
    }

    const fade = 1 - mote.life / mote.maxLife;
    const flick = 0.65 + 0.35 * Math.sin(mote.flicker * 2);
    ctx.globalAlpha = Math.min(1, mote.alpha * fade * flick * brightness * 2.2);
    ctx.shadowBlur = 8;
    ctx.shadowColor = palette.glow;
    ctx.fillStyle = palette.mote;
    ctx.beginPath();
    ctx.arc(mote.x, mote.y, mote.size, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function draw(ctx: CanvasRenderingContext2D, scene: ErdtreeScene, env: FrameEnv) {
  const speed = env.speed;
  if (env.toggles.rays !== false) drawShafts(ctx, scene, env);
  if (env.toggles.runes !== false) drawRunes(ctx, scene, env);
  if (env.toggles.motes !== false) drawMotes(ctx, scene, env, speed);
}

export const ERDTREE_DEF: EffectDefinition<ErdtreeScene> = {
  id: "erdtree",
  label: "Erdtree",
  icon: TreeDeciduous,
  backgroundColor: "#0d0a04",
  panelLabel: "Erdtree effect settings",
  palettes: PALETTES,
  defaultPalette: "erdtree",
  defaults: {
    speed: 1,
    brightness: 0.3,
    density: "medium",
    toggles: { motes: true, runes: true, tree: true, rays: true },
  },
  fps: 30,
  controls: CONTROLS,
  createScene,
  draw,
};
