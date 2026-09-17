/*
 * Left-pane source picker for the host explorer.
 *
 * Lets the left pane show the local machine (default) or another saved server,
 * so two hosts can be browsed — and copied between — side by side.
 */

import { Loader2 } from "lucide-react";
import { CustomSelect } from "../shared/CustomSelect";
import { useHostsStore } from "../../stores/hosts-store";
import type { SavedHost } from "../../types";
import type { LeftPaneSource } from "../../stores/sftp-store";

const LOCAL_VALUE = "__local__";

interface PaneSourcePickerProps {
  source: LeftPaneSource;
  /** Host owning the right pane — excluded so a host isn't its own counterpart. */
  excludeHostId?: string | null;
  /** True while the chosen host's session is being opened. */
  busy?: boolean;
  disabled?: boolean;
  onSelectLocal: () => void;
  onSelectHost: (host: SavedHost) => void;
}

export function PaneSourcePicker({
  source,
  excludeHostId,
  busy = false,
  disabled = false,
  onSelectLocal,
  onSelectHost,
}: PaneSourcePickerProps) {
  const hosts = useHostsStore((s) => s.hosts);
  const candidates = hosts.filter((h) => h.id !== excludeHostId);

  const options = [
    { value: LOCAL_VALUE, label: "Local machine" },
    ...candidates.map((h) => ({
      value: h.id,
      label: h.label || `${h.username}@${h.host}`,
    })),
  ];

  const value = source.kind === "local" ? LOCAL_VALUE : source.hostId;

  return (
    <div className="flex items-center gap-2 px-2 h-9 shrink-0 no-select border-b border-border/60 bg-bg-surface/80">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-text-muted shrink-0">
        Left
      </span>
      <div className="flex-1 min-w-0">
        <CustomSelect
          value={value}
          options={options}
          onChange={(next) => {
            if (next === LOCAL_VALUE) {
              onSelectLocal();
              return;
            }
            const host = candidates.find((h) => h.id === next);
            if (host) onSelectHost(host);
          }}
          disabled={disabled || busy}
          aria-label="Left pane source"
          data-testid="explorer-left-source"
          className="w-full"
          searchable
          searchPlaceholder="Search servers..."
        />
      </div>
      {busy && (
        <Loader2
          size={14}
          strokeWidth={2}
          className="text-accent motion-safe:animate-spin shrink-0"
          aria-label="Connecting"
        />
      )}
    </div>
  );
}
