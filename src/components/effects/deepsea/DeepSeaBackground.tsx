/*
 * Deep Sea theme background: an abyssal bubble/bioluminescence scene rendered
 * by the shared effect framework. See deepsea-def.ts for the effect itself.
 */

import { EffectTheme } from "../EffectTheme";
import { DEEPSEA_DEF } from "./deepsea-def";

export function DeepSeaBackground() {
  return <EffectTheme def={DEEPSEA_DEF} />;
}
