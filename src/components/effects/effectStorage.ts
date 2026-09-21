/*
 * localStorage helpers for effect-theme preferences. Keys follow the existing
 * convention used by the Matrix and Berserk effects (`<id>_theme_<field>`) so
 * persisted preferences stay predictable and testable across themes.
 */

export interface EffectStorageKeys {
  palette: string;
  speed: string;
  brightness: string;
  density: string;
  toggle: (key: string) => string;
}

export function createStorageKeys(id: string): EffectStorageKeys {
  return {
    palette: `${id}_theme_palette`,
    speed: `${id}_theme_speed`,
    brightness: `${id}_theme_brightness`,
    density: `${id}_theme_density`,
    toggle: (key: string) => `${id}_theme_${key}`,
  };
}

export function getStoredValue<T>(key: string, fallback: T): T {
  if (typeof window === "undefined" || !window.localStorage) return fallback;
  try {
    const val = window.localStorage.getItem(key);
    return val !== null ? (JSON.parse(val) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function setStoredValue<T>(key: string, value: T): void {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore storage quota errors */
    }
  }
}
