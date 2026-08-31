/*
 * Unit tests for shell synchronization and terminal command dispatch helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  escapePosixPath,
  buildCdCommand,
  buildShellSyncCommand,
  sendCdToTerminal,
  enableShellSync,
  SHELL_SYNC_SNIPPETS,
} from "./shell-sync";

describe("shell-sync helpers", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  describe("escapePosixPath", () => {
    it("wraps standard paths in single quotes", () => {
      expect(escapePosixPath("/var/log/nginx")).toBe("'/var/log/nginx'");
      expect(escapePosixPath("/home/user/my documents/file.txt")).toBe(
        "'/home/user/my documents/file.txt'",
      );
    });

    it("escapes embedded single quotes properly", () => {
      expect(escapePosixPath("/home/alice/don't touch")).toBe("'/home/alice/don'\\''t touch'");
      expect(escapePosixPath("it's a 'test'")).toBe("'it'\\''s a '\\''test'\\'''");
    });

    it("handles special characters, variables, and wildcards literally", () => {
      expect(escapePosixPath("/path/$VAR/`whoami`/*")).toBe("'/path/$VAR/`whoami`/*'");
    });
  });

  describe("buildCdCommand", () => {
    it("creates newline-terminated cd command", () => {
      expect(buildCdCommand("/var/www/html")).toBe("cd '/var/www/html'\n");
      expect(buildCdCommand("/home/user/dir with spaces")).toBe("cd '/home/user/dir with spaces'\n");
    });
  });

  describe("buildShellSyncCommand", () => {
    it("generates newline-terminated snippets for bash, zsh, fish, and oneshot", () => {
      expect(buildShellSyncCommand("bash")).toBe(`${SHELL_SYNC_SNIPPETS.bash}\n`);
      expect(buildShellSyncCommand("zsh")).toBe(`${SHELL_SYNC_SNIPPETS.zsh}\n`);
      expect(buildShellSyncCommand("fish")).toBe(`${SHELL_SYNC_SNIPPETS.fish}\n`);
      expect(buildShellSyncCommand("oneshot")).toBe(`${SHELL_SYNC_SNIPPETS.oneshot}\n`);
    });

    it("ensures all snippets emit OSC 7 format", () => {
      expect(SHELL_SYNC_SNIPPETS.bash).toContain("]7;file://");
      expect(SHELL_SYNC_SNIPPETS.zsh).toContain("]7;file://");
      expect(SHELL_SYNC_SNIPPETS.fish).toContain("]7;file://");
      expect(SHELL_SYNC_SNIPPETS.oneshot).toContain("]7;file://");
    });
  });

  describe("sendCdToTerminal", () => {
    it("encodes cd command and invokes ssh_send_input", async () => {
      await sendCdToTerminal("sess-1", "/etc/nginx");

      expect(invoke).toHaveBeenCalledTimes(1);
      const [cmd, payload] = invoke.mock.calls[0] as [string, { sessionId: string; data: number[] }];
      expect(cmd).toBe("ssh_send_input");
      expect(payload.sessionId).toBe("sess-1");

      const decoded = new TextDecoder().decode(new Uint8Array(payload.data));
      expect(decoded).toBe("cd '/etc/nginx'\n");
    });
  });

  describe("enableShellSync", () => {
    it("sends shell sync command to the active session", async () => {
      await enableShellSync("sess-2", "zsh");

      expect(invoke).toHaveBeenCalledTimes(1);
      const [cmd, payload] = invoke.mock.calls[0] as [string, { sessionId: string; data: number[] }];
      expect(cmd).toBe("ssh_send_input");
      expect(payload.sessionId).toBe("sess-2");

      const decoded = new TextDecoder().decode(new Uint8Array(payload.data));
      expect(decoded).toBe(`${SHELL_SYNC_SNIPPETS.zsh}\n`);
    });
  });
});
