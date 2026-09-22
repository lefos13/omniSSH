/*
 * Lava theme background: a volcanic tectonic fissure scene rendered by the shared
 * effect framework. Listens for window pointerdown events to trigger interactive
 * spark bursts at the cursor position. See lava-def.ts for the effect itself.
 */

import { useEffect } from "react";
import { EffectTheme } from "../EffectTheme";
import { LAVA_DEF, triggerLavaBurst, resetActiveLavaScene } from "./lava-def";

export function LavaBackground() {
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      /*
       * Suppress burst animations when users click directly on interactive controls,
       * form inputs, or dialog modals so the effect never competes with desktop UI.
       */
      if (e.target instanceof HTMLElement) {
        if (
          e.target.closest(
            "button, input, select, textarea, [role='dialog'], [role='menu'], [role='listbox']"
          )
        ) {
          return;
        }
      }
      triggerLavaBurst(e.clientX, e.clientY);
    };
    window.addEventListener("pointerdown", handlePointerDown, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      resetActiveLavaScene();
    };
  }, []);

  return <EffectTheme def={LAVA_DEF} />;
}
