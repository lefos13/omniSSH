import { create } from "zustand";
import type {
  Session,
  SessionId,
  HostConfig,
  ConnectionStatus,
  LayoutNode,
  SplitDirection,
} from "../types";
import { hostKeyFor } from "../lib/host-key";
import { useRecentPathsStore } from "./recent-paths-store";
import { useTabStore } from "./tab-store";

// ─── Layout tree helpers ─────────────────────────────────────────────────────

function replacePane(
  node: LayoutNode,
  targetSessionId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.type === "pane") {
    return node.sessionId === targetSessionId ? replacement : node;
  }
  return {
    ...node,
    children: [
      replacePane(node.children[0], targetSessionId, replacement),
      replacePane(node.children[1], targetSessionId, replacement),
    ],
  };
}

function removePane(
  node: LayoutNode,
  targetSessionId: string,
): LayoutNode | null {
  if (node.type === "pane") {
    return node.sessionId === targetSessionId ? null : node;
  }
  const [left, right] = node.children;
  if (left.type === "pane" && left.sessionId === targetSessionId) return right;
  if (right.type === "pane" && right.sessionId === targetSessionId) return left;
  const newLeft = removePane(left, targetSessionId);
  const newRight = removePane(right, targetSessionId);
  if (newLeft === null) return right;
  if (newRight === null) return left;
  return { ...node, children: [newLeft, newRight] };
}

function updateRatioAtPath(
  node: LayoutNode,
  path: number[],
  ratio: number,
): LayoutNode {
  if (path.length === 0 && node.type === "split") {
    return { ...node, ratio };
  }
  if (node.type === "pane" || path.length === 0) return node;
  const [idx, ...rest] = path;
  const newChildren = [...node.children] as [LayoutNode, LayoutNode];
  newChildren[idx] = updateRatioAtPath(newChildren[idx], rest, ratio);
  return { ...node, children: newChildren };
}

/** Count total panes in a layout tree. */
export function countPanes(node: LayoutNode): number {
  if (node.type === "pane") return 1;
  return countPanes(node.children[0]) + countPanes(node.children[1]);
}

/** Get the top-level split direction (null if single pane). */
export function getTopDirection(node: LayoutNode): SplitDirection | null {
  if (node.type === "pane") return null;
  return node.direction;
}

/** Find which tab a session belongs to. */
export function findTabForSession(
  tabs: Map<string, Tab>,
  sessionId: string,
): string | null {
  for (const [tabId, tab] of tabs) {
    if (containsSession(tab.layout, sessionId)) return tabId;
  }
  return null;
}

function containsSession(node: LayoutNode, sessionId: string): boolean {
  if (node.type === "pane") return node.sessionId === sessionId;
  return containsSession(node.children[0], sessionId) || containsSession(node.children[1], sessionId);
}

/** Collect all session IDs from a layout tree. */
export function collectSessionIds(node: LayoutNode): string[] {
  if (node.type === "pane") return [node.sessionId];
  return [...collectSessionIds(node.children[0]), ...collectSessionIds(node.children[1])];
}

/*
 * Generate an aggregated tab label for a layout tree based on active sessions.
 * Multiple distinct hosts are formatted as "HostA | HostB", while a single host
 * retains its standard username@host or custom label.
 */
export function computeTabLabel(
  layout: LayoutNode,
  sessions: Map<SessionId, Session>,
): string {
  const ids = collectSessionIds(layout);
  const hostLabels = ids
    .map((id) => {
      const s = sessions.get(id);
      return s ? (s.hostConfig.label || s.hostConfig.host) : null;
    })
    .filter(Boolean) as string[];

  const unique = Array.from(new Set(hostLabels));
  if (unique.length > 1) {
    return unique.join(" | ");
  }
  if (unique.length === 1) {
    const first = sessions.get(ids[0]);
    return first?.label || unique[0];
  }
  return "Terminal";
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Tab {
  layout: LayoutNode;
  label: string;
}

interface SessionState {
  sessions: Map<SessionId, Session>;
  activeSessionId: SessionId | null;
  /** Each tab owns its own layout tree. Tab ID = the first session's ID. */
  tabs: Map<string, Tab>;
  /** Which terminal tab is focused (used by PaneHeader / TerminalArea for split detection). */
  activeTerminalTabId: string | null;
  zoomedPaneId: string | null;
  /** Set of tab IDs whose split panes have parallel command execution / input sync enabled. */
  syncedTabIds: Set<string>;

  addSession: (id: SessionId, hostConfig: HostConfig) => void;
  removeSession: (id: SessionId) => void;
  setActiveSession: (id: SessionId | null) => void;
  /** Called by tab-store when a terminal tab is activated. Sets activeSessionId from the layout tree. */
  focusTab: (tabId: string) => void;
  updateStatus: (id: SessionId, status: ConnectionStatus, message?: string) => void;
  setRemoteCwd: (id: SessionId, cwd: string | null) => void;
  splitPane: (
    direction: SplitDirection,
    targetSessionId: string,
    newSessionId: string,
    hostConfig?: HostConfig,
  ) => void;
  unsplitPane: (sessionId: string) => void;
  updateSplitRatio: (tabId: string, path: number[], ratio: number) => void;
  toggleZoom: (sessionId: string) => void;
  toggleSyncPanes: (tabId: string) => void;
  setSyncPanes: (tabId: string, enabled: boolean) => void;
  isTabSynced: (tabId: string) => boolean;
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: new Map(),
  activeSessionId: null,
  tabs: new Map(),
  activeTerminalTabId: null,
  zoomedPaneId: null,
  syncedTabIds: new Set(),

  addSession: (id, hostConfig) =>
    set((state) => {
      const label = hostConfig.label || `${hostConfig.username}@${hostConfig.host}`;
      const sessions = new Map(state.sessions);
      sessions.set(id, {
        id,
        hostConfig,
        status: "Connected",
        label,
      });

      // New connection = new layout tree entry
      const tabs = new Map(state.tabs);
      tabs.set(id, {
        layout: { type: "pane", sessionId: id },
        label,
      });

      return {
        sessions,
        activeSessionId: id,
        tabs,
        activeTerminalTabId: id,
      };
    }),

  removeSession: (id) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.delete(id);

      const tabs = new Map(state.tabs);
      let activeTerminalTabId = state.activeTerminalTabId;
      const syncedTabIds = new Set(state.syncedTabIds);

      // Find which tab this session belongs to
      const ownerTabId = findTabForSession(state.tabs, id);

      if (ownerTabId) {
        const tab = tabs.get(ownerTabId);
        if (tab) {
          if (ownerTabId === id && tab.layout.type === "pane") {
            // This session IS the tab and it's the only pane — remove the layout
            tabs.delete(ownerTabId);
            syncedTabIds.delete(ownerTabId);
            if (activeTerminalTabId === ownerTabId) {
              activeTerminalTabId = null;
            }
          } else {
            // Session is in a split — remove it from the tree
            const newLayout = removePane(tab.layout, id);
            if (newLayout) {
              const updatedLabel = computeTabLabel(newLayout, sessions);
              tabs.set(ownerTabId, { ...tab, layout: newLayout, label: updatedLabel });
              useTabStore.getState().updateTabLabel(ownerTabId, updatedLabel);
              if (countPanes(newLayout) <= 1) {
                syncedTabIds.delete(ownerTabId);
              }
            } else {
              tabs.delete(ownerTabId);
              syncedTabIds.delete(ownerTabId);
              if (activeTerminalTabId === ownerTabId) {
                activeTerminalTabId = null;
              }
            }
          }
        }
      }

      // Pick a new active session
      let activeSessionId = state.activeSessionId;
      if (activeSessionId === id) {
        if (activeTerminalTabId) {
          const activeTab = tabs.get(activeTerminalTabId);
          if (activeTab) {
            const ids = collectSessionIds(activeTab.layout);
            activeSessionId = ids[0] ?? null;
          } else {
            activeSessionId = null;
          }
        } else {
          activeSessionId = null;
        }
      }

      return {
        sessions,
        activeSessionId,
        tabs,
        activeTerminalTabId,
        zoomedPaneId: state.zoomedPaneId === id ? null : state.zoomedPaneId,
        syncedTabIds,
      };
    }),

  setActiveSession: (id) =>
    set((state) => {
      if (!id) return { activeSessionId: null };
      const tabId = findTabForSession(state.tabs, id);
      return {
        activeSessionId: id,
        activeTerminalTabId: tabId ?? state.activeTerminalTabId,
      };
    }),

  focusTab: (tabId) =>
    set((state) => {
      const tab = state.tabs.get(tabId);
      if (!tab) return state;
      const ids = collectSessionIds(tab.layout);
      return {
        activeTerminalTabId: tabId,
        activeSessionId: ids[0] ?? state.activeSessionId,
      };
    }),

  updateStatus: (id, status, message) =>
    set((state) => {
      const session = state.sessions.get(id);
      if (!session) return state;
      const sessions = new Map(state.sessions);
      sessions.set(id, { ...session, status, statusMessage: message });
      return { sessions };
    }),
  /*
   * Update the remote working directory for a session received via OSC 7.
   * Passing a non-null directory marks cwdSyncActive as true; passing null
   * clears the directory and resets cwdSyncActive to false.
   *
   * A changed directory is also recorded in the host's recent-path history so
   * the terminal pane header can offer one-click `cd` back to it.
   */
  setRemoteCwd: (id, cwd) => {
    const session = get().sessions.get(id);
    if (!session) return;
    if (cwd !== null && cwd !== session.remoteCwd) {
      useRecentPathsStore.getState().record(
        hostKeyFor({
          savedHostId: session.hostConfig.savedHostId,
          username: session.hostConfig.username,
          host: session.hostConfig.host,
          port: session.hostConfig.port,
        }),
        "remote",
        cwd,
      );
    }
    set((state) => {
      const current = state.sessions.get(id);
      if (!current) return state;
      const sessions = new Map(state.sessions);
      sessions.set(id, {
        ...current,
        remoteCwd: cwd,
        cwdSyncActive: cwd !== null,
      });
      return { sessions };
    });
  },

  splitPane: (direction, targetSessionId, newSessionId, hostConfig) =>
    set((state) => {
      const tabId = findTabForSession(state.tabs, targetSessionId);
      if (!tabId) return state;
      const tab = state.tabs.get(tabId);
      if (!tab) return state;

      const sessions = new Map(state.sessions);
      if (hostConfig) {
        const label = hostConfig.label || `${hostConfig.username}@${hostConfig.host}`;
        sessions.set(newSessionId, {
          id: newSessionId,
          hostConfig,
          status: "Connected",
          label,
        });
      } else {
        const sourceSession = state.sessions.get(targetSessionId);
        if (sourceSession) {
          sessions.set(newSessionId, {
            id: newSessionId,
            hostConfig: sourceSession.hostConfig,
            status: "Connected",
            label: sourceSession.label,
          });
        }
      }

      const splitNode: LayoutNode = {
        type: "split",
        direction,
        ratio: 0.5,
        children: [
          { type: "pane", sessionId: targetSessionId },
          { type: "pane", sessionId: newSessionId },
        ],
      };

      const newLayout = replacePane(tab.layout, targetSessionId, splitNode);
      const updatedLabel = computeTabLabel(newLayout, sessions);
      const tabs = new Map(state.tabs);
      tabs.set(tabId, { ...tab, layout: newLayout, label: updatedLabel });
      useTabStore.getState().updateTabLabel(tabId, updatedLabel);

      return { sessions, tabs, activeSessionId: newSessionId };
    }),

  unsplitPane: (sessionId) =>
    set((state) => {
      const tabId = findTabForSession(state.tabs, sessionId);
      if (!tabId) return state;
      const tab = state.tabs.get(tabId);
      if (!tab) return state;

      const newLayout = removePane(tab.layout, sessionId);
      if (!newLayout) return state;

      const updatedLabel = computeTabLabel(newLayout, state.sessions);
      const tabs = new Map(state.tabs);
      tabs.set(tabId, { ...tab, layout: newLayout, label: updatedLabel });
      useTabStore.getState().updateTabLabel(tabId, updatedLabel);

      const syncedTabIds = new Set(state.syncedTabIds);
      if (countPanes(newLayout) <= 1) {
        syncedTabIds.delete(tabId);
      }

      return { tabs, syncedTabIds };
    }),

  updateSplitRatio: (tabId, path, ratio) =>
    set((state) => {
      const tab = state.tabs.get(tabId);
      if (!tab) return state;
      const newLayout = updateRatioAtPath(tab.layout, path, ratio);
      const tabs = new Map(state.tabs);
      tabs.set(tabId, { ...tab, layout: newLayout });
      return { tabs };
    }),

  toggleZoom: (sessionId) =>
    set((state) => ({
      zoomedPaneId: state.zoomedPaneId === sessionId ? null : sessionId,
      activeSessionId: sessionId,
    })),

  /*
   * Toggle parallel command execution across all split panes in a tab.
   * Only activates if the tab has more than one pane. Automatically
   * cleans up when panes are unsplit or removed.
   */
  toggleSyncPanes: (tabId) =>
    set((state) => {
      const tab = state.tabs.get(tabId);
      if (!tab || countPanes(tab.layout) <= 1) {
        if (state.syncedTabIds.has(tabId)) {
          const next = new Set(state.syncedTabIds);
          next.delete(tabId);
          return { syncedTabIds: next };
        }
        return state;
      }
      const next = new Set(state.syncedTabIds);
      if (next.has(tabId)) {
        next.delete(tabId);
      } else {
        next.add(tabId);
      }
      return { syncedTabIds: next };
    }),

  setSyncPanes: (tabId, enabled) =>
    set((state) => {
      const tab = state.tabs.get(tabId);
      const next = new Set(state.syncedTabIds);
      if (enabled && tab && countPanes(tab.layout) > 1) {
        next.add(tabId);
      } else {
        next.delete(tabId);
      }
      return { syncedTabIds: next };
    }),

  isTabSynced: (tabId) => {
    const state = get();
    const tab = state.tabs.get(tabId);
    return state.syncedTabIds.has(tabId) && Boolean(tab && countPanes(tab.layout) > 1);
  },
}));
