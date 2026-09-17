/*
 * Types for terminal configuration and keyword highlighting rules.
 * Supports coloring text or background for specific words or patterns,
 * with either global scope or scoped to specific host IDs.
 */

export type HighlightStyle = "text" | "background";
export type HighlightScope = "global" | "hosts";

export interface TerminalHighlightRule {
  id: string;
  pattern: string;
  color: string;
  style: HighlightStyle;
  scope: HighlightScope;
  hostIds?: string[];
  matchCase?: boolean;
  matchWholeWord?: boolean;
  isRegex?: boolean;
  enabled?: boolean;
}
