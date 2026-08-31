/*
 * Shell integration helpers for terminal working-directory synchronization.
 * Provides additive, session-local OSC 7 escape sequence emitters for Bash,
 * Zsh, and Fish without modifying any remote rc configuration files, as well as
 * explicit "cd here" command generation for linked explorer navigation.
 */

import { invoke } from "@tauri-apps/api/core";

export type SupportedShell = "bash" | "zsh" | "fish" | "oneshot";

/**
 * Session-local, idempotent OSC 7 integration snippets for supported remote shells.
 * Emits an OSC 7 sequence (file://<host><path>) on prompt/directory changes.
 */
export const SHELL_SYNC_SNIPPETS: Record<SupportedShell, string> = {
  bash: `__anyscp_osc7() { printf '\\e]7;file://%s%s\\e\\\\' "\${HOSTNAME:-localhost}" "$PWD"; }; case "$PROMPT_COMMAND" in *__anyscp_osc7*) ;; *) PROMPT_COMMAND="__anyscp_osc7\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}";; esac; __anyscp_osc7`,
  zsh: `__anyscp_osc7() { printf '\\e]7;file://%s%s\\e\\\\' "\${HOST:-localhost}" "$PWD"; }; autoload -Uz add-zsh-hook 2>/dev/null; add-zsh-hook -d chpwd __anyscp_osc7 2>/dev/null; add-zsh-hook chpwd __anyscp_osc7 2>/dev/null || { chpwd_functions=(\${chpwd_functions:#__anyscp_osc7}); chpwd_functions+=(__anyscp_osc7); }; __anyscp_osc7`,
  fish: `functions -e __anyscp_osc7 2>/dev/null; function __anyscp_osc7 --on-variable PWD; printf '\\e]7;file://%s%s\\e\\\\' (hostname) $PWD; end; __anyscp_osc7`,
  oneshot: `printf '\\e]7;file://%s%s\\e\\\\' "\${HOSTNAME:-\${HOST:-localhost}}" "$PWD"`,
};

/**
 * Safely escape a file path for POSIX shells (wrapping in single quotes and
 * escaping existing single quotes as '\\'').
 */
export function escapePosixPath(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a "cd <path>" command string terminated by a newline for execution in a shell.
 */
export function buildCdCommand(path: string): string {
  return `cd ${escapePosixPath(path)}\n`;
}

/**
 * Build the shell sync integration command string terminated by a newline.
 */
export function buildShellSyncCommand(shell: SupportedShell): string {
  return `${SHELL_SYNC_SNIPPETS[shell]}\n`;
}

/**
 * Send raw input string to an active SSH terminal session via `ssh_send_input`.
 */
export async function sendInputToSession(sessionId: string, input: string): Promise<void> {
  const bytes = Array.from(new TextEncoder().encode(input));
  await invoke("ssh_send_input", { sessionId, data: bytes });
}

/**
 * Execute an explicit "cd <path>" in the active terminal pane.
 */
export async function sendCdToTerminal(sessionId: string, targetPath: string): Promise<void> {
  const command = buildCdCommand(targetPath);
  await sendInputToSession(sessionId, command);
}

/**
 * Enable OSC 7 CWD synchronization session-locally for the selected shell.
 */
export async function enableShellSync(sessionId: string, shell: SupportedShell): Promise<void> {
  const command = buildShellSyncCommand(shell);
  await sendInputToSession(sessionId, command);
}
