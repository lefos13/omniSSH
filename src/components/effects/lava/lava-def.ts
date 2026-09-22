/*
 * Lava effect definition: a molten volcanic flow field rendered from domain-warped
 * 3D value noise. Dark cooling crust islands drift over incandescent magma veins
 * that breathe with convective heat pulsing; periodic as well as click-triggered
 * spark eruptions break out at the hottest vein peaks.
 */

import { Flame, Layers, Zap, Activity } from "lucide-react";
import type { ControlSpec, Density, EffectDefinition, FrameEnv, Palette } from "../types";
import { DEFAULT_DIMMER_PRESETS, SPEED_PRESETS } from "../types";

const TAU = Math.PI * 2;

const PALETTES: Record<string, Palette> = {
  magma: {
    head: "#fffbe0",
    glow: "rgba(255, 90, 10, 1)",
    lead: "#ff6a1a",
    mid: "#a81d08",
    deep: "#240604",
    accent: "#ff8a24",
    crust: "#140504",
    spark: "#ffe6a0",
  },
  caldera: {
    head: "#fff0c8",
    glow: "rgba(220, 30, 40, 1)",
    lead: "#e89520",
    mid: "#700e18",
    deep: "#1e0508",
    accent: "#ffa834",
    crust: "#120205",
    spark: "#fff2b8",
  },
  brimstone: {
    head: "#fbffcc",
    glow: "rgba(210, 190, 20, 1)",
    lead: "#d49b13",
    mid: "#5c4d12",
    deep: "#1a1705",
    accent: "#e6c820",
    crust: "#110f02",
    spark: "#ffffc0",
  },
  cryovolcano: {
    head: "#f0faff",
    glow: "rgba(50, 160, 255, 1)",
    lead: "#40c8ff",
    mid: "#3a1c6a",
    deep: "#0d081f",
    accent: "#70e0ff",
    crust: "#080414",
    spark: "#d0f5ff",
  },
};

const CONTROLS: ControlSpec = {
  palettes: [
    { key: "magma", label: "Magma", dot: "bg-orange-600" },
    { key: "caldera", label: "Caldera", dot: "bg-red-700" },
    { key: "brimstone", label: "Brimstone", dot: "bg-yellow-500" },
    { key: "cryovolcano", label: "Cryovolcano", dot: "bg-cyan-500" },
  ],
  density: [
    { key: "low", label: "Low" },
    { key: "medium", label: "Medium" },
    { key: "high", label: "High" },
  ],
  toggles: [
    { key: "fissures", label: "Fissures", icon: Layers },
    { key: "sparks", label: "Sparks", icon: Zap },
    { key: "heatPulse", label: "Heat Pulse", icon: Activity },
  ],
  speedPresets: SPEED_PRESETS,
  dimmerPresets: DEFAULT_DIMMER_PRESETS,
};

interface Spark {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
}

/*
 * The flow field is rendered into a low-resolution ImageData buffer that is
 * upscaled onto the main canvas; this keeps the per-pixel noise cost bounded
 * (~60K pixels) regardless of viewport size while the bilinear smoothing of the
 * upscale keeps the molten gradients soft.
 */
interface LavaScene {
  w: number;
  h: number;
  time: number;
  bufW: number;
  bufH: number;
  freq: number;
  warpFreq: number;
  warp: number;
  offscreen: HTMLCanvasElement;
  offCtx: CanvasRenderingContext2D | null;
  imgData: ImageData;
  data32: Uint32Array;
  ramp: Uint32Array;
  palette: Palette;
  brightness: number;
  perm: Uint8Array;
  sparks: Spark[];
  nextBurstTimer: number;
  hotX: number;
  hotY: number;
}

let activeLavaScene: LavaScene | null = null;

/*
 * Trigger an interactive spark eruption at the designated viewport coordinate.
 * Dispatches to the currently active LavaScene instance, bounding total spark count
 * to avoid runaway particle allocation.
 */
export function triggerLavaBurst(x: number, y: number): void {
  if (!activeLavaScene) return;
  spawnSparkBurst(activeLavaScene, x, y, 22);
  if (activeLavaScene.sparks.length > 250) {
    activeLavaScene.sparks.splice(0, activeLavaScene.sparks.length - 250);
  }
}

/*
 * Reset active scene reference on component unmount to prevent lingering references
 * or orphaned particle updates across theme transitions.
 */
export function resetActiveLavaScene(): void {
  activeLavaScene = null;
}

function spawnSparkBurst(
  scene: LavaScene,
  originX: number,
  originY: number,
  count: number
) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * TAU;
    const speed = 1.5 + Math.random() * 5.5;
    const maxLife = 350 + Math.random() * 450;
    scene.sparks.push({
      x: originX,
      y: originY,
      prevX: originX,
      prevY: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 1.2,
      size: 1 + Math.random() * 1.8,
      life: 0,
      maxLife,
    });
  }
}

/*
 * Density drives three coupled knobs: the noise-buffer resolution (divisor and
 * pixel cap), the number of magma features across the buffer (cycles), and the
 * spark budget. Low density yields large slow crust blobs; high density yields
 * fine vein networks.
 */
function densityConfig(density: Density): {
  bufMax: number;
  divisor: number;
  cycles: number;
  maxSparks: number;
} {
  switch (density) {
    case "low":
      return { bufMax: 240, divisor: 6, cycles: 6, maxSparks: 70 };
    case "high":
      return { bufMax: 400, divisor: 4, cycles: 13, maxSparks: 220 };
    case "medium":
    default:
      return { bufMax: 320, divisor: 5, cycles: 9, maxSparks: 140 };
  }
}

/*
 * Seeded permutation table (doubled to 512 so hash lookups never wrap mid-chain)
 * for the value-noise lattice hash. Built once per scene so every frame samples
 * the same terrain as it evolves.
 */
function buildPerm(seed: number): Uint8Array {
  const perm = new Uint8Array(512);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
  for (let i = 255; i > 0; i--) {
    const j = next() % (i + 1);
    const tmp = base[i];
    base[i] = base[j];
    base[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = base[i & 255];
  return perm;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hash3(x: number, y: number, z: number, perm: Uint8Array): number {
  return perm[(perm[(perm[x & 255] + y) & 255] + z) & 255] * (1 / 255);
}

/*
 * Single-octave 3D value noise in [0, 1]: quintic-smoothed trilinear
 * interpolation over an 8-corner lattice. The z axis doubles as time, so the
 * field boils in place instead of scrolling like a texture.
 */
function valueNoise3D(x: number, y: number, z: number, perm: Uint8Array): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const w = fade(z - zi);

  const c000 = hash3(xi, yi, zi, perm);
  const c100 = hash3(xi + 1, yi, zi, perm);
  const c010 = hash3(xi, yi + 1, zi, perm);
  const c110 = hash3(xi + 1, yi + 1, zi, perm);
  const c001 = hash3(xi, yi, zi + 1, perm);
  const c101 = hash3(xi + 1, yi, zi + 1, perm);
  const c011 = hash3(xi, yi + 1, zi + 1, perm);
  const c111 = hash3(xi + 1, yi + 1, zi + 1, perm);

  const x00 = lerp(c000, c100, u);
  const x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u);
  const x11 = lerp(c011, c111, u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

function fbm3(
  x: number,
  y: number,
  z: number,
  octaves: number,
  perm: Uint8Array
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  let fz = z;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3D(fx, fy, fz, perm);
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
    fz *= 2;
  }
  return sum / norm;
}

type RGB = [number, number, number];

/* Parse the palette's hex and rgb()/rgba() color forms into raw channels. */
function parseColor(color: string): RGB {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const parts = color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return [0, 0, 0];
  return [Math.round(Number(parts[0])), Math.round(Number(parts[1])), Math.round(Number(parts[2]))];
}

/*
 * Build the 256-entry ABGR lookup table mapping noise value to pixel color:
 * dark crust -> cooling edge -> molten veins -> white-hot cores, with channel
 * values pre-scaled by the dimmer so the per-frame pixel loop stays a single
 * Uint32 write. Rebuilt on palette change (recolor) and dimmer change.
 */
function buildRamp(palette: Palette, brightness: number): Uint32Array {
  const stops: { t: number; c: RGB }[] = [
    { t: 0.0, c: parseColor(palette.crust) },
    { t: 0.5, c: parseColor(palette.deep) },
    { t: 0.66, c: parseColor(palette.mid) },
    { t: 0.76, c: parseColor(palette.lead) },
    { t: 0.93, c: parseColor(palette.glow) },
    { t: 1.0, c: parseColor(palette.head) },
  ];
  const scale = 0.3 + 0.7 * brightness;
  const ramp = new Uint32Array(256);

  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let seg = 0;
    while (seg < stops.length - 2 && t > stops[seg + 1].t) seg++;
    const a = stops[seg];
    const b = stops[seg + 1];
    const local = (t - a.t) / (b.t - a.t);
    const r = Math.round(Math.min(255, Math.max(0, (a.c[0] + (b.c[0] - a.c[0]) * local) * scale)));
    const g = Math.round(Math.min(255, Math.max(0, (a.c[1] + (b.c[1] - a.c[1]) * local) * scale)));
    const bl = Math.round(Math.min(255, Math.max(0, (a.c[2] + (b.c[2] - a.c[2]) * local) * scale)));
    ramp[i] = (255 << 24) | (bl << 16) | (g << 8) | r;
  }
  return ramp;
}

function createScene(
  size: { w: number; h: number },
  cfg: { palette: Palette; density: Density }
): LavaScene {
  const { w, h } = size;
  const { bufMax, divisor, cycles } = densityConfig(cfg.density);

  /*
   * Buffer resolution scales with viewport but stays capped (~64K pixels max)
   * so per-frame noise cost is bounded on large displays.
   */
  let bufW = Math.max(16, Math.min(bufMax, Math.ceil(w / divisor)));
  let bufH = Math.max(16, Math.round(bufW * (h / Math.max(1, w))));
  const maxPixels = 64000;
  if (bufW * bufH > maxPixels) {
    const k = Math.sqrt(maxPixels / (bufW * bufH));
    bufW = Math.max(16, Math.floor(bufW * k));
    bufH = Math.max(16, Math.floor(bufH * k));
  }

  const freq = cycles / bufW;
  const offscreen = document.createElement("canvas");
  offscreen.width = bufW;
  offscreen.height = bufH;
  const offCtx = offscreen.getContext("2d");
  const imgData = offCtx
    ? offCtx.createImageData(bufW, bufH)
    : new ImageData(bufW, bufH);

  const scene: LavaScene = {
    w,
    h,
    time: 0,
    bufW,
    bufH,
    freq,
    warpFreq: freq * 0.45,
    warp: 0.65 / freq,
    offscreen,
    offCtx,
    imgData,
    data32: new Uint32Array(imgData.data.buffer),
    ramp: buildRamp(cfg.palette, 0.5),
    palette: cfg.palette,
    brightness: 0.5,
    perm: buildPerm(0x1a4a),
    sparks: [],
    nextBurstTimer: 2000 + Math.random() * 2000,
    hotX: -1,
    hotY: -1,
  };

  activeLavaScene = scene;
  return scene;
}

/*
 * Recolor a live scene in place so a palette switch reads on the next frame:
 * only the 256-entry ramp changes, the noise field itself is color-agnostic.
 */
function recolor(scene: LavaScene, palette: Palette): void {
  scene.palette = palette;
  scene.ramp = buildRamp(palette, scene.brightness);
}

/*
 * Render one frame of the molten field into the low-res buffer.
 *
 * Per pixel: sample two single-octave warp fields (evolving on a faster z
 * timescale), displace the sampling coordinate by their output, then evaluate a
 * 3-octave fbm at the warped position. The result is contrast-stretched and
 * offset by the heat-pulse and pointer-heat terms, then looked up in the color
 * ramp. While walking pixels the brightest sampled point is tracked so spark
 * eruptions break out at white-hot vein peaks.
 */
function drawFlowField(ctx: CanvasRenderingContext2D, scene: LavaScene, env: FrameEnv) {
  const { brightness, toggles, pointer } = env;
  if (!scene.offCtx) return;

  if (Math.abs(brightness - scene.brightness) > 0.005) {
    scene.brightness = brightness;
    scene.ramp = buildRamp(scene.palette, brightness);
  }

  const { bufW, bufH, perm, ramp, data32, freq, warpFreq } = scene;
  const warp = scene.warp;
  const zWarp = scene.time * 0.00016;
  const zField = scene.time * 0.00008;
  const pulse =
    toggles.heatPulse !== false ? 0.035 * Math.sin(scene.time * 0.0016) : 0;
  const contrast = 1.9;

  const pActive = pointer.active && env.width > 0 && env.height > 0;
  const pbx = pActive ? (pointer.x / env.width) * bufW : -1e9;
  const pby = pActive ? (pointer.y / env.height) * bufH : -1e9;
  const pr = pActive ? (160 / env.width) * bufW : 0;
  const pr2 = pr * pr;

  let bestN = -1;
  let bestX = 0;
  let bestY = 0;

  for (let y = 0; y < bufH; y++) {
    const rowOff = y * bufW;
    const ddy = y - pby;
    for (let x = 0; x < bufW; x++) {
      const wx = valueNoise3D(x * warpFreq, y * warpFreq, zWarp, perm) * 2 - 1;
      const wy =
        valueNoise3D(x * warpFreq + 41.7, y * warpFreq + 13.9, zWarp + 7.3, perm) *
          2 -
        1;

      let n = fbm3((x + wx * warp) * freq, (y + wy * warp) * freq, zField, 3, perm);
      n = (n - 0.5) * contrast + 0.5 + pulse;

      if (pActive) {
        const ddx = x - pbx;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < pr2) {
          n += (1 - Math.sqrt(d2) / pr) * 0.25;
        }
      }

      if (n < 0) n = 0;
      else if (n > 1) n = 1;

      const idx = (n * 255) | 0;
      data32[rowOff + x] = ramp[idx];

      if (((rowOff + x) & 31) === 0 && n > bestN) {
        bestN = n;
        bestX = x;
        bestY = y;
      }
    }
  }

  scene.hotX = (bestX / bufW) * env.width;
  scene.hotY = (bestY / bufH) * env.height;

  scene.offCtx.putImageData(scene.imgData, 0, 0);

  /*
   * Upscale the buffer across the full viewport (bilinear smoothing softens the
   * noise into molten gradients), then add a lighter-composited bloom pass so
   * the white-hot cores bleed glow into the surrounding crust.
   */
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.drawImage(scene.offscreen, 0, 0, env.width, env.height);

  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = Math.min(1, 0.15 + 0.3 * brightness);
  ctx.drawImage(scene.offscreen, 0, 0, env.width, env.height);
  ctx.restore();
}

function updateAndDrawSparks(
  ctx: CanvasRenderingContext2D,
  scene: LavaScene,
  env: FrameEnv,
  dtNorm: number
) {
  const { brightness, palette, speed } = env;
  const cfg = densityConfig(env.density);

  // Periodic explosive eruption from the brightest vein peak tracked last frame
  scene.nextBurstTimer -= env.dt * speed;
  if (scene.nextBurstTimer <= 0) {
    const ex = scene.hotX >= 0 ? scene.hotX : Math.random() * scene.w;
    const ey = scene.hotY >= 0 ? scene.hotY : Math.random() * scene.h;
    spawnSparkBurst(scene, ex, ey, 16 + Math.floor(Math.random() * 8));
    scene.nextBurstTimer = 2400 + Math.random() * 2600;
  }

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";

  for (let i = scene.sparks.length - 1; i >= 0; i--) {
    const spark = scene.sparks[i];
    spark.life += env.dt * speed;

    if (spark.life >= spark.maxLife) {
      scene.sparks.splice(i, 1);
      continue;
    }

    spark.prevX = spark.x;
    spark.prevY = spark.y;
    spark.x += spark.vx * dtNorm * speed;
    spark.y += spark.vy * dtNorm * speed;
    spark.vy += 0.06 * dtNorm * speed;
    spark.vx *= 0.985;

    const lifeRatio = 1 - spark.life / spark.maxLife;
    const sparkAlpha = Math.min(1, lifeRatio * brightness * 1.8);

    ctx.strokeStyle = palette.spark ?? palette.head;
    ctx.lineWidth = spark.size;
    ctx.globalAlpha = sparkAlpha;

    ctx.beginPath();
    ctx.moveTo(spark.prevX, spark.prevY);
    ctx.lineTo(spark.x, spark.y);
    ctx.stroke();
  }

  // Cap maximum sparks to maintain 30 FPS target
  if (scene.sparks.length > cfg.maxSparks) {
    scene.sparks.splice(0, scene.sparks.length - cfg.maxSparks);
  }

  ctx.restore();
}

function draw(
  ctx: CanvasRenderingContext2D,
  scene: LavaScene,
  env: FrameEnv
) {
  scene.w = env.width;
  scene.h = env.height;
  const dtNorm = Math.min(env.dt / 16.67, 3);
  scene.time += env.dt * env.speed;

  if (env.toggles.fissures !== false) {
    drawFlowField(ctx, scene, env);
  }

  if (env.toggles.sparks !== false) {
    updateAndDrawSparks(ctx, scene, env, dtNorm);
  } else {
    scene.sparks.length = 0;
  }
}

export const LAVA_DEF: EffectDefinition<LavaScene> = {
  id: "lava",
  label: "Lava",
  icon: Flame,
  backgroundColor: "#0c0605",
  panelLabel: "Lava effect settings",
  palettes: PALETTES,
  defaultPalette: "magma",
  defaults: {
    speed: 1,
    brightness: 0.5,
    density: "medium",
    toggles: { fissures: true, sparks: true, heatPulse: true },
  },
  fps: 30,
  controls: CONTROLS,
  createScene,
  draw,
  recolor,
};
