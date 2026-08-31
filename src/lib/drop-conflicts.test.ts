import { describe, it, expect } from "vitest";
import { basename, conflictingNames, formatBackupDate, backupFilename } from "./drop-conflicts";

describe("basename", () => {
  it("handles POSIX and Windows separators", () => {
    expect(basename("/home/user/a.txt")).toBe("a.txt");
    expect(basename("C:\\Users\\me\\b.txt")).toBe("b.txt");
    expect(basename("noslash")).toBe("noslash");
  });
});

describe("conflictingNames", () => {
  it("returns only basenames that already exist remotely", () => {
    const existing = new Set(["a.txt", "c.txt"]);
    expect(conflictingNames(["/x/a.txt", "/x/b.txt", "/x/c.txt"], existing)).toEqual([
      "a.txt",
      "c.txt",
    ]);
  });

  it("de-duplicates two dropped files sharing a basename", () => {
    const existing = new Set(["dup.txt"]);
    // Same basename from two different source dirs → one conflict entry.
    expect(conflictingNames(["/a/dup.txt", "/b/dup.txt"], existing)).toEqual(["dup.txt"]);
  });

  it("returns an empty list when nothing conflicts", () => {
    expect(conflictingNames(["/x/new.txt"], new Set(["other.txt"]))).toEqual([]);
  });
});

describe("formatBackupDate", () => {
  it("formats dates as YYYYMMDD with zero padding", () => {
    const sample = new Date(2026, 7, 30); // 2026-08-30 (months are 0-indexed)
    expect(formatBackupDate(sample)).toBe("20260830");

    const janSingleDigit = new Date(2025, 0, 5); // 2025-01-05
    expect(formatBackupDate(janSingleDigit)).toBe("20250105");

    const decEnd = new Date(2024, 11, 31); // 2024-12-31
    expect(formatBackupDate(decEnd)).toBe("20241231");
  });
});

describe("backupFilename", () => {
  it("appends .YYYYMMDD.bak to filenames", () => {
    const sample = new Date(2026, 7, 30);
    expect(backupFilename("oldfilename.jpeg", sample)).toBe("oldfilename.jpeg.20260830.bak");
    expect(backupFilename("archive.tar.gz", sample)).toBe("archive.tar.gz.20260830.bak");
    expect(backupFilename("Makefile", sample)).toBe("Makefile.20260830.bak");
  });
});
