/*
 * Starfield effect definition: three parallax star layers with a slow drift and
 * gentle twinkle, occasional shooting stars, soft nebula gradient blobs, and
 * optional constellation lines between neighbouring foreground stars. The
 * cheapest of the special effects — almost all work is static point drawing.
 */

import { Sparkles, Stars, Zap, Network } from "lucide-react";
import type { ControlSpec, Density, EffectDefinition, FrameEnv, Palette } from "../types";
import { DEFAULT_DIMMER_PRESETS, SPEED_PRESETS } from "../types";

const TAU = Math.PI * 2;

const PALETTES: Record<string, Palette> = {
  deepspace: {
    head: "#ffffff",
    glow: "rgba(140, 180, 255, 1)",
    lead: "#cfe0ff",
    mid: "#6f8fd8",
    deep: "#1c2c50",
    accent: "#8fb4ff",
    star: "#dbe7ff",
    nebula: "#3d5bd6",
  },
  nebula: {
    head: "#fff2ff",
    glow: "rgba(210, 120, 255, 1)",
    lead: "#f0d4ff",
    mid: "#a05cd8",
    deep: "#3a1c58",
    accent: "#d98cff",
    star: "#f4e0ff",
    nebula: "#7a3fd0",
  },
  void: {
    head: "#ffffff",
    glow: "rgba(200, 210, 230, 1)",
    lead: "#d8dee9",
    mid: "#7c8698",
    deep: "#20242c",
    accent: "#9aa6b8",
    star: "#e6ebf2",
    nebula: "#4a5260",
  },
  aurora: {
    head: "#ffffff",
    glow: "rgba(80, 240, 210, 1)",
    lead: "#c8fff0",
    mid: "#2fb99a",
    deep: "#0f3f38",
    accent: "#7dffdc",
    star: "#d8fff5",
    nebula: "#2ad6a8",
  },
};

const CONTROLS: ControlSpec = {
  palettes: [
    { key: "deepspace", label: "Deep Space", dot: "bg-blue-600" },
    { key: "nebula", label: "Nebula", dot: "bg-fuchsia-500" },
    { key: "void", label: "Void", dot: "bg-slate-500" },
    { key: "aurora", label: "Aurora", dot: "bg-teal-400" },
  ],
  density: [
    { key: "low", label: "Low" },
    { key: "medium", label: "Medium" },
    { key: "high", label: "High" },
  ],
  toggles: [
    { key: "shooting", label: "Shooting Stars", icon: Zap },
    { key: "nebula", label: "Nebula", icon: Sparkles },
    { key: "constellations", label: "Constellations", icon: Network },
  ],
  speedPresets: SPEED_PRESETS,
  dimmerPresets: DEFAULT_DIMMER_PRESETS,
};

interface Star {
  x: number;
  y: number;
  r: number;
  depth: number;
  vx: number;
  vy: number;
  phase: number;
  twinkleRate: number;
  base: number;
}

interface Shooting {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  len: number;
}

interface Nebula {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
}

interface StarfieldScene {
  w: number;
  h: number;
  stars: Star[];
  shooting: Shooting[];
  nebulas: Nebula[];
  constellations: [number, number][];
  spawnCooldown: number;
}

function densityConfig(density: Density): { stars: number; nebulas: number; spawn: number } {
  switch (density) {
    case "low":
      return { stars: 140, nebulas: 3, spawn: 420 };
    case "high":
      return { stars: 620, nebulas: 10, spawn: 110 };
    case "medium":
    default:
      return { stars: 300, nebulas: 6, spawn: 240 };
  }
}

/*
 * Precompute constellation pairs once at scene creation (nearest-neighbour pairs
 * among the foreground stars). Doing this per frame would be quadratic.
 */
function buildConstellations(stars: Star[], maxPairs: number): [number, number][] {
  const fg: number[] = [];
  for (let i = 0; i < stars.length; i++) {
    if (stars[i].depth > 0.72) fg.push(i);
  }
  const pairs: [number, number][] = [];
  const used = new Set<number>();
  for (const i of fg) {
    if (pairs.length >= maxPairs) break;
    if (used.has(i)) continue;
    let best = -1;
    let bestDist = 190;
    for (const j of fg) {
      if (j === i || used.has(j)) continue;
      const dx = stars[i].x - stars[j].x;
      const dy = stars[i].y - stars[j].y;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        bestDist = dist;
        best = j;
      }
    }
    if (best >= 0) {
      pairs.push([i, best]);
      used.add(i);
      used.add(best);
    }
  }
  return pairs;
}

function createScene(size: { w: number; h: number }, cfg: { density: Density }): StarfieldScene {
  const { w, h } = size;
  const counts = densityConfig(cfg.density);
  const stars: Star[] = [];
  for (let i = 0; i < counts.stars; i++) {
    const depth = Math.random();
    stars.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.45 + depth * 1.25,
      depth,
      vx: (Math.random() - 0.5) * 0.05 * (0.4 + depth),
      vy: 0.02 + depth * 0.09,
      phase: Math.random() * TAU,
      twinkleRate: 0.01 + Math.random() * 0.035,
      base: 0.35 + depth * 0.6,
    });
  }
  const nebulas: Nebula[] = [];
  for (let i = 0; i < counts.nebulas; i++) {
    nebulas.push({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 160 + Math.random() * 280,
      vx: (Math.random() - 0.5) * 0.08,
      vy: (Math.random() - 0.5) * 0.08,
    });
  }
  return {
    w,
    h,
    stars,
    shooting: [],
    nebulas,
    constellations: buildConstellations(stars, 14),
    spawnCooldown: 90,
  };
}

function drawNebula(ctx: CanvasRenderingContext2D, scene: StarfieldScene, env: FrameEnv, speed: number) {
  const { palette, brightness } = env;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const nebula of scene.nebulas) {
    nebula.x += nebula.vx * speed;
    nebula.y += nebula.vy * speed;
    if (nebula.x < -nebula.r) nebula.x = scene.w + nebula.r;
    if (nebula.x > scene.w + nebula.r) nebula.x = -nebula.r;
    if (nebula.y < -nebula.r) nebula.y = scene.h + nebula.r;
    if (nebula.y > scene.h + nebula.r) nebula.y = -nebula.r;

    const gradient = ctx.createRadialGradient(nebula.x, nebula.y, 0, nebula.x, nebula.y, nebula.r);
    gradient.addColorStop(0, palette.nebula);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = Math.min(1, 0.12 * brightness * 2);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(nebula.x, nebula.y, nebula.r, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawConstellations(ctx: CanvasRenderingContext2D, scene: StarfieldScene, env: FrameEnv) {
  const { palette, brightness } = env;
  ctx.save();
  ctx.strokeStyle = palette.mid;
  ctx.lineWidth = 0.8;
  ctx.globalAlpha = Math.min(1, 0.22 * brightness * 2);
  ctx.beginPath();
  for (const [a, b] of scene.constellations) {
    ctx.moveTo(scene.stars[a].x, scene.stars[a].y);
    ctx.lineTo(scene.stars[b].x, scene.stars[b].y);
  }
  ctx.stroke();
  ctx.restore();
}

function spawnShooting(scene: StarfieldScene) {
  const fromLeft = Math.random() < 0.5;
  const vx = (fromLeft ? 1 : -1) * (5 + Math.random() * 4);
  const vy = 2 + Math.random() * 2.5;
  scene.shooting.push({
    x: fromLeft ? -40 : scene.w + 40,
    y: Math.random() * scene.h * 0.5,
    vx,
    vy,
    life: 0,
    maxLife: 60 + Math.random() * 40,
    len: 90 + Math.random() * 90,
  });
}

function drawShooting(ctx: CanvasRenderingContext2D, scene: StarfieldScene, env: FrameEnv, speed: number) {
  const { palette, brightness } = env;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (const star of scene.shooting) {
    star.life += 1;
    star.x += star.vx * speed;
    star.y += star.vy * speed;

    const fade = 1 - star.life / star.maxLife;
    const norm = Math.hypot(star.vx, star.vy) || 1;
    const tailX = star.x - (star.vx / norm) * star.len;
    const tailY = star.y - (star.vy / norm) * star.len;

    const gradient = ctx.createLinearGradient(star.x, star.y, tailX, tailY);
    gradient.addColorStop(0, palette.head);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = Math.min(1, fade * brightness * 2.6);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(star.x, star.y);
    ctx.lineTo(tailX, tailY);
    ctx.stroke();
  }
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, scene: StarfieldScene, env: FrameEnv) {
  const speed = env.speed;
  const { palette, brightness, width, height } = env;

  if (env.toggles.nebula !== false) drawNebula(ctx, scene, env, speed);
  if (env.toggles.constellations !== false) drawConstellations(ctx, scene, env);

  // Stars: sub-pixel points with a slow twinkle; foreground layers drift faster.
  for (const star of scene.stars) {
    star.phase += star.twinkleRate * speed;
    star.x += star.vx * speed;
    star.y += star.vy * speed;
    if (star.y > scene.h + 4) {
      star.y = -4;
      star.x = Math.random() * width;
    }
    if (star.x < -4) star.x = width + 4;
    if (star.x > width + 4) star.x = -4;

    const twinkle = 0.7 + 0.3 * Math.sin(star.phase);
    ctx.globalAlpha = Math.min(1, star.base * twinkle * brightness * 2.2);
    ctx.fillStyle = star.depth > 0.72 ? palette.head : star.depth > 0.4 ? palette.star : palette.mid;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, TAU);
    ctx.fill();
  }

  if (env.toggles.shooting !== false) {
    scene.spawnCooldown -= 1;
    if (scene.spawnCooldown <= 0) {
      spawnShooting(scene);
      const counts = densityConfig(env.density);
      scene.spawnCooldown = counts.spawn + Math.floor(Math.random() * counts.spawn);
    }
    drawShooting(ctx, scene, env, speed);
    scene.shooting = scene.shooting.filter((s) => s.life < s.maxLife && s.y < height + 80);
  }
}

export const STARFIELD_DEF: EffectDefinition<StarfieldScene> = {
  id: "starfield",
  label: "Starfield",
  icon: Stars,
  backgroundColor: "#05060d",
  panelLabel: "Starfield effect settings",
  palettes: PALETTES,
  defaultPalette: "deepspace",
  defaults: {
    speed: 1,
    brightness: 0.3,
    density: "medium",
    toggles: { shooting: true, nebula: true, constellations: true },
  },
  fps: 30,
  controls: CONTROLS,
  createScene,
  draw,
};
