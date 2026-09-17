/* Per-host plugin assignment panel, embedded as a tab in the host editor.
 * Each tracker gets an enable toggle plus its own small config form (ports,
 * paths, contexts). Hidden for brand-new hosts until the first save assigns
 * an id, since rows are keyed by host id. */

import { useEffect, useState } from "react";
import { TRACKERS } from "../../lib/trackers";
import { usePluginConfigStore } from "../../stores/plugin-config-store";

const inputClass =
  "w-full rounded-lg bg-bg-base border border-border px-3 py-2 text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none focus:border-border-focus focus:ring-2 focus:ring-ring transition-[border-color,box-shadow] duration-[var(--duration-fast)]";

const labelClass = "block text-[length:var(--text-xs)] font-medium text-text-secondary mb-1";

/* Config fields per tracker. Values stay strings in the form and are
 * stored verbatim as JSON; trackers coerce (Number(port)) at poll time. */
function ConfigFields({ pluginId, draft, onChange }: {
  pluginId: string;
  draft: Record<string, string>;
  onChange: (patch: Record<string, string>) => void;
}) {
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ [key]: e.target.value });

  switch (pluginId) {
    case "http":
      return (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className={labelClass} htmlFor={`plug-http-port-${pluginId}`}>Port</label>
            <input id={`plug-http-port-${pluginId}`} className={inputClass} inputMode="numeric" placeholder="8080"
              value={draft.port ?? ""} onChange={set("port")} data-testid="plugin-config-http-port" />
          </div>
          <div>
            <label className={labelClass} htmlFor={`plug-http-path-${pluginId}`}>Health path</label>
            <input id={`plug-http-path-${pluginId}`} className={inputClass} placeholder="/actuator/health"
              value={draft.path ?? ""} onChange={set("path")} data-testid="plugin-config-http-path" />
          </div>
        </div>
      );
    case "logs":
      return (
        <div className="mt-2">
          <label className={labelClass} htmlFor={`plug-logs-path-${pluginId}`}>Log path or journald unit</label>
          <input id={`plug-logs-path-${pluginId}`} className={inputClass} placeholder="/var/log/app.log or nginx.service"
            value={draft.path ?? ""} onChange={set("path")} data-testid="plugin-config-logs-path" />
        </div>
      );
    case "ssl":
      return (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className={labelClass} htmlFor={`plug-ssl-host-${pluginId}`}>TLS host</label>
            <input id={`plug-ssl-host-${pluginId}`} className={inputClass} placeholder="example.com"
              value={draft.tlsHost ?? ""} onChange={set("tlsHost")} data-testid="plugin-config-ssl-host" />
          </div>
          <div>
            <label className={labelClass} htmlFor={`plug-ssl-port-${pluginId}`}>Port</label>
            <input id={`plug-ssl-port-${pluginId}`} className={inputClass} inputMode="numeric" placeholder="443"
              value={draft.tlsPort ?? ""} onChange={set("tlsPort")} data-testid="plugin-config-ssl-port" />
          </div>
        </div>
      );
    case "dbping":
      return (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className={labelClass} htmlFor={`plug-db-kind-${pluginId}`}>Database</label>
            <input id={`plug-db-kind-${pluginId}`} className={inputClass} placeholder="postgres | redis | mysql"
              value={draft.db ?? ""} onChange={set("db")} data-testid="plugin-config-db-kind" />
          </div>
          <div>
            <label className={labelClass} htmlFor={`plug-db-host-${pluginId}`}>Host:port</label>
            <input id={`plug-db-host-${pluginId}`} className={inputClass} placeholder="localhost:5432"
              value={draft.dbHost ?? ""} onChange={set("dbHost")} data-testid="plugin-config-db-host" />
          </div>
        </div>
      );
    case "k8s":
      return (
        <div className="grid grid-cols-2 gap-2 mt-2">
          <div>
            <label className={labelClass} htmlFor={`plug-k8s-ns-${pluginId}`}>Namespace</label>
            <input id={`plug-k8s-ns-${pluginId}`} className={inputClass} placeholder="default"
              value={draft.namespace ?? ""} onChange={set("namespace")} data-testid="plugin-config-k8s-namespace" />
          </div>
          <div>
            <label className={labelClass} htmlFor={`plug-k8s-ctx-${pluginId}`}>Context (optional)</label>
            <input id={`plug-k8s-ctx-${pluginId}`} className={inputClass} placeholder="prod"
              value={draft.context ?? ""} onChange={set("context")} data-testid="plugin-config-k8s-context" />
          </div>
        </div>
      );
    default:
      return null;
  }
}

export function HostPluginsPanel({ hostId }: { hostId: string | null }) {
  const rows = usePluginConfigStore((s) => (hostId ? s.byHostId[hostId] : undefined));
  const loadForHost = usePluginConfigStore((s) => s.loadForHost);
  const setPlugin = usePluginConfigStore((s) => s.setPlugin);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (hostId) void loadForHost(hostId);
  }, [hostId, loadForHost]);

  useEffect(() => {
    if (!rows) return;
    const next: Record<string, Record<string, string>> = {};
    for (const [pid, row] of Object.entries(rows)) {
      next[pid] = Object.fromEntries(
        Object.entries(row.config).map(([k, v]) => [k, String(v ?? "")]),
      );
    }
    setDrafts(next);
  }, [rows]);

  if (!hostId) {
    return (
      <p className="text-[length:var(--text-sm)] text-text-muted" data-testid="host-plugins-unsaved">
        Save this host first, then assign plugins to it.
      </p>
    );
  }

  const toggle = (pluginId: string, enabled: boolean) => {
    const config = rows?.[pluginId]?.config ?? {};
    void setPlugin(hostId, pluginId, { enabled, config });
  };

  const saveConfig = async (pluginId: string) => {
    setSaving(pluginId);
    try {
      const raw = drafts[pluginId] ?? {};
      const config = Object.fromEntries(
        Object.entries(raw).filter(([, v]) => v !== ""),
      );
      const enabled = rows?.[pluginId]?.enabled ?? true;
      await setPlugin(hostId, pluginId, { enabled, config });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="host-plugins-panel">
      {TRACKERS.map((t) => {
        const enabled = rows?.[t.id]?.enabled ?? false;
        const hasFields = ["http", "logs", "ssl", "dbping", "k8s"].includes(t.id);
        return (
          <div
            key={t.id}
            className="rounded-xl bg-bg-surface border border-border/50 px-4 py-3"
            data-testid={`host-plugin-${t.id}`}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[length:var(--text-sm)] font-medium text-text-primary">{t.label}</p>
                <p className="text-[length:var(--text-xs)] text-text-muted mt-0.5">{t.description}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                data-testid={`host-plugin-toggle-${t.id}`}
                onClick={() => toggle(t.id, !enabled)}
                className={[
                  "relative w-9 h-5 rounded-full shrink-0 transition-colors duration-[var(--duration-fast)]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  enabled ? "bg-accent" : "bg-bg-muted",
                ].join(" ")}
              >
                <span className={[
                  "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-[var(--shadow-sm)] transition-transform duration-[var(--duration-fast)]",
                  enabled ? "translate-x-4" : "translate-x-0",
                ].join(" ")} />
              </button>
            </div>
            {enabled && hasFields && (
              <>
                <ConfigFields
                  pluginId={t.id}
                  draft={drafts[t.id] ?? {}}
                  onChange={(patch) => setDrafts((d) => ({ ...d, [t.id]: { ...(d[t.id] ?? {}), ...patch } }))}
                />
                <div className="flex justify-end mt-2">
                  <button
                    type="button"
                    data-testid={`host-plugin-save-${t.id}`}
                    disabled={saving === t.id}
                    onClick={() => void saveConfig(t.id)}
                    className="px-3 py-1.5 rounded-lg text-[length:var(--text-sm)] font-medium bg-bg-base border border-border text-text-secondary hover:text-text-primary hover:border-border-focus disabled:opacity-50 transition-all duration-[var(--duration-fast)]"
                  >
                    {saving === t.id ? "Saving…" : "Save"}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
