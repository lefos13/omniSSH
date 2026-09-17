/* Tracker views bound to one terminal session. Renders one collapsible card
 * per ENABLED plugin on the host (read from the plugin-config store), each
 * polling its read-only command on its interval. State-changing actions open
 * the verification modal; read-only views (logs tail, probe results) render
 * inline. Gated by the global plugins switch in Settings. */

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Container, TerminalSquare, Cog, ScrollText, Globe, Boxes, Lock, Database, Clock, RefreshCw, ChevronDown, Play, Maximize2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { TRACKERS, execOnSession, resolveActionCommand, shellQuote, type TrackerId } from "../../lib/trackers";
import { useTrackerPoll } from "../../hooks/use-tracker-poll";
import { usePluginConfigStore } from "../../stores/plugin-config-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useSessionStore } from "../../stores/session-store";
import { ActionVerificationModal, type PendingAction } from "./ActionVerificationModal";

const ICONS: Record<TrackerId, LucideIcon> = {
  health: Activity,
  docker: Container,
  pm2: TerminalSquare,
  systemd: Cog,
  logs: ScrollText,
  http: Globe,
  k8s: Boxes,
  ssl: Lock,
  dbping: Database,
  cron: Clock,
};

const cardClass = "rounded-xl bg-bg-surface border border-border/50 overflow-hidden";
const headerBtnClass = "w-full flex items-center gap-2.5 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const bodyClass = "px-4 pb-3";
const monoClass = "font-mono text-[length:var(--text-xs)]";
const mutedClass = "text-[length:var(--text-xs)] text-text-muted";
const errorClass = "text-[length:var(--text-xs)] text-status-error";
const actionBtnClass = "px-2.5 py-1 rounded-md text-[length:var(--text-xs)] font-medium bg-bg-base border border-border text-text-secondary hover:text-text-primary hover:border-border-focus transition-all duration-[var(--duration-fast)]";
const refreshBtnClass = "inline-flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-bg-muted transition-colors";

function Card({ icon: Icon, title, testId, onRefresh, refreshing, children }: {
  icon: LucideIcon; title: string; testId: string;
  onRefresh?: () => void; refreshing?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className={cardClass} data-testid={testId}>
      <button type="button" className={headerBtnClass} onClick={() => setOpen((o) => !o)}
        aria-expanded={open} data-testid={`${testId}-toggle`}>
        <Icon size={15} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="flex-1 text-[length:var(--text-sm)] font-medium text-text-primary">{title}</span>
        {onRefresh && (
          <span role="button" tabIndex={0} data-testid={`${testId}-refresh`}
            aria-label={`Refresh ${title}`}
            onClick={(e) => { e.stopPropagation(); onRefresh(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onRefresh(); } }}
            className={refreshBtnClass}>
            <RefreshCw size={12} strokeWidth={2} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
          </span>
        )}
        <ChevronDown size={14} className={`shrink-0 text-text-muted transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
      </button>
      {open && <div className={bodyClass}>{children}</div>}
    </section>
  );
}

function useActionRunner(sessionId: string | null, hostLabel: string) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = (template: string, vars: Record<string, string>, label: string) => {
    try {
      setNotice(null);
      setPending({ command: resolveActionCommand(template, vars), label, hostLabel });
    } catch {
      setNotice("Missing value for action — cannot build command.");
    }
  };
  const modal = (
    <>
      {notice && <p role="status" className={mutedClass}>{notice}</p>}
      <ActionVerificationModal action={pending} sessionId={sessionId}
        onClose={() => setPending(null)} onExecuted={(out) => setNotice(out.trim().slice(0, 300) || "Done.")} />
    </>
  );
  return { request, modal, notice, setNotice };
}

/* ─── Health ─── */

interface HealthMetrics {
  cpuPct: number | null;
  load1: string;
  memUsed: number;
  memTotal: number;
  memPct: number | null;
  diskPct: number | null;
  disk: string;
  uptime: string;
}

/* Color ramp shared by every percentage bar: green < 60, amber < 85, red. */
function pctColor(pct: number | null): string {
  if (pct === null) return "bg-text-muted";
  if (pct < 60) return "bg-status-connected";
  if (pct < 85) return "bg-status-connecting";
  return "bg-status-error";
}

function pctText(pct: number | null): string {
  if (pct === null) return "text-text-muted";
  if (pct < 60) return "text-status-connected";
  if (pct < 85) return "text-status-connecting";
  return "text-status-error";
}

function HealthBar({ pct, testId }: { pct: number | null; testId: string }) {
  return (
    <div className="h-1.5 rounded-full bg-bg-muted overflow-hidden" data-testid={testId} data-pct={pct ?? "unknown"}>
      <div className={`h-full rounded-full transition-[width] ${pctColor(pct)}`} style={{ width: `${pct ?? 0}%` }} />
    </div>
  );
}

function parseHealth(stdout: string): HealthMetrics {
  const sections = stdout.split("---").map((s) => s.trim());
  const cpus = parseInt(sections[0]?.split(/\s+/)[0] ?? "", 10) || null;
  const load1 = sections[1]?.split(/\s+/)[0] ?? "?";
  const cpuPct = cpus && cpus > 0 ? Math.min(100, Math.round((parseFloat(load1) / cpus) * 100)) : null;
  const memLine = (sections[2] ?? "").split("\n").find((l) => l.startsWith("Mem:")) ?? "";
  const memParts = memLine.split(/\s+/);
  const memTotal = Number(memParts[1]) || 0;
  const memUsed = Number(memParts[2]) || 0;
  const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : null;
  const dfLine = (sections[3] ?? "").split("\n").find((l) => l.startsWith("/dev/") || l.includes(" /")) ?? "";
  const dfParts = dfLine.split(/\s+/);
  const usePct = dfParts.find((p) => p.endsWith("%"));
  const diskPct = usePct ? parseInt(usePct, 10) || null : null;
  return {
    cpuPct,
    load1,
    memUsed,
    memTotal,
    memPct,
    diskPct,
    disk: dfParts.slice(-2).join(" ") || "?",
    uptime: (sections[4] ?? "").split("\n")[0]?.trim() || "?",
  };
}

function HealthCard({ sessionId, hostLabel }: { sessionId: string; hostLabel: string }) {
  const def = TRACKERS.find((t) => t.id === "health")!;
  const poll = useTrackerPoll(sessionId, def.pollCommand, def.pollIntervalMs, (r) => parseHealth(r.stdout));
  const runner = useActionRunner(sessionId, hostLabel);
  const [pid, setPid] = useState("");
  return (
    <Card icon={ICONS.health} title="Server Health" testId="tracker-health" onRefresh={poll.refresh} refreshing={poll.refreshing}>
      {poll.error ? <p className={errorClass}>{poll.error}</p>
      : !poll.data ? <p className={mutedClass}>Collecting metrics…</p>
      : (
        <div className="flex flex-col gap-2.5">
          <div>
            <div className="flex items-baseline justify-between">
              <span className={mutedClass}>CPU</span>
              <span className={`${monoClass} font-medium ${pctText(poll.data.cpuPct)}`} data-testid="tracker-health-cpu-pct">
                {poll.data.cpuPct === null ? `load ${poll.data.load1}` : `${poll.data.cpuPct}%`}
              </span>
            </div>
            <HealthBar pct={poll.data.cpuPct} testId="tracker-health-cpu-bar" />
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <span className={mutedClass}>Memory</span>
              <span className={`${monoClass} font-medium ${pctText(poll.data.memPct)}`} data-testid="tracker-health-mem-pct">
                {poll.data.memPct === null ? `${poll.data.memUsed} / ${poll.data.memTotal} MB` : `${poll.data.memPct}% · ${poll.data.memUsed} / ${poll.data.memTotal} MB`}
              </span>
            </div>
            <HealthBar pct={poll.data.memPct} testId="tracker-health-mem-bar" />
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <span className={mutedClass}>Disk (/)</span>
              <span className={`${monoClass} font-medium ${pctText(poll.data.diskPct)}`} data-testid="tracker-health-disk-pct">
                {poll.data.diskPct === null ? poll.data.disk : `${poll.data.diskPct}% · ${poll.data.disk}`}
              </span>
            </div>
            <HealthBar pct={poll.data.diskPct} testId="tracker-health-disk-bar" />
          </div>
          <p className={`${mutedClass} font-mono`}>up {poll.data.uptime}</p>
        </div>
      )}
      <div className="flex items-center gap-2 mt-2.5">
        <input aria-label="Process ID" placeholder="PID" inputMode="numeric" value={pid}
          onChange={(e) => setPid(e.target.value)}
          data-testid="tracker-health-pid"
          className="w-24 px-2 py-1 rounded-md bg-bg-base border border-border text-text-primary text-[length:var(--text-xs)] font-mono outline-none focus:border-border-focus" />
        <button type="button" data-testid="tracker-health-kill" className={actionBtnClass}
          onClick={() => runner.request("kill {pid}", { pid: pid.trim() }, "Kill process")}>
          Kill process…
        </button>
      </div>
      {runner.modal}
    </Card>
  );
}

/* ─── Docker ─── */

interface DockerContainer { ID: string; Names: string; Image: string; State: string; Status: string }

function parseDockerPs(stdout: string): DockerContainer[] {
  const out: DockerContainer[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as DockerContainer);
    } catch { /* skip malformed lines */ }
  }
  return out;
}

function DockerCard({ sessionId, hostLabel }: { sessionId: string; hostLabel: string }) {
  const def = TRACKERS.find((t) => t.id === "docker")!;
  const poll = useTrackerPoll(sessionId, def.pollCommand, def.pollIntervalMs, (r) => parseDockerPs(r.stdout));
  const runner = useActionRunner(sessionId, hostLabel);
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  const showLogs = async (name: string) => {
    try {
      const r = await execOnSession(sessionId, `docker logs --tail 200 ${shellQuote(name)} 2>&1`);
      setLogs({ name, text: r.stdout || "(no logs)" });
    } catch (e) {
      setLogs({ name, text: e instanceof Error ? e.message : "Failed to fetch logs" });
    }
  };
  const rows = poll.data ?? [];
  return (
    <Card icon={ICONS.docker} title="Docker" testId="tracker-docker" onRefresh={poll.refresh} refreshing={poll.refreshing}>
      {poll.error ? <p className={errorClass}>{poll.error}</p>
      : !poll.data ? <p className={mutedClass}>Listing containers…</p>
      : rows.length === 0 ? <p className={mutedClass}>No containers running.</p>
      : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((c) => (
            <li key={c.ID || c.Names} data-testid={`tracker-docker-row-${c.Names}`}
              className="flex items-center gap-2 rounded-lg bg-bg-base border border-border/50 px-2.5 py-1.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.State === "running" ? "bg-status-connected" : "bg-text-muted"}`} aria-hidden="true" />
              <span className="flex-1 min-w-0">
                <span className={`${monoClass} text-text-primary block truncate`}>{c.Names}</span>
                <span className={`${mutedClass} block truncate`}>{c.Image} · {c.Status}</span>
              </span>
              <button type="button" className={actionBtnClass} data-testid={`tracker-docker-logs-${c.Names}`}
                onClick={() => void showLogs(c.Names)}>Logs</button>
              <button type="button" className={actionBtnClass} data-testid={`tracker-docker-restart-${c.Names}`}
                onClick={() => runner.request("docker restart {name}", { name: c.Names }, "Restart container")}>Restart…</button>
              <button type="button" className={actionBtnClass} data-testid={`tracker-docker-stop-${c.Names}`}
                onClick={() => runner.request("docker stop {name}", { name: c.Names }, "Stop container")}>Stop…</button>
            </li>
          ))}
        </ul>
      )}
      {logs && (
        <div className="mt-2 rounded-lg bg-bg-base border border-border/50 p-2.5" data-testid="tracker-docker-logs-view">
          <p className={`${monoClass} text-text-secondary mb-1`}>logs — {logs.name}</p>
          <pre className={`${monoClass} text-text-primary whitespace-pre-wrap break-all max-h-48 overflow-y-auto`}>{logs.text}</pre>
          <button type="button" className={`${actionBtnClass} mt-1.5`} onClick={() => setLogs(null)}>Close</button>
        </div>
      )}
      {runner.modal}
    </Card>
  );
}

/* ─── PM2 ─── */

interface Pm2Proc { name: string; pm_id: number; status: string; cpu: number; memory: number }

function parsePm2(stdout: string): Pm2Proc[] {
  const trimmed = stdout.trim();
  /* Fallback paths when `pm2` isn't on the non-interactive PATH: the daemon
   * dump is a JSON array with `name`/`pm_id`, the pids dir is one file per
   * process. Either beats "command not found" with zero signal. */
  if (trimmed === "PM2_NOT_FOUND") throw new Error("pm2 not found on PATH and no ~/.pm2 dump or pids found");
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
    return trimmed.split("\n").map((l) => l.trim()).filter(Boolean).map((name) => ({
      name: name.replace(/\.pid$/, ""), pm_id: -1, status: "unknown", cpu: 0, memory: 0,
    }));
  }
  try {
    const arr = JSON.parse(stdout) as { name: string; pm_id: number; pm2_env?: { status?: string }; monit?: { cpu?: number; memory?: number } }[];
    if (!Array.isArray(arr)) return [];
    return arr.map((p) => ({
      name: p.name, pm_id: p.pm_id,
      status: p.pm2_env?.status ?? "?",
      cpu: p.monit?.cpu ?? 0, memory: p.monit?.memory ?? 0,
    }));
  } catch {
    return [];
  }
}

function Pm2Card({ sessionId, hostLabel }: { sessionId: string; hostLabel: string }) {
  const def = TRACKERS.find((t) => t.id === "pm2")!;
  const poll = useTrackerPoll(sessionId, def.pollCommand, def.pollIntervalMs, (r) => {
    /* A stale pm2 wrapper (nvm shim printing usage to stdout with exit 0)
     * yields non-JSON output; surface the hint instead of an empty list. */
    if (r.exitCode !== 0) {
      const hint = (r.stderr || r.stdout).trim();
      throw new Error(hint || `pm2 exited with ${r.exitCode}`);
    }
    return parsePm2(r.stdout);
  });
  const runner = useActionRunner(sessionId, hostLabel);
  const rows = poll.data ?? [];
  return (
    <Card icon={ICONS.pm2} title="PM2" testId="tracker-pm2" onRefresh={poll.refresh} refreshing={poll.refreshing}>
      {poll.error ? <p className={errorClass}>{poll.error}</p>
      : !poll.data ? <p className={mutedClass}>Listing processes…</p>
      : rows.length === 0 ? <p className={mutedClass}>No PM2 processes. Start one with `pm2 start app.js` in the terminal.</p>
      : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((p) => (
            <li key={`${p.name}-${p.pm_id}`} data-testid={`tracker-pm2-row-${p.name}`}
              className="flex items-center gap-2 rounded-lg bg-bg-base border border-border/50 px-2.5 py-1.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.status === "online" ? "bg-status-connected" : "bg-status-error"}`} aria-hidden="true" />
              <span className="flex-1 min-w-0">
                <span className={`${monoClass} text-text-primary block truncate`}>{p.name} <span className={mutedClass}>#{p.pm_id}</span></span>
                <span className={`${mutedClass} block`}>{p.status} · cpu {p.cpu}% · {(p.memory / 1048576).toFixed(0)} MB</span>
              </span>
              <button type="button" className={actionBtnClass} data-testid={`tracker-pm2-restart-${p.name}`}
                onClick={() => runner.request("pm2 restart {name}", { name: p.name }, "Restart process")}>Restart…</button>
              <button type="button" className={actionBtnClass} data-testid={`tracker-pm2-stop-${p.name}`}
                onClick={() => runner.request("pm2 stop {name}", { name: p.name }, "Stop process")}>Stop…</button>
            </li>
          ))}
        </ul>
      )}
      {runner.modal}
    </Card>
  );
}

/* ─── systemd ─── */

function SystemdCard({ sessionId, hostLabel }: { sessionId: string; hostLabel: string }) {
  const def = TRACKERS.find((t) => t.id === "systemd")!;
  const poll = useTrackerPoll(sessionId, def.pollCommand, def.pollIntervalMs, (r) => {
    try {
      const v: unknown = JSON.parse(r.stdout);
      return Array.isArray(v) ? (v as { unit?: string; load?: string }[]).slice(0, 50) : [];
    } catch {
      return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 50).map((unit) => ({ unit }));
    }
  });
  const runner = useActionRunner(sessionId, hostLabel);
  const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);
  const showLogs = async (unit: string) => {
    try {
      const r = await execOnSession(sessionId, `journalctl -u ${shellQuote(unit)} -n 200 --no-pager 2>&1`);
      setLogs({ name: unit, text: r.stdout || "(no logs)" });
    } catch (e) {
      setLogs({ name: unit, text: e instanceof Error ? e.message : "Failed to fetch logs" });
    }
  };
  const rows = poll.data ?? [];
  return (
    <Card icon={ICONS.systemd} title="systemd Services" testId="tracker-systemd" onRefresh={poll.refresh} refreshing={poll.refreshing}>
      {poll.error ? <p className={errorClass}>{poll.error}</p>
      : !poll.data ? <p className={mutedClass}>Listing services…</p>
      : rows.length === 0 ? <p className={mutedClass}>No running services found.</p>
      : (
        <ul className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
          {rows.map((s, i) => {
            const unit = s.unit ?? `unit-${i}`;
            return (
              <li key={unit} data-testid={`tracker-systemd-row-${unit}`}
                className="flex items-center gap-2 rounded-lg bg-bg-base border border-border/50 px-2.5 py-1.5">
                <span className={`${monoClass} text-text-primary flex-1 min-w-0 truncate`}>{unit}</span>
                <button type="button" className={actionBtnClass} onClick={() => void showLogs(unit)}>Logs</button>
                <button type="button" className={actionBtnClass} data-testid={`tracker-systemd-restart-${unit}`}
                  onClick={() => runner.request("systemctl restart {name}", { name: unit }, "Restart service")}>Restart…</button>
              </li>
            );
          })}
        </ul>
      )}
      {logs && (
        <div className="mt-2 rounded-lg bg-bg-base border border-border/50 p-2.5" data-testid="tracker-systemd-logs-view">
          <p className={`${monoClass} text-text-secondary mb-1`}>journal — {logs.name}</p>
          <pre className={`${monoClass} text-text-primary whitespace-pre-wrap break-all max-h-48 overflow-y-auto`}>{logs.text}</pre>
          <button type="button" className={`${actionBtnClass} mt-1.5`} onClick={() => setLogs(null)}>Close</button>
        </div>
      )}
      {runner.modal}
    </Card>
  );
}

/* ─── Log viewer (on demand) ─── */

function LogsCard({ sessionId, initialPath }: { sessionId: string; initialPath?: string }) {
  const rows = usePluginConfigStore((s) => {
    const sid = useSessionStore.getState().sessions.get(sessionId)?.hostConfig.savedHostId;
    return (sid ? s.byHostId[sid]?.logs : undefined);
  });
  const [path, setPath] = useState(initialPath ?? "");
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  /* Tail output in-place so the deep-link's auto-tail and the button share
   * one code path; `target` is the exact path to read (avoids stale state). */
  const runTail = async (target: string) => {
    const trimmed = target.trim();
    if (!trimmed) { setError("Enter a log path or journald unit."); return; }
    setBusy(true);
    setError(null);
    try {
      const cmd = trimmed.endsWith(".service")
        ? `journalctl -u ${shellQuote(trimmed)} -n 200 --no-pager 2>&1`
        : `tail -n 200 ${shellQuote(trimmed)} 2>&1`;
      const r = await execOnSession(sessionId, cmd);
      setText(r.stdout || "(empty)");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read log");
    } finally {
      setBusy(false);
    }
  };
  const tail = () => runTail(path);
  useEffect(() => {
    const cfg = rows?.config as { path?: unknown } | undefined;
    if (!initialPath && typeof cfg?.path === "string") setPath(cfg.path);
  }, [rows, initialPath]);
  /* Deep link from "Tail log in Plugins": prime the path and auto-trigger
   * the tail so output is already loaded. One-shot per distinct path. */
  const autoTailedRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialPath && autoTailedRef.current !== initialPath) {
      autoTailedRef.current = initialPath;
      setPath(initialPath);
      setText(null);
      setError(null);
      void runTail(initialPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);
  useEffect(() => {
    if (!expanded) return;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);
  const output = text !== null && (
    <pre data-testid="tracker-logs-view" className={`${monoClass} mt-2 text-text-primary bg-bg-base border border-border/50 rounded-lg p-2.5 whitespace-pre-wrap break-all ${expanded ? "flex-1 min-h-0 overflow-y-auto max-h-none" : "max-h-56 overflow-y-auto"}`}>{text}</pre>
  );
  return (
    <Card icon={ICONS.logs} title="Log Viewer" testId="tracker-logs">
      <div className="flex items-center gap-2">
        <input aria-label="Log path or unit" placeholder="/var/log/app.log or nginx.service" value={path}
          onChange={(e) => setPath(e.target.value)} data-testid="tracker-logs-path"
          className="flex-1 px-2 py-1 rounded-md bg-bg-base border border-border text-text-primary text-[length:var(--text-xs)] font-mono outline-none focus:border-border-focus" />
        <button type="button" data-testid="tracker-logs-tail" disabled={busy} onClick={() => void tail()} className={actionBtnClass}>
          {busy ? "Reading…" : "Tail"}
        </button>
        <button type="button" data-testid="tracker-logs-expand" onClick={() => setExpanded(true)}
          title="Open fullscreen" aria-label="Open log viewer fullscreen" className={refreshBtnClass}>
          <Maximize2 size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {error && <p className={errorClass} role="alert">{error}</p>}
      {output}
      {expanded && (
        <div data-testid="tracker-logs-fullscreen" role="dialog" aria-modal="true" aria-label="Log viewer fullscreen"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 sm:p-8"
          onClick={() => setExpanded(false)}>
          <div className="flex flex-col w-full max-w-5xl h-full max-h-[90vh] rounded-xl bg-bg-surface border border-border shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60 shrink-0">
              <ScrollText size={15} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden="true" />
              <span className="flex-1 min-w-0 text-[length:var(--text-sm)] font-medium text-text-primary truncate" title={path}>
                {path || "Log Viewer"}
              </span>
              <button type="button" data-testid="tracker-logs-fullscreen-tail" disabled={busy} onClick={() => void tail()} className={actionBtnClass}>
                {busy ? "Reading…" : "Tail"}
              </button>
              <button ref={closeBtnRef} type="button" data-testid="tracker-logs-fullscreen-close" onClick={() => setExpanded(false)}
                title="Close fullscreen" aria-label="Close log viewer fullscreen" className={refreshBtnClass}>
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 min-h-0 flex flex-col px-4 pb-4 overflow-hidden">
              {error && <p className={`${errorClass} mt-2`} role="alert">{error}</p>}
              {output ?? <p className={`${mutedClass} mt-2`}>No output yet — press Tail to read the log.</p>}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ─── HTTP probe (on demand) ─── */

function HttpCard({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const savedHostId = session?.hostConfig.savedHostId;
  const stored = usePluginConfigStore((s) => (savedHostId ? s.byHostId[savedHostId]?.http : undefined));
  const [port, setPort] = useState("8080");
  const [path, setPath] = useState("/actuator/health");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const cfg = stored?.config as { port?: unknown; path?: unknown } | undefined;
    if (typeof cfg?.port !== "undefined" && cfg.port !== "") setPort(String(cfg.port));
    if (typeof cfg?.path === "string" && cfg.path) setPath(cfg.path);
  }, [stored]);
  const probe = async (preset: "actuator" | "prometheus") => {
    setBusy(true);
    setError(null);
    try {
      const p = port.trim() || "8080";
      if (!/^\d+$/.test(p)) throw new Error("Port must be numeric.");
      const cmd = preset === "actuator"
        ? `curl -sS -m 10 http://localhost:${p}${path.startsWith("/") ? path : `/${path}`} 2>&1`
        : `curl -sS -m 10 http://localhost:${p}/metrics 2>&1 | head -n 40`;
      const r = await execOnSession(sessionId, cmd);
      setResult(r.stdout || "(empty response)");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Probe failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card icon={ICONS.http} title="HTTP Health Probe" testId="tracker-http">
      <div className="flex items-center gap-2">
        <input aria-label="Port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric"
          data-testid="tracker-http-port" placeholder="8080"
          className="w-20 px-2 py-1 rounded-md bg-bg-base border border-border text-text-primary text-[length:var(--text-xs)] font-mono outline-none focus:border-border-focus" />
        <input aria-label="Health path" value={path} onChange={(e) => setPath(e.target.value)}
          data-testid="tracker-http-path" placeholder="/actuator/health"
          className="flex-1 px-2 py-1 rounded-md bg-bg-base border border-border text-text-primary text-[length:var(--text-xs)] font-mono outline-none focus:border-border-focus" />
      </div>
      <div className="flex items-center gap-2 mt-2">
        <button type="button" data-testid="tracker-http-probe" disabled={busy} onClick={() => void probe("actuator")} className={actionBtnClass}>
          {busy ? "Probing…" : "Probe health"}
        </button>
        <button type="button" data-testid="tracker-http-metrics" disabled={busy} onClick={() => void probe("prometheus")} className={actionBtnClass}>
          Scrape /metrics
        </button>
      </div>
      {error && <p className={errorClass} role="alert">{error}</p>}
      {result !== null && (
        <pre data-testid="tracker-http-view" className={`${monoClass} mt-2 text-text-primary bg-bg-base border border-border/50 rounded-lg p-2.5 whitespace-pre-wrap break-all max-h-56 overflow-y-auto`}>{result}</pre>
      )}
    </Card>
  );
}

/* ─── Kubernetes ─── */

interface K8sPod { name: string; status: string; restarts: string }

function parseK8s(stdout: string): K8sPod[] {
  try {
    const v = JSON.parse(stdout) as { items?: { metadata?: { name?: string }; status?: { phase?: string; containerStatuses?: { restartCount?: number }[] } }[] };
    return (v.items ?? []).map((i) => ({
      name: i.metadata?.name ?? "?",
      status: i.status?.phase ?? "?",
      restarts: String(i.status?.containerStatuses?.reduce((a, c) => a + (c.restartCount ?? 0), 0) ?? 0),
    }));
  } catch {
    return [];
  }
}

function K8sCard({ sessionId, hostLabel }: { sessionId: string; hostLabel: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const savedHostId = session?.hostConfig.savedHostId;
  const stored = usePluginConfigStore((s) => (savedHostId ? s.byHostId[savedHostId]?.k8s : undefined));
  const ns = useMemo(() => {
    const cfg = stored?.config as { namespace?: unknown; context?: unknown } | undefined;
    const parts: string[] = [];
    if (typeof cfg?.context === "string" && cfg.context) parts.push(`--context ${shellQuote(cfg.context)}`);
    if (typeof cfg?.namespace === "string" && cfg.namespace) parts.push(`-n ${shellQuote(cfg.namespace)}`);
    return parts.join(" ");
  }, [stored]);
  const base = ns ? `kubectl ${ns}` : "kubectl";
  const poll = useTrackerPoll(sessionId, `${base} get pods -o json`, 15000, (r) => parseK8s(r.stdout));
  const runner = useActionRunner(sessionId, hostLabel);
  const rows = poll.data ?? [];
  return (
    <Card icon={ICONS.k8s} title="Kubernetes" testId="tracker-k8s" onRefresh={poll.refresh} refreshing={poll.refreshing}>
      {poll.error ? <p className={errorClass}>{poll.error}</p>
      : !poll.data ? <p className={mutedClass}>Listing pods…</p>
      : rows.length === 0 ? <p className={mutedClass}>No pods found.</p>
      : (
        <ul className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
          {rows.map((p) => (
            <li key={p.name} data-testid={`tracker-k8s-row-${p.name}`}
              className="flex items-center gap-2 rounded-lg bg-bg-base border border-border/50 px-2.5 py-1.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.status === "Running" ? "bg-status-connected" : "bg-status-error"}`} aria-hidden="true" />
              <span className="flex-1 min-w-0">
                <span className={`${monoClass} text-text-primary block truncate`}>{p.name}</span>
                <span className={`${mutedClass} block`}>{p.status} · restarts {p.restarts}</span>
              </span>
              <button type="button" className={actionBtnClass} data-testid={`tracker-k8s-restart-${p.name}`}
                onClick={() => runner.request(`${base} delete pod {name}`, { name: p.name }, "Delete pod (recreate via controller)")}>Delete…</button>
            </li>
          ))}
        </ul>
      )}
      {runner.modal}
    </Card>
  );
}

/* ─── SSL / DB ping / cron (lightweight on-demand cards) ─── */

function SslCard({ sessionId }: { sessionId: string }) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("443");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const h = host.trim();
      if (!h) throw new Error("Enter a TLS host.");
      const p = port.trim() || "443";
      if (!/^\d+$/.test(p)) throw new Error("Port must be numeric.");
      if (!/^[A-Za-z0-9.-]+$/.test(h)) throw new Error("Invalid host name.");
      const cmd = `echo | openssl s_client -connect ${h}:${p} -servername ${h} 2>/dev/null | openssl x509 -noout -dates -subject 2>&1`;
      const r = await execOnSession(sessionId, cmd);
      setResult(r.stdout || "(no output)");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card icon={ICONS.ssl} title="SSL & Ports" testId="tracker-ssl">
      <div className="flex items-center gap-2">
        <input aria-label="TLS host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com"
          data-testid="tracker-ssl-host"
          className="flex-1 px-2 py-1 rounded-md bg-bg-base border border-border text-text-primary text-[length:var(--text-xs)] font-mono outline-none focus:border-border-focus" />
        <input aria-label="TLS port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric"
          data-testid="tracker-ssl-port" placeholder="443"
          className="w-20 px-2 py-1 rounded-md bg-bg-base border border-border text-text-primary text-[length:var(--text-xs)] font-mono outline-none focus:border-border-focus" />
        <button type="button" data-testid="tracker-ssl-check" disabled={busy} onClick={() => void check()} className={actionBtnClass}>
          {busy ? "Checking…" : "Check"}
        </button>
      </div>
      {error && <p className={errorClass} role="alert">{error}</p>}
      {result !== null && (
        <pre data-testid="tracker-ssl-view" className={`${monoClass} mt-2 text-text-primary bg-bg-base border border-border/50 rounded-lg p-2.5 whitespace-pre-wrap break-all max-h-40 overflow-y-auto`}>{result}</pre>
      )}
    </Card>
  );
}

function DbPingCard({ sessionId }: { sessionId: string }) {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ping = async (kind: "postgres" | "redis" | "mysql") => {
    setBusy(true);
    setError(null);
    try {
      const cmd = kind === "postgres"
        ? "command -v pg_isready >/dev/null 2>&1 && pg_isready 2>&1 || echo 'pg_isready not installed'"
        : kind === "redis"
          ? "command -v redis-cli >/dev/null 2>&1 && redis-cli ping 2>&1 || echo 'redis-cli not installed'"
          : "command -v mysqladmin >/dev/null 2>&1 && mysqladmin ping 2>&1 || echo 'mysqladmin not installed'";
      const r = await execOnSession(sessionId, cmd);
      setResult(r.stdout || "(no output)");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ping failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card icon={ICONS.dbping} title="Database Ping" testId="tracker-dbping">
      <div className="flex items-center gap-2">
        {(["postgres", "redis", "mysql"] as const).map((k) => (
          <button key={k} type="button" data-testid={`tracker-dbping-${k}`} disabled={busy}
            onClick={() => void ping(k)} className={actionBtnClass}>
            {k === "postgres" ? "Postgres" : k === "redis" ? "Redis" : "MySQL"}
          </button>
        ))}
      </div>
      {error && <p className={errorClass} role="alert">{error}</p>}
      {result !== null && (
        <pre data-testid="tracker-dbping-view" className={`${monoClass} mt-2 text-text-primary bg-bg-base border border-border/50 rounded-lg p-2.5 whitespace-pre-wrap break-all`}>{result}</pre>
      )}
    </Card>
  );
}

function CronCard({ sessionId }: { sessionId: string }) {
  const def = TRACKERS.find((t) => t.id === "cron")!;
  const poll = useTrackerPoll(sessionId, def.pollCommand, def.pollIntervalMs, (r) => r.stdout);
  return (
    <Card icon={ICONS.cron} title="Cron & Timers" testId="tracker-cron" onRefresh={poll.refresh} refreshing={poll.refreshing}>
      {poll.error ? <p className={errorClass}>{poll.error}</p>
      : poll.data === null ? <p className={mutedClass}>Reading schedules…</p>
      : (
        <pre data-testid="tracker-cron-view" className={`${monoClass} text-text-primary bg-bg-base border border-border/50 rounded-lg p-2.5 whitespace-pre-wrap break-all max-h-56 overflow-y-auto`}>{poll.data || "(no cron entries or timers)"}</pre>
      )}
    </Card>
  );
}

/* ─── View ─── */

export function PluginTrackersView({ sessionId, initialLogPath }: { sessionId: string; initialLogPath?: string }) {
  const pluginsEnabled = useSettingsStore((s) => s.pluginsEnabled);
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const savedHostId = session?.hostConfig.savedHostId ?? null;
  const rows = usePluginConfigStore((s) => (savedHostId ? s.byHostId[savedHostId] : undefined));
  const loadForHost = usePluginConfigStore((s) => s.loadForHost);
  const connected = session?.status === "Connected";
  const hostLabel = session?.hostConfig.label || session?.hostConfig.host || "host";

  useEffect(() => {
    if (savedHostId) void loadForHost(savedHostId);
  }, [savedHostId, loadForHost]);

  const enabledIds = useMemo(
    () => (Object.entries(rows ?? {}).filter(([, r]) => r.enabled).map(([id]) => id)),
    [rows],
  );

  if (!pluginsEnabled || !connected || enabledIds.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 p-2" data-testid="plugin-trackers-view">
      <p className={`${mutedClass} px-1 flex items-center gap-1.5`}>
        <Play size={11} aria-hidden="true" /> Trackers for {hostLabel} — actions ask for review first.
      </p>
      {enabledIds.includes("health") && <HealthCard sessionId={sessionId} hostLabel={hostLabel} />}
      {enabledIds.includes("docker") && <DockerCard sessionId={sessionId} hostLabel={hostLabel} />}
      {enabledIds.includes("pm2") && <Pm2Card sessionId={sessionId} hostLabel={hostLabel} />}
      {enabledIds.includes("systemd") && <SystemdCard sessionId={sessionId} hostLabel={hostLabel} />}
      {enabledIds.includes("logs") && <LogsCard sessionId={sessionId} initialPath={initialLogPath} />}
      {enabledIds.includes("http") && <HttpCard sessionId={sessionId} />}
      {enabledIds.includes("k8s") && <K8sCard sessionId={sessionId} hostLabel={hostLabel} />}
      {enabledIds.includes("ssl") && <SslCard sessionId={sessionId} />}
      {enabledIds.includes("dbping") && <DbPingCard sessionId={sessionId} />}
      {enabledIds.includes("cron") && <CronCard sessionId={sessionId} />}
    </div>
  );
}
