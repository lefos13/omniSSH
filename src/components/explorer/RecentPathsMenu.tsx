/*
 * Recent server paths menu.
 *
 * A dropdown listing the host's most-recently-visited directories so one click
 * navigates there. Used by the remote explorer toolbar (navigate the pane) and
 * the terminal pane header (run `cd` in the shell), both reading the same
 * per-host history.
 *
 * The panel is rendered in a portal so it is not clipped by the toolbar's
 * `overflow-hidden` container.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History } from "lucide-react";
import {
  useRecentPathsStore,
  selectRecentPaths,
  type RecentPathScope,
} from "../../stores/recent-paths-store";

interface RecentPathsMenuProps {
  /** Host identity key from `host-key` helpers. */
  hostKey: string;
  scope?: RecentPathScope;
  /** Called with the chosen path. */
  onSelect: (path: string) => void;
  /** Button styling; pass the surrounding toolbar's icon-button classes. */
  buttonClassName?: string;
  iconSize?: number;
  /** Align the dropdown to the right edge (toolbar) or left (default). */
  align?: "left" | "right";
  label?: string;
  testId?: string;
  disabled?: boolean;
}

export function RecentPathsMenu({
  hostKey,
  scope = "remote",
  onSelect,
  buttonClassName,
  iconSize = 14,
  align = "right",
  label = "Recent paths",
  testId = "recent-paths-menu",
  disabled = false,
}: RecentPathsMenuProps) {
  const [open, setOpen] = useState(false);
  const paths = useRecentPathsStore((s) => selectRecentPaths(s, hostKey, scope));
  const load = useRecentPathsStore((s) => s.load);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left?: number; right?: number }>({
    top: 0,
  });

  // Fetch the persisted list the first time the menu is opened.
  useEffect(() => {
    if (open) void load(hostKey, scope);
  }, [open, hostKey, scope, load]);

  // Anchor the portaled panel to the trigger, re-measuring on resize/scroll.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition(
        align === "right"
          ? { top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) }
          : { top: rect.bottom + 4, left: rect.left },
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        title={label}
        className={
          buttonClassName ??
          "flex items-center justify-center w-7 h-7 rounded-md shrink-0 text-text-muted hover:text-text-secondary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed"
        }
      >
        <History size={iconSize} strokeWidth={1.8} aria-hidden="true" />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            data-testid={`${testId}-list`}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              right: position.right,
            }}
            className="w-64 rounded-md border border-border bg-bg-surface p-1 shadow-xl z-[60]"
          >
            <div className="px-2 py-1.5 border-b border-border/50 mb-1">
              <div className="text-[11px] font-semibold text-text-primary">{label}</div>
            </div>

            {paths.length > 0 ? (
              paths.map((path, index) => (
                <button
                  key={path}
                  type="button"
                  role="menuitem"
                  data-testid={`${testId}-item-${index}`}
                  onClick={() => {
                    setOpen(false);
                    onSelect(path);
                  }}
                  title={path}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-bg-subtle text-text-primary hover:text-accent transition-colors text-[11px] font-mono truncate"
                >
                  {path}
                </button>
              ))
            ) : (
              <p className="px-2 py-1.5 text-[11px] text-text-muted">No recent paths yet.</p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
