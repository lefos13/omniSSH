/*
 * Fog theme background: drifting volumetric fog with grain and vignette, rendered
 * by the shared effect framework. See fog-def.ts for the effect itself.
 */

import { EffectTheme } from "../EffectTheme";
import { FOG_DEF } from "./fog-def";

export function FogBackground() {
  return <EffectTheme def={FOG_DEF} />;
}
