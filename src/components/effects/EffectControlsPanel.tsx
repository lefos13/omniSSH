/*
 * Generic floating controls panel for effect themes.
 *
 * Renders the bottom-right pill + expandable panel from an `EffectDefinition`'s
 * `ControlSpec`, so every theme gets identical play/pause, visibility, dimmer,
 * density, velocity, palette, toggle, and restore-defaults behaviour. Styling
 * mirrors the original Matrix/Berserk panels exactly, and test-ids follow the
 * existing `<id>-<element>` convention so tests and E2E flows stay consistent.
 */

import { useState } from "react";
import { Palette as PaletteIcon, Play, Pause, Sliders, Eye, EyeOff, Sun, X, RotateCcw } from "lucide-react";
import type { Density, EffectControls, EffectDefinition, SpeedMultiplier } from "./types";

const SELECTED_CHIP = "bg-accent/20 text-accent border-accent/50 font-bold";
const UNSELECTED_CHIP =
  "bg-bg-base/80 border-border/60 text-text-secondary hover:text-text-primary hover:bg-bg-subtle";

function speedLabel(speed: SpeedMultiplier): string {
  if (speed === 0.6) return "0.6x";
  if (speed === 1.6) return "1.6x";
  return "1.0x";
}

function speedTestIdSuffix(speed: SpeedMultiplier): string {
  return speed === 1 ? "1.0" : String(speed);
}

export function EffectControlsPanel<S>({
  def,
  controls,
}: {
  def: EffectDefinition<S>;
  controls: EffectControls;
}) {
  const [controlsOpen, setControlsOpen] = useState(false);
  const id = def.id;
  const spec = def.controls;
  const Icon = def.icon;

  const dimmerPresets = spec.dimmerPresets ?? [];

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end pointer-events-auto select-none">
      {controlsOpen && (
        <div
          className="mb-2 p-3 rounded-xl bg-bg-surface/95 border border-border shadow-2xl backdrop-blur-xl w-64 max-h-[85vh] overflow-y-auto text-xs font-sans text-text-primary"
          role="region"
          aria-label={def.panelLabel}
        >
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/60">
            <span className="font-semibold flex items-center gap-1.5 font-mono text-[length:var(--text-xs)] text-text-primary">
              <Icon className="w-3.5 h-3.5 text-accent" />
              {def.label}
            </span>
            <button
              type="button"
              onClick={() => setControlsOpen(false)}
              className="text-text-muted hover:text-text-primary p-0.5 rounded transition-colors"
              aria-label={`Close ${id} controls`}
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
                data-testid={`${id}-control-play-pause`}
                onClick={() => controls.setUserPaused(controls.isRunning)}
                className={`px-2 py-1 rounded-md flex items-center gap-1 font-mono text-[11px] transition-all border ${
                  controls.isRunning
                    ? "bg-accent/15 text-accent border-accent/30 hover:bg-accent/25"
                    : "bg-bg-subtle text-text-muted border-border hover:bg-bg-muted hover:text-text-primary"
                }`}
                aria-label={controls.isRunning ? `Pause ${id} animation` : `Resume ${id} animation`}
              >
                {controls.isRunning ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                <span>{controls.isRunning ? "Running" : "Paused"}</span>
              </button>

              <button
                type="button"
                data-testid={`${id}-control-visibility`}
                onClick={() => controls.setVisible(!controls.isVisible)}
                className={`p-1 rounded-md transition-all border ${
                  controls.isVisible
                    ? "bg-bg-subtle text-text-secondary border-border hover:text-text-primary"
                    : "bg-status-error/20 text-status-error border-status-error/30"
                }`}
                title={controls.isVisible ? `Hide ${def.label}` : `Show ${def.label}`}
                aria-label={controls.isVisible ? `Hide ${def.label}` : `Show ${def.label}`}
              >
                {controls.isVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
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
                {Math.round(controls.brightness * 100)}%
              </span>
            </div>
            <input
              type="range"
              min="0.2"
              max="1.0"
              step="0.05"
              value={controls.brightness}
              onChange={(e) => controls.setBrightness(parseFloat(e.target.value))}
              data-testid={`${id}-dimmer-slider`}
              aria-label={`${def.label} brightness dimmer`}
              className="w-full h-1.5 bg-bg-base rounded-lg appearance-none cursor-pointer accent-accent"
            />
            {dimmerPresets.length > 0 && (
              <div className="flex justify-between mt-1.5 gap-1 font-mono text-[10px]">
                {dimmerPresets.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    data-testid={`${id}-dimmer-${preset.label.toLowerCase()}`}
                    onClick={() => controls.setBrightness(preset.val)}
                    className={`flex-1 py-0.5 rounded border transition-colors ${
                      Math.abs(controls.brightness - preset.val) < 0.08 ? SELECTED_CHIP : UNSELECTED_CHIP
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Density */}
          {spec.density && spec.density.length > 0 && (
            <div className="py-2 border-t border-border/50 flex items-center justify-between">
              <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                <Sliders className="w-3 h-3 text-accent" />
                Density
              </span>
              <div className="flex gap-1 font-mono text-[10px]">
                {spec.density.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    data-testid={`${id}-density-${option.key}`}
                    onClick={() => controls.setDensity(option.key as Density)}
                    className={`px-2 py-0.5 rounded border transition-colors ${
                      controls.density === option.key ? SELECTED_CHIP : UNSELECTED_CHIP
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Toggles */}
          {spec.toggles?.map((toggle) => {
            const ToggleIcon = toggle.icon;
            const enabled = controls.toggles[toggle.key] === true;
            return (
              <div
                key={toggle.key}
                className="py-2 border-t border-border/50 flex items-center justify-between"
              >
                <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                  <ToggleIcon className="w-3 h-3 text-accent" />
                  {toggle.label}
                </span>
                <button
                  type="button"
                  data-testid={`${id}-control-${toggle.key}`}
                  onClick={() => controls.setToggle(toggle.key, !enabled)}
                  aria-pressed={enabled}
                  aria-label={`Toggle ${toggle.label.toLowerCase()}`}
                  className={`px-2 py-0.5 rounded border font-mono text-[10px] transition-colors ${
                    enabled ? SELECTED_CHIP : UNSELECTED_CHIP
                  }`}
                >
                  {enabled ? "On" : "Off"}
                </button>
              </div>
            );
          })}

          {/* Color Palette Selector */}
          <div className="py-2 border-t border-border/50 mt-1">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                <PaletteIcon className="w-3 h-3 text-accent" />
                Palette
              </span>
              <span className="text-[10px] uppercase font-mono text-accent font-medium">
                {controls.paletteKey}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1 font-mono text-[11px]">
              {spec.palettes.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  data-testid={`${id}-palette-${option.key}`}
                  onClick={() => controls.setPaletteKey(option.key)}
                  className={`px-2 py-1 rounded border text-left flex items-center gap-1.5 transition-colors ${
                    controls.paletteKey === option.key
                      ? "bg-accent/20 border-accent text-text-primary font-semibold"
                      : UNSELECTED_CHIP
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${option.dot} shrink-0`} />
                  <span className="truncate">{option.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Velocity / Speed Control */}
          {spec.speedPresets && spec.speedPresets.length > 0 && (
            <div className="py-2 border-t border-border/50 flex items-center justify-between">
              <span className="text-text-secondary flex items-center gap-1 text-[length:var(--text-xs)]">
                <Sliders className="w-3 h-3 text-accent" />
                Velocity
              </span>
              <div className="flex gap-1 font-mono text-[10px]">
                {spec.speedPresets.map((speed) => (
                  <button
                    key={speed}
                    type="button"
                    data-testid={`${id}-speed-${speedTestIdSuffix(speed)}`}
                    onClick={() => controls.setSpeed(speed)}
                    className={`px-1.5 py-0.5 rounded border transition-colors ${
                      controls.speed === speed ? SELECTED_CHIP : UNSELECTED_CHIP
                    }`}
                  >
                    {speedLabel(speed)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Restore to Defaults */}
          <div className="pt-2 border-t border-border/50 mt-1 flex justify-end">
            <button
              type="button"
              data-testid={`${id}-restore-defaults`}
              onClick={controls.restoreDefaults}
              className="w-full py-1.5 px-2 rounded flex items-center justify-center gap-1.5 font-mono text-[11px] text-text-secondary hover:text-text-primary hover:bg-bg-subtle border border-border/60 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent cursor-pointer"
              aria-label={`Restore default ${id} settings`}
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
        data-testid={`${id}-controls-toggle`}
        onClick={() => setControlsOpen((prev) => !prev)}
        className="group inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-bg-surface/90 hover:bg-bg-overlay border border-accent/40 hover:border-accent shadow-lg shadow-black/60 backdrop-blur-md transition-all text-xs font-mono text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={controlsOpen}
        aria-label={`Toggle ${def.label} effect options`}
      >
        <span className="relative flex h-2 w-2">
          {controls.isRunning && controls.isVisible && (
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
          )}
          <span
            className={`relative inline-flex rounded-full h-2 w-2 ${
              !controls.isVisible ? "bg-text-muted" : controls.isRunning ? "bg-accent" : "bg-amber-400"
            }`}
          />
        </span>
        <span className="text-[11px] font-medium tracking-tight">{def.label}</span>
        <Icon className="w-3 h-3 text-accent" />
      </button>
    </div>
  );
}
