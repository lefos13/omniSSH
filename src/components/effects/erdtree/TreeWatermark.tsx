/*
 * TreeWatermark renders a stylized, original gnarled great-tree silhouette — a
 * faint watermark mark evoking golden-order iconography. It pulses slowly via the
 * `erdtree-tree-pulse` keyframes in theme.css, which are disabled automatically
 * under prefers-reduced-motion. The geometry is original vector art.
 */

interface TreeWatermarkProps {
  /** Extra classes for sizing/positioning/colour (uses `currentColor`). */
  className?: string;
  /** Base watermark opacity, multiplied by the internal pulse. */
  opacity?: number;
  /** Whether to run the slow glow/pulse animation. */
  pulse?: boolean;
}

export function TreeWatermark({ className, opacity = 0.2, pulse = true }: TreeWatermarkProps) {
  return (
    <svg
      viewBox="0 0 200 260"
      className={className}
      style={{ opacity, filter: "drop-shadow(0 0 14px currentColor)" }}
      data-testid="erdtree-watermark"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <g className={pulse ? "erdtree-tree-anim" : undefined}>
        {/* Trunk and root flare */}
        <path d="M100 22 V196" />
        <path d="M100 196 C86 202 74 214 62 236" />
        <path d="M100 196 C114 202 126 214 138 236" />
        <path d="M100 196 C96 212 90 226 82 244" />
        <path d="M100 196 C104 212 110 226 118 244" />
        {/* Lower branches */}
        <path d="M100 150 C82 140 66 132 46 130" />
        <path d="M100 150 C118 140 134 132 154 130" />
        <path d="M100 118 C88 106 74 96 56 88" />
        <path d="M100 118 C112 106 126 96 144 88" />
        {/* Upper branches */}
        <path d="M100 78 C92 60 84 48 70 38" />
        <path d="M100 78 C108 60 116 48 130 38" />
        {/* Canopy arcs */}
        <path d="M46 130 C40 112 48 96 56 88" />
        <path d="M154 130 C160 112 152 96 144 88" />
        <path d="M56 88 C58 68 64 52 70 38" />
        <path d="M144 88 C142 68 136 52 130 38" />
        <path d="M70 38 C82 24 118 24 130 38" />
      </g>
    </svg>
  );
}
