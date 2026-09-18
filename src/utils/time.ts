/* Timestamps reach the UI in three shapes: SQLite's `datetime('now')`
 * ("2026-09-18 17:51:27", UTC with no designator), plain ISO ending in "Z",
 * and RFC3339 with a numeric offset ("…+00:00") as the sync layer writes with
 * chrono. Only the first needs a "Z" appended — doing it to the third produced
 * "…+00:00Z", which parses as NaN and rendered as "NaNmo ago". */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Parse a stored timestamp into a Date, treating a bare SQLite value as UTC. */
export function parseSqliteUtc(isoDate: string): Date {
  const value = isoDate.trim().replace(" ", "T");
  return new Date(HAS_ZONE.test(value) ? value : `${value}Z`);
}

/**
 * Format a stored timestamp as a human-readable relative time. An unparseable
 * value reports itself rather than rendering arithmetic on NaN.
 */
export function relativeTime(isoDate: string): string {
  const now = Date.now();
  const then = parseSqliteUtc(isoDate).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
