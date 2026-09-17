/* Linked plugins panel state. Mirrors the linked-explorer store's shape
 * (per-tab open set, retained width, active-pane follow) without any
 * protocol binding — trackers poll over the existing SSH session via
 * `ssh_exec_command`, so open/close is pure UI state. */

import { create } from "zustand";
import type { LayoutNode } from "../types";
import { useSessionStore } from "./session-store";

interface LinkedPluginsState {
  /** Tab IDs where the plugins panel is open */
  openTabIds: Set<string>;
  /** Retained panel width in pixels */
  panelWidth: number;
  /** Deep link target: { tabId, path } set by "Tail log" in the explorer */
  logTarget: { tabId: string; path: string } | null;

  toggleLinkedPlugins: (tabId: string) => void;
  openLinkedPlugins: (tabId: string) => void;
  closeLinkedPlugins: (tabId: string) => void;
  setPanelWidth: (width: number) => void;
  /** Open the panel on `tabId` scrolled to the log viewer for `path`. */
  openLogTail: (tabId: string, path: string) => void;
  consumeLogTarget: () => void;
}

const STORAGE_KEY_WIDTH = "anyscp_linked_plugins_width";
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 220;
const MAX_WIDTH = 800;

function initialWidth(): number {
  if (typeof window === "undefined" || !window.localStorage) return DEFAULT_WIDTH;
  const stored = window.localStorage.getItem(STORAGE_KEY_WIDTH);
  if (!stored) return DEFAULT_WIDTH;
  const parsed = parseInt(stored, 10);
  return isNaN(parsed) ? DEFAULT_WIDTH : Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parsed));
}

function layoutContainsSession(layout: LayoutNode, sshSessionId: string): boolean {
  if (layout.type === "pane") return layout.sessionId === sshSessionId;
  return layout.children.some((child) => layoutContainsSession(child, sshSessionId));
}

/** Collect all session IDs in a layout node. */
export function collectTabSessionIds(layout: LayoutNode): string[] {
  if (layout.type === "pane") return [layout.sessionId];
  return [...collectTabSessionIds(layout.children[0]), ...collectTabSessionIds(layout.children[1])];
}

export const useLinkedPluginsStore = create<LinkedPluginsState>((set, get) => ({
  openTabIds: new Set(),
  panelWidth: initialWidth(),
  logTarget: null,

  toggleLinkedPlugins: (tabId) => {
    if (get().openTabIds.has(tabId)) {
      get().closeLinkedPlugins(tabId);
    } else {
      get().openLinkedPlugins(tabId);
    }
  },

  openLinkedPlugins: (tabId) =>
    set((state) => {
      const next = new Set(state.openTabIds);
      next.add(tabId);
      return { openTabIds: next };
    }),

  closeLinkedPlugins: (tabId) =>
    set((state) => {
      const next = new Set(state.openTabIds);
      next.delete(tabId);
      const logTarget = state.logTarget?.tabId === tabId ? null : state.logTarget;
      return { openTabIds: next, logTarget };
    }),

  setPanelWidth: (width) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
    }
    set({ panelWidth: clamped });
  },

  openLogTail: (tabId, path) =>
    set((state) => {
      const next = new Set(state.openTabIds);
      next.add(tabId);
      return { openTabIds: next, logTarget: { tabId, path } };
    }),

  consumeLogTarget: () => set({ logTarget: null }),
}));

/* Drop open state for terminal tabs that no longer exist. Trackers are
 * session-bound (not tab-bound), so no per-session cleanup is needed — an
 * unmounted view simply stops its interval. */
useSessionStore.subscribe((sessionState) => {
  const currentTabs = sessionState.tabs;
  const store = useLinkedPluginsStore.getState();
  let changed = false;
  const next = new Set(store.openTabIds);
  for (const tabId of store.openTabIds) {
    if (!currentTabs.has(tabId)) {
      next.delete(tabId);
      changed = true;
    }
  }
  if (changed) useLinkedPluginsStore.setState({ openTabIds: next });
});

export { layoutContainsSession };
