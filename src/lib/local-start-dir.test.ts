/*
 * Unit tests for resolveLocalStartCandidates.
 * Verifies candidate ordering (host folder > global default), trimming,
 * empty/whitespace value handling, null/undefined host IDs, and deduplication.
 */

import { describe, it, expect } from "vitest";
import { resolveLocalStartCandidates } from "./local-start-dir";

describe("resolveLocalStartCandidates", () => {
  it("orders host folder before global default", () => {
    const candidates = resolveLocalStartCandidates("host-1", {
      explorerDefaultLocalDir: "/Users/user/global",
      explorerHostLocalDirs: { "host-1": "/Users/user/projects/host1" },
    });
    expect(candidates).toEqual([
      "/Users/user/projects/host1",
      "/Users/user/global",
    ]);
  });

  it("returns only global default when host has no entry", () => {
    const candidates = resolveLocalStartCandidates("unknown-host", {
      explorerDefaultLocalDir: "/Users/user/global",
      explorerHostLocalDirs: { "other-host": "/other/path" },
    });
    expect(candidates).toEqual(["/Users/user/global"]);
  });

  it("handles null or undefined hostId by returning global default", () => {
    const settings = {
      explorerDefaultLocalDir: "/Users/user/global",
      explorerHostLocalDirs: { "host-1": "/Users/user/projects/host1" },
    };
    expect(resolveLocalStartCandidates(null, settings)).toEqual(["/Users/user/global"]);
    expect(resolveLocalStartCandidates(undefined, settings)).toEqual(["/Users/user/global"]);
  });

  it("trims whitespace from paths and skips empty or whitespace-only paths", () => {
    const candidates = resolveLocalStartCandidates("host-1", {
      explorerDefaultLocalDir: "   ",
      explorerHostLocalDirs: {
        "host-1": "   /trimmed/host/path   ",
      },
    });
    expect(candidates).toEqual(["/trimmed/host/path"]);

    const withGlobalOnly = resolveLocalStartCandidates("host-1", {
      explorerDefaultLocalDir: "  /trimmed/global/path  ",
      explorerHostLocalDirs: {
        "host-1": "",
      },
    });
    expect(withGlobalOnly).toEqual(["/trimmed/global/path"]);
  });

  it("deduplicates identical host and global folders", () => {
    const candidates = resolveLocalStartCandidates("host-1", {
      explorerDefaultLocalDir: "/same/folder",
      explorerHostLocalDirs: { "host-1": "/same/folder" },
    });
    expect(candidates).toEqual(["/same/folder"]);

    const withWhitespace = resolveLocalStartCandidates("host-1", {
      explorerDefaultLocalDir: "  /same/folder  ",
      explorerHostLocalDirs: { "host-1": "/same/folder" },
    });
    expect(withWhitespace).toEqual(["/same/folder"]);
  });

  it("returns an empty array when neither candidate is configured", () => {
    expect(
      resolveLocalStartCandidates("host-1", {
        explorerDefaultLocalDir: "",
        explorerHostLocalDirs: {},
      }),
    ).toEqual([]);

    expect(
      resolveLocalStartCandidates(null, {
        explorerDefaultLocalDir: "   ",
        explorerHostLocalDirs: {},
      }),
    ).toEqual([]);
  });

  it("does not include the OS home directory in candidate list", () => {
    const candidates = resolveLocalStartCandidates(null, {
      explorerDefaultLocalDir: "",
      explorerHostLocalDirs: {},
    });
    expect(candidates).not.toContain("~");
    expect(candidates).toHaveLength(0);
  });
});
