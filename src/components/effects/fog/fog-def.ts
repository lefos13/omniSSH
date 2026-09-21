/*
 * Fog effect definition: layered volumetric fog bands drifting horizontally over
 * a heavy vignette, converging light shafts through the mist, curling mist wisps,
 * and distant tree/pole silhouettes that fade in and out of the haze.
 *
 * Deliberately low-contrast — no bright highlights, the antithesis of the Matrix
 * rain. An earlier high-frequency grain overlay was removed because the per-pixel
 * flicker was fatiguing to look at for long sessions; the wisps and silhouettes
 * give the scene depth without that eye strain.
 *
 * Fog bands and wisps use pre-rendered soft sprites (cached per colour) so there
 * is no per-pixel work per frame.
 */

import { CloudFog, Sun, Wind, Trees, CircleDashed } from "lucide-react";
import type { ControlSpec, Density, EffectDefinition, FrameEnv, Palette } from "../types";
import { DEFAULT_DIMMER_PRESETS, SPEED_PRESETS } from "../types";
import { drawLightShafts, type LightShaft } from "../lightShafts";

const TAU = Math.PI * 2;
const SPRITE_SIZE = 128;

const PALETTES: Record<string, Palette> = {
  silent: {
    head: "#dfe6e2",
    glow: "rgba(150, 170, 160, 1)",
    lead: "#c3ccc6",
    mid: "#8a9990",
    deep: "#3d463f",
    accent: "#a7b5a9",
    fog: "#7d8c82",
    wisp: "#93a29a",
    shaft: "#cbd6cf",
    silhouette: "#1d2420",
  },
  ash: {
    head: "#e6e0da",
    glow: "rgba(170, 155, 140, 1)",
    lead: "#cfc6bb",
    mid: "#9a9086",
    deep: "#463f39",
    accent: "#b3a795",
    fog: "#8c8378",
    wisp: "#a3968a",
    shaft: "#ded3c6",
    silhouette: "#221d19",
  },
  mire: {
    head: "#dbe6cf",
    glow: "rgba(150, 180, 110, 1)",
    lead: "#c4d1ad",
    mid: "#88996a",
    deep: "#3b4430",
    accent: "#9fb27a",
    fog: "#7c8c5e",
    wisp: "#93a876",
    shaft: "#d3e0bd",
    silhouette: "#1e2418",
  },
  pale: {
    head: "#dce6ee",
    glow: "rgba(150, 175, 200, 1)",
    lead: "#c2cfdb",
    mid: "#8899aa",
    deep: "#3a444f",
    accent: "#a4b8c9",
    fog: "#7d8d9c",
    wisp: "#93a6b8",
    shaft: "#cfdbe6",
    silhouette: "#1a2027",
  },
};

const CONTROLS: ControlSpec = {
  palettes: [
    { key: "silent", label: "Silent", dot: "bg-slate-500" },
    { key: "ash", label: "Ash", dot: "bg-stone-500" },
    { key: "mire", label: "Mire", dot: "bg-lime-800" },
    { key: "pale", label: "Pale", dot: "bg-sky-700" },
  ],
  density: [
    { key: "low", label: "Low" },
    { key: "medium", label: "Medium" },
    { key: "high", label: "High" },
  ],
  toggles: [
    { key: "beams", label: "Light Shafts", icon: Sun },
    { key: "wisps", label: "Wisps", icon: Wind },
    { key: "silhouettes", label: "Silhouettes", icon: Trees },
    { key: "vignette", label: "Vignette", icon: CircleDashed },
  ],
  speedPresets: SPEED_PRESETS,
  dimmerPresets: DEFAULT_DIMMER_PRESETS,
};

interface FogBand {
  x: number;
  y: number;
  r: number;
  vx: number;
  alpha: number;
  squash: number;
}

interface Wisp {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  curl: number;
  phase: number;
  phaseSpeed: number;
  scale: number;
  alpha: number;
}

interface Silhouette {
  kind: "tree" | "pole";
  x: number;
  baseY: number;
  size: number;
  depth: number;
  vx: number;
}

interface FogShaft extends LightShaft {
  baseAlpha: number;
  phase: number;
  shimmer: number;
}

interface FogScene {
  w: number;
  h: number;
  bands: FogBand[];
  wisps: Wisp[];
  silhouettes: Silhouette[];
  shafts: FogShaft[];
  /** Cached soft radial sprites keyed by colour, rebuilt when the palette changes. */
  sprites: Map<string, HTMLCanvasElement | null>;
}

function densityConfig(density: Density): {
  bands: number;
  wisps: number;
  silhouettes: number;
  shafts: number;
} {
  switch (density) {
    case "low":
      return { bands: 5, wisps: 5, silhouettes: 7, shafts: 3 };
    case "high":
      return { bands: 16, wisps: 14, silhouettes: 20, shafts: 7 };
    case "medium":
    default:
      return { bands: 9, wisps: 9, silhouettes: 12, shafts: 5 };
  }
}

/*
 * Soft radial sprite for fog bands and wisps, cached per colour so drifting the
 * mist costs one drawImage per blob instead of building a gradient every frame.
 * Guarded so it degrades to "no sprite" without real canvas support.
 */
function getSoftSprite(
  cache: Map<string, HTMLCanvasElement | null>,
  color: string
): HTMLCanvasElement | null {
  if (cache.has(color)) return cache.get(color) ?? null;
  let sprite: HTMLCanvasElement | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = SPRITE_SIZE;
    canvas.height = SPRITE_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      cache.set(color, null);
      return null;
    }
    const gradient = ctx.createRadialGradient(
      SPRITE_SIZE / 2,
      SPRITE_SIZE / 2,
      0,
      SPRITE_SIZE / 2,
      SPRITE_SIZE / 2,
      SPRITE_SIZE / 2
    );
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.45, color);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
    sprite = canvas;
  } catch {
    sprite = null;
  }
  cache.set(color, sprite);
  return sprite;
}

function createScene(size: { w: number; h: number }, cfg: { density: Density }): FogScene {
  const { w, h } = size;
  const counts = densityConfig(cfg.density);

  const bands: FogBand[] = [];
  for (let i = 0; i < counts.bands; i++) {
    bands.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 220 + Math.random() * 360,
      vx: (0.12 + Math.random() * 0.4) * (Math.random() < 0.5 ? -1 : 1),
      alpha: 0.16 + Math.random() * 0.26,
      squash: 0.34 + Math.random() * 0.26,
    });
  }

  const wisps: Wisp[] = [];
  for (let i = 0; i < counts.wisps; i++) {
    wisps.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (0.2 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1),
      vy: (Math.random() - 0.5) * 0.08,
      length: 130 + Math.random() * 260,
      curl: 1.4 + Math.random() * 2.2,
      phase: Math.random() * TAU,
      phaseSpeed: 0.004 + Math.random() * 0.01,
      scale: 34 + Math.random() * 62,
      alpha: 0.16 + Math.random() * 0.22,
    });
  }

  const silhouettes: Silhouette[] = [];
  for (let i = 0; i < counts.silhouettes; i++) {
    const depth = Math.random();
    const kind: Silhouette["kind"] = Math.random() < 0.65 ? "tree" : "pole";
    silhouettes.push({
      kind,
      x: Math.random() * w,
      // Farther shapes sit higher in the frame, nearer ones lower.
      baseY: h * (0.78 + depth * 0.16) + Math.random() * 24,
      size: kind === "tree" ? 60 + depth * 150 : 80 + depth * 120,
      depth,
      vx: (Math.random() - 0.5) * 0.05,
    });
  }

  // Two light sources above the frame; shafts fan out and converge there, which
  // reads as sun breaking through a canopy rather than free-floating rectangles.
  const sources = [
    { x: w * 0.16, y: -h * 0.3, angle: 0.34 },
    { x: w * 0.74, y: -h * 0.26, angle: -0.24 },
  ];
  const shafts: FogShaft[] = [];
  for (let i = 0; i < counts.shafts; i++) {
    const source = sources[i % sources.length];
    const baseAlpha = 0.14 + Math.random() * 0.12;
    shafts.push({
      x: source.x,
      y: source.y,
      angle: source.angle + (Math.random() - 0.5) * 0.34,
      length: h * 1.7 + Math.random() * h * 0.5,
      halfWidth: 70 + Math.random() * 150,
      alpha: baseAlpha,
      baseAlpha,
      phase: Math.random() * TAU,
      shimmer: 0.14 + Math.random() * 0.16,
    });
  }

  return { w, h, bands, wisps, silhouettes, shafts, sprites: new Map() };
}

function drawBands(ctx: CanvasRenderingContext2D, scene: FogScene, env: FrameEnv, speed: number) {
  const sprite = getSoftSprite(scene.sprites, env.palette.fog);
  if (!sprite) return;

  for (const band of scene.bands) {
    band.x += band.vx * speed;
    if (band.x - band.r > scene.w) band.x = -band.r;
    if (band.x + band.r < 0) band.x = scene.w + band.r;

    // Sprites are square; scaling the vertical axis turns them into fog banks.
    ctx.save();
    ctx.globalAlpha = Math.min(1, band.alpha * env.brightness * 2);
    ctx.translate(band.x, band.y);
    ctx.scale(1, band.squash);
    ctx.drawImage(sprite, -band.r, -band.r, band.r * 2, band.r * 2);
    ctx.restore();
  }
}

function drawWisps(ctx: CanvasRenderingContext2D, scene: FogScene, env: FrameEnv, speed: number) {
  const sprite = getSoftSprite(scene.sprites, env.palette.wisp);
  if (!sprite) return;

  const blobs = 6;
  ctx.save();
  for (const wisp of scene.wisps) {
    wisp.phase += wisp.phaseSpeed * speed;
    wisp.x += wisp.vx * speed;
    wisp.y += wisp.vy * speed;
    const span = wisp.length * 1.6;
    if (wisp.x - span > scene.w) wisp.x = -span;
    if (wisp.x + span < 0) wisp.x = scene.w + span;

    for (let k = 0; k < blobs; k++) {
      const t = k / (blobs - 1);
      // A travelling sine along the wisp length gives it a slow curling motion.
      const px = wisp.x + t * wisp.length;
      const py = wisp.y + Math.sin(wisp.phase + t * wisp.curl) * wisp.curl * 18;
      const radius = wisp.scale * Math.sin(Math.PI * (0.18 + t * 0.82));
      if (radius <= 0.5) continue;

      ctx.globalAlpha = Math.min(
        1,
        wisp.alpha * Math.sin(Math.PI * t) * env.brightness * 2
      );
      ctx.drawImage(sprite, px - radius, py - radius, radius * 2, radius * 2);
    }
  }
  ctx.restore();
}

function drawRidge(ctx: CanvasRenderingContext2D, scene: FogScene, env: FrameEnv) {
  ctx.save();
  ctx.globalAlpha = Math.min(1, 0.5 * env.brightness * 2);
  ctx.fillStyle = env.palette.silhouette;
  ctx.beginPath();
  ctx.moveTo(0, scene.h);
  for (let x = 0; x <= scene.w; x += 40) {
    const y =
      scene.h * 0.82 +
      Math.sin(x * 0.004 + 1.3) * 26 +
      Math.sin(x * 0.011 + 0.4) * 12;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(scene.w, scene.h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSilhouettes(ctx: CanvasRenderingContext2D, scene: FogScene, env: FrameEnv) {
  drawRidge(ctx, scene, env);

  ctx.save();
  ctx.fillStyle = env.palette.silhouette;
  ctx.strokeStyle = env.palette.silhouette;
  ctx.lineCap = "round";

  for (const shape of scene.silhouettes) {
    shape.x += shape.vx * env.speed;
    if (shape.x < -200) shape.x = scene.w + 200;
    if (shape.x > scene.w + 200) shape.x = -200;

    // Farther shapes are dimmer, which is what sells the depth through the haze.
    ctx.globalAlpha = Math.min(1, (0.1 + shape.depth * 0.3) * env.brightness * 2);

    if (shape.kind === "tree") {
      const half = shape.size * 0.3;
      ctx.beginPath();
      ctx.moveTo(shape.x, shape.baseY - shape.size);
      ctx.lineTo(shape.x - half, shape.baseY);
      ctx.lineTo(shape.x + half, shape.baseY);
      ctx.closePath();
      ctx.fill();
      // Two lower skirts make it read as a conifer rather than a plain triangle.
      ctx.beginPath();
      ctx.moveTo(shape.x, shape.baseY - shape.size * 0.62);
      ctx.lineTo(shape.x - half * 1.35, shape.baseY - shape.size * 0.18);
      ctx.lineTo(shape.x + half * 1.35, shape.baseY - shape.size * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(shape.x - shape.size * 0.03, shape.baseY - 2, shape.size * 0.06, shape.size * 0.12);
    } else {
      const top = shape.baseY - shape.size;
      ctx.lineWidth = Math.max(1.5, shape.size * 0.03);
      ctx.beginPath();
      ctx.moveTo(shape.x, shape.baseY);
      ctx.lineTo(shape.x, top);
      ctx.stroke();
      // A single leaning crossbar reads as a fence post or a bare branch.
      ctx.beginPath();
      ctx.moveTo(shape.x, top + shape.size * 0.22);
      ctx.lineTo(shape.x + shape.size * 0.18, top + shape.size * 0.1);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawShafts(ctx: CanvasRenderingContext2D, scene: FogScene, env: FrameEnv) {
  for (const shaft of scene.shafts) {
    shaft.phase += 0.008;
    shaft.alpha = shaft.baseAlpha * (1 - shaft.shimmer + shaft.shimmer * (0.5 + 0.5 * Math.sin(shaft.phase)));
  }
  drawLightShafts(ctx, scene.shafts, {
    color: env.palette.shaft,
    brightness: env.brightness,
    strips: 9,
    focus: 0.05,
    additive: true,
  });
}

function drawVignette(ctx: CanvasRenderingContext2D, scene: FogScene, env: FrameEnv) {
  const gradient = ctx.createRadialGradient(
    scene.w / 2,
    scene.h / 2,
    Math.min(scene.w, scene.h) * 0.22,
    scene.w / 2,
    scene.h / 2,
    Math.max(scene.w, scene.h) * 0.72
  );
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, env.palette.deep);
  ctx.save();
  ctx.globalAlpha = Math.min(1, 0.5 * env.brightness * 2);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, scene.w, scene.h);
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, scene: FogScene, env: FrameEnv) {
  const speed = env.speed;

  if (env.toggles.silhouettes !== false) drawSilhouettes(ctx, scene, env);
  drawBands(ctx, scene, env, speed);
  if (env.toggles.wisps !== false) drawWisps(ctx, scene, env, speed);
  if (env.toggles.beams !== false) drawShafts(ctx, scene, env);
  if (env.toggles.vignette !== false) drawVignette(ctx, scene, env);
}

export const FOG_DEF: EffectDefinition<FogScene> = {
  id: "fog",
  label: "Fog",
  icon: CloudFog,
  backgroundColor: "#0b0d0c",
  panelLabel: "Fog effect settings",
  palettes: PALETTES,
  defaultPalette: "silent",
  defaults: {
    speed: 1,
    brightness: 0.3,
    density: "medium",
    toggles: { beams: true, wisps: true, silhouettes: true, vignette: true },
  },
  fps: 20,
  controls: CONTROLS,
  createScene,
  draw,
};
