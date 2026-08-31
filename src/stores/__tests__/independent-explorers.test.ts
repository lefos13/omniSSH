/*
 * Tests for multiple independent explorer connections.
 * Verifies that two or more explorer sessions (SFTP and S3) maintain isolated
 * directory paths, file listings, loading states, error states, and sort settings
 * without cross-session contamination or state leakage.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useSftpStore } from "../sftp-store";
import { useS3Store } from "../s3-store";
import { useTabStore } from "../tab-store";
import type { SftpEntry } from "../../types/sftp";
import type { S3Entry } from "../../types/s3";

function makeSftpEntry(name: string, isDir = false): SftpEntry {
  return {
    name,
    path: `/${name}`,
    entry_type: isDir ? "Directory" : "File",
    size: isDir ? 0 : 1024,
    modified: 1700000000,
    permissions_display: isDir ? "drwxr-xr-x" : "-rw-r--r--",
    permissions: isDir ? 16877 : 33188,
    is_symlink: false,
  };
}

function makeS3Entry(name: string, isDir = false): S3Entry {
  return {
    name,
    key: `backups/${name}`,
    entry_type: isDir ? "Directory" : "File",
    size: isDir ? 0 : 2048,
    last_modified: "2026-08-31T12:00:00Z",
    storage_class: "STANDARD",
  };
}

describe("Independent explorer connections", () => {
  beforeEach(() => {
    useSftpStore.setState({
      sessions: new Map(),
      activeSftpSessionId: null,
      clipboard: null,
    });
    useS3Store.setState({
      sessions: new Map(),
      activeS3SessionId: null,
    });
    useTabStore.setState({
      tabs: new Map(),
      tabOrder: [],
      activeTabId: null,
    });
  });

  it("maintains isolated state between two independent SFTP sessions", () => {
    const sftp = useSftpStore.getState();

    // Open two distinct SFTP sessions
    sftp.openSession("sftp-alpha", "ssh-1", "Host Alpha", "user1", false, "/var/www");
    sftp.openSession("sftp-beta", "ssh-2", "Host Beta", "user2", false, "/home/user2");

    const entriesAlpha: SftpEntry[] = [makeSftpEntry("index.html"), makeSftpEntry("css", true)];
    const entriesBeta: SftpEntry[] = [makeSftpEntry("notes.txt"), makeSftpEntry(".bashrc")];

    sftp.setEntries("sftp-alpha", "/var/www", entriesAlpha);
    sftp.setEntries("sftp-beta", "/home/user2", entriesBeta);

    const sessionAlpha = useSftpStore.getState().sessions.get("sftp-alpha");
    const sessionBeta = useSftpStore.getState().sessions.get("sftp-beta");

    expect(sessionAlpha).toBeDefined();
    expect(sessionBeta).toBeDefined();

    // Paths and entries remain strictly separate
    expect(sessionAlpha?.currentPath).toBe("/var/www");
    expect(sessionAlpha?.entries.map((e) => e.name)).toEqual(["index.html", "css"]);

    expect(sessionBeta?.currentPath).toBe("/home/user2");
    expect(sessionBeta?.entries.map((e) => e.name)).toEqual(["notes.txt", ".bashrc"]);

    // Sort order configured on Alpha does not affect Beta
    sftp.setSort("sftp-alpha", "size", false);
    expect(useSftpStore.getState().sessions.get("sftp-alpha")?.sortBy).toBe("size");
    expect(useSftpStore.getState().sessions.get("sftp-alpha")?.sortAsc).toBe(false);
    expect(useSftpStore.getState().sessions.get("sftp-beta")?.sortBy).toBe("name");
    expect(useSftpStore.getState().sessions.get("sftp-beta")?.sortAsc).toBe(true);

    // Error on Beta does not affect Alpha
    sftp.setError("sftp-beta", "Permission denied");
    expect(useSftpStore.getState().sessions.get("sftp-alpha")?.error).toBeNull();
    expect(useSftpStore.getState().sessions.get("sftp-beta")?.error).toBe("Permission denied");

    // Closing Alpha leaves Beta completely active
    sftp.closeSession("sftp-alpha");
    expect(useSftpStore.getState().sessions.has("sftp-alpha")).toBe(false);
    expect(useSftpStore.getState().sessions.has("sftp-beta")).toBe(true);
    expect(useSftpStore.getState().activeSftpSessionId).toBe("sftp-beta");
  });

  it("coexists cleanly across SFTP and S3 independent explorer sessions", () => {
    const sftp = useSftpStore.getState();
    const s3 = useS3Store.getState();

    sftp.openSession("sftp-prod", "ssh-prod", "Production Server");
    s3.openSession("s3-backups", "AWS Backup Bucket");

    sftp.setEntries("sftp-prod", "/etc/nginx", [makeSftpEntry("nginx.conf")]);
    s3.setEntries("s3-backups", "backups/", [makeS3Entry("db.tar.gz")]);

    expect(useSftpStore.getState().sessions.get("sftp-prod")?.currentPath).toBe("/etc/nginx");
    expect(useS3Store.getState().sessions.get("s3-backups")?.currentPrefix).toBe("backups/");

    // Independent loading toggles
    sftp.setLoading("sftp-prod", true);
    expect(useSftpStore.getState().sessions.get("sftp-prod")?.loading).toBe(true);
    expect(useS3Store.getState().sessions.get("s3-backups")?.loading).toBe(false);
  });

  it("integrates with tab-store for active explorer session switching", () => {
    const sftpStore = useSftpStore.getState();

    sftpStore.openSession("sftp-1", "ssh-1", "Server 1");
    sftpStore.openSession("sftp-2", "ssh-2", "Server 2");

    useTabStore.getState().addTab({ type: "sftp", id: "sftp-1", label: "Server 1" });
    useTabStore.getState().addTab({ type: "sftp", id: "sftp-2", label: "Server 2" });

    expect(useTabStore.getState().activeTabId).toBe("sftp-2");

    // Switching active tab synchronizes activeSftpSessionId
    useTabStore.getState().setActiveTab("sftp-1");
    expect(useSftpStore.getState().activeSftpSessionId).toBe("sftp-1");

    useTabStore.getState().setActiveTab("sftp-2");
    expect(useSftpStore.getState().activeSftpSessionId).toBe("sftp-2");
  });
});
