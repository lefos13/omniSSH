import { describe, it, expect } from "vitest";
import { parseSqliteUtc, relativeTime } from "./time";

/* The three shapes a stored timestamp arrives in. The offset form is what the
 * sync layer writes (chrono's RFC3339); appending "Z" to it produced NaN and
 * rendered "NaNmo ago" on the dataset card. */
describe("parseSqliteUtc", () => {
  it("reads a bare SQLite timestamp as UTC", () => {
    expect(parseSqliteUtc("2026-09-18 17:51:27").toISOString()).toBe("2026-09-18T17:51:27.000Z");
  });

  it("reads an ISO timestamp that already ends in Z", () => {
    expect(parseSqliteUtc("2026-09-18T17:51:27Z").toISOString()).toBe("2026-09-18T17:51:27.000Z");
  });

  it("reads an RFC3339 timestamp carrying a numeric offset", () => {
    expect(parseSqliteUtc("2026-09-18T17:51:27.039432+00:00").toISOString()).toBe(
      "2026-09-18T17:51:27.039Z",
    );
    expect(parseSqliteUtc("2026-09-18T19:51:27+02:00").toISOString()).toBe(
      "2026-09-18T17:51:27.000Z",
    );
  });
});

describe("relativeTime", () => {
  it("measures against an offset timestamp instead of reporting NaN", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000)
      .toISOString()
      .replace("Z", "+00:00");
    expect(relativeTime(twoHoursAgo)).toBe("2h ago");
  });

  it("says so when the value cannot be parsed at all", () => {
    expect(relativeTime("not a timestamp")).toBe("unknown");
  });
});
