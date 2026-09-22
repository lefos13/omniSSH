/*
 * Embers effect definition: a rising ember field buoyed upwards from a radiant
 * bottom glow line, modulated by procedural convective heat-shimmer wave turbulence,
 * with optional falling dark soot flakes.
 */

import { Flame, Sparkles, Wind, Cloud } from "lucide-react";
import type { ControlSpec, Density, EffectDefinition, FrameEnv, Palette } from "../types";
import { DEFAULT_DIMMER_PRESETS, SPEED_PRESETS } from "../types";

const TAU = Math.PI * 2;

const PALETTES: Record<string, Palette> = {
  forge: {
    head: "#fff6d0",
    glow: "rgba(255, 140, 20, 1)",
    lead: "#ff8c2e",
    mid: "#d94814",
    deep: "#4a1005",
    accent: "#ffa238",
    ember: "#ff9233",
    soot: "#261a14",
  },
  apocalypse: {
    head: "#ffe8e8",
    glow: "rgba(230, 40, 25, 1)",
    lead: "#e84025",
    mid: "#991810",
    deep: "#3b0808",
    accent: "#ff4830",
    ember: "#e83a20",
    soot: "#240c0c",
  },
  "blue-flame": {
    head: "#e8f8ff",
    glow: "rgba(30, 160, 255, 1)",
    lead: "#40b8ff",
    mid: "#1a68d6",
    deep: "#0a1c4a",
    accent: "#5cd0ff",
    ember: "#38aeff",
    soot: "#0d1729",
  },
  ash: {
    head: "#f5f5f7",
    glow: "rgba(180, 150, 130, 1)",
    lead: "#c4b5a5",
    mid: "#7a6e63",
    deep: "#2b2622",
    accent: "#e08a50",
    ember: "#c89878",
    soot: "#1e1b19",
  },
};

const CONTROLS: ControlSpec = {
  palettes: [
    { key: "forge", label: "Forge", dot: "bg-amber-500" },
    { key: "apocalypse", label: "Apocalypse", dot: "bg-red-600" },
    { key: "blue-flame", label: "Blue Flame", dot: "bg-cyan-400" },
    { key: "ash", label: "Ash", dot: "bg-stone-400" },
  ],
  density: [
    { key: "low", label: "Low" },
    { key: "medium", label: "Medium" },
    { key: "high", label: "High" },
  ],
  toggles: [
    { key: "embers", label: "Embers", icon: Flame },
    { key: "glowLine", label: "Glow Line", icon: Sparkles },
    { key: "shimmer", label: "Heat Shimmer", icon: Wind },
    { key: "soot", label: "Soot Flakes", icon: Cloud },
  ],
  speedPresets: SPEED_PRESETS,
  dimmerPresets: DEFAULT_DIMMER_PRESETS,
};

interface Ember {
  x: number;
  y: number;
  size: number;
  baseAlpha: number;
  flickerSpeed: number;
  phase: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

interface SootFlake {
  x: number;
  y: number;
  size: number;
  vy: number;
  phase: number;
  rot: number;
  rotSpeed: number;
  alpha: number;
}

interface EmbersScene {
  w: number;
  h: number;
  time: number;
  embers: Ember[];
  soot: SootFlake[];
}

function densityConfig(density: Density): { embers: number; soot: number } {
  switch (density) {
    case "low":
      return { embers: 45, soot: 25 };
    case "high":
      return { embers: 180, soot: 90 };
    case "medium":
    default:
      return { embers: 90, soot: 50 };
  }
}

function createEmber(scene: { w: number; h: number }, scatter: boolean): Ember {
  /*
   * Lifetime expressed in milliseconds (5s to 12s) to match `env.dt * speed`
   * accumulation and allow embers to ascend across the full viewport height.
   */
  const maxLife = 5000 + Math.random() * 7000;
  return {
    x: Math.random() * scene.w,
    y: scatter ? Math.random() * scene.h : scene.h + Math.random() * 30,
    size: 1.2 + Math.random() * 2.4,
    baseAlpha: 0.6 + Math.random() * 0.4,
    flickerSpeed: 0.04 + Math.random() * 0.08,
    phase: Math.random() * TAU,
    vx: (Math.random() - 0.5) * 0.4,
    vy: -(0.7 + Math.random() * 1.5),
    life: scatter ? Math.random() * maxLife : 0,
    maxLife,
  };
}

function createSoot(scene: { w: number; h: number }, scatter: boolean): SootFlake {
  return {
    x: Math.random() * scene.w,
    y: scatter ? Math.random() * scene.h : -15 - Math.random() * 40,
    size: 1.5 + Math.random() * 2.2,
    vy: 0.35 + Math.random() * 0.55,
    phase: Math.random() * TAU,
    rot: Math.random() * TAU,
    rotSpeed: (Math.random() - 0.5) * 0.02,
    alpha: 0.25 + Math.random() * 0.4,
  };
}

function createScene(
  size: { w: number; h: number },
  cfg: { density: Density }
): EmbersScene {
  const { w, h } = size;
  const counts = densityConfig(cfg.density);
  const embers: Ember[] = [];
  for (let i = 0; i < counts.embers; i++) {
    embers.push(createEmber({ w, h }, true));
  }
  const soot: SootFlake[] = [];
  for (let i = 0; i < counts.soot; i++) {
    soot.push(createSoot({ w, h }, true));
  }
  return { w, h, time: 0, embers, soot };
}

function drawBottomGlow(
  ctx: CanvasRenderingContext2D,
  scene: EmbersScene,
  env: FrameEnv
) {
  const { brightness, palette } = env;
  const breathe = 0.85 + 0.15 * Math.sin(scene.time * 0.002);
  const glowH = Math.min(scene.h * 0.35, 200);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  const grad = ctx.createLinearGradient(0, scene.h, 0, scene.h - glowH);
  grad.addColorStop(0, palette.glow);
  grad.addColorStop(0.35, palette.mid);
  grad.addColorStop(1, "rgba(0,0,0,0)");

  ctx.globalAlpha = Math.min(1, 0.45 * brightness * breathe);
  ctx.fillStyle = grad;
  ctx.fillRect(0, scene.h - glowH, scene.w, glowH);

  // Concentrated radiant horizon streak along the bottom edge
  const horizonGrad = ctx.createLinearGradient(0, scene.h, 0, scene.h - 22);
  horizonGrad.addColorStop(0, palette.head);
  horizonGrad.addColorStop(0.4, palette.lead);
  horizonGrad.addColorStop(1, "rgba(0,0,0,0)");

  ctx.globalAlpha = Math.min(1, 0.65 * brightness * breathe);
  ctx.fillStyle = horizonGrad;
  ctx.fillRect(0, scene.h - 22, scene.w, 22);

  ctx.restore();
}

function drawHeatShimmer(
  ctx: CanvasRenderingContext2D,
  scene: EmbersScene,
  env: FrameEnv
) {
  const { brightness, palette } = env;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  const bands = 4;
  for (let i = 0; i < bands; i++) {
    const bandY =
      ((scene.h - (scene.time * 0.08 + i * (scene.h / bands))) % scene.h +
        scene.h) %
      scene.h;

    ctx.beginPath();
    for (let x = 0; x <= scene.w; x += 32) {
      const wave =
        Math.sin(x * 0.008 + scene.time * 0.003 + i * 1.5) * 12 +
        Math.cos(x * 0.016 - scene.time * 0.002 + i) * 6;
      if (x === 0) ctx.moveTo(x, bandY + wave);
      else ctx.lineTo(x, bandY + wave);
    }

    ctx.strokeStyle = palette.glow;
    ctx.lineWidth = 2 + i * 0.8;
    ctx.globalAlpha = Math.min(1, 0.035 * brightness);
    ctx.stroke();
  }

  ctx.restore();
}

function drawEmbers(
  ctx: CanvasRenderingContext2D,
  scene: EmbersScene,
  env: FrameEnv,
  dtNorm: number
) {
  const { brightness, palette, speed, pointer, toggles } = env;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";

  for (const ember of scene.embers) {
    ember.life += env.dt * speed;
    ember.phase += ember.flickerSpeed * speed;
    ember.x += ember.vx * dtNorm * speed;
    ember.y += ember.vy * dtNorm * speed;

    const wobbleX =
      toggles.shimmer !== false
        ? Math.sin(ember.y * 0.012 + scene.time * 0.003) * 14 +
          Math.cos(ember.y * 0.024 + scene.time * 0.005) * 6
        : 0;
    const renderX = ember.x + wobbleX;

    // Updraft interaction from cursor proximity
    if (pointer.active) {
      const dx = renderX - pointer.x;
      const dy = ember.y - pointer.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 120 && dist > 0.1) {
        const factor = (1 - dist / 120) * 0.3;
        ember.vx += (dx / dist) * factor;
        ember.vy -= factor * 0.4;
      }
    }

    /*
     * Apply gentle fluid drag to prevent lateral velocity run-away or permanent
     * horizontal deflection after cursor displacement passes.
     */
    ember.vx *= 0.98;
    if (ember.vy < -3.5) {
      ember.vy *= 0.98;
    }

    // Boundary check and respawn
    if (
      ember.y < -30 ||
      ember.life >= ember.maxLife ||
      renderX < -50 ||
      renderX > scene.w + 50
    ) {
      Object.assign(ember, createEmber(scene, false));
      continue;
    }

    const flicker = 0.7 + 0.3 * Math.sin(ember.phase);
    const lifeRatio = 1 - ember.life / ember.maxLife;
    const currentAlpha = Math.min(
      1,
      ember.baseAlpha * flicker * brightness * 1.8 * Math.max(0.15, lifeRatio)
    );

    const radius = ember.size * (1 + 0.3 * flicker);
    const glowRadius = radius * 3.2;

    const grad = ctx.createRadialGradient(
      renderX,
      ember.y,
      0,
      renderX,
      ember.y,
      glowRadius
    );
    grad.addColorStop(0, palette.head);
    grad.addColorStop(0.3, palette.lead);
    grad.addColorStop(0.7, palette.glow);
    grad.addColorStop(1, "rgba(0,0,0,0)");

    ctx.globalAlpha = currentAlpha;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(renderX, ember.y, glowRadius, 0, TAU);
    ctx.fill();

    // Hot bright center core
    ctx.globalAlpha = Math.min(1, currentAlpha * 1.4);
    ctx.fillStyle = palette.head;
    ctx.beginPath();
    ctx.arc(renderX, ember.y, radius * 0.45, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

function drawSoot(
  ctx: CanvasRenderingContext2D,
  scene: EmbersScene,
  env: FrameEnv,
  dtNorm: number
) {
  const { brightness, palette, speed } = env;
  ctx.save();

  for (const flake of scene.soot) {
    flake.y += flake.vy * dtNorm * speed;
    flake.rot += flake.rotSpeed * speed;
    flake.phase += 0.02 * speed;

    const driftX = flake.x + Math.sin(flake.phase + flake.y * 0.01) * 15;

    if (flake.y > scene.h + 20) {
      Object.assign(flake, createSoot(scene, false));
      continue;
    }

    ctx.save();
    ctx.translate(driftX, flake.y);
    ctx.rotate(flake.rot);
    ctx.fillStyle = palette.soot;
    ctx.globalAlpha = Math.min(1, flake.alpha * brightness * 0.85);
    ctx.fillRect(-flake.size * 0.5, -flake.size * 0.5, flake.size, flake.size * 0.7);
    ctx.restore();
  }

  ctx.restore();
}

function draw(
  ctx: CanvasRenderingContext2D,
  scene: EmbersScene,
  env: FrameEnv
) {
  scene.w = env.width;
  scene.h = env.height;
  const dtNorm = Math.min(env.dt / 16.67, 3);
  scene.time += env.dt * env.speed;

  if (env.toggles.glowLine !== false) {
    drawBottomGlow(ctx, scene, env);
  }
  if (env.toggles.shimmer !== false) {
    drawHeatShimmer(ctx, scene, env);
  }
  if (env.toggles.embers !== false) {
    drawEmbers(ctx, scene, env, dtNorm);
  }
  if (env.toggles.soot !== false) {
    drawSoot(ctx, scene, env, dtNorm);
  }
}

export const EMBERS_DEF: EffectDefinition<EmbersScene> = {
  id: "embers",
  label: "Embers",
  icon: Flame,
  backgroundColor: "#0d0806",
  panelLabel: "Embers effect settings",
  palettes: PALETTES,
  defaultPalette: "forge",
  defaults: {
    speed: 1,
    brightness: 0.5,
    density: "medium",
    toggles: { embers: true, glowLine: true, shimmer: true, soot: false },
  },
  fps: 30,
  controls: CONTROLS,
  createScene,
  draw,
};
