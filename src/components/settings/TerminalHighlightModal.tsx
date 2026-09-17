/*
 * Modal dialog for creating and editing terminal keyword highlight rules.
 * Allows choosing the keyword or regex pattern, matching options (case-sensitivity,
 * whole-word matching), color and styling (text color or background fill), and
 * scoping the rule either globally across all hosts or to specific saved hosts.
 */

import { useState, useEffect, useMemo, useRef } from "react";
import {
  Highlighter,
  Check,
  Search,
  CheckSquare,
  Square,
  AlertCircle,
} from "lucide-react";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";
import { useHostsStore } from "../../stores/hosts-store";
import type {
  TerminalHighlightRule,
  HighlightStyle,
  HighlightScope,
} from "../../types";
import { isLightColor } from "../../lib/terminal-highlighter";

export const HIGHLIGHT_COLOR_PRESETS = [
  { name: "Red", hex: "#ef4444" },
  { name: "Orange", hex: "#f97316" },
  { name: "Amber", hex: "#f59e0b" },
  { name: "Green", hex: "#22c55e" },
  { name: "Cyan", hex: "#06b6d4" },
  { name: "Blue", hex: "#3b82f6" },
  { name: "Purple", hex: "#a855f7" },
  { name: "Pink", hex: "#ec4899" },
];

interface TerminalHighlightModalProps {
  open: boolean;
  initial?: TerminalHighlightRule | null;
  onClose: () => void;
  onSave: (rule: Omit<TerminalHighlightRule, "id"> & { id?: string }) => void;
}

const FIELD_LABEL_CLASS = "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1.5";
const INPUT_CLASS = [
  "w-full px-3 py-2 rounded-lg text-[length:var(--text-sm)]",
  "bg-bg-base border border-border text-text-primary placeholder:text-text-muted",
  "outline-none focus:border-border-focus focus:ring-2 focus:ring-ring",
  "transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
].join(" ");

export function TerminalHighlightModal({
  open,
  initial,
  onClose,
  onSave,
}: TerminalHighlightModalProps) {
  const hosts = useHostsStore((s) => s.hosts);

  const [pattern, setPattern] = useState("");
  const [color, setColor] = useState(HIGHLIGHT_COLOR_PRESETS[0].hex);
  const [style, setStyle] = useState<HighlightStyle>("text");
  const [scope, setScope] = useState<HighlightScope>("global");
  const [selectedHostIds, setSelectedHostIds] = useState<string[]>([]);
  const [matchCase, setMatchCase] = useState(false);
  const [matchWholeWord, setMatchWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [hostSearch, setHostSearch] = useState("");

  const patternInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      if (initial) {
        setPattern(initial.pattern);
        setColor(initial.color || HIGHLIGHT_COLOR_PRESETS[0].hex);
        setStyle(initial.style || "text");
        setScope(initial.scope || "global");
        setSelectedHostIds(initial.hostIds ? [...initial.hostIds] : []);
        setMatchCase(Boolean(initial.matchCase));
        setMatchWholeWord(Boolean(initial.matchWholeWord));
        setIsRegex(Boolean(initial.isRegex));
      } else {
        setPattern("");
        setColor(HIGHLIGHT_COLOR_PRESETS[0].hex);
        setStyle("text");
        setScope("global");
        setSelectedHostIds([]);
        setMatchCase(false);
        setMatchWholeWord(false);
        setIsRegex(false);
      }
      setHostSearch("");
      requestAnimationFrame(() => patternInputRef.current?.focus());
    }
  }, [open, initial]);

  // Validate regex if regex option is enabled
  const regexError = useMemo(() => {
    if (!isRegex || !pattern.trim()) return null;
    try {
      new RegExp(pattern);
      return null;
    } catch (err: unknown) {
      return err instanceof Error ? err.message : "Invalid regular expression";
    }
  }, [isRegex, pattern]);

  // Filtered hosts for per-host selector
  const filteredHosts = useMemo(() => {
    const q = hostSearch.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter(
      (h) =>
        h.label?.toLowerCase().includes(q) ||
        h.host.toLowerCase().includes(q) ||
        h.username.toLowerCase().includes(q),
    );
  }, [hosts, hostSearch]);

  const handleToggleHost = (id: string) => {
    setSelectedHostIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const handleSelectAllHosts = () => {
    setSelectedHostIds(hosts.map((h) => h.id));
  };

  const handleClearAllHosts = () => {
    setSelectedHostIds([]);
  };

  const canSave = Boolean(
    pattern.trim() &&
      !regexError &&
      (scope === "global" || selectedHostIds.length > 0),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;

    onSave({
      ...(initial?.id ? { id: initial.id } : {}),
      pattern: pattern.trim(),
      color,
      style,
      scope,
      hostIds: scope === "hosts" ? selectedHostIds : [],
      matchCase,
      matchWholeWord,
      isRegex,
      enabled: initial?.enabled ?? true,
    });
    onClose();
  };

  // Preview styling calculation
  const previewSampleText = pattern.trim() || "sample";
  const previewFg =
    style === "background"
      ? isLightColor(color)
        ? "#000000"
        : "#ffffff"
      : color;
  const previewBg = style === "background" ? color : "transparent";

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title={initial ? "Edit Keyword Highlight" : "New Keyword Highlight"}
      icon={Highlighter}
      maxWidth="xl"
      scrollable
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className={BTN_GHOST}
            data-testid="highlight-modal-cancel"
          >
            Cancel
          </button>
          <button
            form="terminal-highlight-form"
            type="submit"
            disabled={!canSave}
            className={BTN_PRIMARY}
            data-testid="highlight-modal-save"
          >
            {initial ? "Save Changes" : "Add Highlight"}
          </button>
        </>
      }
    >
      <form
        id="terminal-highlight-form"
        onSubmit={handleSubmit}
        className="flex flex-col gap-4"
      >
        {/* Pattern input */}
        <div>
          <label htmlFor="hl-pattern" className={FIELD_LABEL_CLASS}>
            Word or Pattern <span className="text-status-error">*</span>
          </label>
          <input
            id="hl-pattern"
            ref={patternInputRef}
            data-testid="hl-pattern-input"
            type="text"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="e.g. ERROR, WARNING, 192.168.1.1"
            className={INPUT_CLASS}
          />
          {regexError && (
            <p className="flex items-center gap-1 mt-1 text-[length:var(--text-xs)] text-status-error">
              <AlertCircle size={13} className="shrink-0" />
              {regexError}
            </p>
          )}
        </div>

        {/* Matching options */}
        <div>
          <span className={FIELD_LABEL_CLASS}>Match Options</span>
          <div className="flex items-center gap-5 flex-wrap">
            <label className="flex items-center gap-2 cursor-pointer text-[length:var(--text-sm)] text-text-primary">
              <input
                type="checkbox"
                data-testid="hl-match-case"
                checked={matchCase}
                onChange={(e) => setMatchCase(e.target.checked)}
                className="w-4 h-4 rounded border-border text-accent focus:ring-ring"
              />
              Match case
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-[length:var(--text-sm)] text-text-primary">
              <input
                type="checkbox"
                data-testid="hl-whole-word"
                checked={matchWholeWord}
                onChange={(e) => setMatchWholeWord(e.target.checked)}
                disabled={isRegex}
                className="w-4 h-4 rounded border-border text-accent focus:ring-ring disabled:opacity-50"
              />
              <span className={isRegex ? "text-text-muted" : undefined}>
                Whole word
              </span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer text-[length:var(--text-sm)] text-text-primary">
              <input
                type="checkbox"
                data-testid="hl-is-regex"
                checked={isRegex}
                onChange={(e) => setIsRegex(e.target.checked)}
                className="w-4 h-4 rounded border-border text-accent focus:ring-ring"
              />
              Regular expression
            </label>
          </div>
        </div>

        {/* Highlight Style & Color */}
        <div className="grid grid-cols-1 sm:grid-cols-[auto_minmax(0,1fr)] gap-4 items-start">
          <div className="min-w-0">
            <span className={FIELD_LABEL_CLASS}>Highlight Style</span>
            <div className="inline-grid grid-cols-2 gap-1 p-1 rounded-lg bg-bg-base border border-border">
              <button
                type="button"
                data-testid="hl-style-text"
                onClick={() => setStyle("text")}
                className={[
                  "px-3 py-1.5 rounded-md text-center text-[length:var(--text-sm)] font-medium whitespace-nowrap",
                  "transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  style === "text"
                    ? "bg-bg-overlay text-text-primary shadow-[var(--shadow-sm)]"
                    : "text-text-muted hover:text-text-primary",
                ].join(" ")}
              >
                Text Color
              </button>
              <button
                type="button"
                data-testid="hl-style-background"
                onClick={() => setStyle("background")}
                className={[
                  "px-3 py-1.5 rounded-md text-center text-[length:var(--text-sm)] font-medium whitespace-nowrap",
                  "transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  style === "background"
                    ? "bg-bg-overlay text-text-primary shadow-[var(--shadow-sm)]"
                    : "text-text-muted hover:text-text-primary",
                ].join(" ")}
              >
                Background Fill
              </button>
            </div>
          </div>

          <div className="min-w-0">
            <span className={FIELD_LABEL_CLASS}>Highlight Color</span>
            <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
              {HIGHLIGHT_COLOR_PRESETS.map((preset) => {
                const selected = color.toLowerCase() === preset.hex.toLowerCase();
                return (
                  <button
                    key={preset.hex}
                    type="button"
                    title={preset.name}
                    aria-label={preset.name}
                    data-testid={`hl-color-${preset.name.toLowerCase()}`}
                    onClick={() => setColor(preset.hex)}
                    className={[
                      "relative flex items-center justify-center w-7 h-7 rounded-full shrink-0",
                      "transition-transform duration-[var(--duration-fast)] hover:scale-110",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    ].join(" ")}
                    style={{
                      backgroundColor: preset.hex,
                      boxShadow: selected
                        ? `0 0 0 2px var(--color-bg-surface), 0 0 0 4px ${preset.hex}`
                        : undefined,
                    }}
                  >
                    {selected && (
                      <Check size={14} strokeWidth={3} className="text-white drop-shadow" />
                    )}
                  </button>
                );
              })}

              {/* Custom hex color input */}
              <div className="relative flex items-center ml-1">
                <input
                  type="color"
                  value={color.startsWith("#") && color.length === 7 ? color : "#ef4444"}
                  onChange={(e) => setColor(e.target.value)}
                  className="w-7 h-7 rounded-full cursor-pointer border-0 p-0 bg-transparent"
                  title="Pick custom color"
                  aria-label="Pick custom color"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Live Preview Box */}
        <div>
          <span className={FIELD_LABEL_CLASS}>Live Preview</span>
          <div className="p-3 rounded-lg bg-[#18181b] border border-border text-[#e4e4e7] font-mono text-[13px] leading-relaxed select-none">
            <span className="text-[#71717a]">[12:34:56]</span> output line containing{" "}
            <span
              data-testid="hl-preview-text"
              style={{
                color: previewFg,
                backgroundColor: previewBg,
                padding: style === "background" ? "1px 4px" : undefined,
                borderRadius: style === "background" ? "3px" : undefined,
                fontWeight: 600,
              }}
            >
              {previewSampleText}
            </span>{" "}
            in terminal.
          </div>
        </div>

        {/* Scope: Global vs Per Host */}
        <div>
          <span className={FIELD_LABEL_CLASS}>Scope</span>
          <div className="inline-grid grid-cols-2 w-full gap-1 p-1 rounded-lg bg-bg-base border border-border mb-2.5">
            <button
              type="button"
              data-testid="hl-scope-global"
              onClick={() => setScope("global")}
              className={[
                "px-3 py-1.5 rounded-md text-center text-[length:var(--text-sm)] font-medium",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                scope === "global"
                  ? "bg-bg-overlay text-text-primary shadow-[var(--shadow-sm)]"
                  : "text-text-muted hover:text-text-primary",
              ].join(" ")}
            >
              All Hosts (Global)
            </button>
            <button
              type="button"
              data-testid="hl-scope-hosts"
              onClick={() => setScope("hosts")}
              className={[
                "px-3 py-1.5 rounded-md text-center text-[length:var(--text-sm)] font-medium",
                "transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                scope === "hosts"
                  ? "bg-bg-overlay text-text-primary shadow-[var(--shadow-sm)]"
                  : "text-text-muted hover:text-text-primary",
              ].join(" ")}
            >
              Specific Hosts
            </button>
          </div>

          {/* Host list selector when scope is per-hosts */}
          {scope === "hosts" && (
            <div className="flex flex-col gap-2 p-3 rounded-xl bg-bg-surface border border-border/60">
              <div className="flex items-center justify-between gap-2">
                <div className="relative flex-1">
                  <Search
                    size={14}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
                  />
                  <input
                    type="text"
                    value={hostSearch}
                    onChange={(e) => setHostSearch(e.target.value)}
                    placeholder="Search saved hosts…"
                    className="w-full pl-8 pr-2.5 py-1.5 rounded-lg text-[length:var(--text-xs)] bg-bg-base border border-border text-text-primary outline-none focus:border-border-focus"
                  />
                </div>
                <div className="flex items-center gap-1.5 shrink-0 text-[length:var(--text-xs)]">
                  <button
                    type="button"
                    onClick={handleSelectAllHosts}
                    className="px-2 py-1 rounded text-text-secondary hover:text-text-primary hover:bg-bg-overlay"
                  >
                    Select all
                  </button>
                  <span className="text-text-muted">/</span>
                  <button
                    type="button"
                    onClick={handleClearAllHosts}
                    className="px-2 py-1 rounded text-text-secondary hover:text-text-primary hover:bg-bg-overlay"
                  >
                    Clear
                  </button>
                </div>
              </div>

              {hosts.length === 0 ? (
                <p className="text-[length:var(--text-xs)] text-text-muted text-center py-4">
                  No saved hosts found. Add hosts in the dashboard first.
                </p>
              ) : (
                <div className="max-h-40 overflow-y-auto flex flex-col gap-1 pr-1">
                  {filteredHosts.map((host) => {
                    const checked = selectedHostIds.includes(host.id);
                    return (
                      <label
                        key={host.id}
                        data-testid={`hl-host-checkbox-${host.id}`}
                        className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg hover:bg-bg-overlay/50 cursor-pointer text-[length:var(--text-sm)] transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggleHost(host.id)}
                          className="sr-only"
                        />
                        {checked ? (
                          <CheckSquare size={16} className="text-accent shrink-0" />
                        ) : (
                          <Square size={16} className="text-text-muted shrink-0" />
                        )}
                        <span className="font-medium text-text-primary truncate">
                          {host.label || host.host}
                        </span>
                        <span className="text-[length:var(--text-xs)] text-text-muted truncate ml-auto">
                          {host.username}@{host.host}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              <p className="text-[length:var(--text-xs)] text-text-muted">
                {selectedHostIds.length}{" "}
                {selectedHostIds.length === 1 ? "host" : "hosts"} selected.
                {selectedHostIds.length === 0 && (
                  <span className="text-status-error ml-1">
                    Select at least one host.
                  </span>
                )}
              </p>
            </div>
          )}
        </div>
      </form>
    </ModalShell>
  );
}
