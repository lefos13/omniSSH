/*
 * Starfield theme background: parallax stars, nebula and shooting stars rendered
 * by the shared effect framework. See starfield-def.ts for the effect itself.
 */

import { EffectTheme } from "../EffectTheme";
import { STARFIELD_DEF } from "./starfield-def";

export function StarfieldBackground() {
  return <EffectTheme def={STARFIELD_DEF} />;
}
