/*
 * BerserkBackground renders a dark-fantasy "blood rain" background on an HTML5
 * canvas — the Berserk counterpart to the Matrix digital-rain effect. Vertical
 * tracks of crimson blood streaks fall with white-hot, glowing droplet heads
 * over a blood-black base, joined by rising ember flecks and an optional pulsing
 * brand-sigil watermark. It matches the Matrix effect's energy profile:
 * 30 FPS throttle, prefers-reduced-motion support, tab-hidden pause, pointer
 * proximity reactivity, and compact controls (including Restore to Defaults)
 * persisted to localStorage.
 */

import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import { Droplet, Flame, Play, Pause, Palette, Sliders, Eye, EyeOff, Sparkles, X, Sun, RotateCcw } from "lucide-react";
import { BrandSigil } from "./BrandSigil";

export type ColorTheme = "berserk" | "eclipse" | "behelit" | "steel";
export type Density = "low" | "medium" | "high";

type PaletteKey = ColorTheme;

interface BloodPalette {
  head: string;
  glow: string;
  lead: string;
  mid: string;
  deep: string;
  ember: string;
}

/*
 * Palette presets. `head` is the white-hot droplet tip, `glow` the shadow bloom
 * colour, and `lead`→`mid`→`deep` the fading trail gradient. `ember` tints the
 * drifting particles.
 */
const THEME_PALETTES: Record<PaletteKey, BloodPalette> = {
  berserk: {
    head: "#fff5f2",
    glow: "rgba(255, 45, 60, 1)",
    lead: "#ff6b6b",
    mid: "#c1121f",
    deep: "#5c0a12",
    ember: "#ff8c42",
  },
  eclipse: {
    head: "#f4ecff",
    glow: "rgba(150, 60, 220, 1)",
    lead: "#c9a2ff",
    mid: "#7c3aed",
    deep: "#2a1650",
    ember: "#ff3b6b",
  },
  behelit: {
    head: "#fffbe8",
    glow: "rgba(255, 170, 40, 1)",
    lead: "#ffd166",
    mid: "#e08a00",
    deep: "#5a3200",
    ember: "#ff5a36",
  },
  steel: {
    head: "#ffffff",
    glow: "rgba(180, 200, 220, 1)",
    lead: "#cfd8e3",
    mid: "#7d8a99",
    deep: "#2b333d",
    ember: "#ff4d4d",
  },
};

const THEME_KEYS: PaletteKey[] = ["berserk", "eclipse", "behelit", "steel"];
const DENSITY_KEYS: Density[] = ["low", "medium", "high"];
const TAU = Math.PI * 2;

interface BloodColumn {
  x: number;
  y: number;
  speed: number;
  trailLength: number;
  spacing: number;
  radius: number;
  paletteKey: PaletteKey;
  layer: "bg" | "mid" | "fg";
  baseOpacity: number;
  wobble: number;
  waitFrames: number;
}

interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  flicker: number;
  life: number;
  maxLife: number;
  color: string;
}

/** Per-density tuning: vertical droplet spacing, base radius, opacity, ember cap. */
function densityConfig(d: Density): { spacing: number; radius: number; opacity: number; embers: number } {
  switch (d) {
    case "low":
      return { spacing: 22, radius: 2.6, opacity: 0.55, embers: 26 };
    case "high":
      return { spacing: 11, radius: 1.7, opacity: 0.62, embers: 90 };
    case "medium":
    default:
      return { spacing: 16, radius: 2.1, opacity: 0.58, embers: 55 };
  }
}

const subscribeReducedMotion = (callback: () => void) => {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
};

const getReducedMotionSnapshot = () => {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};
const getReducedMotionServerSnapshot = () => false;

const STORAGE_PALETTE_KEY = "berserk_theme_palette";
const STORAGE_SPEED_KEY = "berserk_theme_speed";
const STORAGE_BRIGHTNESS_KEY = "berserk_theme_brightness";
const STORAGE_DENSITY_KEY = "berserk_theme_density";
const STORAGE_EMBERS_KEY = "berserk_theme_embers";
const STORAGE_BRAND_KEY = "berserk_theme_brand";

/*
 * Default visual configuration for the Berserk blood-rain background:
 * - Blood crimson palette with the signature white-hot droplet heads.
 * - High density (11px droplet spacing) for a heavier downpour.
 * - 30% dimmer so the rain stays subtle behind terminal text and shell UI.
 * - Ember flecks and the brand-sigil watermark both enabled.
 * - Standard 1.0x velocity.
 */
export const BERSERK_DEFAULTS = {
  theme: "berserk" as ColorTheme,
  speedMultiplier: 1 as 1 | 0.6 | 1.6,
  brightness: 0.30,
  density: "high" as Density,
  embersEnabled: true,
  brandEnabled: true,
} as const;

function getStoredValue<T>(key: string, fallback: T): T {
  if (typeof window === "undefined" || !window.localStorage) return fallback;
  try {
    const val = window.localStorage.getItem(key);
    return val !== null ? (JSON.parse(val) as T) : fallback;
  } catch {
    return fallback;
  }
}

function setStoredValue<T>(key: string, value: T): void {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore storage quota errors */
    }
  }
}

export function BerserkBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prefersReducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot
  );

  const [userPaused, setUserPaused] = useState(false);
  const isRunning = !prefersReducedMotion && !userPaused;

  const [isVisible, setIsVisible] = useState(true);
  const [theme, setThemeState] = useState<ColorTheme>(() => {
    const v = getStoredValue<ColorTheme>(STORAGE_PALETTE_KEY, BERSERK_DEFAULTS.theme);
    return THEME_KEYS.includes(v) ? v : BERSERK_DEFAULTS.theme;
  });
  const [speedMultiplier, setSpeedMultiplierState] = useState<1 | 0.6 | 1.6>(() => {
    const v = getStoredValue<number>(STORAGE_SPEED_KEY, BERSERK_DEFAULTS.speedMultiplier);
    return v === 1 || v === 0.6 || v === 1.6 ? v : BERSERK_DEFAULTS.speedMultiplier;
  });
  const [brightness, setBrightnessState] = useState<number>(() => {
    const v = getStoredValue<number>(STORAGE_BRIGHTNESS_KEY, BERSERK_DEFAULTS.brightness);
    return typeof v === "number" && !isNaN(v)
      ? Math.max(0.15, Math.min(1.0, Math.round(v * 100) / 100))
      : BERSERK_DEFAULTS.brightness;
  });
  const [density, setDensityState] = useState<Density>(() => {
    const v = getStoredValue<Density>(STORAGE_DENSITY_KEY, BERSERK_DEFAULTS.density);
    return DENSITY_KEYS.includes(v) ? v : BERSERK_DEFAULTS.density;
  });
  const [embersEnabled, setEmbersEnabledState] = useState<boolean>(() =>
    getStoredValue<boolean>(STORAGE_EMBERS_KEY, BERSERK_DEFAULTS.embersEnabled)
  );
  const [brandEnabled, setBrandEnabledState] = useState<boolean>(() =>
    getStoredValue<boolean>(STORAGE_BRAND_KEY, BERSERK_DEFAULTS.brandEnabled)
  );
  const [controlsOpen, setControlsOpen] = useState(false);

  const setTheme = useCallback((t: ColorTheme) => {
    setThemeState(t);
    setStoredValue(STORAGE_PALETTE_KEY, t);
    themeRef.current = t;
    // Repaint existing tracks immediately so the new palette is instant
    applyPaletteRef.current(t);
  }, []);

  const setSpeedMultiplier = useCallback((s: 1 | 0.6 | 1.6) => {
    setSpeedMultiplierState(s);
    setStoredValue(STORAGE_SPEED_KEY, s);
    speedRef.current = s;
  }, []);

  const setBrightness = useCallback((b: number) => {
    const clamped = Math.max(0.15, Math.min(1.0, Math.round(b * 100) / 100));
    setBrightnessState(clamped);
    setStoredValue(STORAGE_BRIGHTNESS_KEY, clamped);
    brightnessRef.current = clamped;
  }, []);

  const setEmbersEnabled = useCallback((v: boolean) => {
    setEmbersEnabledState(v);
    setStoredValue(STORAGE_EMBERS_KEY, v);
    embersEnabledRef.current = v;
  }, []);

  const setBrandEnabled = useCallback((v: boolean) => {
    setBrandEnabledState(v);
    setStoredValue(STORAGE_BRAND_KEY, v);
  }, []);

  const mousePosRef = useRef({ x: -9999, y: -9999, lastActive: 0 });
  const animFrameIdRef = useRef<number>(0);
  const isRunningRef = useRef(isRunning);
  const isVisibleRef = useRef(isVisible);
  const themeRef = useRef(theme);
  const speedRef = useRef(speedMultiplier);
  const brightnessRef = useRef(brightness);
  const densityRef = useRef(density);
  const embersEnabledRef = useRef(embersEnabled);
  const setupRef = useRef<() => void>(() => {});
  /* Recolors every live track/ember in place when the palette changes. */
  const applyPaletteRef = useRef<(t: ColorTheme) => void>(() => {});

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    setStoredValue(STORAGE_DENSITY_KEY, d);
    densityRef.current = d;
    setupRef.current();
  }, []);

  /*
   * Revert all Berserk visual options and playback states to default presets,
   * synchronizing React state, canvas render refs, and persisted localStorage.
   */
  const restoreDefaults = useCallback(() => {
    setTheme(BERSERK_DEFAULTS.theme);
    setSpeedMultiplier(BERSERK_DEFAULTS.speedMultiplier);
    setBrightness(BERSERK_DEFAULTS.brightness);
    setDensity(BERSERK_DEFAULTS.density);
    setEmbersEnabled(BERSERK_DEFAULTS.embersEnabled);
    setBrandEnabled(BERSERK_DEFAULTS.brandEnabled);
    setUserPaused(false);
    setIsVisible(true);
  }, [setTheme, setSpeedMultiplier, setBrightness, setDensity, setEmbersEnabled, setBrandEnabled]);

  useEffect(() => {
    isRunningRef.current = isRunning;
    isVisibleRef.current = isVisible;
    themeRef.current = theme;
    speedRef.current = speedMultiplier;
    brightnessRef.current = brightness;
    densityRef.current = density;
    embersEnabledRef.current = embersEnabled;
  }, [isRunning, isVisible, theme, speedMultiplier, brightness, density, embersEnabled]);

  /*
   * Initialize and run the canvas render loop: high-DPI scaling, 30 FPS frame
   * throttling, pointer-proximity reactivity, blood-rain columns, and drifting
   * ember particles. All mutable state is read through refs so the loop is set
   * up exactly once.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let columns: BloodColumn[] = [];
    let embers: Ember[] = [];
    let width = window.innerWidth;
    let height = window.innerHeight;

    const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

    /*
     * Build one falling droplet track. Depth layer is rolled pseudo-randomly and
     * scales spacing/radius/speed/opacity so background tracks read as distant
     * and foreground tracks as close.
     */
    const createColumn = (x: number, initScatter = false, d: Density = densityRef.current): BloodColumn => {
      const base = densityConfig(d);
      const layerRoll = Math.random();
      let layer: "bg" | "mid" | "fg" = "mid";
      let spacing = base.spacing;
      let radius = base.radius;
      let speed = 1.9;
      let opacity = base.opacity;
      let trail = 20;

      if (layerRoll < 0.28) {
        layer = "bg";
        spacing = base.spacing * 1.15;
        radius = base.radius * 0.8;
        speed = 1.2;
        opacity = base.opacity * 0.7;
        trail = 14;
      } else if (layerRoll > 0.72) {
        layer = "fg";
        spacing = base.spacing * 0.95;
        radius = base.radius * 1.15;
        speed = 2.7;
        opacity = Math.min(1, base.opacity * 1.25);
        trail = 28;
      }

      const trailLength = Math.floor(trail * (0.8 + Math.random() * 0.4));
      const y = initScatter
        ? Math.random() * (height + 300) - 200
        : -Math.random() * 300 - trailLength * spacing;

      return {
        x,
        y,
        speed: speed * (0.85 + Math.random() * 0.3),
        trailLength,
        spacing,
        radius,
        paletteKey: themeRef.current,
        layer,
        baseOpacity: opacity,
        wobble: Math.random() * TAU,
        waitFrames: 0,
      };
    };

    const createEmber = (initScatter: boolean): Ember => {
      const pal = THEME_PALETTES[themeRef.current] || THEME_PALETTES.berserk;
      const maxLife = 140 + Math.random() * 220;
      return {
        x: Math.random() * width,
        y: initScatter ? Math.random() * height : height + Math.random() * 40,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -(0.2 + Math.random() * 0.55),
        size: 1.2 + Math.random() * 2.2,
        alpha: 0.55 + Math.random() * 0.45,
        flicker: Math.random() * TAU,
        life: Math.random() * maxLife,
        maxLife,
        color: Math.random() < 0.7 ? pal.ember : pal.lead,
      };
    };

    const setup = () => {
      const colWidth = Math.max(10, densityConfig(densityRef.current).spacing);
      const colCount = Math.ceil(width / colWidth);
      columns = [];
      for (let i = 0; i < colCount; i++) {
        columns.push(createColumn(i * colWidth, true, densityRef.current));
      }
      const emberCount = densityConfig(densityRef.current).embers;
      embers = [];
      for (let i = 0; i < emberCount; i++) {
        embers.push(createEmber(true));
      }
    };

    setupRef.current = setup;

    /*
     * Apply a palette to every already-falling track and ember, so a palette
     * change is visible on the next frame instead of waiting for each column to
     * scroll off screen and respawn with the new colours.
     */
    applyPaletteRef.current = (t: ColorTheme) => {
      const pal = THEME_PALETTES[t] || THEME_PALETTES.berserk;
      for (const col of columns) col.paletteKey = t;
      for (const e of embers) e.color = Math.random() < 0.7 ? pal.ember : pal.lead;
    };

    const resizeCanvas = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      if (typeof ctx.setTransform === "function") {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      if (typeof ctx.scale === "function") {
        ctx.scale(dpr, dpr);
      }
      setup();
    };

    resizeCanvas();

    let resizeTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeCanvas, 150);
    };

    const handlePointerMove = (e: PointerEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY, lastActive: Date.now() };
    };

    const handlePointerLeave = () => {
      mousePosRef.current = { x: -9999, y: -9999, lastActive: 0 };
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerleave", handlePointerLeave);

    // 30 FPS target: enough for a slow, heavy blood-fall while sparing battery.
    const targetFps = 30;
    const frameInterval = 1000 / targetFps;
    let lastFrameTime = performance.now();

    const drawFrame = (currentTime: number) => {
      animFrameIdRef.current = requestAnimationFrame(drawFrame);

      if (!isVisibleRef.current) return;

      const elapsed = currentTime - lastFrameTime;
      if (elapsed < frameInterval) return;
      lastFrameTime = currentTime - (elapsed % frameInterval);

      if (!isRunningRef.current) return;

      // Clear transparently so the themed background colour shows through
      ctx.clearRect(0, 0, width, height);

      const mouse = mousePosRef.current;
      const isMouseRecentlyActive = Date.now() - mouse.lastActive < 2000;
      const speedMult = speedRef.current;
      const dim = brightnessRef.current;

      for (let c = 0; c < columns.length; c++) {
        const col = columns[c];

        if (col.waitFrames > 0) {
          col.waitFrames--;
          continue;
        }

        // Nearness to the cursor brightens and speeds a track slightly
        let mouseBoost = 0;
        if (isMouseRecentlyActive) {
          const distX = Math.abs(col.x - mouse.x);
          if (distX < 140) {
            mouseBoost = (1 - distX / 140) * 0.3;
          }
        }

        const pal = THEME_PALETTES[col.paletteKey] || THEME_PALETTES.berserk;
        const headRow = Math.floor(col.y / col.spacing);
        const segLen = col.spacing * 0.62;

        // Blood trail: a glowing droplet head followed by elongated streaks
        for (let i = 0; i < col.trailLength; i++) {
          const py = (headRow - i) * col.spacing;
          if (py < -col.spacing || py > height + col.spacing) continue;

          const wobbleX = col.x + Math.sin(i * 1.7 + col.wobble) * 1.4;
          const progress = i / col.trailLength;

          if (i === 0) {
            // White-hot, glowing droplet head
            ctx.shadowBlur = Math.round(16 * dim);
            ctx.shadowColor = pal.glow;
            ctx.fillStyle = pal.head;
            ctx.globalAlpha = clamp01((col.baseOpacity + 0.4 + mouseBoost) * dim);
            ctx.beginPath();
            ctx.arc(wobbleX, py, col.radius * 1.8, 0, TAU);
            ctx.fill();
            ctx.shadowBlur = 0;
          } else {
            // Elongated falling blood streak
            ctx.globalAlpha = clamp01((1 - progress) * (col.baseOpacity + mouseBoost) * dim);
            ctx.strokeStyle = progress < 0.25 ? pal.lead : progress < 0.7 ? pal.mid : pal.deep;
            ctx.lineWidth = col.radius * 2 * (1 - progress * 0.45);
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(wobbleX, py - segLen / 2);
            ctx.lineTo(wobbleX, py + segLen / 2);
            ctx.stroke();
          }
        }

        col.y += col.speed * speedMult;

        // Reset a track once its whole trail has fallen past the viewport
        if (col.y - col.trailLength * col.spacing > height) {
          col.y = -Math.random() * 200 - col.trailLength * col.spacing;
          col.speed =
            (col.layer === "fg" ? 2.7 : col.layer === "bg" ? 1.2 : 1.9) *
            (0.85 + Math.random() * 0.3);
          col.paletteKey = themeRef.current;
          col.waitFrames = Math.floor(Math.random() * 18);
        }
      }

      // Embers render above the rain so their warm glow reads as distinct
      if (embersEnabledRef.current) {
        for (let i = 0; i < embers.length; i++) {
          const e = embers[i];
          e.life += 1;
          e.flicker += 0.06;
          e.x += e.vx + Math.sin(e.flicker) * 0.4;
          e.y += e.vy;

          if (e.life > e.maxLife || e.y < -20 || e.x < -20 || e.x > width + 20) {
            embers[i] = createEmber(false);
            continue;
          }

          const fade = 1 - e.life / e.maxLife;
          const flick = 0.65 + 0.35 * Math.sin(e.flicker * 2);
          ctx.globalAlpha = clamp01(e.alpha * fade * flick * dim);
          ctx.shadowBlur = 8;
          ctx.shadowColor = e.color;
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.size, 0, TAU);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
    };

    animFrameIdRef.current = requestAnimationFrame(drawFrame);

    // Pause when the window/tab is hidden to save energy
    const handleVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(animFrameIdRef.current);
      } else {
        /*
         * Cancel any prior frame to maintain the single-chain invariant
         * before scheduling, preventing redundant events from spawning loops.
         */
        cancelAnimationFrame(animFrameIdRef.current);
        lastFrameTime = performance.now();
        animFrameIdRef.current = requestAnimationFrame(drawFrame);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelAnimationFrame(animFrameIdRef.current);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTimeout(resizeTimer);
    };
  }, []);

  const toggleRunning = useCallback(() => {
    setUserPaused((prev) => !prev);
  }, []);

  const toggleVisibility = useCallback(() => {
    setIsVisible((prev) => !prev);
  }, []);

  // Sigil stroke follows the active palette via `currentColor`
  const accentText =
    theme === "eclipse"
      ? "text-[#7c3aed]"
      : theme === "behelit"
        ? "text-[#e08a00]"
        : theme === "steel"
          ? "text-[#7d8a99]"
          : "text-[#c1121f]";

  return (
    <>
      {/* Background blood-rain canvas layer */}
      <div
        className={`fixed inset-0 pointer-events-none z-0 overflow-hidden select-none transition-opacity duration-500 bg-[#0a0507] ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
        aria-hidden="true"
      >
        <canvas ref={canvasRef} className="w-full h-full block" />
        {brandEnabled && (
          <BrandSigil
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[38vmin] h-[50vmin] ${accentText}`}
            opacity={0.2}
            pulse={isRunning}
          />
        )}
      </div>

      {/* Floating Berserk controls badge (bottom-right) */}
      <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end pointer-events-auto select-none">
        {controlsOpen && (
          <div
            className="mb-2 p-3 rounded-xl bg-bg-surface/95 border border-border shadow-2xl backdrop-blur-xl w-64 max-h-[85vh] overflow-y-auto text-xs font-sans text-text-primary"
            role="region"
            aria-label="Berserk rain settings"
          >
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/60">
              <span className="font-semibold flex items-center gap-1.5 font-mono text-[length:var(--text-xs)] text-text-primary">
                <Droplet className="w-3.5 h-3.5 text-accent" />
                Blood Rain
              </span>
              <button
                type="button"
                onClick={() => setControlsOpen(false)}
                className="text-text-muted hover:text-text-primary p-0.5 rounded transition-colors"
                aria-label="Close berserk controls"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Play/Pause & Visibility */}
            <div className="flex items-center justify-between py-1">
              <span className="text-text-secondary text-[length:var(--text-xs)]">Animation</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="berserk-control-play-pause"
                  onClick={toggleRunning}
                  className={`px-2 py-1 rounded-md flex items-center gap-1 font-mono text-[11px] transition-all border ${
                    isRunning
                      ? "bg-accent/15 text-accent border-accent/30 hover:bg-accent/25"
                      : "bg-bg-subtle text-text-muted border-border hover:bg-bg-muted hover:text-text-primary"
                  }`}
                  aria-label={isRunning ? "Pause berserk animation" : "Resume berserk animation"}
                >
                  {isRunning ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  <span>{isRunning ? "Running" : "Paused"}</span>
                </button>

                <button
                  type="button"
                  data-testid="berserk-control-visibility"
                  onClick={toggleVisibility}
                  className={`p-1 rounded-md transition-all border ${
                    isVisible
                      ? "bg-bg-subtle text-text-secondary border-border hover:text-text-primary"
                      : "bg-status-error/20 text-status-error border-status-error/30"
                  }`}
                  title={isVisible ? "Hide blood rain" : "Show blood rain"}
                  aria-label={isVisible ? "Hide blood rain" : "Show blood rain"}
                >
                  {isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Brightness / Dimmer */}
            <div className="py-2 border-t border-border/50 mt-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                  <Sun className="w-3 h-3 text-accent" />
                  Dimmer
                </span>
                <span className="text-[10px] font-mono text-accent font-medium">
                  {Math.round(brightness * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0.2"
                max="1.0"
                step="0.05"
                value={brightness}
                onChange={(e) => setBrightness(parseFloat(e.target.value))}
                data-testid="berserk-dimmer-slider"
                aria-label="Blood rain brightness dimmer"
                className="w-full h-1.5 bg-bg-base rounded-lg appearance-none cursor-pointer accent-accent"
              />
              <div className="flex justify-between mt-1.5 gap-1 font-mono text-[10px]">
                {([
                  { label: "Subtle", val: 0.3, testId: "berserk-dimmer-subtle" },
                  { label: "Balanced", val: 0.65, testId: "berserk-dimmer-balanced" },
                  { label: "Vivid", val: 0.95, testId: "berserk-dimmer-vivid" },
                ]).map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    data-testid={preset.testId}
                    onClick={() => setBrightness(preset.val)}
                    className={`flex-1 py-0.5 rounded border transition-colors ${
                      Math.abs(brightness - preset.val) < 0.08
                        ? "bg-accent/20 text-accent border-accent/50 font-bold"
                        : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Density */}
            <div className="py-2 border-t border-border/50 flex items-center justify-between">
              <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                <Droplet className="w-3 h-3 text-accent" />
                Density
              </span>
              <div className="flex gap-1 font-mono text-[10px]">
                {([
                  { label: "Low", val: "low" as const, testId: "berserk-density-low" },
                  { label: "Medium", val: "medium" as const, testId: "berserk-density-medium" },
                  { label: "High", val: "high" as const, testId: "berserk-density-high" },
                ]).map((d) => (
                  <button
                    key={d.val}
                    type="button"
                    data-testid={d.testId}
                    onClick={() => setDensity(d.val)}
                    className={`px-2 py-0.5 rounded border transition-colors ${
                      density === d.val
                        ? "bg-accent/20 text-accent border-accent/50 font-bold"
                        : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Embers & Brand toggles */}
            <div className="py-2 border-t border-border/50 flex items-center justify-between">
              <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                <Flame className="w-3 h-3 text-accent" />
                Embers
              </span>
              <button
                type="button"
                data-testid="berserk-control-embers"
                onClick={() => setEmbersEnabled(!embersEnabled)}
                aria-pressed={embersEnabled}
                aria-label="Toggle ember particles"
                className={`px-2 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                  embersEnabled
                    ? "bg-accent/20 text-accent border-accent/50 font-bold"
                    : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                }`}
              >
                {embersEnabled ? "On" : "Off"}
              </button>
            </div>

            <div className="py-2 border-t border-border/50 flex items-center justify-between">
              <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                <Sparkles className="w-3 h-3 text-accent" />
                Brand
              </span>
              <button
                type="button"
                data-testid="berserk-control-brand"
                onClick={() => setBrandEnabled(!brandEnabled)}
                aria-pressed={brandEnabled}
                aria-label="Toggle brand sigil watermark"
                className={`px-2 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                  brandEnabled
                    ? "bg-accent/20 text-accent border-accent/50 font-bold"
                    : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                }`}
              >
                {brandEnabled ? "On" : "Off"}
              </button>
            </div>

            {/* Color Palette Selector */}
            <div className="py-2 border-t border-border/50 mt-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                  <Palette className="w-3 h-3 text-accent" />
                  Palette
                </span>
                <span className="text-[10px] uppercase font-mono text-accent font-medium">{theme}</span>
              </div>
              <div className="grid grid-cols-2 gap-1 font-mono text-[11px]">
                {([
                  { key: "berserk" as const, label: "Berserk", dot: "bg-[#c1121f]" },
                  { key: "eclipse" as const, label: "Eclipse", dot: "bg-[#7c3aed]" },
                  { key: "behelit" as const, label: "Behelit", dot: "bg-[#e08a00]" },
                  { key: "steel" as const, label: "Steel", dot: "bg-[#7d8a99]" },
                ]).map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    data-testid={`berserk-palette-${p.key}`}
                    onClick={() => setTheme(p.key)}
                    className={`px-2 py-1 rounded border text-left flex items-center gap-1.5 transition-colors ${
                      theme === p.key
                        ? "bg-accent/20 border-accent text-text-primary font-semibold"
                        : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${p.dot} shrink-0`} />
                    <span className="truncate">{p.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Velocity / Speed Control */}
            <div className="py-2 border-t border-border/50 flex items-center justify-between">
              <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                <Sliders className="w-3 h-3 text-accent" />
                Velocity
              </span>
              <div className="flex gap-1 font-mono text-[10px]">
                {([
                  { label: "0.6x", val: 0.6 as const, testId: "berserk-speed-0.6" },
                  { label: "1.0x", val: 1 as const, testId: "berserk-speed-1.0" },
                  { label: "1.6x", val: 1.6 as const, testId: "berserk-speed-1.6" },
                ]).map((sp) => (
                  <button
                    key={sp.label}
                    type="button"
                    data-testid={sp.testId}
                    onClick={() => setSpeedMultiplier(sp.val)}
                    className={`px-1.5 py-0.5 rounded border transition-colors ${
                      speedMultiplier === sp.val
                        ? "bg-accent/20 text-accent border-accent/50 font-bold"
                        : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                    }`}
                  >
                    {sp.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Restore to Defaults */}
            <div className="pt-2 border-t border-border/50 mt-1 flex justify-end">
              <button
                type="button"
                data-testid="berserk-restore-defaults"
                onClick={restoreDefaults}
                className="w-full py-1.5 px-2 rounded flex items-center justify-center gap-1.5 font-mono text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-subtle border border-border/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent cursor-pointer"
                aria-label="Restore default berserk settings"
              >
                <RotateCcw className="w-3.5 h-3.5 text-accent" />
                <span>Restore to Defaults</span>
              </button>
            </div>
          </div>
        )}

        {/* Minimalist pill trigger */}
        <button
          type="button"
          data-testid="berserk-controls-toggle"
          onClick={() => setControlsOpen((prev) => !prev)}
          className="group inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-bg-surface/90 hover:bg-bg-overlay border border-accent/40 hover:border-accent shadow-lg shadow-black/60 backdrop-blur-md transition-all text-xs font-mono text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={controlsOpen}
          aria-label="Toggle Berserk effect options"
        >
          <span className="relative flex h-2 w-2">
            {isRunning && isVisible && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${
                !isVisible ? "bg-text-muted" : isRunning ? "bg-accent" : "bg-amber-400"
              }`}
            />
          </span>
          <span className="text-[11px] font-medium tracking-tight">Berserk</span>
          <Droplet className="w-3 h-3 text-accent group-hover:translate-y-0.5 transition-transform" />
        </button>
      </div>
    </>
  );
}
