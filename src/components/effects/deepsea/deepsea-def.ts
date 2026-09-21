/*
 * Deep Sea effect definition: an abyssal scene of rising bubble streams,
 * drifting bioluminescent blobs, slow plankton motes, and a shimmering caustic
 * light band near the surface. Palette and density are read per frame so a
 * palette swap is instant.
 */

import { Droplets, Waves, Sparkles, ShipWheel } from "lucide-react";
import type { ControlSpec, Density, EffectDefinition, FrameEnv, Palette } from "../types";
import { DEFAULT_DIMMER_PRESETS, SPEED_PRESETS } from "../types";

const TAU = Math.PI * 2;

const PALETTES: Record<string, Palette> = {
  abyss: {
    head: "#eaf6ff",
    glow: "rgba(80, 200, 255, 1)",
    lead: "#a8e5ff",
    mid: "#2a9fd6",
    deep: "#0b3a56",
    accent: "#4fd6ff",
    bubble: "#bfe9ff",
    mote: "#9fe8ff",
    blob: "#39c7ff",
  },
  trench: {
    head: "#e6ecff",
    glow: "rgba(120, 110, 255, 1)",
    lead: "#b9c2ff",
    mid: "#4a52c9",
    deep: "#141a4a",
    accent: "#8f9bff",
    bubble: "#cdd4ff",
    mote: "#a9b2ff",
    blob: "#6a6cff",
  },
  coral: {
    head: "#ffffff",
    glow: "rgba(0, 230, 200, 1)",
    lead: "#b6fff2",
    mid: "#12b39a",
    deep: "#0a3f3a",
    accent: "#ff8a6b",
    bubble: "#c9fff5",
    mote: "#ffd0b8",
    blob: "#2fd8bd",
  },
  twilight: {
    head: "#f3eaff",
    glow: "rgba(170, 120, 255, 1)",
    lead: "#dcc8ff",
    mid: "#7a4fd0",
    deep: "#2a1a52",
    accent: "#c08bff",
    bubble: "#e3d6ff",
    mote: "#c9b0ff",
    blob: "#9a6cff",
  },
};

const CONTROLS: ControlSpec = {
  palettes: [
    { key: "abyss", label: "Abyss", dot: "bg-sky-600" },
    { key: "trench", label: "Trench", dot: "bg-indigo-700" },
    { key: "coral", label: "Coral", dot: "bg-teal-400" },
    { key: "twilight", label: "Twilight", dot: "bg-violet-500" },
  ],
  density: [
    { key: "low", label: "Low" },
    { key: "medium", label: "Medium" },
    { key: "high", label: "High" },
  ],
  toggles: [
    { key: "bubbles", label: "Bubbles", icon: Droplets },
    { key: "bioluminescence", label: "Glow", icon: Sparkles },
    { key: "caustics", label: "Caustics", icon: Waves },
  ],
  speedPresets: SPEED_PRESETS,
  dimmerPresets: DEFAULT_DIMMER_PRESETS,
};

interface Bubble {
  x: number;
  y: number;
  r: number;
  vy: number;
  vx: number;
  phase: number;
  alpha: number;
  depth: number;
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
  alpha: number;
}

interface Blob {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  phase: number;
}

interface DeepSeaScene {
  w: number;
  h: number;
  bubbles: Bubble[];
  motes: Mote[];
  blobs: Blob[];
  causticPhase: number;
}

function densityConfig(density: Density): { bubbles: number; motes: number; blobs: number } {
  switch (density) {
    case "low":
      return { bubbles: 34, motes: 40, blobs: 3 };
    case "high":
      return { bubbles: 130, motes: 160, blobs: 9 };
    case "medium":
    default:
      return { bubbles: 72, motes: 90, blobs: 6 };
  }
}

function createScene(
  size: { w: number; h: number },
  cfg: { density: Density }
): DeepSeaScene {
  const { w, h } = size;
  const counts = densityConfig(cfg.density);
  const bubbles: Bubble[] = [];
  for (let i = 0; i < counts.bubbles; i++) {
    const depth = Math.random();
    bubbles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 1 + depth * 3.4,
      vy: -(0.25 + depth * 0.9),
      vx: (Math.random() - 0.5) * 0.25,
      phase: Math.random() * TAU,
      alpha: 0.18 + depth * 0.4,
      depth,
    });
  }
  const motes: Mote[] = [];
  for (let i = 0; i < counts.motes; i++) {
    motes.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.16,
      vy: (Math.random() - 0.5) * 0.16,
      size: 0.6 + Math.random() * 1.5,
      phase: Math.random() * TAU,
      alpha: 0.2 + Math.random() * 0.5,
    });
  }
  const blobs: Blob[] = [];
  for (let i = 0; i < counts.blobs; i++) {
    blobs.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 90 + Math.random() * 190,
      vx: (Math.random() - 0.5) * 0.2,
      vy: (Math.random() - 0.5) * 0.2,
      phase: Math.random() * TAU,
    });
  }
  return { w, h, bubbles, motes, blobs, causticPhase: 0 };
}

function drawCaustics(ctx: CanvasRenderingContext2D, scene: DeepSeaScene, env: FrameEnv) {
  const { width, brightness, palette } = env;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  const bands = 5;
  const span = scene.h * 0.42;
  for (let b = 0; b < bands; b++) {
    const baseY = (b / (bands - 1)) * span;
    ctx.beginPath();
    for (let x = 0; x <= width; x += 24) {
      const wave =
        Math.sin(x * 0.006 + scene.causticPhase + b * 1.7) * 12 +
        Math.sin(x * 0.013 - scene.causticPhase * 0.7 + b) * 6;
      const y = baseY + wave;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = Math.min(1, (0.1 - b * 0.012) * brightness * 2);
    ctx.strokeStyle = palette.mid;
    ctx.lineWidth = 1 + b * 0.4;
    ctx.stroke();
  }
  ctx.restore();
}

function drawBlobs(ctx: CanvasRenderingContext2D, scene: DeepSeaScene, env: FrameEnv, speed: number) {
  const { palette, brightness } = env;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const blob of scene.blobs) {
    blob.phase += 0.012;
    blob.x += blob.vx * speed;
    blob.y += blob.vy * speed;
    if (blob.x < -blob.r) blob.x = scene.w + blob.r;
    if (blob.x > scene.w + blob.r) blob.x = -blob.r;
    if (blob.y < -blob.r) blob.y = scene.h + blob.r;
    if (blob.y > scene.h + blob.r) blob.y = -blob.r;

    const pulse = 0.72 + 0.28 * Math.sin(blob.phase);
    const radius = blob.r * pulse;
    const gradient = ctx.createRadialGradient(blob.x, blob.y, 0, blob.x, blob.y, radius);
    gradient.addColorStop(0, palette.blob);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = Math.min(1, 0.24 * brightness * 2);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(blob.x, blob.y, radius, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawMotes(ctx: CanvasRenderingContext2D, scene: DeepSeaScene, env: FrameEnv, speed: number) {
  const { palette, brightness } = env;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const mote of scene.motes) {
    mote.phase += 0.05;
    mote.x += mote.vx * speed;
    mote.y += mote.vy * speed;
    if (mote.x < -10) mote.x = scene.w + 10;
    if (mote.x > scene.w + 10) mote.x = -10;
    if (mote.y < -10) mote.y = scene.h + 10;
    if (mote.y > scene.h + 10) mote.y = -10;

    const flicker = 0.6 + 0.4 * Math.sin(mote.phase);
    ctx.globalAlpha = Math.min(1, mote.alpha * flicker * brightness * 1.6);
    ctx.fillStyle = palette.mote;
    ctx.beginPath();
    ctx.arc(mote.x, mote.y, mote.size, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawBubbles(ctx: CanvasRenderingContext2D, scene: DeepSeaScene, env: FrameEnv, speed: number) {
  const { palette, brightness } = env;
  for (const bubble of scene.bubbles) {
    bubble.phase += 0.04;
    bubble.y += bubble.vy * speed;
    bubble.x += bubble.vx * speed + Math.sin(bubble.phase) * 0.25;

    if (bubble.y < -bubble.r * 2) {
      bubble.y = scene.h + bubble.r * 2;
      bubble.x = Math.random() * scene.w;
    }

    ctx.globalAlpha = Math.min(1, bubble.alpha * brightness * 1.8);
    ctx.strokeStyle = palette.bubble;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(bubble.x, bubble.y, bubble.r, 0, TAU);
    ctx.stroke();

    // Small specular highlight so bubbles read as glassy rather than flat rings.
    ctx.globalAlpha = Math.min(1, bubble.alpha * brightness * 2.6);
    ctx.fillStyle = palette.head;
    ctx.beginPath();
    ctx.arc(bubble.x - bubble.r * 0.3, bubble.y - bubble.r * 0.35, bubble.r * 0.28, 0, TAU);
    ctx.fill();
  }
}

function draw(ctx: CanvasRenderingContext2D, scene: DeepSeaScene, env: FrameEnv) {
  const speed = env.speed;
  scene.causticPhase += 0.02 * speed;

  if (env.toggles.bioluminescence !== false) drawBlobs(ctx, scene, env, speed);
  drawMotes(ctx, scene, env, speed);
  if (env.toggles.caustics !== false) drawCaustics(ctx, scene, env);
  if (env.toggles.bubbles !== false) drawBubbles(ctx, scene, env, speed);
}

export const DEEPSEA_DEF: EffectDefinition<DeepSeaScene> = {
  id: "deepsea",
  label: "Deep Sea",
  icon: ShipWheel,
  backgroundColor: "#030814",
  panelLabel: "Deep Sea effect settings",
  palettes: PALETTES,
  defaultPalette: "abyss",
  defaults: {
    speed: 1,
    brightness: 0.3,
    density: "medium",
    toggles: { bubbles: true, bioluminescence: true, caustics: true },
  },
  fps: 30,
  controls: CONTROLS,
  createScene,
  draw,
};
