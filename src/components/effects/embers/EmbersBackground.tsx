/*
 * Embers theme background: a rising ember field and radiant glow line
 * rendered by the shared effect framework. See embers-def.ts for the effect itself.
 */

import { EffectTheme } from "../EffectTheme";
import { EMBERS_DEF } from "./embers-def";

export function EmbersBackground() {
  return <EffectTheme def={EMBERS_DEF} />;
}
