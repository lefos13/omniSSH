/*
 * Persisted control state for an effect theme.
 *
 * Replaces the per-component useState/getStoredValue block that the Matrix and
 * Berserk effects each carry. Reads validated values from localStorage on mount,
 * writes every change through, and exposes a single `restoreDefaults` that
 * returns both React state and persisted storage to the theme's defaults.
 */

import { useCallback, useState } from "react";
import type { Density, EffectControls, EffectDefinition, SpeedMultiplier } from "./types";
import { createStorageKeys, getStoredValue, setStoredValue } from "./effectStorage";
import { useReducedMotion } from "./useReducedMotion";

const DENSITY_KEYS: Density[] = ["low", "medium", "high"];

function clampBrightness(value: number, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(0.15, Math.min(1.0, Math.round(value * 100) / 100));
}

export function useEffectControls<S>(def: EffectDefinition<S>): EffectControls {
  const keys = createStorageKeys(def.id);
  const prefersReducedMotion = useReducedMotion();

  const [userPaused, setUserPaused] = useState(false);
  const [isVisible, setVisible] = useState(true);

  const [paletteKey, setPaletteKeyState] = useState<string>(() => {
    const stored = getStoredValue<string>(keys.palette, def.defaultPalette);
    return def.palettes[stored] ? stored : def.defaultPalette;
  });
  const [speed, setSpeedState] = useState<SpeedMultiplier>(() => {
    const stored = getStoredValue<number>(keys.speed, def.defaults.speed);
    return stored === 0.6 || stored === 1 || stored === 1.6 ? stored : def.defaults.speed;
  });
  const [brightness, setBrightnessState] = useState<number>(() =>
    clampBrightness(getStoredValue<number>(keys.brightness, def.defaults.brightness), def.defaults.brightness)
  );
  const [density, setDensityState] = useState<Density>(() => {
    const stored = getStoredValue<string>(keys.density, def.defaults.density);
    return DENSITY_KEYS.includes(stored as Density) ? (stored as Density) : def.defaults.density;
  });
  const [toggles, setToggles] = useState<Record<string, boolean>>(() => {
    const next: Record<string, boolean> = {};
    for (const [key, fallback] of Object.entries(def.defaults.toggles)) {
      const stored = getStoredValue<boolean>(keys.toggle(key), fallback);
      next[key] = typeof stored === "boolean" ? stored : fallback;
    }
    return next;
  });

  const setPaletteKey = useCallback(
    (key: string) => {
      setPaletteKeyState(key);
      setStoredValue(keys.palette, key);
    },
    [keys.palette]
  );

  const setSpeed = useCallback(
    (value: SpeedMultiplier) => {
      setSpeedState(value);
      setStoredValue(keys.speed, value);
    },
    [keys.speed]
  );

  const setBrightness = useCallback(
    (value: number) => {
      const clamped = clampBrightness(value, def.defaults.brightness);
      setBrightnessState(clamped);
      setStoredValue(keys.brightness, clamped);
    },
    [keys.brightness, def.defaults.brightness]
  );

  const setDensity = useCallback(
    (value: Density) => {
      setDensityState(value);
      setStoredValue(keys.density, value);
    },
    [keys.density]
  );

  const setToggle = useCallback(
    (key: string, value: boolean) => {
      setToggles((prev) => ({ ...prev, [key]: value }));
      setStoredValue(keys.toggle(key), value);
    },
    [keys.toggle]
  );

  const restoreDefaults = useCallback(() => {
    setPaletteKey(def.defaultPalette);
    setSpeed(def.defaults.speed);
    setBrightness(def.defaults.brightness);
    setDensity(def.defaults.density);
    for (const [key, value] of Object.entries(def.defaults.toggles)) {
      setToggle(key, value);
    }
    setUserPaused(false);
    setVisible(true);
  }, [def.defaultPalette, def.defaults, setPaletteKey, setSpeed, setBrightness, setDensity, setToggle]);

  const palette = def.palettes[paletteKey] ?? def.palettes[def.defaultPalette];

  return {
    paletteKey,
    palette,
    speed,
    brightness,
    density,
    toggles,
    isRunning: !prefersReducedMotion && !userPaused,
    isVisible,
    setPaletteKey,
    setSpeed,
    setBrightness,
    setDensity,
    setToggle,
    setUserPaused,
    setVisible,
    restoreDefaults,
  };
}
