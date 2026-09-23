import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Lightbulb, X } from "lucide-react";
import { useSettingsStore } from "../../stores/settings-store";
import { useToastStore } from "../../stores/toast-store";
import { useUpdaterStore } from "../../stores/updater-store";
import { TIPS } from "./tips";

/* Delay before the card appears after launch, so startup toasts and the
 * update-announce modal get the corner to themselves first. */
const SHOW_DELAY_MS = 3000;

/*
 * Bottom-right tip card, shown once per app launch but fully browsable: the
 * prev/next arrows step through the whole tip list (wrapping around) so the
 * user can read more than one. Waits for settings to load, starts at the
 * persisted rotation index (and advances it immediately so the next launch
 * rotates), then reveals itself after a short delay. It hides while toasts
 * occupy the same corner and while the update announcement modal is open.
 *
 * Mounted at the AppShell ROOT level with z-[45]: the theme controls badge is
 * a `z-40` fixed element also at root level (rendered by the effect
 * backgrounds), and anything inside the app container (`relative z-10`) can
 * never stack above it — the container's z-index caps its children. z-[45]
 * clears the badge while staying below the root-level vault prompt (z-50).
 */
export function TipPopup() {
  const loaded = useSettingsStore((s) => s.loaded);
  const toastCount = useToastStore((s) => s.toasts.length);
  const announceOpen = useUpdaterStore((s) => s.announceOpen);

  const [cursor, setCursor] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const started = useRef(false);

  // Capture the starting tip + advance the rotation pointer exactly once per
  // mount (the ref guards React strict-mode's double-invoked effects).
  useEffect(() => {
    if (!loaded || started.current) return;
    started.current = true;
    const { tipIndex, setTipIndex } = useSettingsStore.getState();
    setCursor(tipIndex % TIPS.length);
    setTipIndex(tipIndex + 1);
    const timer = setTimeout(() => setReady(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loaded]);

  // Session-local browsing only — the persisted pointer already advanced at
  // show time, so next launch rotates regardless of how much the user browses.
  const step = (delta: number) =>
    setCursor((c) => (c === null ? c : (c + delta + TIPS.length) % TIPS.length));

  if (!ready || dismissed || cursor === null) return null;
  if (toastCount > 0 || announceOpen) return null;
  const tip = TIPS[cursor];

  const navBtn =
    "p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

  return (
    <div
      data-testid="tip-popup"
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[45] w-[22rem] max-w-sm px-3.5 py-3 rounded-xl bg-bg-overlay border border-border shadow-[var(--shadow-lg)] animate-in fade-in-0 slide-in-from-bottom-2 duration-[var(--duration-fast)] no-select"
    >
      <div className="flex items-start gap-2.5">
        <div className="flex items-center justify-center w-6 h-6 rounded-lg bg-accent/10 shrink-0 mt-0.5">
          <Lightbulb size={13} strokeWidth={1.8} className="text-accent" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[length:var(--text-xs)] font-semibold uppercase tracking-wide text-text-muted">
            Did you know?
          </p>
          <p className="mt-1 text-[length:var(--text-sm)] font-medium text-text-primary">
            {tip.title}
          </p>
          <p className="mt-0.5 text-[length:var(--text-sm)] text-text-secondary leading-relaxed">
            {tip.body}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss tip"
          data-testid="tip-dismiss"
          className="shrink-0 -mr-1 -mt-0.5 p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Prev/next browsing footer with a position counter */}
      <div className="mt-2.5 pt-2.5 border-t border-border/60 flex items-center justify-between">
        <span
          data-testid="tip-counter"
          className="text-[length:var(--text-2xs)] text-text-muted tabular-nums"
        >
          Tip {cursor + 1} / {TIPS.length}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label="Previous tip"
            data-testid="tip-prev"
            className={navBtn}
          >
            <ChevronLeft size={14} strokeWidth={2} />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label="Next tip"
            data-testid="tip-next"
            className={navBtn}
          >
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
