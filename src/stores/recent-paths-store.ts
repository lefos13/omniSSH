/*
 * Per-host recent-path history (MRU, capped at five).
 *
 * One list is shared by the remote explorer pane and the terminal's cd menu for
 * the same host, keyed by the host identity produced by `host-key`.
 *
 * Updates are optimistic so the menu reflects a navigation immediately; the
 * backend write is best-effort (history is a convenience, never a blocker).
 */

import { create } from "zustand";

export const MAX_RECENT_PATHS = 5;

/** Scope of a path list. Only remote server paths are tracked today. */
export type RecentPathScope = "remote";

function keyFor(hostKey: string, scope: RecentPathScope): string {
  return `${hostKey}:${scope}`;
}

interface RecentPathsState {
  /** `${hostKey}:${scope}` → paths, newest-first. */
  byKey: Map<string, string[]>;

  /** Fetch the persisted list for a host (idempotent; safe to call on mount). */
  load: (hostKey: string, scope: RecentPathScope) => Promise<void>;
  /** Optimistically push a path to the top and persist it. */
  record: (hostKey: string, scope: RecentPathScope, path: string) => void;
  /** Forget a host's history. */
  clear: (hostKey: string, scope: RecentPathScope) => Promise<void>;
}

export const useRecentPathsStore = create<RecentPathsState>((set, get) => ({
  byKey: new Map(),

  load: async (hostKey, scope) => {
    if (!hostKey) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const paths = await invoke<string[]>("list_recent_paths", {
        hostKey,
        scope,
        limit: MAX_RECENT_PATHS,
      });
      set((state) => {
        const byKey = new Map(state.byKey);
        byKey.set(keyFor(hostKey, scope), paths);
        return { byKey };
      });
    } catch {
      /* Non-fatal — the menu simply shows whatever is cached. */
    }
  },

  record: (hostKey, scope, path) => {
    if (!hostKey || !path) return;
    const key = keyFor(hostKey, scope);
    const current = get().byKey.get(key) ?? [];
    // Already the most recent — nothing to reorder or persist.
    if (current[0] === path) return;

    const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENT_PATHS);
    set((state) => {
      const byKey = new Map(state.byKey);
      byKey.set(key, next);
      return { byKey };
    });

    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("record_recent_path", { hostKey, scope, path });
      } catch {
        /* Non-fatal. */
      }
    })();
  },

  clear: async (hostKey, scope) => {
    set((state) => {
      const byKey = new Map(state.byKey);
      byKey.set(keyFor(hostKey, scope), []);
      return { byKey };
    });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("clear_recent_paths", { hostKey, scope });
    } catch {
      /* Non-fatal. */
    }
  },
}));

/** Read the cached list for a host without subscribing to the whole map.
 *
 *  Returns a module-level empty array when nothing is cached so the selector
 *  keeps a stable reference across renders — returning a fresh `[]` would make
 *  zustand's `useSyncExternalStore` re-render forever. */
const EMPTY_PATHS: string[] = [];

export function selectRecentPaths(
  state: RecentPathsState,
  hostKey: string,
  scope: RecentPathScope,
): string[] {
  return state.byKey.get(keyFor(hostKey, scope)) ?? EMPTY_PATHS;
}
