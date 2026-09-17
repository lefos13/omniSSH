/*
 * Terminal keyword highlighting engine.
 * Scans active xterm.js buffer lines in the visible viewport for matching words
 * or regular expressions, registering xterm decorations for foreground text or
 * cell background colors. Handles Unicode and wide-character cell offsets,
 * tracks decorations by buffer line to eliminate duplicate registration, and
 * binds to terminal output and scroll events for real-time highlighting.
 */

import type { Terminal as XTerm, IDecoration, IBufferLine } from "@xterm/xterm";
import { useSettingsStore } from "../stores/settings-store";
import { useSessionStore } from "../stores/session-store";
import type { TerminalHighlightRule } from "../types";

export interface MatchRange {
  col: number;
  width: number;
  foregroundColor?: string;
  backgroundColor?: string;
}

/*
 * Escape special regular expression characters for literal string matching.
 */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/*
 * Determine whether a hex color is light or dark to guarantee readable text
 * contrast when rendering background highlight fills.
 */
export function isLightColor(hexColor: string): boolean {
  let hex = hexColor.trim();
  if (hex.startsWith("#")) hex = hex.slice(1);
  if (hex.length === 3) {
    hex = hex.split("").map((c) => c + c).join("");
  }
  if (hex.length >= 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance > 0.55;
    }
  }
  return false;
}

/*
 * Translate a character string offset within a line to its xterm buffer column
 * index, adjusting for wide characters (CJK) and multi-codepoint characters (emojis).
 */
export function stringLengthToBufferSize(line: IBufferLine | undefined, offset: number): number {
  if (offset <= 0) return 0;
  if (!line) return offset;
  let adjusted = offset;
  for (let i = 0; i < adjusted; i++) {
    const cell = line.getCell(i);
    if (!cell) break;
    const chars = cell.getChars();
    if (chars.length > 1) {
      adjusted -= chars.length - 1;
    }
    const nextCell = line.getCell(i + 1);
    if (nextCell && nextCell.getWidth() === 0) {
      adjusted++;
    }
  }
  return adjusted;
}


/*
 * Find all matching decoration ranges for the given text string across a set of rules.
 */
export function findHighlightRanges(
  text: string,
  line: IBufferLine | undefined,
  rules: TerminalHighlightRule[],
): MatchRange[] {
  if (!text || rules.length === 0) return [];
  const ranges: MatchRange[] = [];

  for (const rule of rules) {
    if (!rule.pattern || !rule.pattern.trim()) continue;

    let regex: RegExp;
    try {
      if (rule.isRegex) {
        regex = new RegExp(rule.pattern, rule.matchCase ? "g" : "gi");
      } else {
        const escaped = escapeRegex(rule.pattern.trim());
        const patternStr = rule.matchWholeWord ? `\\b${escaped}\\b` : escaped;
        regex = new RegExp(patternStr, rule.matchCase ? "g" : "gi");
      }
    } catch {
      continue;
    }

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const matchedText = match[0];
      if (matchedText.length === 0) {
        regex.lastIndex++;
        continue;
      }

      const strStart = match.index;
      const strEnd = strStart + matchedText.length;

      const colStart = stringLengthToBufferSize(line, strStart);
      const colEnd = stringLengthToBufferSize(line, strEnd);
      const width = Math.max(1, colEnd - colStart);

      const isBg = rule.style === "background";
      ranges.push({
        col: colStart,
        width,
        foregroundColor: isBg ? (isLightColor(rule.color) ? "#000000" : "#ffffff") : rule.color,
        backgroundColor: isBg ? rule.color : undefined,
      });
    }
  }

  return ranges;
}

/*
 * Filter rules applicable to a specific terminal session, honoring enabled state
 * and matching either global scope or target host IDs.
 */
export function getActiveHighlightRules(
  allRules: TerminalHighlightRule[],
  savedHostId?: string | null,
): TerminalHighlightRule[] {
  return allRules.filter((rule) => {
    if (rule.enabled === false) return false;
    if (rule.scope === "global") return true;
    if (rule.scope === "hosts") {
      return Boolean(savedHostId && rule.hostIds?.includes(savedHostId));
    }
    return true;
  });
}

export class TerminalKeywordHighlighter {
  private _disposed = false;
  private _activeRules: TerminalHighlightRule[] = [];
  private _savedHostId: string | null = null;
  private _scannedLines = new Map<number, { text: string; decorations: IDecoration[] }>();
  private _scheduledRaf: number | null = null;
  private _eventCleanups: (() => void)[] = [];

  constructor(
    private readonly _sessionId: string,
    private readonly _term: XTerm,
  ) {
    this._resolveHostId();
    this._updateActiveRules();

    // Subscribe to settings store changes to re-apply highlights immediately
    const unsubSettings = useSettingsStore.subscribe((state, prevState) => {
      if (state.terminalHighlightRules !== prevState.terminalHighlightRules) {
        this._updateActiveRules();
        this.clearAndRescan();
      }
    });
    this._eventCleanups.push(unsubSettings);

    // Subscribe to session store changes in case the session's savedHostId is resolved
    const unsubSession = useSessionStore.subscribe(() => {
      const prevHost = this._savedHostId;
      this._resolveHostId();
      if (this._savedHostId !== prevHost) {
        this._updateActiveRules();
        this.clearAndRescan();
      }
    });
    this._eventCleanups.push(unsubSession);

    // Terminal lifecycle events
    const writeDisposable = this._term.onWriteParsed(() => {
      this.scheduleScan();
    });
    this._eventCleanups.push(() => writeDisposable.dispose());

    const scrollDisposable = this._term.onScroll(() => {
      this.scheduleScan();
    });
    this._eventCleanups.push(() => scrollDisposable.dispose());

    const resizeDisposable = this._term.onResize(() => {
      this.scheduleScan();
    });
    this._eventCleanups.push(() => resizeDisposable.dispose());

    // Initial scan after next microtask
    this.scheduleScan();
  }

  private _resolveHostId(): void {
    const session = useSessionStore.getState().sessions.get(this._sessionId);
    this._savedHostId = session?.hostConfig.savedHostId ?? null;
  }

  private _updateActiveRules(): void {
    const allRules = useSettingsStore.getState().terminalHighlightRules;
    this._activeRules = getActiveHighlightRules(allRules, this._savedHostId);
  }

  /*
   * Schedule a scan of visible viewport lines on the next animation frame.
   */
  public scheduleScan(): void {
    if (this._disposed) return;
    if (this._scheduledRaf !== null) return;

    if (typeof requestAnimationFrame !== "undefined") {
      this._scheduledRaf = requestAnimationFrame(() => {
        this._scheduledRaf = null;
        this.scanViewport();
      });
    } else {
      this._scheduledRaf = setTimeout(() => {
        this._scheduledRaf = null;
        this.scanViewport();
      }, 16) as unknown as number;
    }
  }

  /*
   * Scan visible viewport rows and register decorations for all matching keywords.
   */
  public scanViewport(): void {
    if (this._disposed || this._activeRules.length === 0) {
      if (this._scannedLines.size > 0 && this._activeRules.length === 0) {
        this.clearAllDecorations();
      }
      return;
    }

    const buffer = this._term.buffer.active;
    const viewportY = buffer.viewportY;
    const rows = this._term.rows;

    const startLine = viewportY;
    const endLine = Math.min(buffer.length - 1, viewportY + rows);

    for (let lineIdx = startLine; lineIdx <= endLine; lineIdx++) {
      this.scanLine(lineIdx);
    }

    // Prune entries far from the viewport to maintain low memory usage
    this._pruneCache(viewportY, rows);
  }

  /*
   * Scan a single line index and update its xterm decorations if the text changed.
   */
  public scanLine(lineIdx: number): void {
    if (this._disposed) return;
    const buffer = this._term.buffer.active;
    const line = buffer.getLine(lineIdx);
    if (!line) {
      this._clearLineDecorations(lineIdx);
      return;
    }

    const text = line.translateToString(true);
    const existing = this._scannedLines.get(lineIdx);

    if (existing && existing.text === text) {
      // Content has not changed, decorations are already registered
      return;
    }

    // Line changed or was not previously scanned — dispose existing decorations
    this._clearLineDecorations(lineIdx);
    if (!text) {
      this._scannedLines.set(lineIdx, { text: "", decorations: [] });
      return;
    }

    const matches = findHighlightRanges(text, line, this._activeRules);
    if (matches.length === 0) {
      this._scannedLines.set(lineIdx, { text, decorations: [] });
      return;
    }

    const cursorYOffset = lineIdx - (buffer.baseY + buffer.cursorY);
    const marker = this._term.registerMarker(cursorYOffset);
    if (!marker || marker.isDisposed) return;

    const decorations: IDecoration[] = [];
    for (const match of matches) {
      const decoration = this._term.registerDecoration({
        marker,
        x: match.col,
        width: match.width,
        foregroundColor: match.foregroundColor,
        backgroundColor: match.backgroundColor,
        layer: "top",
      });
      if (decoration) {
        decorations.push(decoration);
      }
    }

    marker.onDispose(() => {
      this._scannedLines.delete(lineIdx);
    });

    this._scannedLines.set(lineIdx, { text, decorations });
  }

  private _clearLineDecorations(lineIdx: number): void {
    const entry = this._scannedLines.get(lineIdx);
    if (entry) {
      for (const dec of entry.decorations) {
        dec.dispose();
      }
      this._scannedLines.delete(lineIdx);
    }
  }

  private _pruneCache(viewportY: number, rows: number): void {
    const keepDistance = Math.max(300, rows * 4);
    for (const [lineIdx, entry] of this._scannedLines.entries()) {
      if (Math.abs(lineIdx - viewportY) > keepDistance) {
        for (const dec of entry.decorations) {
          dec.dispose();
        }
        this._scannedLines.delete(lineIdx);
      }
    }
  }

  /*
   * Clear all active decorations from all lines.
   */
  public clearAllDecorations(): void {
    for (const entry of this._scannedLines.values()) {
      for (const dec of entry.decorations) {
        dec.dispose();
      }
    }
    this._scannedLines.clear();
  }

  /*
   * Clear all decorations, re-scan the visible viewport, and refresh rows.
   */
  public clearAndRescan(): void {
    if (this._disposed) return;
    this.clearAllDecorations();
    this.scanViewport();
    this._term.refresh(0, Math.max(0, this._term.rows - 1));
  }

  /*
   * Dispose all listeners, timers, markers, and decorations.
   */
  public dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this._scheduledRaf !== null) {
      if (typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this._scheduledRaf);
      } else {
        clearTimeout(this._scheduledRaf);
      }
      this._scheduledRaf = null;
    }

    for (const cleanup of this._eventCleanups) {
      cleanup();
    }
    this._eventCleanups = [];

    this.clearAllDecorations();
  }
}
