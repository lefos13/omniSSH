/*
 * Sakura Night theme background: pale petals and a moon disc over a near-black
 * base, rendered by the shared effect framework. Built from the same variant
 * factory as the light Sakura theme (see sakura-def.ts).
 */

import { EffectTheme } from "../EffectTheme";
import { SAKURA_NIGHT_DEF } from "./sakura-def";

export function SakuraNightBackground() {
  return <EffectTheme def={SAKURA_NIGHT_DEF} />;
}
