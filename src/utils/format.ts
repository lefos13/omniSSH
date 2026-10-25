/**
 * Format a byte count to a human-readable string.
 * Examples: 0 → "0 B", 1024 → "1.0 KB", 1048576 → "1.0 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

/**
 * Format a transfer speed in bytes/sec to a human-readable string.
 * Examples: 500 → "500 B/s", 2048 → "2.0 KB/s", 5242880 → "5.0 MB/s"
 */
export function formatSpeed(bps: number): string {
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

/**
 * Format an ETA in seconds to a human-readable string.
 * Returns an empty string when eta is null or zero.
 */
export function formatEta(secs: number | null): string {
  if (secs === null || secs <= 0) return "";
  if (secs < 60) return `~${secs}s`;
  if (secs < 3600) return `~${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `~${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

import type { TransferStatusValue } from "../types";

/*
 * First visible grapheme of a display name for avatar initials. `charAt(0)`
 * splits surrogate pairs (emoji labels rendered a replacement character), so
 * use Intl.Segmenter where available and fall back to code points.
 */
type GraphemeSegmenter = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => { segment(input: string): Iterable<{ segment: string }> };

export function hostInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // Intl.Segmenter ships in every supported webview but is missing from the
  // ES2020 lib this project targets; the runtime shape is the standard one.
  const intl = Intl as unknown as { Segmenter?: GraphemeSegmenter };
  const Segmenter = intl.Segmenter;
  if (Segmenter) {
    const first = new Segmenter(undefined, { granularity: "grapheme" })
      .segment(trimmed)
      [Symbol.iterator]()
      .next().value?.segment;
    if (first) return first.toLocaleUpperCase();
  }
  return (Array.from(trimmed)[0] ?? "?").toLocaleUpperCase();
}

/**
 * Coerce a TransferStatusValue (which may be a tagged union object) into a
 * plain string for display or comparison purposes.
 */
export function getStatusString(status: TransferStatusValue): string {
  if (typeof status === "string") return status;
  if ("Failed" in status) return "Failed";
  return "Unknown";
}
