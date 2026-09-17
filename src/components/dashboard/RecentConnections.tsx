import { FolderOpen } from "lucide-react";
import type { RecentConnection } from "../../types";
import { getHostColor } from "./HostCard";
import { relativeTime } from "../../utils/time";

// ─── Props ────────────────────────────────────────────────────────────────────

interface RecentConnectionsProps {
  connections: RecentConnection[];
  /** Opens a terminal session (the chip body). */
  onConnect: (connection: RecentConnection) => void;
  /** Opens a file-explorer session for the same host. */
  onOpenExplorer?: (connection: RecentConnection) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function RecentConnections({
  connections,
  onConnect,
  onOpenExplorer,
}: RecentConnectionsProps) {
  if (connections.length === 0) return null;

  return (
    <section aria-labelledby="recent-heading">
      <h2
        id="recent-heading"
        className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted mb-3"
      >
        Recent
      </h2>

      {/* Horizontal scrollable chip row */}
      <div
        className="flex gap-2 overflow-x-auto pb-1"
        style={{ scrollbarWidth: "none" }}
        role="list"
        aria-label="Recent connections"
      >
        {connections.map((conn) => {
          const displayName = conn.host_label || conn.host;
          const color = getHostColor(conn.host);
          const timestamp = relativeTime(conn.connected_at);

          return (
            // Two sibling actions per chip (terminal + explorer) rather than a
            // nested button, which would be invalid markup.
            <div
              key={`${conn.host_id}-${conn.connected_at}`}
              role="listitem"
              className={[
                "flex items-center shrink-0 rounded-lg",
                "bg-bg-surface border border-border",
                "hover:border-border-focus hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
              ].join(" ")}
            >
              <button
                type="button"
                data-testid={`recent-connection-${conn.host_id}`}
                data-recent-host-id={conn.host_id}
                data-recent-label={displayName}
                onClick={() => onConnect(conn)}
                title={`Reconnect to ${displayName} (${conn.username}@${conn.host}:${conn.port})`}
                className={[
                  "flex items-center gap-2 pl-3 pr-1.5 py-1.5 rounded-l-lg",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                ].join(" ")}
              >
                {/* Status dot */}
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />

                {/* Host label */}
                <span className="text-[length:var(--text-xs)] font-medium text-text-primary max-w-[120px] truncate">
                  {displayName}
                </span>

                {/* Timestamp */}
                <span className="text-[length:var(--text-xs)] text-text-muted whitespace-nowrap">
                  {timestamp}
                </span>
              </button>

              {onOpenExplorer && (
                <button
                  type="button"
                  data-testid={`recent-connection-${conn.host_id}-explorer`}
                  onClick={() => onOpenExplorer(conn)}
                  aria-label={`Open explorer for ${displayName}`}
                  title={`Open file explorer for ${displayName}`}
                  className={[
                    "flex items-center justify-center self-stretch px-1.5 mr-1 my-1 rounded",
                    "text-text-muted hover:text-accent hover:bg-bg-muted",
                    "transition-colors duration-[var(--duration-fast)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  ].join(" ")}
                >
                  <FolderOpen size={13} strokeWidth={1.8} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
