/*
 * BrandSigil renders a stylized, original angular rune — a faint watermark mark
 * evoking dark-fantasy "brand" iconography. It pulses slowly via the
 * `berserk-sigil-pulse` keyframes in theme.css, which are disabled automatically
 * under prefers-reduced-motion. The geometry is original vector art, not a
 * reproduction of any specific published symbol.
 */

interface BrandSigilProps {
  /** Extra classes for sizing/positioning/colour (uses `currentColor`). */
  className?: string;
  /** Base watermark opacity, multiplied by the internal pulse. */
  opacity?: number;
  /** Whether to run the slow glow/pulse animation. */
  pulse?: boolean;
}

export function BrandSigil({ className, opacity = 0.2, pulse = true }: BrandSigilProps) {
  return (
    <svg
      viewBox="0 0 120 160"
      className={className}
      style={{ opacity, filter: "drop-shadow(0 0 12px currentColor)" }}
      data-testid="berserk-brand-sigil"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className={pulse ? "berserk-sigil-anim" : undefined}>
        <path d="M60 14 V146" />
        <path d="M60 14 L38 32" />
        <path d="M60 14 L82 32" />
        <path d="M34 60 L60 42 L86 60" />
        <path d="M34 100 L60 118 L86 100" />
        <path d="M60 146 L40 130" />
        <path d="M60 146 L80 130" />
      </g>
    </svg>
  );
}
