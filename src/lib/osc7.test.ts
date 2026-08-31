import { describe, it, expect, beforeEach } from "vitest";
import { parseOsc7Cwd } from "./osc7";
import { useSessionStore } from "../stores/session-store";
import type { HostConfig } from "../types";

describe("parseOsc7Cwd", () => {
  it("parses valid OSC 7 payloads across diverse formats", () => {
    const cases: Array<{
      name: string;
      input: string;
      expected: { host: string; path: string } | null;
    }> = [
      // Basic payload
      {
        name: "basic file://host/home/u",
        input: "file://host/home/u",
        expected: { host: "host", path: "/home/u" },
      },
      // Empty host
      {
        name: "empty host file:///home/u",
        input: "file:///home/u",
        expected: { host: "", path: "/home/u" },
      },
      {
        name: "empty host root file:///",
        input: "file:///",
        expected: { host: "", path: "/" },
      },
      // Percent-encoded space and UTF-8
      {
        name: "percent-encoded space",
        input: "file://host/home/u/my%20documents",
        expected: { host: "host", path: "/home/u/my documents" },
      },
      {
        name: "percent-encoded UTF-8 latin",
        input: "file://host/home/u/%C3%A9cole",
        expected: { host: "host", path: "/home/u/école" },
      },
      {
        name: "percent-encoded UTF-8 CJK",
        input: "file://host/home/u/%E6%9D%B1%E4%BA%AC",
        expected: { host: "host", path: "/home/u/東京" },
      },
      {
        name: "percent-encoded 4-byte UTF-8 emoji",
        input: "file://host/home/u/%F0%9F%9A%80",
        expected: { host: "host", path: "/home/u/🚀" },
      },
      // Root file://h/ -> /
      {
        name: "root directory on named host file://h/",
        input: "file://h/",
        expected: { host: "h", path: "/" },
      },
      // Trailing-slash stripping
      {
        name: "strips single trailing slash",
        input: "file://host/home/u/",
        expected: { host: "host", path: "/home/u" },
      },
      {
        name: "strips multiple trailing slashes",
        input: "file://host/home/u///",
        expected: { host: "host", path: "/home/u" },
      },
      // Uppercase FILE scheme accepted
      {
        name: "uppercase FILE scheme",
        input: "FILE://host/home/u",
        expected: { host: "host", path: "/home/u" },
      },
      {
        name: "mixed-case File scheme",
        input: "File://HostName/var/log",
        expected: { host: "HostName", path: "/var/log" },
      },
      // Ignored query and fragment
      {
        name: "ignores query string suffix",
        input: "file://host/home/u?query=val",
        expected: { host: "host", path: "/home/u" },
      },
      {
        name: "ignores fragment suffix",
        input: "file://host/home/u#section",
        expected: { host: "host", path: "/home/u" },
      },
      {
        name: "ignores query and fragment together",
        input: "file://host/home/u?query=val#section",
        expected: { host: "host", path: "/home/u" },
      },
      // Encoded query and fragment characters preserved in path
      {
        name: "preserves percent-encoded question mark and hash in path",
        input: "file://host/home/u/file%3Fname%231",
        expected: { host: "host", path: "/home/u/file?name#1" },
      },
      // Malformed percent tolerated
      {
        name: "tolerates literal percent in directory name",
        input: "file://host/home/u/100%done",
        expected: { host: "host", path: "/home/u/100%done" },
      },
      {
        name: "tolerates invalid hex digits after percent",
        input: "file://host/home/u/%ZZ",
        expected: { host: "host", path: "/home/u/%ZZ" },
      },
      {
        name: "tolerates incomplete single hex digit at end",
        input: "file://host/home/u/%2",
        expected: { host: "host", path: "/home/u/%2" },
      },
      {
        name: "tolerates trailing percent",
        input: "file://host/home/u/%",
        expected: { host: "host", path: "/home/u/%" },
      },
      {
        name: "tolerates incomplete multi-byte UTF-8 sequence",
        input: "file://host/home/u/%C3%20",
        expected: { host: "host", path: "/home/u/%C3 " },
      },
      // Non-file schemes rejected
      {
        name: "rejects ssh scheme",
        input: "ssh://host/home/u",
        expected: null,
      },
      {
        name: "rejects http scheme",
        input: "http://host/home/u",
        expected: null,
      },
      {
        name: "rejects ftp scheme",
        input: "ftp://host/home/u",
        expected: null,
      },
      // Relative path rejected
      {
        name: "rejects host without path slash",
        input: "file://host",
        expected: null,
      },
      {
        name: "rejects empty payload after file://",
        input: "file://",
        expected: null,
      },
      {
        name: "rejects relative file: scheme",
        input: "file:home/u",
        expected: null,
      },
      {
        name: "rejects relative path without double slash",
        input: "file:/home/u",
        expected: null,
      },
      // Oversized rejected (> 4096 characters)
      {
        name: "rejects path exceeding 4096 characters",
        input: "file://host/" + "a".repeat(4096),
        expected: null,
      },
      {
        name: "accepts path of exactly 4096 characters",
        input: "file://host/" + "a".repeat(4095),
        expected: { host: "host", path: "/" + "a".repeat(4095) },
      },
    ];

    for (const { name, input, expected } of cases) {
      expect(parseOsc7Cwd(input), name).toEqual(expected);
    }
  });

  it("returns null for non-string inputs", () => {
    // @ts-expect-error test non-string runtime guard
    expect(parseOsc7Cwd(null)).toBeNull();
    // @ts-expect-error test non-string runtime guard
    expect(parseOsc7Cwd(undefined)).toBeNull();
    // @ts-expect-error test non-string runtime guard
    expect(parseOsc7Cwd(123)).toBeNull();
  });
});

describe("session-store setRemoteCwd", () => {
  const dummyHost: HostConfig = {
    host: "example.com",
    port: 22,
    username: "alice",
    auth_method: { type: "password", password: "secret" },
  };

  beforeEach(() => {
    useSessionStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      tabs: new Map(),
      activeTerminalTabId: null,
      zoomedPaneId: null,
    });
  });

  it("updates remoteCwd and activates cwdSyncActive immutably", () => {
    const sessionId = "sess-1";
    useSessionStore.getState().addSession(sessionId, dummyHost);

    const initialSession = useSessionStore.getState().sessions.get(sessionId);
    expect(initialSession?.remoteCwd).toBeUndefined();
    expect(initialSession?.cwdSyncActive).toBeUndefined();

    useSessionStore.getState().setRemoteCwd(sessionId, "/var/www");

    const updatedSession = useSessionStore.getState().sessions.get(sessionId);
    expect(updatedSession?.remoteCwd).toBe("/var/www");
    expect(updatedSession?.cwdSyncActive).toBe(true);
    expect(updatedSession).not.toBe(initialSession);
  });

  it("resets cwdSyncActive to false and sets remoteCwd to null when null is passed", () => {
    const sessionId = "sess-1";
    useSessionStore.getState().addSession(sessionId, dummyHost);
    useSessionStore.getState().setRemoteCwd(sessionId, "/home/alice");

    expect(useSessionStore.getState().sessions.get(sessionId)?.cwdSyncActive).toBe(true);

    useSessionStore.getState().setRemoteCwd(sessionId, null);

    const session = useSessionStore.getState().sessions.get(sessionId);
    expect(session?.remoteCwd).toBeNull();
    expect(session?.cwdSyncActive).toBe(false);
  });

  it("is a no-op when session does not exist", () => {
    const prevSessions = useSessionStore.getState().sessions;
    useSessionStore.getState().setRemoteCwd("unknown-id", "/tmp");
    expect(useSessionStore.getState().sessions).toBe(prevSessions);
  });
});
