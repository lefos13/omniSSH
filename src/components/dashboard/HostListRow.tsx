import { useState } from "react";
import { Activity, Pencil, TerminalSquare, Copy, Trash2, FolderOpen, Waypoints } from "lucide-react";
import { CardActionButton } from "./CardActionButton";
import { relativeTime } from "../../utils/time";
import { ContextMenu } from "../shared/ContextMenu";
import { ConfirmDangerDialog } from "../shared/ConfirmDangerDialog";
import { useHealthStore, IDLE_HEALTH } from "../../stores/health-store";
import { useHostsStore } from "../../stores/hosts-store";
import {
  getHostColor,
  statusColor,
  ENV_BADGE_CLASSES,
  ENV_LABELS,
  isEnvironmentValue,
  type HostCardProps,
} from "./HostCard";

/* Compact horizontal list row for the Hosts dashboard, providing an alternative
 * to the card grid. Preserves full interactive parity with HostCard including
 * click-to-connect, drag-and-drop handles, action buttons, context menu, and
 * health status reporting. */
export function HostListRow({
  host,
  onConnect,
  onExplore,
  onEdit,
  onDelete,
  onDuplicate,
}: HostCardProps) {
  const displayName = host.label || host.host;
  const avatarColor = host.color || getHostColor(host.host);
  const initial = displayName.charAt(0).toUpperCase();

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const health = useHealthStore((s) => s.byHostId[host.id] ?? IDLE_HEALTH);
  const checkHealth = useHealthStore((s) => s.checkHealth);

  const jumpHost = useHostsStore((s) =>
    host.proxy_jump_host_id
      ? s.hosts.find((h) => h.id === host.proxy_jump_host_id) ?? null
      : null,
  );
  const jumpLabel = jumpHost ? jumpHost.label || jumpHost.host : null;

  const subtitleParts: string[] = [`SSH, ${host.username}`];
  if (host.os_type) {
    const osLabels: Record<string, string> = {
      linux: "Linux",
      macos: "macOS",
      windows: "Windows",
      freebsd: "FreeBSD",
    };
    subtitleParts.push(osLabels[host.os_type] ?? host.os_type);
  }
  const lastSeen = host.last_connected_at ? relativeTime(host.last_connected_at) : null;
  if (lastSeen) subtitleParts.push(lastSeen);

  const subtitle = subtitleParts.join(" · ");
  const env = host.environment && isEnvironmentValue(host.environment) ? host.environment : null;

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const contextItems = [
    {
      label: "Ping",
      icon: Activity,
      onClick: () => void checkHealth(host.id),
    },
    {
      label: "Terminal",
      icon: TerminalSquare,
      onClick: () => onConnect(host),
    },
    {
      label: "Explorer",
      icon: FolderOpen,
      onClick: () => onExplore(host),
    },
    {
      label: "Edit",
      icon: Pencil,
      onClick: () => onEdit(host.id),
    },
    {
      label: "Duplicate",
      icon: Copy,
      onClick: () => onDuplicate(host),
    },
    {
      label: "Delete",
      icon: Trash2,
      danger: true,
      onClick: () => setConfirmDelete(true),
    },
  ];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onConnect(host);
    }
  };

  const healthLabel = (() => {
    if (health.status === "idle") return null;
    if (health.status === "checking") return "Pinging...";
    const latency = health.latencyMs !== null ? ` · ${health.latencyMs}ms` : "";
    if (health.status === "reachable") return `SSH reachable${latency}`;
    if (health.status === "dnsFailed") return "DNS failed";
    if (health.status === "portClosed") return "Port unreachable";
    if (health.status === "sshFailed") return "SSH failed";
    return "Ping failed";
  })();

  const ipPreview = host.label ? `${host.host}${host.port && host.port !== 22 ? `:${host.port}` : ""}` : null;

  return (
    <>
      <div
        data-testid={`host-card-${host.id}`}
        data-host-id={host.id}
        data-host-label={displayName}
        role="button"
        tabIndex={0}
        onClick={() => onConnect(host)}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        title={`Connect to ${displayName}`}
        className={[
          "group relative isolate flex items-center justify-between gap-3.5 px-3.5 py-2.5 rounded-xl text-left w-full cursor-grab active:cursor-grabbing",
          "bg-bg-surface border border-border",
          "hover:border-border-focus hover:bg-bg-overlay hover:z-20 focus-within:z-20",
          "transition-[background-color,border-color] duration-[var(--duration-fast)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        ].join(" ")}
      >
        {/* Accent background gradient */}
        <div
          className="absolute inset-0 rounded-xl pointer-events-none -z-10 opacity-60 group-hover:opacity-100 transition-opacity duration-[var(--duration-fast)]"
          style={{
            background: `radial-gradient(circle at left center, ${avatarColor}22, transparent 35%)`,
          }}
          aria-hidden="true"
        />

        {/* Left side: Avatar + Host info */}
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 font-semibold text-[length:var(--text-xs)] select-none"
            style={{
              backgroundColor: `${avatarColor}25`,
              color: avatarColor,
              fontFamily: "var(--font-sans)",
            }}
            aria-hidden="true"
          >
            {initial}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-[length:var(--text-sm)] font-medium text-text-primary truncate leading-tight">
                {displayName}
              </p>
              {ipPreview && (
                <span className="text-[length:var(--text-xs)] text-text-muted font-mono truncate">
                  {ipPreview}
                </span>
              )}
              {env && (
                <span
                  className={[
                    "inline-flex items-center px-1 py-px rounded text-[11px] font-semibold tracking-wide leading-none shrink-0",
                    ENV_BADGE_CLASSES[env],
                  ].join(" ")}
                >
                  {ENV_LABELS[env]}
                </span>
              )}
              {jumpLabel && (
                <span
                  data-testid={`host-card-${host.id}-tunnel`}
                  className="inline-flex items-center gap-1 text-[length:var(--text-xs)] text-text-muted truncate"
                  title={`Tunnels through ${jumpLabel}`}
                >
                  <Waypoints size={11} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">via {jumpLabel}</span>
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-[length:var(--text-xs)] text-text-muted font-mono truncate">
                {subtitle}
              </p>
            </div>
          </div>
        </div>

        {/* Right side: Health status + Action buttons */}
        <div className="flex items-center gap-3 shrink-0">
          <p
            data-testid={`host-card-${host.id}-health-status`}
            role="status"
            aria-live="polite"
            className={[
              "text-[length:var(--text-xs)] font-medium truncate max-w-[140px] hidden sm:block",
              healthLabel ? statusColor(health.status) : "text-transparent",
            ].join(" ")}
            title={health.message ?? undefined}
          >
            {healthLabel ?? ""}
          </p>

          <div className="flex items-center">
            <CardActionButton
              icon={Activity}
              label="Ping"
              onClick={() => void checkHealth(host.id)}
              ariaLabel={`Ping ${displayName}`}
              detail={health.message ?? undefined}
              testId={`host-card-${host.id}-health`}
              disabled={health.status === "checking"}
              busy={health.status === "checking"}
              colorClass={statusColor(health.status)}
            />
            <CardActionButton
              icon={TerminalSquare}
              label="Terminal"
              onClick={() => onConnect(host)}
              ariaLabel={`Open terminal for ${displayName}`}
              testId={`host-card-${host.id}-terminal`}
            />
            <CardActionButton
              icon={FolderOpen}
              label="Explorer"
              onClick={() => onExplore(host)}
              ariaLabel={`Open explorer for ${displayName}`}
              testId={`host-card-${host.id}-explorer`}
            />
          </div>
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          items={contextItems}
          position={contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}

      <ConfirmDangerDialog
        open={confirmDelete}
        title="Delete this host?"
        message="This host will be permanently removed."
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete(host.id);
        }}
      />
    </>
  );
}
