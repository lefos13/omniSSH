/*
 * Sakura theme background: drifting cherry petals over a soft light base,
 * rendered by the shared effect framework. See sakura-def.ts for the effect.
 */

import { EffectTheme } from "../EffectTheme";
import { SAKURA_DEF } from "./sakura-def";

export function SakuraBackground() {
  return <EffectTheme def={SAKURA_DEF} />;
}
