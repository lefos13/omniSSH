import { useState, useRef, useEffect, useMemo, useId } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check, Search } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "data-testid"?: string;
  /** When true, each dropdown option renders in its own `value` as a CSS
   *  font-family — a live preview for font pickers (like a text editor's font
   *  list). Only the list items preview; the trigger keeps the UI font. Set
   *  this only when every option's `value` is a valid font-family stack. */
  previewOptionFont?: boolean;
  /** Renders a filter box at the top of the dropdown. Use for long option
   *  lists (e.g. the explorer's host picker). */
  searchable?: boolean;
  searchPlaceholder?: string;
}

export function CustomSelect({
  value,
  options,
  onChange,
  placeholder = "Select...",
  disabled,
  className,
  id,
  "aria-label": ariaLabel,
  "data-testid": testid,
  previewOptionFont,
  searchable = false,
  searchPlaceholder = "Search...",
}: CustomSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [query, setQuery] = useState("");
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number; maxWidth: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder;

  // Options narrowed by the search box. Keyboard navigation and rendering must
  // both walk this list, not the raw one.
  const visibleOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchable || !q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, searchable, query]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // The panel is portaled out of the root, so both are valid "inside".
      if (panelRef.current?.contains(target) || rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape (capture so nested modals don't consume it first)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open]);

  // Focus the filter box as soon as a searchable dropdown opens.
  useEffect(() => {
    if (open && searchable) searchRef.current?.focus();
  }, [open, searchable]);

  // Reset the filter each time the dropdown opens.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || highlightIndex < 0 || !listRef.current) return;
    const item = listRef.current.children[highlightIndex] as HTMLElement;
    item?.scrollIntoView({ block: "nearest" });
  }, [open, highlightIndex]);

  const computePos = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        maxWidth: Math.max(rect.width, window.innerWidth - rect.left - 16),
      });
    }
  };

  const select = (option: SelectOption | undefined) => {
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveHighlight = (delta: number) => {
    setHighlightIndex((prev) => {
      if (visibleOptions.length === 0) return -1;
      if (prev < 0) return delta > 0 ? 0 : visibleOptions.length - 1;
      return Math.min(Math.max(prev + delta, 0), visibleOptions.length - 1);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (!open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
      e.preventDefault();
      computePos();
      setOpen(true);
      setHighlightIndex(options.findIndex((o) => o.value === value));
      return;
    }

    if (!open) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      // With a filter narrowed to one match, Enter should pick it without
      // requiring an explicit highlight first.
      if (highlightIndex >= 0 && highlightIndex < visibleOptions.length) {
        select(visibleOptions[highlightIndex]);
      } else if (visibleOptions.length === 1) {
        select(visibleOptions[0]);
      }
    }
  };

  // Same navigation, driven from the filter input.
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < visibleOptions.length) {
        select(visibleOptions[highlightIndex]);
      } else if (visibleOptions.length === 1) {
        select(visibleOptions[0]);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Escape clears the filter first, then closes on a second press.
      if (query) {
        setQuery("");
        setHighlightIndex(-1);
      } else {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className ?? ""}`}>
      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        data-testid={testid}
        data-value={value}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            if (!open) computePos();
            setOpen(!open);
            if (!open) setHighlightIndex(options.findIndex((o) => o.value === value));
          }
        }}
        onKeyDown={handleKeyDown}
        className={[
          "w-full flex items-center justify-between gap-2",
          "rounded-lg bg-bg-base border border-border px-3 py-2",
          "text-[length:var(--text-sm)] text-left",
          "outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
          "focus:border-border-focus focus:ring-2 focus:ring-ring",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          open ? "border-border-focus ring-2 ring-ring" : "",
        ].join(" ")}
      >
        <span className={selectedOption ? "text-text-primary truncate" : "text-text-muted truncate"}>
          {displayLabel}
        </span>
        <ChevronDown
          size={15}
          strokeWidth={2}
          className={[
            "text-text-muted shrink-0 transition-transform duration-[var(--duration-fast)]",
            open ? "rotate-180" : "",
          ].join(" ")}
          aria-hidden="true"
        />
      </button>

      {/* Dropdown — portaled to body to escape transform/overflow ancestors.
          The panel (not just the list) is the outside-click boundary so the
          search box counts as inside. */}
      {open && dropdownPos && createPortal(
        <div
          ref={panelRef}
          style={{ top: dropdownPos.top, left: dropdownPos.left, minWidth: dropdownPos.width, maxWidth: dropdownPos.maxWidth }}
          className={[
            "fixed z-[100] w-max flex flex-col",
            "bg-bg-overlay border border-border rounded-lg",
            "shadow-[var(--shadow-lg)]",
            "py-1",
            "animate-[fadeIn_80ms_var(--ease-expo-out)_both]",
          ].join(" ")}
        >
          {searchable && (
            <div className="relative shrink-0 px-2 pb-1.5 mb-1 border-b border-border/50">
              <Search
                size={13}
                strokeWidth={2}
                className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
                aria-hidden="true"
              />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlightIndex(-1);
                }}
                onKeyDown={handleSearchKeyDown}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                aria-controls={listboxId}
                autoComplete="off"
                spellCheck={false}
                data-testid={testid ? `${testid}-search` : undefined}
                className={[
                  "w-full pl-6 pr-2 py-1 rounded",
                  "bg-bg-base border border-border text-text-primary placeholder:text-text-muted",
                  "text-[length:var(--text-sm)] outline-none",
                  "focus:border-border-focus focus:ring-1 focus:ring-ring",
                ].join(" ")}
              />
            </div>
          )}

          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-[200px] overflow-y-auto"
          >
            {visibleOptions.map((option, index) => {
              const isSelected = option.value === value;
              const isHighlighted = index === highlightIndex;

              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-testid={testid ? `${testid}-option-${option.value}` : undefined}
                  onClick={() => select(option)}
                  onMouseEnter={() => setHighlightIndex(index)}
                  className={[
                    "w-full flex items-center gap-2 px-3 py-1.5 text-left",
                    "text-[length:var(--text-sm)] transition-colors duration-[var(--duration-fast)]",
                    isHighlighted ? "bg-bg-subtle" : "",
                    isSelected ? "text-accent font-medium" : "text-text-primary",
                  ].join(" ")}
                >
                  <span className="w-4 shrink-0">
                    {isSelected && <Check size={14} strokeWidth={2.5} className="text-accent" />}
                  </span>
                  <span
                    className="truncate"
                    style={previewOptionFont ? { fontFamily: option.value } : undefined}
                  >
                    {option.label}
                  </span>
                </button>
              );
            })}

            {visibleOptions.length === 0 && (
              <p className="px-3 py-2 text-[length:var(--text-sm)] text-text-muted">
                No matches
              </p>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
