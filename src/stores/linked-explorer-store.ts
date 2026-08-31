/*
 * Linked terminal explorer state management.
 * Manages per-terminal-tab linked explorer panel visibility, retained panel
 * width, CWD auto-follow preferences, and tab-scoped SSH-to-SFTP/SCP session bindings.
 * Automatically cleans up linked file sessions when the owning terminal session
 * disconnects or the panel is closed / rebound, while closing the explorer never
 * disconnects the terminal SSH session.
 */

import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "./session-store";
import { useSftpStore } from "./sftp-store";
import type { Transport } from "../lib/explorer-transport";

export interface LinkedExplorerBinding {
  tabId: string;
  sshSessionId: string;
  sftpSessionId: string;
  transport: Transport;
  status: "connecting" | "connected" | "error";
  error: string | null;
}

interface LinkedExplorerState {
  /** Tab IDs where the linked explorer panel is open */
  openTabIds: Set<string>;
  /** Retained panel width in pixels */
  panelWidth: number;
  /** Whether the explorer automatically follows terminal CWD changes */
  followPath: boolean;
  /** Map of tabId -> linked SFTP/SCP binding (one binding per terminal tab) */
  bindings: Map<string, LinkedExplorerBinding>;

  toggleLinkedExplorer: (tabId: string) => void;
  openLinkedExplorer: (tabId: string) => void;
  closeLinkedExplorer: (tabId: string) => void;
  setPanelWidth: (width: number) => void;
  setFollowPath: (enabled: boolean) => void;
  setBinding: (tabId: string, binding: LinkedExplorerBinding) => void;
  removeBinding: (tabId: string) => void;
  ensureConnected: (tabIdOrSshId: string, sshSessionId?: string) => Promise<LinkedExplorerBinding | null>;
  disconnectBinding: (tabId: string) => Promise<void>;
}

const STORAGE_KEY_WIDTH = "anyscp_linked_explorer_width";
const STORAGE_KEY_FOLLOW = "anyscp_linked_explorer_follow";
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

function initialFollow(): boolean {
  if (typeof window === "undefined" || !window.localStorage) return true;
  const stored = window.localStorage.getItem(STORAGE_KEY_FOLLOW);
  return stored === null ? true : stored === "true";
}

// In-flight connection promises and generation counters to ensure idempotency
// and immediately close stale connections if the tab closed or rebound mid-flight.
const inFlightConnections = new Map<string, Promise<LinkedExplorerBinding | null>>();
const tabGenerations = new Map<string, number>();

export const useLinkedExplorerStore = create<LinkedExplorerState>((set, get) => ({
  openTabIds: new Set(),
  panelWidth: initialWidth(),
  followPath: initialFollow(),
  bindings: new Map(),

  toggleLinkedExplorer: (tabId) => {
    const isCurrentlyOpen = get().openTabIds.has(tabId);
    if (isCurrentlyOpen) {
      get().closeLinkedExplorer(tabId);
    } else {
      get().openLinkedExplorer(tabId);
    }
  },

  openLinkedExplorer: (tabId) =>
    set((state) => {
      const next = new Set(state.openTabIds);
      next.add(tabId);
      return { openTabIds: next };
    }),

  closeLinkedExplorer: (tabId) => {
    // Invalidate any in-flight connection for this tab
    tabGenerations.set(tabId, (tabGenerations.get(tabId) ?? 0) + 1);

    set((state) => {
      const next = new Set(state.openTabIds);
      next.delete(tabId);
      return { openTabIds: next };
    });

    // Best-effort cleanup of the linked SFTP/SCP channel & sftp-store session
    void get().disconnectBinding(tabId);
  },

  setPanelWidth: (width) => {
    const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
    }
    set({ panelWidth: clamped });
  },

  setFollowPath: (enabled) => {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY_FOLLOW, String(enabled));
    }
    set({ followPath: enabled });
  },

  setBinding: (tabId, binding) =>
    set((state) => {
      const next = new Map(state.bindings);
      next.set(tabId, binding);
      return { bindings: next };
    }),

  removeBinding: (tabId) =>
    set((state) => {
      const next = new Map(state.bindings);
      next.delete(tabId);
      return { bindings: next };
    }),

  ensureConnected: async (tabIdOrSshId, sshSessionIdParam) => {
    // Support either ensureConnected(tabId, sshSessionId) or ensureConnected(sshSessionId)
    const tabId = sshSessionIdParam ? tabIdOrSshId : tabIdOrSshId;
    const sshSessionId = sshSessionIdParam ? sshSessionIdParam : tabIdOrSshId;

    const state = get();
    const existing = state.bindings.get(tabId);

    // Reuse existing binding if it matches the current active pane and is already connected
    if (
      existing &&
      existing.sshSessionId === sshSessionId &&
      existing.status === "connected" &&
      useSftpStore.getState().sessions.has(existing.sftpSessionId)
    ) {
      return existing;
    }

    // Idempotent: return in-flight promise if one is already running for this exact pair
    const connectionKey = `${tabId}:${sshSessionId}`;
    const inFlight = inFlightConnections.get(connectionKey);
    if (inFlight) return inFlight;

    // Clean up previous binding if tab is rebinding to a different active pane
    if (existing && existing.sshSessionId !== sshSessionId) {
      void get().disconnectBinding(tabId);
    }

    const sshSession = useSessionStore.getState().sessions.get(sshSessionId);
    if (!sshSession) return null;

    // Track generation to detect stale completions if closed/rebound mid-flight
    const currentGeneration = (tabGenerations.get(tabId) ?? 0) + 1;
    tabGenerations.set(tabId, currentGeneration);

    // Mark as connecting
    const connectingBinding: LinkedExplorerBinding = {
      tabId,
      sshSessionId,
      sftpSessionId: existing?.sftpSessionId ?? "",
      transport: existing?.transport ?? "sftp",
      status: "connecting",
      error: null,
    };
    get().setBinding(tabId, connectingBinding);

    const connectPromise = (async (): Promise<LinkedExplorerBinding | null> => {
      let sftpSessionId = "";
      let transport: Transport = "sftp";

      try {
        sftpSessionId = await invoke<string>("sftp_open", { sessionId: sshSessionId });
        transport = "sftp";
      } catch (sftpErr) {
        try {
          sftpSessionId = await invoke<string>("scp_open", { sessionId: sshSessionId });
          transport = "scp";
        } catch (scpErr) {
          // If tab closed or generation changed, don't set error
          if (tabGenerations.get(tabId) !== currentGeneration) {
            return null;
          }

          const errorMsg =
            sftpErr instanceof Error
              ? sftpErr.message
              : typeof sftpErr === "string"
                ? sftpErr
                : scpErr instanceof Error
                  ? scpErr.message
                  : "Failed to open SFTP/SCP session";

          const errorBinding: LinkedExplorerBinding = {
            tabId,
            sshSessionId,
            sftpSessionId: "",
            transport: "sftp",
            status: "error",
            error: errorMsg,
          };
          get().setBinding(tabId, errorBinding);
          return errorBinding;
        }
      }

      // Check if connection became stale during await (panel closed or rebound)
      const isStale =
        tabGenerations.get(tabId) !== currentGeneration ||
        !get().openTabIds.has(tabId);

      if (isStale) {
        // Immediately close the late-opened channel so it doesn't leak
        const closeCmd = transport === "scp" ? "scp_close" : "sftp_close";
        const key = transport === "scp" ? "scpSessionId" : "sftpSessionId";
        try {
          await invoke(closeCmd, { [key]: sftpSessionId });
        } catch {
          /* ignore */
        }
        return null;
      }

      // Register in sftp-store with transport metadata (startDirectory left undefined)
      useSftpStore
        .getState()
        .openSession(
          sftpSessionId,
          sshSessionId,
          sshSession.label,
          sshSession.hostConfig.username,
          false,
          undefined,
          transport,
        );

      const connectedBinding: LinkedExplorerBinding = {
        tabId,
        sshSessionId,
        sftpSessionId,
        transport,
        status: "connected",
        error: null,
      };
      get().setBinding(tabId, connectedBinding);
      return connectedBinding;
    })();

    inFlightConnections.set(connectionKey, connectPromise);
    try {
      return await connectPromise;
    } finally {
      inFlightConnections.delete(connectionKey);
    }
  },

  disconnectBinding: async (tabId) => {
    const binding = get().bindings.get(tabId);
    if (!binding) return;

    // Synchronously remove from store so UI updates immediately
    get().removeBinding(tabId);

    if (binding.sftpSessionId) {
      useSftpStore.getState().closeSession(binding.sftpSessionId);
    }

    if (binding.sftpSessionId) {
      const closeCmd = binding.transport === "scp" ? "scp_close" : "sftp_close";
      const key = binding.transport === "scp" ? "scpSessionId" : "sftpSessionId";
      try {
        await invoke(closeCmd, { [key]: binding.sftpSessionId });
      } catch {
        /* Best-effort cleanup */
      }
    }
  },
}));

/*
 * Subscribe to session-store to clean up linked SFTP/SCP sessions when the
 * terminal SSH session disconnects or is removed from the session store.
 */
useSessionStore.subscribe((sessionState) => {
  const currentSessions = sessionState.sessions;
  const store = useLinkedExplorerStore.getState();
  for (const [tabId, binding] of store.bindings.entries()) {
    if (!currentSessions.has(binding.sshSessionId)) {
      void store.disconnectBinding(tabId);
    }
  }
});
