/*
 * Volumetric light shafts ("god rays") for the effect themes.
 *
 * Each shaft is rendered as a converging wedge: it originates at a small, tightly
 * focused source (like sunlight through a canopy) and widens with distance. The
 * beam is split into lateral strips whose opacity follows a bell curve, which
 * softens both edges, and a length-wise gradient fades the tip out. This replaces
 * the flat rotated-rectangle approach, which read as floating squares.
 *
 * Implementation notes: the length gradient is built once per shaft and reused by
 * every strip — only `globalAlpha` varies between strips — so a shaft costs one
 * gradient plus N cheap fills.
 */

export interface LightShaft {
  /** Apex (source) position — typically above the viewport. */
  x: number;
  y: number;
  /** Direction from the apex in radians, measured from straight down. */
  angle: number;
  /** Distance from the apex to the far tip. */
  length: number;
  /** Half-width of the beam at its far tip. */
  halfWidth: number;
  /** Peak opacity at the beam's core. */
  alpha: number;
}

export interface LightShaftStyle {
  color: string;
  brightness: number;
  /** Lateral strips used to soften the beam edges. More = smoother, slower. */
  strips?: number;
  /** Fraction of the tip half-width at the apex (small = tightly focused source). */
  focus?: number;
  /** Additive blending, for light over a dark background. Defaults to true. */
  additive?: boolean;
  /** Extra multiplier applied to every shaft's alpha. */
  alphaScale?: number;
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function drawLightShafts(
  ctx: CanvasRenderingContext2D,
  shafts: LightShaft[],
  style: LightShaftStyle
): void {
  if (shafts.length === 0) return;

  const strips = style.strips ?? 9;
  const focus = style.focus ?? 0.06;
  const alphaScale = style.alphaScale ?? 1;

  ctx.save();
  ctx.globalCompositeOperation = style.additive === false ? "source-over" : "lighter";

  for (const shaft of shafts) {
    const dirX = Math.sin(shaft.angle);
    const dirY = Math.cos(shaft.angle);
    const perpX = Math.cos(shaft.angle);
    const perpY = -Math.sin(shaft.angle);

    const tipX = shaft.x + dirX * shaft.length;
    const tipY = shaft.y + dirY * shaft.length;

    // Shared length-wise falloff: solid through the body, fading near the tip.
    const gradient = ctx.createLinearGradient(shaft.x, shaft.y, tipX, tipY);
    gradient.addColorStop(0, style.color);
    gradient.addColorStop(0.72, style.color);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;

    for (let i = 0; i < strips; i++) {
      const a0 = i / strips - 0.5;
      const a1 = (i + 1) / strips - 0.5;
      const center = (a0 + a1) / 2;
      // Bell curve across the beam width -> bright core, feathered edges.
      const bell = Math.pow(Math.cos(center * Math.PI), 1.5);
      const alpha = clamp01(shaft.alpha * bell * style.brightness * 2 * alphaScale);
      if (alpha <= 0.001) continue;

      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(
        shaft.x + perpX * a0 * shaft.halfWidth * focus,
        shaft.y + perpY * a0 * shaft.halfWidth * focus
      );
      ctx.lineTo(
        shaft.x + perpX * a1 * shaft.halfWidth * focus,
        shaft.y + perpY * a1 * shaft.halfWidth * focus
      );
      ctx.lineTo(tipX + perpX * a1 * shaft.halfWidth, tipY + perpY * a1 * shaft.halfWidth);
      ctx.lineTo(tipX + perpX * a0 * shaft.halfWidth, tipY + perpY * a0 * shaft.halfWidth);
      ctx.closePath();
      ctx.fill();
    }
  }

  ctx.restore();
}
