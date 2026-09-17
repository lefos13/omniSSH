/*
 * Unit tests for shell synchronization and terminal command dispatch helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

/*
 * `node:child_process` is a Node builtin with no types in the app's TS config.
 * Import it through a non-literal specifier so type resolution is skipped while
 * the test runtime (vitest under Node) still resolves and runs it.
 */
async function execFile(file: string, args: string[], input?: string): Promise<void> {
  const specifier = "node:child_process";
  const mod = (await import(/* @vite-ignore */ specifier)) as {
    execFileSync: (
      file: string,
      args: string[],
      options: { input?: string; stdio: string[] },
    ) => unknown;
  };
  mod.execFileSync(file, args, {
    input,
    stdio: input === undefined ? ["ignore", "ignore", "pipe"] : ["pipe", "ignore", "pipe"],
  });
}

import {
  escapePosixPath,
  buildCdCommand,
  buildShellSyncCommand,
  buildAutoCwdSyncCommand,
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

    it("guarantees idempotency across shell hooks", () => {
      expect(SHELL_SYNC_SNIPPETS.bash).toContain("case \"$PROMPT_COMMAND\" in *__anyscp_osc7*)");
      expect(SHELL_SYNC_SNIPPETS.zsh).toContain("add-zsh-hook -d chpwd __anyscp_osc7");
      expect(SHELL_SYNC_SNIPPETS.fish).toContain("functions -e __anyscp_osc7 2>/dev/null;");
    });
  });

  describe("buildAutoCwdSyncCommand", () => {
    it("defaults to the POSIX/bash/zsh installer", () => {
      const cmd = buildAutoCwdSyncCommand();
      expect(cmd.endsWith("\n")).toBe(true);
      expect(cmd).toContain("__anyscp_osc7");
      expect(cmd).toContain("PROMPT_COMMAND");
      expect(cmd).toContain("add-zsh-hook");
    });

    it("selects the fish installer for a fish login shell", () => {
      expect(buildAutoCwdSyncCommand("/usr/bin/fish")).toBe(`${SHELL_SYNC_SNIPPETS.fish}\n`);
      expect(buildAutoCwdSyncCommand("fish")).toBe(`${SHELL_SYNC_SNIPPETS.fish}\n`);
    });

    // The installer is typed into a live shell, so a syntax error would break
    // the user's prompt. Parse it for real with every shell we target.
    it("parses as valid syntax in sh, bash and zsh", async () => {
      const script = buildAutoCwdSyncCommand();
      const candidates = ["sh", "bash", "zsh"];
      const available: string[] = [];
      for (const shell of candidates) {
        try {
          await execFile("which", [shell]);
          available.push(shell);
        } catch {
          // Shell not installed on this machine — skip it.
        }
      }
      expect(available.length).toBeGreaterThan(0);

      for (const shell of available) {
        await expect(
          execFile(shell, ["-n"], script),
          `${shell} should parse the installer`,
        ).resolves.toBeUndefined();
      }
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
