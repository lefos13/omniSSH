/*
 * Composing shell for an effect theme.
 *
 * Wires the two framework hooks together — persisted control state and the
 * canvas lifecycle — and renders the fixed canvas layer plus the controls panel.
 * A theme component is therefore just `<EffectTheme def={MY_DEF} />`, optionally
 * with an `overlay` node (e.g. Erdtree's tree watermark).
 */

import type { ReactNode } from "react";
import type { EffectControls, EffectDefinition } from "./types";
import { EffectControlsPanel } from "./EffectControlsPanel";
import { useCanvasEffect } from "./useCanvasEffect";
import { useEffectControls } from "./useEffectControls";

export function EffectTheme<S>({
  def,
  overlay,
}: {
  def: EffectDefinition<S>;
  /** Static node, or a render prop that can react to control state (e.g. toggles). */
  overlay?: ReactNode | ((controls: EffectControls) => ReactNode);
}) {
  const controls = useEffectControls(def);
  const canvasRef = useCanvasEffect(def, controls);

  return (
    <>
      <div
        className={`fixed inset-0 pointer-events-none z-0 overflow-hidden select-none transition-opacity duration-500 ${
          controls.isVisible ? "opacity-100" : "opacity-0"
        }`}
        style={{ backgroundColor: def.backgroundColor }}
        aria-hidden="true"
      >
        <canvas ref={canvasRef} className="w-full h-full block" />
        {typeof overlay === "function" ? overlay(controls) : overlay}
      </div>
      <EffectControlsPanel def={def} controls={controls} />
    </>
  );
}
