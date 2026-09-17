/* Per-host plugin enablement + config, persisted in the `host_plugin_config`
 * table. Config values are opaque frontend-owned JSON (ports, paths, kube
 * context) and must never contain secrets. */

import { create } from "zustand";
import type { HostPluginConfig } from "../types";

export interface PluginRow {
  enabled: boolean;
  config: Record<string, unknown>;
}

interface PluginConfigState {
  byHostId: Record<string, Record<string, PluginRow>>;
  loadForHost: (hostId: string) => Promise<void>;
  setPlugin: (hostId: string, pluginId: string, row: PluginRow) => Promise<void>;
  removePlugin: (hostId: string, pluginId: string) => Promise<void>;
}

function parseConfig(config: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(config || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* fall through to empty */ }
  return {};
}

export const usePluginConfigStore = create<PluginConfigState>((set) => ({
  byHostId: {},

  loadForHost: async (hostId) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const rows = await invoke<HostPluginConfig[]>("list_plugin_configs", { hostId });
      const mapped: Record<string, PluginRow> = {};
      for (const row of rows) {
        mapped[row.plugin_id] = { enabled: row.enabled, config: parseConfig(row.config) };
      }
      set((s) => ({ byHostId: { ...s.byHostId, [hostId]: mapped } }));
    } catch { /* backend unavailable — keep previous state */ }
  },

  setPlugin: async (hostId, pluginId, row) => {
    const config = JSON.stringify(row.config ?? {});
    set((s) => ({
      byHostId: {
        ...s.byHostId,
        [hostId]: { ...(s.byHostId[hostId] ?? {}), [pluginId]: row },
      },
    }));
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_plugin_config", { hostId, pluginId, enabled: row.enabled, config });
    } catch {
      /* Best-effort: optimistic state stays; the next load reconciles. */
      await usePluginConfigStore.getState().loadForHost(hostId).catch(() => {});
    }
  },

  removePlugin: async (hostId, pluginId) => {
    set((s) => {
      const next = { ...(s.byHostId[hostId] ?? {}) };
      delete next[pluginId];
      return { byHostId: { ...s.byHostId, [hostId]: next } };
    });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("delete_plugin_config", { hostId, pluginId });
    } catch {
      await usePluginConfigStore.getState().loadForHost(hostId).catch(() => {});
    }
  },
}));
