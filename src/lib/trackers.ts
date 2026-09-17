/* Shared contract for the built-in per-host trackers (health, docker, pm2,
 * systemd, logs, probes). A tracker declares how to detect itself, what to
 * poll, how to parse output, and which state-changing actions it offers —
 * every action executes only through the verification modal, which shows the
 * exact interpolated command before running it. */

import type { SshExecResult } from "../types";

/* Built-in tracker ids. The backend stores these as `plugin_id` strings in
 * `host_plugin_config`; keep them stable — renaming breaks saved rows. */
export type TrackerId =
  | "health"
  | "docker"
  | "pm2"
  | "systemd"
  | "logs"
  | "http"
  | "k8s"
  | "ssl"
  | "dbping"
  | "cron";

/* Prefix every remote command so tools installed outside the non-interactive
 * PATH (nvm/npm-global PM2, /usr/local docker, user kubectl) still resolve.
 * Hidden exec channels don't source .bashrc/.zshrc, so without this `pm2`
 * reports "command not found" even when the interactive terminal finds it. */
const REMOTE_ENV_PREFIX =
  "export PATH=\"$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node 2>/dev/null | head -n 1)/bin:$HOME/.local/bin:/usr/local/bin:$PATH\" >/dev/null 2>&1; ";

function withRemoteEnv(command: string): string {
  return `${REMOTE_ENV_PREFIX}${command}`;
}

/* Commands the tracker layer is willing to execute via `ssh_exec_command`.
 * State-changing actions print the exact command in the verification modal;
 * cleanup/prune/vacuum commands are deliberately absent — disk cleanup is
 * rejected by policy (data-loss risk) and must never be added here. */
function isAllowedCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return false;
  if (/\b(rm\s+-rf?|mkfs|dd\s+[^ ]*of=|: *\( *\) *\{|shutdown|reboot|halt|poweroff)\b/.test(c)) return false;
  if (/\bsystem\s+prune\b/.test(c)) return false;
  if (/\bjournalctl\s+--vacuum/.test(c)) return false;
  return true;
}

/* Every state-changing tracker action. `commandTemplate` uses `{name}`-style
 * placeholders; the modal shows the fully-interpolated string and the invoke
 * payload must equal the shown string (no re-interpolation at execution). */
export interface ActionDefinition {
  id: string;
  label: string;
  commandTemplate: string;
  dangerLevel: "restart" | "stop" | "kill";
}

/* Static definition of one built-in tracker. */
export interface TrackerDefinition {
  id: TrackerId;
  label: string;
  description: string;
  detectCommand: string;
  pollCommand: string;
  pollIntervalMs: number;
  actions: ActionDefinition[];
}

/* PM2 often lives outside the non-interactive PATH (nvm shims, npm-global
 * bins); fall back to its daemon dump / pid files so the tracker still
 * lists processes when the binary isn't on PATH. */
export const PM2_POLL_COMMAND =
  "command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null || (cat $HOME/.pm2/dump.pm2 2>/dev/null || ls $HOME/.pm2/pids 2>/dev/null || echo 'PM2_NOT_FOUND')";

/* The eight built-in trackers. Detection is a `command -v` probe; polling is
 * one read-only command per interval; parsing lives beside each tracker UI. */
export const TRACKERS: TrackerDefinition[] = [
  {
    id: "health",
    label: "Server Health",
    description: "CPU load, memory, disk usage, and uptime.",
    detectCommand: "command -v free >/dev/null 2>&1 || cat /proc/loadavg >/dev/null 2>&1; echo ok",
    pollCommand: "nproc 2>/dev/null; echo ---; cat /proc/loadavg; echo ---; free -m; echo ---; df -hP /; echo ---; uptime -p 2>/dev/null || uptime",
    pollIntervalMs: 10000,
    actions: [{ id: "kill-pid", label: "Kill process", commandTemplate: "kill {pid}", dangerLevel: "kill" }],
  },
  {
    id: "docker",
    label: "Docker",
    description: "Containers, status, resource usage, and logs.",
    detectCommand: "command -v docker >/dev/null 2>&1; echo $?",
    pollCommand: "docker ps --format '{{json .}}'",
    pollIntervalMs: 10000,
    actions: [
      { id: "restart", label: "Restart container", commandTemplate: "docker restart {name}", dangerLevel: "restart" },
      { id: "stop", label: "Stop container", commandTemplate: "docker stop {name}", dangerLevel: "stop" },
      { id: "start", label: "Start container", commandTemplate: "docker start {name}", dangerLevel: "restart" },
    ],
  },
  {
    id: "pm2",
    label: "PM2",
    description: "Node.js processes managed by PM2.",
    detectCommand: "command -v pm2 >/dev/null 2>&1; echo $?",
    pollCommand: PM2_POLL_COMMAND,
    pollIntervalMs: 10000,
    actions: [
      { id: "restart", label: "Restart process", commandTemplate: "pm2 restart {name}", dangerLevel: "restart" },
      { id: "stop", label: "Stop process", commandTemplate: "pm2 stop {name}", dangerLevel: "stop" },
      { id: "reload", label: "Reload process", commandTemplate: "pm2 reload {name}", dangerLevel: "restart" },
    ],
  },
  {
    id: "systemd",
    label: "systemd Services",
    description: "Running services, status, and journal logs.",
    detectCommand: "command -v systemctl >/dev/null 2>&1; echo $?",
    pollCommand: "systemctl list-units --type=service --state=running --output=json",
    pollIntervalMs: 15000,
    actions: [
      { id: "restart", label: "Restart service", commandTemplate: "systemctl restart {name}", dangerLevel: "restart" },
      { id: "stop", label: "Stop service", commandTemplate: "systemctl stop {name}", dangerLevel: "stop" },
    ],
  },
  {
    id: "logs",
    label: "Log Viewer",
    description: "Tail journald units and log files.",
    detectCommand: "echo ok",
    pollCommand: "",
    pollIntervalMs: 0,
    actions: [],
  },
  {
    id: "http",
    label: "HTTP Health Probe",
    description: "Probe app health endpoints (Spring Actuator preset included).",
    detectCommand: "command -v curl >/dev/null 2>&1; echo $?",
    pollCommand: "",
    pollIntervalMs: 15000,
    actions: [],
  },
  {
    id: "k8s",
    label: "Kubernetes",
    description: "Pods, status, and logs via kubectl on the remote.",
    detectCommand: "command -v kubectl >/dev/null 2>&1; echo $?",
    pollCommand: "kubectl get pods -o json",
    pollIntervalMs: 15000,
    actions: [
      { id: "rollout-restart", label: "Rollout restart", commandTemplate: "kubectl rollout restart {kind}/{name}", dangerLevel: "restart" },
      { id: "delete-pod", label: "Delete pod", commandTemplate: "kubectl delete pod {name}", dangerLevel: "stop" },
    ],
  },
  {
    id: "ssl",
    label: "SSL & Ports",
    description: "Certificate expiry and port reachability.",
    detectCommand: "command -v openssl >/dev/null 2>&1; echo $?",
    pollCommand: "",
    pollIntervalMs: 0,
    actions: [],
  },
  {
    id: "dbping",
    label: "Database Ping",
    description: "pg_isready, redis-cli, and mysqladmin presets.",
    detectCommand: "echo ok",
    pollCommand: "",
    pollIntervalMs: 0,
    actions: [],
  },
  {
    id: "cron",
    label: "Cron & Timers",
    description: "crontab entries and systemd timers.",
    detectCommand: "echo ok",
    pollCommand: "crontab -l 2>/dev/null; echo ---; systemctl list-timers --all --no-pager 2>/dev/null | head -n 30",
    pollIntervalMs: 60000,
    actions: [],
  },
];

/* Shell-quote one interpolated value (single-quote style, safe for any name
 * including spaces, $, backticks, or single quotes). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* Resolve `{placeholders}` against vars, shell-quoting each value. Throws on
 * a missing key so the modal can never show a half-interpolated command. */
export function resolveActionCommand(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    if (value === undefined || value === "") throw new Error(`missing value for {${key}}`);
    return shellQuote(value);
  });
}

/* Run one allowlisted command on a live session via hidden exec. Rejects
 * anything outside the allowlist before touching IPC. */
export async function execOnSession(sessionId: string, command: string): Promise<SshExecResult> {
  if (!isAllowedCommand(command)) throw new Error("command is not allowlisted for tracker execution");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshExecResult>("ssh_exec_command", { sessionId, command: withRemoteEnv(command) });
}

/* Raw variant used ONLY by the verification modal: the command was already
 * reviewed by the user (fully interpolated), so it runs verbatim without the
 * env prefix — executed bytes must equal the shown string. Still allowlisted. */
export async function execReviewedCommand(sessionId: string, reviewedCommand: string): Promise<SshExecResult> {
  if (!isAllowedCommand(reviewedCommand)) throw new Error("command is not allowlisted for tracker execution");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<SshExecResult>("ssh_exec_command", { sessionId, command: reviewedCommand });
}

/* Probe whether a tracker's tool exists on the remote. Returns false when the
 * session is gone, the probe fails, or the tool is absent. */
export async function detectTracker(sessionId: string, tracker: TrackerDefinition): Promise<boolean> {
  try {
    const result = await execOnSession(sessionId, tracker.detectCommand);
    if (tracker.id === "health" || tracker.id === "logs" || tracker.id === "dbping" || tracker.id === "cron") return true;
    return result.exitCode === 0 && result.stdout.trim().endsWith("0");
  } catch {
    return false;
  }
}
