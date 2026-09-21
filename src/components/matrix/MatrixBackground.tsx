/*
 * MatrixBackground renders an authentic, GPU-accelerated Matrix digital rain
 * background effect on an HTML5 canvas, directly adapted from omnissh-web.
 * Features 3D depth layering, character flickering, mouse proximity reactivity,
 * frame-rate throttling (33 FPS target for low battery & CPU impact),
 * prefers-reduced-motion detection, and compact interactive controls.
 */

import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import { Terminal, Play, Pause, Palette, Sliders, Eye, EyeOff, Sparkles, X, Sun, Type, Zap } from "lucide-react";

// Authentic Matrix half-width Katakana + code / binary / sysadmin glyphs
const KATAKANA = "ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ1234567890:・.=\"=*+-<>¦｜";
const CODE_SYMBOLS = "01010101ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789{}[]<>/\\$#@!%&*";
const ALL_CHARS = KATAKANA + CODE_SYMBOLS;

export type ColorTheme = "omnissh" | "cyan" | "emerald" | "classic";
export type GlyphSize = "small" | "medium" | "large";
export type HeadMode = "white" | "tinted" | "soft";

interface ColorPalette {
  head: string;
  glow: string;
  lead: string;
  mid: string;
  deep: string;
}

const THEME_PALETTES: Record<"cyan" | "emerald" | "purple" | "classic", ColorPalette> = {
  cyan: {
    head: "#ffffff",
    glow: "rgba(0, 240, 255, 1)",
    lead: "#bbf7fe",
    mid: "#00e5ff",
    deep: "#06b6d4",
  },
  emerald: {
    head: "#ffffff",
    glow: "rgba(16, 230, 140, 1)",
    lead: "#86efac",
    mid: "#10b981",
    deep: "#059669",
  },
  purple: {
    head: "#ffffff",
    glow: "rgba(192, 110, 255, 1)",
    lead: "#f3e8ff",
    mid: "#c084fc",
    deep: "#9333ea",
  },
  classic: {
    head: "#ffffff",
    glow: "rgba(0, 255, 102, 1)",
    lead: "#86efac",
    mid: "#00ff66",
    deep: "#15803d",
  },
};

interface ColumnStream {
  x: number;
  y: number;
  speed: number;
  trailLength: number;
  fontSize: number;
  chars: string[];
  themeKey: "cyan" | "emerald" | "purple" | "classic";
  layer: "bg" | "mid" | "fg";
  baseOpacity: number;
  active: boolean;
  waitFrames: number;
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

const STORAGE_PALETTE_KEY = "matrix_theme_palette";
const STORAGE_SPEED_KEY = "matrix_theme_speed";
const STORAGE_BRIGHTNESS_KEY = "matrix_theme_brightness";
const STORAGE_SIZE_KEY = "matrix_theme_size";
const STORAGE_HEAD_KEY = "matrix_theme_head";

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

export function MatrixBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const prefersReducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot
  );

  const [userPaused, setUserPaused] = useState(false);
  const isRunning = !prefersReducedMotion && !userPaused;

  const [isVisible, setIsVisible] = useState(true);
  const [theme, setThemeState] = useState<ColorTheme>(() =>
    getStoredValue<ColorTheme>(STORAGE_PALETTE_KEY, "omnissh")
  );
  const [speedMultiplier, setSpeedMultiplierState] = useState<1 | 0.6 | 1.6>(() =>
    getStoredValue<1 | 0.6 | 1.6>(STORAGE_SPEED_KEY, 1)
  );
  const [brightness, setBrightnessState] = useState<number>(() =>
    getStoredValue<number>(STORAGE_BRIGHTNESS_KEY, 0.45)
  );
  const [glyphSize, setGlyphSizeState] = useState<GlyphSize>(() =>
    getStoredValue<GlyphSize>(STORAGE_SIZE_KEY, "medium")
  );
  const [headMode, setHeadModeState] = useState<HeadMode>(() => {
    const val = getStoredValue<HeadMode>(STORAGE_HEAD_KEY, "white");
    return val === "white" || val === "tinted" || val === "soft" ? val : "white";
  });
  const [controlsOpen, setControlsOpen] = useState(false);

  const setTheme = useCallback((t: ColorTheme) => {
    setThemeState(t);
    setStoredValue(STORAGE_PALETTE_KEY, t);
    themeRef.current = t;
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

  const setHeadMode = useCallback((m: HeadMode) => {
    setHeadModeState(m);
    setStoredValue(STORAGE_HEAD_KEY, m);
    headModeRef.current = m;
  }, []);

  const mousePosRef = useRef({ x: -9999, y: -9999, lastActive: 0 });
  const animFrameIdRef = useRef<number>(0);
  const isRunningRef = useRef(isRunning);
  const isVisibleRef = useRef(isVisible);
  const themeRef = useRef(theme);
  const speedRef = useRef(speedMultiplier);
  const brightnessRef = useRef(brightness);
  const sizeRef = useRef(glyphSize);
  const headModeRef = useRef(headMode);
  const setupColumnsRef = useRef<() => void>(() => {});

  const setGlyphSize = useCallback((s: GlyphSize) => {
    setGlyphSizeState(s);
    setStoredValue(STORAGE_SIZE_KEY, s);
    sizeRef.current = s;
    setupColumnsRef.current();
  }, []);

  useEffect(() => {
    isRunningRef.current = isRunning;
    isVisibleRef.current = isVisible;
    themeRef.current = theme;
    speedRef.current = speedMultiplier;
    brightnessRef.current = brightness;
    sizeRef.current = glyphSize;
    headModeRef.current = headMode;
  }, [isRunning, isVisible, theme, speedMultiplier, brightness, glyphSize, headMode]);

  /*
   * Initialize and run the canvas render loop with frame-rate throttling,
   * high-DPI scaling, and multi-layered stream updates.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let columns: ColumnStream[] = [];
    let width = window.innerWidth;
    let height = window.innerHeight;

    const getRandomChar = () => ALL_CHARS[Math.floor(Math.random() * ALL_CHARS.length)];

    const pickThemeKey = (selectedTheme: ColorTheme): "cyan" | "emerald" | "purple" | "classic" => {
      if (selectedTheme === "classic") return "classic";
      if (selectedTheme === "cyan") return "cyan";
      if (selectedTheme === "emerald") return "emerald";
      // "omnissh" theme mirrors the landing page's main colors:
      // 60% electric cyan, 32% emerald green, 8% dock purple
      const roll = Math.random();
      if (roll < 0.60) return "cyan";
      if (roll < 0.92) return "emerald";
      return "purple";
    };

    const getColumnWidth = (sz: GlyphSize): number => {
      switch (sz) {
        case "small":
          return 14;
        case "large":
          return 22;
        case "medium":
        default:
          return 18;
      }
    };

    /*
     * Build a single falling character stream column according to the selected
     * glyph size tier and pseudo-random 3D depth layer (background, mid, foreground).
     */
    const createColumn = (x: number, initScatter = false, sz: GlyphSize = sizeRef.current): ColumnStream => {
      const layerRoll = Math.random();
      let layer: "bg" | "mid" | "fg" = "mid";
      let fontSize = 14;
      let baseSpeed = 2.4;
      let baseOpacity = 0.60;
      let trailLength = 22;

      if (sz === "small") {
        fontSize = 12;
        baseSpeed = 2.2;
        baseOpacity = 0.55;
        trailLength = 18;
        if (layerRoll < 0.25) {
          layer = "bg";
          fontSize = 10;
          baseSpeed = 1.4;
          baseOpacity = 0.35;
          trailLength = 14;
        } else if (layerRoll > 0.70) {
          layer = "fg";
          fontSize = 14;
          baseSpeed = 3.2;
          baseOpacity = 0.75;
          trailLength = 24;
        }
      } else if (sz === "large") {
        fontSize = 17;
        baseSpeed = 2.6;
        baseOpacity = 0.65;
        trailLength = 26;
        if (layerRoll < 0.25) {
          layer = "bg";
          fontSize = 14;
          baseSpeed = 1.6;
          baseOpacity = 0.40;
          trailLength = 18;
        } else if (layerRoll > 0.70) {
          layer = "fg";
          fontSize = 20;
          baseSpeed = 3.8;
          baseOpacity = 0.85;
          trailLength = 32;
        }
      } else {
        // "medium" (default)
        fontSize = 14;
        baseSpeed = 2.4;
        baseOpacity = 0.60;
        trailLength = 22;
        if (layerRoll < 0.25) {
          layer = "bg";
          fontSize = 12;
          baseSpeed = 1.5;
          baseOpacity = 0.38;
          trailLength = 16;
        } else if (layerRoll > 0.70) {
          layer = "fg";
          fontSize = 16;
          baseSpeed = 3.5;
          baseOpacity = 0.80;
          trailLength = 28;
        }
      }

      const length = Math.floor(trailLength * (0.8 + Math.random() * 0.4));
      const chars: string[] = [];
      for (let i = 0; i < length; i++) {
        chars.push(getRandomChar());
      }

      // If scattering on initial load, distribute across viewport height
      const y = initScatter
        ? Math.random() * (height + 300) - 200
        : -Math.random() * 300 - length * fontSize;

      return {
        x,
        y,
        speed: baseSpeed * (0.85 + Math.random() * 0.3),
        trailLength: length,
        fontSize,
        chars,
        themeKey: pickThemeKey(themeRef.current),
        layer,
        baseOpacity,
        active: true,
        waitFrames: 0,
      };
    };

    const setupColumns = () => {
      const colWidth = getColumnWidth(sizeRef.current);
      const colCount = Math.ceil(width / colWidth);
      columns = [];
      for (let i = 0; i < colCount; i++) {
        columns.push(createColumn(i * colWidth, true, sizeRef.current));
      }
    };

    setupColumnsRef.current = setupColumns;

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
      setupColumns();
    };

    resizeCanvas();

    let resizeTimer: ReturnType<typeof setTimeout>;
    const handleResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resizeCanvas, 150);
    };

    const handlePointerMove = (e: PointerEvent) => {
      mousePosRef.current = {
        x: e.clientX,
        y: e.clientY,
        lastActive: Date.now(),
      };
    };

    const handlePointerLeave = () => {
      mousePosRef.current = { x: -9999, y: -9999, lastActive: 0 };
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerleave", handlePointerLeave);

    // Frame-rate throttle: 33 FPS target for cinematic retro rhythm & low battery usage
    const targetFps = 33;
    const frameInterval = 1000 / targetFps;
    let lastFrameTime = performance.now();

    const drawFrame = (currentTime: number) => {
      animFrameIdRef.current = requestAnimationFrame(drawFrame);

      if (!isVisibleRef.current) return;

      const elapsed = currentTime - lastFrameTime;
      if (elapsed < frameInterval) return;
      lastFrameTime = currentTime - (elapsed % frameInterval);

      if (!isRunningRef.current) return;

      // Clear transparently so underlying theme background stays visible
      ctx.clearRect(0, 0, width, height);

      const mouse = mousePosRef.current;
      const isMouseRecentlyActive = Date.now() - mouse.lastActive < 2000;
      const speedMult = speedRef.current;
      const currentTheme = themeRef.current;
      const brightness = brightnessRef.current;

      for (let c = 0; c < columns.length; c++) {
        const col = columns[c];

        // If inactive or waiting, decrement wait
        if (col.waitFrames > 0) {
          col.waitFrames--;
          continue;
        }

        // Mouse proximity boost
        let mouseBoost = 0;
        if (isMouseRecentlyActive) {
          const distX = Math.abs(col.x - mouse.x);
          if (distX < 140) {
            mouseBoost = (1 - distX / 140) * 0.35;
          }
        }

        // Determine effective palette
        let paletteKey = col.themeKey;
        if (currentTheme !== "omnissh") {
          paletteKey = currentTheme;
        }
        const palette = THEME_PALETTES[paletteKey] || THEME_PALETTES.cyan;

        ctx.font = `bold ${col.fontSize}px "JetBrains Mono", "Fira Code", monospace`;
        ctx.textBaseline = "top";

        const headRow = Math.floor(col.y / col.fontSize);

        // Draw trail glyphs from head backwards
        for (let i = 0; i < col.trailLength; i++) {
          const charY = (headRow - i) * col.fontSize;

          // Skip characters outside visible canvas bounds
          if (charY < -col.fontSize || charY > height + col.fontSize) continue;

          const char = col.chars[i] || "0";
          const progress = i / col.trailLength;

          if (i === 0) {
            /*
             * Head character rendering style:
             * - "white": classic authentic glowing white head with bloom.
             * - "tinted": stream-matched vibrant lead tint with softened bloom.
             * - "soft": smooth stream blend without blooming glare.
             */
            const currentHeadMode = headModeRef.current;
            if (currentHeadMode === "tinted") {
              const headBlur = Math.round(6 * brightness);
              ctx.shadowBlur = headBlur;
              ctx.shadowColor = palette.glow;
              ctx.fillStyle = palette.lead;
              ctx.globalAlpha = Math.min(
                1,
                Math.max(0.1, (col.baseOpacity + 0.25 + mouseBoost) * brightness)
              );
            } else if (currentHeadMode === "soft") {
              ctx.shadowBlur = 0;
              ctx.shadowColor = "transparent";
              ctx.fillStyle = palette.lead;
              ctx.globalAlpha = Math.min(
                1,
                Math.max(0.1, (col.baseOpacity + 0.10 + mouseBoost) * brightness)
              );
            } else {
              const headBlur = Math.round(10 * brightness);
              ctx.shadowBlur = headBlur;
              ctx.shadowColor = palette.glow;
              ctx.fillStyle = palette.head;
              ctx.globalAlpha = Math.min(
                1,
                Math.max(0.1, (col.baseOpacity + 0.35 + mouseBoost) * brightness)
              );
            }
            ctx.fillText(char, col.x, charY);
            ctx.shadowBlur = 0;
            ctx.shadowColor = "transparent";
          } else {
            // Trail character: smooth gradient fade modulated by column opacity & dimmer
            const fadeAlpha = (1 - progress) * (col.baseOpacity + mouseBoost) * brightness;
            ctx.globalAlpha = Math.min(1, Math.max(0, fadeAlpha));

            if (progress < 0.22) {
              ctx.fillStyle = palette.lead;
            } else if (progress < 0.68) {
              ctx.fillStyle = palette.mid;
            } else {
              ctx.fillStyle = palette.deep;
            }

            ctx.fillText(char, col.x, charY);
          }
        }

        // Advance column position
        col.y += col.speed * speedMult;

        // Occasional head mutation (flickering character at leader position)
        if (Math.random() < 0.25) {
          col.chars[0] = getRandomChar();
        }

        // Random mid-stream character mutations (classic Matrix code shift)
        if (Math.random() < 0.04) {
          const randIdx = Math.floor(Math.random() * col.trailLength);
          col.chars[randIdx] = getRandomChar();
        }

        // Reset column once entire trail passes below canvas
        if (col.y - col.trailLength * col.fontSize > height) {
          col.y = -Math.random() * 200 - col.trailLength * col.fontSize;
          col.speed =
            (col.layer === "fg" ? 3.5 : col.layer === "bg" ? 1.5 : 2.4) *
            (0.85 + Math.random() * 0.3);
          col.themeKey = pickThemeKey(currentTheme);
          col.waitFrames = Math.floor(Math.random() * 20);
          for (let i = 0; i < col.trailLength; i++) {
            col.chars[i] = getRandomChar();
          }
        }
      }
    };

    animFrameIdRef.current = requestAnimationFrame(drawFrame);

    // Pause when window tab is hidden to save energy
    const handleVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(animFrameIdRef.current);
      } else {
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

  return (
    <>
      {/* Background Matrix Canvas Layer */}
      <div
        className={`fixed inset-0 pointer-events-none z-0 overflow-hidden select-none transition-opacity duration-500 bg-[#040805] ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
        aria-hidden="true"
      >
        <canvas ref={canvasRef} className="w-full h-full block" />
      </div>

      {/* Floating Matrix Controls Badge (Bottom-Right) */}
      <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end pointer-events-auto select-none">
        {controlsOpen && (
          <div
            className="mb-2 p-3 rounded-xl bg-bg-surface/95 border border-border shadow-2xl backdrop-blur-xl w-64 max-h-[85vh] overflow-y-auto text-xs font-sans text-text-primary"
            role="region"
            aria-label="Matrix Rain Settings"
          >
            <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/60">
              <span className="font-semibold flex items-center gap-1.5 font-mono text-[length:var(--text-xs)] text-text-primary">
                <Terminal className="w-3.5 h-3.5 text-accent" />
                Matrix Rain
              </span>
              <button
                type="button"
                onClick={() => setControlsOpen(false)}
                className="text-text-muted hover:text-text-primary p-0.5 rounded transition-colors"
                aria-label="Close matrix controls"
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
                  data-testid="matrix-control-play-pause"
                  onClick={toggleRunning}
                  className={`px-2 py-1 rounded-md flex items-center gap-1 font-mono text-[11px] transition-all border ${
                    isRunning
                      ? "bg-accent/15 text-accent border-accent/30 hover:bg-accent/25"
                      : "bg-bg-subtle text-text-muted border-border hover:bg-bg-muted hover:text-text-primary"
                  }`}
                  aria-label={isRunning ? "Pause matrix animation" : "Resume matrix animation"}
                >
                  {isRunning ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  <span>{isRunning ? "Running" : "Paused"}</span>
                </button>

                <button
                  type="button"
                  data-testid="matrix-control-visibility"
                  onClick={toggleVisibility}
                  className={`p-1 rounded-md transition-all border ${
                    isVisible
                      ? "bg-bg-subtle text-text-secondary border-border hover:text-text-primary"
                      : "bg-status-error/20 text-status-error border-status-error/30"
                  }`}
                  title={isVisible ? "Hide Matrix rain" : "Show Matrix rain"}
                  aria-label={isVisible ? "Hide Matrix rain" : "Show Matrix rain"}
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
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="0.2"
                  max="1.0"
                  step="0.05"
                  value={brightness}
                  onChange={(e) => setBrightness(parseFloat(e.target.value))}
                  data-testid="matrix-dimmer-slider"
                  aria-label="Matrix rain brightness dimmer"
                  className="w-full h-1.5 bg-bg-base rounded-lg appearance-none cursor-pointer accent-accent"
                />
              </div>
              <div className="flex justify-between mt-1.5 gap-1 font-mono text-[10px]">
                {([
                  { label: "Subtle", val: 0.35, testId: "matrix-dimmer-subtle" },
                  { label: "Balanced", val: 0.55, testId: "matrix-dimmer-balanced" },
                  { label: "Vivid", val: 0.90, testId: "matrix-dimmer-vivid" },
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

            {/* Glyph Size */}
            <div className="py-2 border-t border-border/50 flex items-center justify-between">
              <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                <Type className="w-3 h-3 text-accent" />
                Size
              </span>
              <div className="flex gap-1 font-mono text-[10px]">
                {([
                  { label: "Small", val: "small" as const, testId: "matrix-size-small" },
                  { label: "Medium", val: "medium" as const, testId: "matrix-size-medium" },
                  { label: "Large", val: "large" as const, testId: "matrix-size-large" },
                ]).map((sz) => (
                  <button
                    key={sz.val}
                    type="button"
                    data-testid={sz.testId}
                    onClick={() => setGlyphSize(sz.val)}
                    className={`px-2 py-0.5 rounded border transition-colors ${
                      glyphSize === sz.val
                        ? "bg-accent/20 text-accent border-accent/50 font-bold"
                        : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                    }`}
                  >
                    {sz.label}
                  </button>
                ))}
              </div>
            </div>

            {/* First Letter / Lead Character Style */}
            <div className="py-2 border-t border-border/50 flex items-center justify-between">
              <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)] whitespace-nowrap shrink-0">
                <Zap className="w-3 h-3 text-accent" />
                First Letter
              </span>
              <div className="flex gap-1 font-mono text-[10px]" role="group" aria-label="First letter style">
                {([
                  { label: "White", val: "white" as const, testId: "matrix-head-white" },
                  { label: "Tinted", val: "tinted" as const, testId: "matrix-head-tinted" },
                  { label: "Soft", val: "soft" as const, testId: "matrix-head-soft" },
                ]).map((mode) => (
                  <button
                    key={mode.val}
                    type="button"
                    data-testid={mode.testId}
                    onClick={() => setHeadMode(mode.val)}
                    aria-pressed={headMode === mode.val}
                    aria-label={`First letter style: ${mode.label}`}
                    className={`px-1.5 py-0.5 rounded border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                      headMode === mode.val
                        ? "bg-accent/20 text-accent border-accent/50 font-bold"
                        : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Color Palette Selector */}
            <div className="py-2 border-t border-border/50 mt-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                  <Palette className="w-3 h-3 text-accent" />
                  Palette
                </span>
                <span className="text-[10px] uppercase font-mono text-accent font-medium">
                  {theme}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1 font-mono text-[11px]">
                <button
                  type="button"
                  data-testid="matrix-palette-omnissh"
                  onClick={() => setTheme("omnissh")}
                  className={`px-2 py-1 rounded border text-left flex items-center gap-1.5 transition-colors ${
                    theme === "omnissh"
                      ? "bg-accent/20 border-accent text-text-primary font-semibold"
                      : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-gradient-to-r from-cyan-400 to-emerald-400 shrink-0" />
                  <span className="truncate">OmniSSH</span>
                </button>
                <button
                  type="button"
                  data-testid="matrix-palette-classic"
                  onClick={() => setTheme("classic")}
                  className={`px-2 py-1 rounded border text-left flex items-center gap-1.5 transition-colors ${
                    theme === "classic"
                      ? "bg-accent/20 border-accent text-text-primary font-semibold"
                      : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                  <span className="truncate">Classic 1999</span>
                </button>
                <button
                  type="button"
                  data-testid="matrix-palette-cyan"
                  onClick={() => setTheme("cyan")}
                  className={`px-2 py-1 rounded border text-left flex items-center gap-1.5 transition-colors ${
                    theme === "cyan"
                      ? "bg-accent/20 border-accent text-text-primary font-semibold"
                      : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-cyan-400 shrink-0" />
                  <span className="truncate">Cyan</span>
                </button>
                <button
                  type="button"
                  data-testid="matrix-palette-emerald"
                  onClick={() => setTheme("emerald")}
                  className={`px-2 py-1 rounded border text-left flex items-center gap-1.5 transition-colors ${
                    theme === "emerald"
                      ? "bg-accent/20 border-accent text-text-primary font-semibold"
                      : "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle"
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  <span className="truncate">Emerald</span>
                </button>
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
                  { label: "0.6x", val: 0.6 as const, testId: "matrix-speed-0.6" },
                  { label: "1.0x", val: 1 as const, testId: "matrix-speed-1.0" },
                  { label: "1.6x", val: 1.6 as const, testId: "matrix-speed-1.6" },
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
          </div>
        )}

        {/* Minimalist Pill Trigger Button */}
        <button
          type="button"
          data-testid="matrix-controls-toggle"
          onClick={() => setControlsOpen((prev) => !prev)}
          className="group inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-bg-surface/90 hover:bg-bg-overlay border border-accent/40 hover:border-accent shadow-lg shadow-black/60 backdrop-blur-md transition-all text-xs font-mono text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={controlsOpen}
          aria-label="Toggle Matrix effect options"
        >
          <span className="relative flex h-2 w-2">
            {isRunning && isVisible && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${
                !isVisible
                  ? "bg-text-muted"
                  : isRunning
                  ? "bg-accent"
                  : "bg-amber-400"
              }`}
            />
          </span>
          <span className="text-[11px] font-medium tracking-tight">Matrix</span>
          <Sparkles className="w-3 h-3 text-accent group-hover:rotate-12 transition-transform" />
        </button>
      </div>
    </>
  );
}
