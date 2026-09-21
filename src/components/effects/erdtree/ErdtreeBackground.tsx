/*
 * Erdtree theme background: golden motes, runes and god-rays rendered by the
 * shared effect framework, with a gnarled tree watermark layered above the
 * canvas. The watermark is the framework's `overlay` render prop so it can be
 * toggled off from the controls panel. See erdtree-def.ts for the effect.
 */

import { EffectTheme } from "../EffectTheme";
import type { EffectControls } from "../types";
import { ERDTREE_DEF } from "./erdtree-def";
import { TreeWatermark } from "./TreeWatermark";

/** Watermark stroke colour follows the active palette (via `currentColor`). */
const WATERMARK_TEXT: Record<string, string> = {
  erdtree: "text-[#e0b040]",
  grace: "text-[#e8d192]",
  rot: "text-[#b8433a]",
  night: "text-[#8fa8e0]",
};

export function ErdtreeBackground() {
  return (
    <EffectTheme
      def={ERDTREE_DEF}
      overlay={(controls: EffectControls) =>
        controls.toggles.tree !== false ? (
          <TreeWatermark
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[34vmin] h-[44vmin] ${
              WATERMARK_TEXT[controls.paletteKey] ?? WATERMARK_TEXT.erdtree
            }`}
            opacity={0.2}
            pulse={controls.isRunning}
          />
        ) : null
      }
    />
  );
}
