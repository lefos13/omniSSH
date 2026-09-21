/*
 * Shared type contracts for the reusable animated-theme effect framework.
 *
 * Every special theme is described by a single `EffectDefinition`: a palette
 * table, a scene factory, a per-frame draw function, and a declarative
 * `ControlSpec` that drives the generic controls panel. The framework owns the
 * canvas lifecycle (see useCanvasEffect) and all persisted control state (see
 * useEffectControls), so a theme only supplies its own visuals.
 */

import type { LucideIcon } from "lucide-react";

export type SpeedMultiplier = 0.6 | 1 | 1.6;
export type Density = "low" | "medium" | "high";

/*
 * A theme palette. The first five fields are the shared gradient roles used by
 * the falling/rising particle systems; `accent` tints smaller detail work.
 * Theme-specific extras (embers, bubbles, petals, motes, fog, stars, rays) are
 * carried by the index signature so each effect can name its own roles.
 */
export interface Palette {
  head: string;
  glow: string;
  lead: string;
  mid: string;
  deep: string;
  accent: string;
  [extra: string]: string;
}

export interface PaletteOption {
  key: string;
  label: string;
  /** Tailwind class for the swatch dot in the palette grid. */
  dot: string;
}

export interface DensityOption {
  key: Density;
  label: string;
}

export interface ToggleOption {
  key: string;
  label: string;
  icon: LucideIcon;
}

/** Declarative description of the controls panel rows for a theme. */
export interface ControlSpec {
  palettes: PaletteOption[];
  density?: DensityOption[];
  toggles?: ToggleOption[];
  speedPresets?: SpeedMultiplier[];
  dimmerPresets?: { label: string; val: number }[];
}

export interface SceneSize {
  w: number;
  h: number;
}

/** Inputs read once when a scene is (re)built. */
export interface SceneConfig {
  palette: Palette;
  density: Density;
  toggles: Record<string, boolean>;
}

/** Per-frame environment passed to `draw`. */
export interface FrameEnv {
  width: number;
  height: number;
  /** Milliseconds since the previously drawn frame. */
  dt: number;
  speed: number;
  brightness: number;
  density: Density;
  toggles: Record<string, boolean>;
  palette: Palette;
  pointer: { x: number; y: number; active: boolean };
}

export interface EffectDefinition<S> {
  /** Storage-key prefix and data-testid prefix, e.g. "deepsea". */
  id: string;
  /** Human label shown in the controls pill and panel header. */
  label: string;
  /** Pill icon. */
  icon: LucideIcon;
  /** Opaque background painted behind the transparent canvas. */
  backgroundColor: string;
  /** ARIA label for the controls region. */
  panelLabel: string;
  palettes: Record<string, Palette>;
  defaultPalette: string;
  defaults: {
    speed: SpeedMultiplier;
    brightness: number;
    density: Density;
    toggles: Record<string, boolean>;
  };
  /** Draw throttle target. */
  fps: number;
  controls: ControlSpec;
  createScene(size: SceneSize, cfg: SceneConfig): S;
  draw(ctx: CanvasRenderingContext2D, scene: S, env: FrameEnv): void;
  /** Optional: recolor a live scene in place so a palette change is instant. */
  recolor?(scene: S, palette: Palette): void;
}

/** Live control state shared by the canvas loop and the controls panel. */
export interface EffectControls {
  paletteKey: string;
  palette: Palette;
  speed: SpeedMultiplier;
  brightness: number;
  density: Density;
  toggles: Record<string, boolean>;
  isRunning: boolean;
  isVisible: boolean;
  setPaletteKey: (key: string) => void;
  setSpeed: (speed: SpeedMultiplier) => void;
  setBrightness: (brightness: number) => void;
  setDensity: (density: Density) => void;
  setToggle: (key: string, value: boolean) => void;
  setUserPaused: (paused: boolean) => void;
  setVisible: (visible: boolean) => void;
  restoreDefaults: () => void;
}

export const SPEED_PRESETS: SpeedMultiplier[] = [0.6, 1, 1.6];

export const DEFAULT_DIMMER_PRESETS = [
  { label: "Subtle", val: 0.3 },
  { label: "Balanced", val: 0.65 },
  { label: "Vivid", val: 0.95 },
];
