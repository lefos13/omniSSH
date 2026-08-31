/*
 * Tests for OSC 7 working-directory synchronization and explicit "cd" command dispatch.
 * Verifies parsing of RFC/iTerm2 compliant file:// URIs, POSIX path escaping,
 * shell sync snippet generation for Bash/Zsh/Fish, and session-store CWD state transitions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { parseOsc7Cwd } from "../osc7";
import {
  buildCdCommand,
  buildShellSyncCommand,
  escapePosixPath,
  sendCdToTerminal,
  enableShellSync,
  SHELL_SYNC_SNIPPETS,
} from "../shell-sync";
import { useSessionStore } from "../../stores/session-store";
import type { HostConfig } from "../../types";

const mockHost: HostConfig = {
  host: "osc7.server",
  port: 22,
  username: "user",
  auth_method: { type: "password", password: "p" },
};

describe("OSC 7 CWD follow and explicit cd helpers", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSessionStore.setState({
      sessions: new Map(),
      activeSessionId: null,
      tabs: new Map(),
      activeTerminalTabId: null,
      zoomedPaneId: null,
    });
  });

  describe("parseOsc7Cwd", () => {
    it("parses valid absolute paths with hostnames", () => {
      const parsed = parseOsc7Cwd("file://ubuntu-server/var/log/nginx");
      expect(parsed).toEqual({ host: "ubuntu-server", path: "/var/log/nginx" });
    });

    it("parses empty hostnames correctly", () => {
      const parsed = parseOsc7Cwd("file:///home/user/project");
      expect(parsed).toEqual({ host: "", path: "/home/user/project" });
    });

    it("percent-decodes spaces and Unicode path segments", () => {
      const parsed = parseOsc7Cwd("file://localhost/home/user/My%20Documents/caf%C3%A9");
      expect(parsed).toEqual({ host: "localhost", path: "/home/user/My Documents/café" });
    });

    it("strips query parameters and hash fragments", () => {
      const parsed = parseOsc7Cwd("file://localhost/etc/config.json?version=2#section");
      expect(parsed).toEqual({ host: "localhost", path: "/etc/config.json" });
    });

    it("strips trailing slashes except for root directory", () => {
      expect(parseOsc7Cwd("file://localhost/var/log/")?.path).toBe("/var/log");
      expect(parseOsc7Cwd("file://localhost///")?.path).toBe("/");
    });

    it("rejects invalid schemes, paths missing leading slashes, and non-strings", () => {
      expect(parseOsc7Cwd("http://localhost/var/log")).toBeNull();
      expect(parseOsc7Cwd("file://localhost")).toBeNull();
      expect(parseOsc7Cwd("file://localhost?query")).toBeNull();
      expect(parseOsc7Cwd("" as string)).toBeNull();
      expect(parseOsc7Cwd(null as unknown as string)).toBeNull();
    });

    it("handles paths containing dot-segment traversals while requiring leading slash", () => {
      expect(parseOsc7Cwd("file://localhost/../relative")?.path).toBe("/../relative");
    });
  });

  describe("shell-sync command generation & escaping", () => {
    it("escapes POSIX paths containing spaces, quotes, and special characters", () => {
      expect(escapePosixPath("/simple/path")).toBe("'/simple/path'");
      expect(escapePosixPath("/path with spaces/file")).toBe("'/path with spaces/file'");
      expect(escapePosixPath("/home/user/O'Connor's Folder")).toBe("'/home/user/O'\\''Connor'\\''s Folder'");
      expect(escapePosixPath("/var/log/data $VAR `cmd` \"quote\"")).toBe("'/var/log/data $VAR `cmd` \"quote\"'");
    });

    it("builds correct newline-terminated cd commands", () => {
      expect(buildCdCommand("/var/www/html")).toBe("cd '/var/www/html'\n");
      expect(buildCdCommand("/tmp/test folder")).toBe("cd '/tmp/test folder'\n");
    });

    it("builds shell sync snippets for bash, zsh, fish, and oneshot", () => {
      expect(buildShellSyncCommand("bash")).toBe(`${SHELL_SYNC_SNIPPETS.bash}\n`);
      expect(buildShellSyncCommand("zsh")).toBe(`${SHELL_SYNC_SNIPPETS.zsh}\n`);
      expect(buildShellSyncCommand("fish")).toBe(`${SHELL_SYNC_SNIPPETS.fish}\n`);
      expect(buildShellSyncCommand("oneshot")).toBe(`${SHELL_SYNC_SNIPPETS.oneshot}\n`);
    });

    it("dispatches explicit cd command to session via ssh_send_input", async () => {
      const sessionId = "sess-cd-test";
      const targetPath = "/srv/storage/my files";
      const expectedCommand = "cd '/srv/storage/my files'\n";
      const expectedBytes = Array.from(new TextEncoder().encode(expectedCommand));

      await sendCdToTerminal(sessionId, targetPath);

      expect(invoke).toHaveBeenCalledWith("ssh_send_input", {
        sessionId,
        data: expectedBytes,
      });
    });

    it("dispatches shell sync snippet to session via ssh_send_input", async () => {
      const sessionId = "sess-sync-test";
      const expectedCommand = `${SHELL_SYNC_SNIPPETS.bash}\n`;
      const expectedBytes = Array.from(new TextEncoder().encode(expectedCommand));

      await enableShellSync(sessionId, "bash");

      expect(invoke).toHaveBeenCalledWith("ssh_send_input", {
        sessionId,
        data: expectedBytes,
      });
    });
  });

  describe("remote CWD state updates in session-store", () => {
    it("updates remoteCwd and activates cwdSyncActive", () => {
      const sessionId = "sess-osc7-state";
      useSessionStore.getState().addSession(sessionId, mockHost);

      expect(useSessionStore.getState().sessions.get(sessionId)?.remoteCwd).toBeUndefined();
      expect(useSessionStore.getState().sessions.get(sessionId)?.cwdSyncActive).toBeUndefined();

      // Remote CWD received via OSC 7
      useSessionStore.getState().setRemoteCwd(sessionId, "/home/user/workspace");

      const session = useSessionStore.getState().sessions.get(sessionId);
      expect(session?.remoteCwd).toBe("/home/user/workspace");
      expect(session?.cwdSyncActive).toBe(true);

      // Clearing remote CWD deactivates sync
      useSessionStore.getState().setRemoteCwd(sessionId, null);

      const clearedSession = useSessionStore.getState().sessions.get(sessionId);
      expect(clearedSession?.remoteCwd).toBeNull();
      expect(clearedSession?.cwdSyncActive).toBe(false);
    });
  });
});
