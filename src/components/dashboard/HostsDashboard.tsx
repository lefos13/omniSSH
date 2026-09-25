import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Search, Plus, Import, Cloud, LayoutGrid, List, ListTree, KeyRound } from "lucide-react";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { ImportSshConfigModal, type ImportSource } from "./ImportSshConfigModal";
import { ImportPasswordsModal } from "./ImportPasswordsModal";
import { S3ConnectDialog } from "../s3/S3ConnectDialog";
import { useHostsStore } from "../../stores/hosts-store";
import { useGroupsStore } from "../../stores/groups-store";
import { useSessionStore } from "../../stores/session-store";
import { useUiStore } from "../../stores/ui-store";
import { useTabStore } from "../../stores/tab-store";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useResizeHandle } from "../../hooks/use-resize-handle";
import type { SavedHost, HostGroup, RecentConnection, S3Connection, HostConfig, SplitDirection } from "../../types";
import { HostCard } from "./HostCard";
import { HostListRow } from "./HostListRow";
import { HostGroupedView } from "./HostGroupedView";
import { S3Card } from "./S3Card";
import { SortableCard } from "./SortableCard";
import { GroupsSidebar, UNGROUPED_ID } from "./GroupsSidebar";
import { GroupDeleteDialog } from "./GroupDeleteDialog";
import { GroupModal } from "./GroupModal";
import { ConnectionDialog } from "./ConnectionDialog";
import { RecentConnections } from "./RecentConnections";
import { toast } from "../../stores/toast-store";
import { openExplorerSessionForHost } from "../../lib/open-explorer-session";
import { handleVaultLockedError } from "../../lib/vault-errors";

// Abort an in-flight SSH connection attempt on the Rust side. Best-effort:
// the attempt may already have settled, in which case the backend reports it
// found nothing and we simply move on.
async function cancelConnectAttempt(attemptId: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("ssh_cancel_connect", { attemptId });
  } catch {
    /* attempt already finished — nothing to cancel */
  }
}

/* Groups sidebar resize bounds, mirroring the linked-panel handle pattern
 * (TerminalTabContainer) with a narrower range suited to a nav rail. */
const GROUPS_SIDEBAR_STORAGE_KEY = "anyscp_groups_sidebar_width";
const GROUPS_SIDEBAR_DEFAULT = 224;
const GROUPS_SIDEBAR_MIN = 160;
const GROUPS_SIDEBAR_MAX = 400;
const GROUPS_SIDEBAR_STEP = 20;

/* Grouped-view section navigation: a clicked section is parked this far below
 * the top of the main column, and the same line decides which section the
 * sidebar highlights while the list is scrolled. */
const GROUP_SECTION_OFFSET = 16;

// ─── Component ───────────────────────────────────────────────────────────────

export function HostsDashboard() {
  const { hosts, loadHosts, recentConnections, loadRecent, saveHost, deleteHost, reorderHosts } =
    useHostsStore();
  const { groups, loadGroups, createGroup, deleteGroup, reorderGroups } = useGroupsStore();
  const setEditingHostId = useUiStore((s) => s.setEditingHostId);
  const hostsViewMode = useSettingsStore((s) => s.hostsViewMode);
  const setHostsViewMode = useSettingsStore((s) => s.setHostsViewMode);

  const [query, setQuery] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  /* Grouped view: the sidebar scroll-navigates instead of filtering, and the
   * scroll-spy keeps its highlight in sync with the visible section. */
  const [visibleGroupId, setVisibleGroupId] = useState<string | null>(null);
  const mainScrollRef = useRef<HTMLDivElement>(null);
  /* Set while a sidebar click drives the programmatic scroll, so the spy stays
   * silent until the next real scroll gesture. */
  const suppressSpyRef = useRef(false);
  const sidebarWidthRef = useRef(GROUPS_SIDEBAR_DEFAULT);

  /* Resizable groups sidebar (persisted in localStorage, like the linked
   * panel widths). Left-docked, so dragging right (+delta) widens it. */
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined" || !window.localStorage) return GROUPS_SIDEBAR_DEFAULT;
    const stored = window.localStorage.getItem(GROUPS_SIDEBAR_STORAGE_KEY);
    const parsed = stored ? parseInt(stored, 10) : NaN;
    const initial = Number.isNaN(parsed)
      ? GROUPS_SIDEBAR_DEFAULT
      : Math.max(GROUPS_SIDEBAR_MIN, Math.min(GROUPS_SIDEBAR_MAX, parsed));
    sidebarWidthRef.current = initial;
    return initial;
  });
  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => {
      const next = Math.max(GROUPS_SIDEBAR_MIN, Math.min(GROUPS_SIDEBAR_MAX, w + delta));
      sidebarWidthRef.current = next;
      return next;
    });
  }, []);
  const handleSidebarResizeEnd = useCallback(() => {
    try {
      window.localStorage.setItem(GROUPS_SIDEBAR_STORAGE_KEY, String(sidebarWidthRef.current));
    } catch { /* storage unavailable — width still applies for the session */ }
  }, []);
  const sidebarResizeHandle = useResizeHandle({
    direction: "horizontal",
    onResize: handleSidebarResize,
    onResizeEnd: handleSidebarResizeEnd,
  });
  const handleSidebarKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const apply = (next: number) => {
        const clamped = Math.max(GROUPS_SIDEBAR_MIN, Math.min(GROUPS_SIDEBAR_MAX, next));
        sidebarWidthRef.current = clamped;
        setSidebarWidth(clamped);
        try {
          window.localStorage.setItem(GROUPS_SIDEBAR_STORAGE_KEY, String(clamped));
        } catch { /* storage unavailable — width still applies for the session */ }
      };
      if (e.key === "ArrowRight") {
        e.preventDefault();
        apply(sidebarWidthRef.current + GROUPS_SIDEBAR_STEP);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        apply(sidebarWidthRef.current - GROUPS_SIDEBAR_STEP);
      } else if (e.key === "Home") {
        e.preventDefault();
        apply(GROUPS_SIDEBAR_MIN);
      } else if (e.key === "End") {
        e.preventDefault();
        apply(GROUPS_SIDEBAR_MAX);
      }
    },
    [],
  );

  // Group modal state
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPasswordsOpen, setImportPasswordsOpen] = useState(false);
  const [importSource, setImportSource] = useState<ImportSource>("ssh");
  const [s3DialogOpen, setS3DialogOpen] = useState(false);

  /* Settings → Data deeplink: another page requested the Import Connections
   * modal while this dashboard was unmounted. Consume the request once so
   * switching away and back never reopens the modal on its own. */
  const pendingHostsImport = useUiStore((s) => s.pendingHostsImport);
  useEffect(() => {
    if (pendingHostsImport !== "connections") return;
    useUiStore.getState().consumeHostsImport();
    setImportSource("ssh");
    setImportModalOpen(true);
  }, [pendingHostsImport]);

  // Group delete dialog state
  const [deletingGroup, setDeletingGroup] = useState<{
    group: HostGroup;
    hostCount: number;
  } | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // S3 connections
  const s3Connections = useS3Store((s) => s.connections);
  const loadS3Connections = useS3Store((s) => s.loadConnections);
  const reorderS3Connections = useS3Store((s) => s.reorderConnections);

  const [editingS3Connection, setEditingS3Connection] = useState<S3Connection | null>(null);

  const handleS3Duplicate = async (conn: S3Connection) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_save_connection", {
        label: `${conn.label} (copy)`,
        provider: conn.provider,
        bucketName: conn.bucket ?? "",
        region: conn.region,
        endpoint: conn.endpoint,
        accessKey: "",
        secretKey: "",
        pathStyle: conn.path_style,
        groupId: conn.group_id,
        color: conn.color,
        environment: conn.environment,
        notes: conn.notes,
      });
    } catch { /* credential-less copy saved to DB */ }
    await loadS3Connections();
  };

  const handleS3Connect = async (conn: S3Connection) => {
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      setConnectingHost(null);
    };
    setConnectingHost({ label: conn.label, error: null, retry: () => void handleS3Connect(conn), cancel });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_reconnect", { id: conn.id });
      if (cancelled) return;
      useS3Store.getState().openSession(conn.id, conn.label);
      if (conn.bucket) {
        useS3Store.getState().setCurrentBucket(conn.id, conn.bucket);
      }
      setConnectingHost(null);
      useTabStore.getState().addTab({ type: "s3", id: conn.id, label: conn.label });
    } catch (err) {
      if (cancelled) return;
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : "S3 connection failed";
      setConnectingHost({ label: conn.label, error: msg, retry: () => void handleS3Connect(conn), cancel: null });
    }
  };

  const handleS3Delete = async (conn: S3Connection) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("s3_delete_connection", { id: conn.id });
      await loadS3Connections();
    } catch { /* best-effort */ }
  };

  // Connection dialog state
  const [connectingHost, setConnectingHost] = useState<{ label: string; error: string | null; retry: (() => void) | null; cancel: (() => void) | null } | null>(null);

  // Load data on mount
  useEffect(() => {
    void loadHosts();
    void loadGroups();
    void loadRecent();
    void loadS3Connections();
  }, [loadHosts, loadGroups, loadRecent, loadS3Connections]);


  // ─── Derived data ─────────────────────────────────────────────────────────

  const hostCountByGroup = useMemo<Record<string, number>>(() => {
    const counts: Record<string, number> = {};
    for (const host of hosts) {
      if (host.group_id) {
        counts[host.group_id] = (counts[host.group_id] ?? 0) + 1;
      }
    }
    for (const conn of s3Connections) {
      if (conn.group_id) {
        counts[conn.group_id] = (counts[conn.group_id] ?? 0) + 1;
      }
    }
    return counts;
  }, [hosts, s3Connections]);

  const ungroupedCount = useMemo(
    () =>
      hosts.filter((h) => !h.group_id).length +
      s3Connections.filter((c) => !c.group_id).length,
    [hosts, s3Connections],
  );

  // Group membership test shared by hosts and S3 connections. `UNGROUPED_ID`
  // is the sidebar's sentinel for "belongs to no group".
  const matchesSelectedGroup = useCallback(
    (groupId: string | null) => {
      if (selectedGroupId === null) return true;
      if (selectedGroupId === UNGROUPED_ID) return groupId === null;
      return groupId === selectedGroupId;
    },
    [selectedGroupId],
  );

  const filteredHosts = useMemo<SavedHost[]>(() => {
    let result = hosts;

    // Group filter (grouped view shows every group; the sidebar navigates)
    if (hostsViewMode !== "grouped") {
      result = result.filter((h) => matchesSelectedGroup(h.group_id));
    }

    // Search filter
    const q = query.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (h) =>
          h.host.toLowerCase().includes(q) ||
          h.label.toLowerCase().includes(q) ||
          h.username.toLowerCase().includes(q),
      );
    }

    return result;
  }, [hosts, matchesSelectedGroup, query, hostsViewMode]);

  const filteredS3 = useMemo<S3Connection[]>(() => {
    let result = s3Connections;

    // Group filter (grouped view shows every group; the sidebar navigates)
    if (hostsViewMode !== "grouped") {
      result = result.filter((c) => matchesSelectedGroup(c.group_id));
    }

    // Search filter
    const q = query.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (c) =>
          c.label.toLowerCase().includes(q) ||
          c.provider.toLowerCase().includes(q) ||
          (c.bucket?.toLowerCase().includes(q) ?? false),
      );
    }

    return result;
  }, [s3Connections, matchesSelectedGroup, query, hostsViewMode]);

  /* Grouped view buckets: every group in sort order, ungrouped last. Search
   * still applies (via filteredHosts/filteredS3); empty sections render
   * nothing so a query hides non-matching groups. */
  const hostsByGroup = useMemo(() => {
    const map = new Map<string | null, SavedHost[]>();
    for (const h of filteredHosts) {
      const key = h.group_id;
      const list = map.get(key);
      if (list) list.push(h);
      else map.set(key, [h]);
    }
    return map;
  }, [filteredHosts]);

  const s3ByGroup = useMemo(() => {
    const map = new Map<string | null, S3Connection[]>();
    for (const c of filteredS3) {
      const key = c.group_id;
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    return map;
  }, [filteredS3]);

  /* Scroll the main column to a group section (grouped view). "All Hosts"
   * returns to the top. A click is an explicit selection, so the spy is muted
   * until the user scrolls again: the highlight stays on the clicked row while
   * the smooth scroll animates over the sections in between, and it stays there
   * when the clicked section is too short to ever reach the top of the list. */
  const scrollToGroup = useCallback((groupId: string | null) => {
    const root = mainScrollRef.current;
    if (!root) return;
    if (groupId === null) {
      suppressSpyRef.current = true;
      root.scrollTo({ top: 0, behavior: "smooth" });
      setVisibleGroupId(null);
      return;
    }
    const section = root.querySelector<HTMLElement>(`#group-section-${CSS.escape(groupId)}`);
    if (!section) return;
    suppressSpyRef.current = true;
    const top =
      section.getBoundingClientRect().top -
      root.getBoundingClientRect().top +
      root.scrollTop -
      GROUP_SECTION_OFFSET;
    root.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    setVisibleGroupId(groupId);
  }, []);

  /* Scroll-spy: the highlighted group is the last section whose header has
   * crossed the line GROUP_SECTION_OFFSET below the top of the main column.
   * Trailing sections shorter than the viewport can never reach that line once
   * the list ends, so the last section wins at the bottom — otherwise the last
   * groups would be unreachable from the sidebar. */
  useEffect(() => {
    if (hostsViewMode !== "grouped") return;
    const root = mainScrollRef.current;
    if (!root) return;
    suppressSpyRef.current = false;

    const sync = () => {
      if (suppressSpyRef.current) return;
      const sections = Array.from(root.querySelectorAll<HTMLElement>("[id^='group-section-']"));
      if (sections.length === 0) return;
      const rootTop = root.getBoundingClientRect().top;
      let active: HTMLElement | null = null;
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 1) {
        active = sections[sections.length - 1];
      } else {
        for (const section of sections) {
          if (section.getBoundingClientRect().top - rootTop > GROUP_SECTION_OFFSET) break;
          active = section;
        }
      }
      setVisibleGroupId(active ? active.id.replace(/^group-section-/, "") : null);
    };

    /* A smooth scroll emits scroll events too, so only real user gestures
     * resume the spy after a sidebar click. */
    const resumeSpy = () => {
      suppressSpyRef.current = false;
    };

    root.addEventListener("scroll", sync, { passive: true });
    root.addEventListener("wheel", resumeSpy, { passive: true });
    root.addEventListener("touchstart", resumeSpy, { passive: true });
    root.addEventListener("pointerdown", resumeSpy);
    root.addEventListener("keydown", resumeSpy);
    return () => {
      root.removeEventListener("scroll", sync);
      root.removeEventListener("wheel", resumeSpy);
      root.removeEventListener("touchstart", resumeSpy);
      root.removeEventListener("pointerdown", resumeSpy);
      root.removeEventListener("keydown", resumeSpy);
    };
  }, [hostsViewMode]);

  // ─── Connect handlers ──────────────────────────────────────────────────────

  // Connect directly using saved credentials from the vault.
  // If connection fails (e.g., no saved credential), the error shows in the terminal overlay.
  const connectToHost = useCallback(
    async (host: SavedHost) => {
      const label = host.label || `${host.username}@${host.host}`;
      const attemptId = crypto.randomUUID();
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        void cancelConnectAttempt(attemptId);
        setConnectingHost(null);
      };
      setConnectingHost({ label, error: null, retry: () => void connectToHost(host), cancel });
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const addSession = useSessionStore.getState().addSession;
        const sessionId = await invoke<string>("connect_saved_host", { hostId: host.id, attemptId });
        if (cancelled) {
          void invoke("ssh_disconnect", { sessionId });
          return;
        }
        const hostLabel = host.label || `${host.username}@${host.host}`;
        addSession(sessionId, {
          host: host.host,
          port: host.port,
          username: host.username,
          label: host.label || undefined,
          auth_method: { type: "password", password: "" },
          savedHostId: host.id,
        });
        void useHostsStore.getState().recordConnection(host.id);
        setConnectingHost(null);
        useTabStore.getState().addTab({ type: "terminal", id: sessionId, label: hostLabel });
      } catch (err) {
        if (cancelled) return;
        if (handleVaultLockedError(err, label, () => void connectToHost(host))) {
          setConnectingHost(null);
          return;
        }
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Connection failed. Check host, port, and credentials.";
        setConnectingHost({ label, error: msg, retry: () => void connectToHost(host), cancel: null });
      }
    },
    [],
  );

  const handleRecentConnect = useCallback(
    async (conn: RecentConnection) => {
      const label = conn.host_label || `${conn.username}@${conn.host}`;
      const attemptId = crypto.randomUUID();
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        void cancelConnectAttempt(attemptId);
        setConnectingHost(null);
      };
      setConnectingHost({ label, error: null, retry: () => void handleRecentConnect(conn), cancel });
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const addSession = useSessionStore.getState().addSession;
        const sessionId = await invoke<string>("connect_saved_host", { hostId: conn.host_id, attemptId });
        if (cancelled) {
          void invoke("ssh_disconnect", { sessionId });
          return;
        }
        const connLabel = conn.host_label || `${conn.username}@${conn.host}`;
        addSession(sessionId, {
          host: conn.host,
          port: conn.port,
          username: conn.username,
          label: conn.host_label || undefined,
          auth_method: { type: "password", password: "" },
          savedHostId: conn.host_id,
        });
        void useHostsStore.getState().recordConnection(conn.host_id);
        setConnectingHost(null);
        useTabStore.getState().addTab({ type: "terminal", id: sessionId, label: connLabel });
      } catch (err) {
        if (cancelled) return;
        if (handleVaultLockedError(err, label, () => void handleRecentConnect(conn))) {
          setConnectingHost(null);
          return;
        }
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Connection failed.";
        setConnectingHost({ label, error: msg, retry: () => void handleRecentConnect(conn), cancel: null });
      }
    },
    [],
  );

  /*
   * Connect to a saved host and attach it as a new split pane in the active
   * terminal tab. Re-uses the active terminal's layout and switches tab focus.
   */
  const splitHostIntoTerminal = useCallback(
    async (host: SavedHost, direction: SplitDirection) => {
      const { activeTerminalTabId, activeSessionId } = useSessionStore.getState();
      const targetSessionId = activeSessionId;
      if (!targetSessionId) return;

      const attemptId = crypto.randomUUID();
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const sessionId = await invoke<string>("connect_saved_host", { hostId: host.id, attemptId });
        const hostConfig: HostConfig = {
          host: host.host,
          port: host.port,
          username: host.username,
          label: host.label || undefined,
          auth_method:
            host.auth_type === "privateKey"
              ? { type: "privateKey", key_path: host.key_path ?? "" }
              : { type: "password", password: "" },
          savedHostId: host.id,
        };
        useSessionStore.getState().splitPane(direction, targetSessionId, sessionId, hostConfig);
        void useHostsStore.getState().recordConnection(host.id);
        if (activeTerminalTabId) {
          useTabStore.getState().setActiveTab(activeTerminalTabId);
        }
      } catch (err) {
        /* A locked vault is the one split failure worth surfacing — offer the
         * unlock prompt and re-run the split once the vault opens. */
        const label = host.label || `${host.username}@${host.host}`;
        if (handleVaultLockedError(err, label, () => void splitHostIntoTerminal(host, direction))) {
          return;
        }
        console.error("Failed to split host into terminal:", err);
      }
    },
    [],
  );

  // Explore: connect SSH + open a file browser + switch to Files page.
  // NOTE: We don't call addSession — the SSH connection lives in Rust's SshManager
  // but we don't need a terminal pane for file-only connections.
  const exploreHost = useCallback(
    async (host: SavedHost) => {
      const label = host.label || `${host.username}@${host.host}`;
      const attemptId = crypto.randomUUID();
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        void cancelConnectAttempt(attemptId);
        setConnectingHost(null);
      };
      setConnectingHost({ label, error: null, retry: () => void exploreHost(host), cancel });
      try {
        const opened = await openExplorerSessionForHost(host.id, {
          attemptId,
          isCancelled: () => cancelled,
        });
        if (!opened) return;

        useSftpStore.getState().openSession(
          opened.sftpSessionId,
          opened.sshSessionId,
          label,
          host.username,
          false,
          host.start_directory ?? undefined,
          opened.transport,
          host.id,
        );

        setConnectingHost(null);
        useTabStore
          .getState()
          .addTab({ type: "sftp", id: opened.sftpSessionId, label, transport: opened.transport });
      } catch (err) {
        if (cancelled) return;
        if (handleVaultLockedError(err, label, () => void exploreHost(host))) {
          setConnectingHost(null);
          return;
        }
        const msg = err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Connection failed.";
        setConnectingHost({ label, error: msg, retry: () => void exploreHost(host), cancel: null });
      }
    },
    [],
  );

  // Open a file-explorer session for a recent connection. Resolves the saved
  // host first — the recent row carries only display fields, and the explorer
  // path needs the host's stored start directory and credentials.
  const handleRecentExplore = useCallback(
    (conn: RecentConnection) => {
      const host = hosts.find((h) => h.id === conn.host_id);
      if (!host) {
        toast.error("This host no longer exists.");
        return;
      }
      void exploreHost(host);
    },
    [hosts, exploreHost],
  );

  // ─── Host action handlers ──────────────────────────────────────────────────

  const handleDeleteHost = useCallback(
    async (id: string) => {
      await deleteHost(id);
      // deleteHost already reloads the hosts list in the store
    },
    [deleteHost],
  );

  const handleDuplicateHost = useCallback(
    async (host: SavedHost) => {
      const now = new Date().toISOString();
      const duplicate: SavedHost = {
        ...host,
        id: crypto.randomUUID(),
        label: `${host.label || host.host} (copy)`,
        created_at: now,
        updated_at: now,
        last_connected_at: null,
        connection_count: null,
      };
      await saveHost(duplicate);
      // saveHost already reloads the hosts list in the store
    },
    [saveHost],
  );

  // ─── Drag-and-drop reordering ────────────────────────────────────────────────

  // The whole card is the drag surface, so a drag must only begin on a
  // deliberate gesture — otherwise every click-to-connect would be a drag.
  // Mouse: require a 5px move. Touch: require a 250ms press (with 5px slop) so a
  // tap connects and a scroll still scrolls. Keyboard: focus a card and use the
  // arrow keys (Space/Enter to pick up and drop) — accessible reordering.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = filteredHosts.findIndex((h) => h.id === active.id);
      const newIndex = filteredHosts.findIndex((h) => h.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      // Reorder within the currently visible subset, then splice that new order
      // back into the full host list — hosts hidden by a group/search filter keep
      // their positions. This keeps the persisted global order self-consistent
      // even when the user reorders inside a filtered view.
      const reorderedVisible = arrayMove(filteredHosts, oldIndex, newIndex);
      const visibleIds = new Set(filteredHosts.map((h) => h.id));
      let cursor = 0;
      const newFullOrder = hosts.map((h) =>
        visibleIds.has(h.id) ? reorderedVisible[cursor++] : h,
      );

      void reorderHosts(newFullOrder).catch(() => {
        toast.error("Couldn't save the new host order — reverted.");
      });
    },
    [filteredHosts, hosts, reorderHosts],
  );

  // The sidebar computes the new order and hands it back; persist it with the
  // store's optimistic update + rollback.
  const handleGroupReorder = useCallback(
    (newOrder: HostGroup[]) => {
      void reorderGroups(newOrder).catch(() => {
        toast.error("Couldn't save the new group order — reverted.");
      });
    },
    [reorderGroups],
  );

  // Reorder the S3 connection cards. Its own DndContext over the Cloud Storage
  // grid. Like the host handler, we reorder the visible subset then splice it
  // back into the full list so connections hidden by a group/search filter keep
  // their positions; the s3-store applies the optimistic update + rollback.
  const handleS3DragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = filteredS3.findIndex((c) => c.id === active.id);
      const newIndex = filteredS3.findIndex((c) => c.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reorderedVisible = arrayMove(filteredS3, oldIndex, newIndex);
      const visibleIds = new Set(filteredS3.map((c) => c.id));
      let cursor = 0;
      const newFullOrder = s3Connections.map((c) =>
        visibleIds.has(c.id) ? reorderedVisible[cursor++] : c,
      );

      void reorderS3Connections(newFullOrder).catch(() => {
        toast.error("Couldn't save the new connection order — reverted.");
      });
    },
    [filteredS3, s3Connections, reorderS3Connections],
  );

  // ─── Group handlers ────────────────────────────────────────────────────────

  const handleGroupDeleteRequest = useCallback(
    (groupId: string) => {
      const group = groups.find((g) => g.id === groupId);
      if (!group) return;
      const hostCount = hostCountByGroup[groupId] ?? 0;
      setDeletingGroup({ group, hostCount });
    },
    [groups, hostCountByGroup],
  );

  const handleGroupDeleteConfirm = useCallback(
    async (deleteHosts: boolean) => {
      if (!deletingGroup) return;
      const { group } = deletingGroup;

      try {
        if (deleteHosts) {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("delete_group_with_hosts", { id: group.id });
          // Reload both hosts and groups
          await Promise.all([loadHosts(), loadGroups()]);
        } else {
          await deleteGroup(group.id);
          // deleteGroup reloads groups; reload hosts too since their group_id may change
          await loadHosts();
        }
      } finally {
        // If the deleted group was selected, clear the filter
        if (selectedGroupId === group.id) {
          setSelectedGroupId(null);
        }
        setDeletingGroup(null);
      }
    },
    [deletingGroup, deleteGroup, loadHosts, loadGroups, selectedGroupId],
  );

  const handleCreateGroup = async (data: { name: string; color: string; icon: string }) => {
    const now = new Date().toISOString();
    await createGroup({
      id: crypto.randomUUID(),
      name: data.name,
      color: data.color,
      icon: data.icon,
      sort_order: groups.length,
      default_username: null,
      created_at: now,
      updated_at: now,
    });
    setGroupModalOpen(false);
  };

  // ─── Active group label (breadcrumb) ──────────────────────────────────────

  const activeGroup = selectedGroupId
    ? groups.find((g) => g.id === selectedGroupId)
    : null;

  const isGroupedView = hostsViewMode === "grouped";

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="flex h-full bg-bg-base">
        <GroupsSidebar
          groups={groups}
          hostCountByGroup={hostCountByGroup}
          ungroupedCount={ungroupedCount}
          selectedGroupId={isGroupedView ? visibleGroupId : selectedGroupId}
          onSelect={setSelectedGroupId}
          onDelete={handleGroupDeleteRequest}
          onReorder={handleGroupReorder}
          onNewGroup={() => setGroupModalOpen(true)}
          width={sidebarWidth}
          {...(isGroupedView ? { onNavigate: scrollToGroup } : {})}
        />
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize groups sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={GROUPS_SIDEBAR_MIN}
          aria-valuemax={GROUPS_SIDEBAR_MAX}
          data-testid="groups-sidebar-resize-handle"
          className="relative z-10 flex-shrink-0 w-1.5 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded transition-colors"
          onKeyDown={handleSidebarKeyDown}
          {...sidebarResizeHandle}
        />

        <div
          ref={mainScrollRef}
          data-testid="hosts-scroll-area"
          className="flex-1 min-w-0 overflow-y-scroll"
        >
          <div className="max-w-4xl w-full mx-auto px-8 py-8 flex flex-col gap-8">

          {/* ── Page title ── */}
          <div>
            <h1 className="text-[length:var(--text-lg)] font-semibold text-text-primary">Hosts</h1>
            <p className="text-[length:var(--text-xs)] text-text-muted mt-1">Manage your saved servers, organize them into groups, and connect with one click</p>
          </div>

          {/* ── Search bar ── */}
          <div className="relative">
            <Search
              size={16}
              strokeWidth={2}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              data-testid="host-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder="Search hosts..."
              aria-label="Search hosts"
              className={[
                "w-full pl-10 pr-4 py-2.5 rounded-xl text-[length:var(--text-sm)]",
                "bg-bg-surface border border-border text-text-primary placeholder:text-text-muted",
                "outline-none transition-[border-color,box-shadow] duration-[var(--duration-fast)]",
                "focus:border-border-focus focus:ring-2 focus:ring-ring",
              ].join(" ")}
            />
          </div>

          {/* ── Recent connections ── */}
          {recentConnections.length > 0 && (
            <RecentConnections
              connections={recentConnections}
              onConnect={(conn) => void handleRecentConnect(conn)}
              onOpenExplorer={handleRecentExplore}
            />
          )}

          {/* ── Action buttons ── */}
          <div className="flex gap-2">
            <button
              data-testid="new-host-button"
              onClick={() => setEditingHostId("__new__")}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="New Server (Cmd+T)"
            >
              <Plus size={14} strokeWidth={2.2} aria-hidden="true" />
              New Server
            </button>

            <button
              data-testid="new-s3-button"
              onClick={() => setS3DialogOpen(true)}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="New S3 Connection"
            >
              <Cloud size={14} strokeWidth={2} aria-hidden="true" />
              New S3
            </button>

            <button
              data-testid="import-ssh-config-button"
              onClick={() => {
                setImportSource("ssh");
                setImportModalOpen(true);
              }}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="Import Connections"
            >
              <Import size={14} strokeWidth={2} aria-hidden="true" />
              Import
            </button>

            <button
              data-testid="import-passwords-button"
              onClick={() => setImportPasswordsOpen(true)}
              className={[
                "flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium uppercase tracking-wide",
                "bg-bg-surface border border-border text-text-secondary",
                "hover:border-border-focus hover:text-text-primary hover:bg-bg-overlay",
                "transition-all duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              ].join(" ")}
              title="Import passwords from a file"
            >
              <KeyRound size={14} strokeWidth={2} aria-hidden="true" />
              Import Passwords
            </button>
          </div>

          {/* ── Hosts section ── */}
          <section aria-labelledby="hosts-heading">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2
                id="hosts-heading"
                className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted"
              >
                {selectedGroupId === UNGROUPED_ID
                  ? "Ungrouped"
                  : activeGroup
                    ? activeGroup.name
                    : "Hosts"}
              </h2>

              {/* View mode toggle (Cards vs List vs Grouped) */}
              {(filteredHosts.length > 0 || isGroupedView) && (
                <div
                  className="flex items-center gap-0.5 p-0.5 rounded-lg bg-bg-surface border border-border"
                  role="group"
                  aria-label="Hosts view layout"
                >
                  <button
                    type="button"
                    data-testid="hosts-view-cards-button"
                    onClick={() => setHostsViewMode("cards")}
                    aria-pressed={hostsViewMode === "cards"}
                    aria-label="Card grid view"
                    title="Cards view"
                    className={[
                      "p-1.5 rounded-md transition-colors",
                      hostsViewMode === "cards"
                        ? "bg-bg-overlay text-text-primary shadow-xs"
                        : "text-text-muted hover:text-text-primary",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    ].join(" ")}
                  >
                    <LayoutGrid size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    data-testid="hosts-view-list-button"
                    onClick={() => setHostsViewMode("list")}
                    aria-pressed={hostsViewMode === "list"}
                    aria-label="List view"
                    title="List view"
                    className={[
                      "p-1.5 rounded-md transition-colors",
                      hostsViewMode === "list"
                        ? "bg-bg-overlay text-text-primary shadow-xs"
                        : "text-text-muted hover:text-text-primary",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    ].join(" ")}
                  >
                    <List size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    data-testid="hosts-view-grouped-button"
                    onClick={() => setHostsViewMode("grouped")}
                    aria-pressed={hostsViewMode === "grouped"}
                    aria-label="Grouped view"
                    title="Grouped view"
                    className={[
                      "p-1.5 rounded-md transition-colors",
                      hostsViewMode === "grouped"
                        ? "bg-bg-overlay text-text-primary shadow-xs"
                        : "text-text-muted hover:text-text-primary",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    ].join(" ")}
                  >
                    <ListTree size={14} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>

            {/* Host grid, list, grouped tree, or empty state */}
            {isGroupedView ? (
              filteredHosts.length > 0 || filteredS3.length > 0 ? (
                <HostGroupedView
                  groups={groups}
                  hostsByGroup={hostsByGroup}
                  s3ByGroup={s3ByGroup}
                  onConnect={(h) => void connectToHost(h)}
                  onExplore={(h) => void exploreHost(h)}
                  onEdit={setEditingHostId}
                  onDelete={(id) => void handleDeleteHost(id)}
                  onDuplicate={(h) => void handleDuplicateHost(h)}
                  onSplit={splitHostIntoTerminal}
                  onS3Connect={(c) => void handleS3Connect(c)}
                  onS3Edit={(c) => setEditingS3Connection(c)}
                  onS3Duplicate={(c) => void handleS3Duplicate(c)}
                  onS3Delete={(c) => void handleS3Delete(c)}
                />
              ) : (
                <EmptyHostsState
                  query={query}
                  hasHosts={hosts.length > 0}
                  groupFiltered={false}
                />
              )
            ) : filteredHosts.length > 0 ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={filteredHosts.map((h) => h.id)}
                  strategy={hostsViewMode === "list" ? verticalListSortingStrategy : rectSortingStrategy}
                >
                  {hostsViewMode === "list" ? (
                    <div className="flex flex-col gap-2">
                      {filteredHosts.map((host) => (
                        <SortableCard key={host.id} id={host.id}>
                          <HostListRow
                            host={host}
                            onConnect={(h) => void connectToHost(h)}
                            onExplore={(h) => void exploreHost(h)}
                            onEdit={setEditingHostId}
                            onDelete={(id) => void handleDeleteHost(id)}
                            onDuplicate={(h) => void handleDuplicateHost(h)}
                            onSplit={splitHostIntoTerminal}
                          />
                        </SortableCard>
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2.5">
                      {filteredHosts.map((host) => (
                        <SortableCard key={host.id} id={host.id}>
                          <HostCard
                            host={host}
                            onConnect={(h) => void connectToHost(h)}
                            onExplore={(h) => void exploreHost(h)}
                            onEdit={setEditingHostId}
                            onDelete={(id) => void handleDeleteHost(id)}
                            onDuplicate={(h) => void handleDuplicateHost(h)}
                            onSplit={splitHostIntoTerminal}
                          />
                        </SortableCard>
                      ))}
                    </div>
                  )}
                </SortableContext>
              </DndContext>
            ) : (
              <EmptyHostsState
                query={query}
                hasHosts={hosts.length > 0}
                groupFiltered={selectedGroupId !== null}
              />
            )}
          </section>

          {/* ── S3 connections section (folded into grouped sections in grouped view) ── */}
          {!isGroupedView && filteredS3.length > 0 && (
            <section aria-labelledby="s3-heading">
              <h2
                id="s3-heading"
                className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted mb-3"
              >
                Cloud Storage
              </h2>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleS3DragEnd}
              >
                <SortableContext
                  items={filteredS3.map((c) => c.id)}
                  strategy={rectSortingStrategy}
                >
                  <div className="grid grid-cols-3 gap-2.5">
                    {filteredS3.map((conn) => (
                      <SortableCard key={conn.id} id={conn.id}>
                        <S3Card
                          conn={conn}
                          onConnect={(c) => void handleS3Connect(c)}
                          onEdit={(c) => setEditingS3Connection(c)}
                          onDuplicate={(c) => void handleS3Duplicate(c)}
                          onDelete={(c) => void handleS3Delete(c)}
                        />
                      </SortableCard>
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </section>
          )}
          </div>
        </div>
      </div>

      {/* ── Group create modal ── */}
      <GroupModal
        open={groupModalOpen}
        onClose={() => setGroupModalOpen(false)}
        onSave={handleCreateGroup}
      />

      {/* ── Group delete confirmation dialog ── */}
      {deletingGroup && (
        <GroupDeleteDialog
          group={deletingGroup.group}
          hostCount={deletingGroup.hostCount}
          onConfirm={(deleteHosts) => void handleGroupDeleteConfirm(deleteHosts)}
          onCancel={() => setDeletingGroup(null)}
        />
      )}

      {s3DialogOpen && (
        <S3ConnectDialog onClose={() => { setS3DialogOpen(false); void loadS3Connections(); }} />
      )}

      {editingS3Connection && (
        <S3ConnectDialog
          editConnection={editingS3Connection}
          onClose={() => { setEditingS3Connection(null); void loadS3Connections(); }}
        />
      )}

      {importModalOpen && (
        <ImportSshConfigModal
          onClose={() => setImportModalOpen(false)}
          onImported={() => void Promise.all([loadHosts(), loadGroups()])}
          initialSource={importSource}
        />
      )}

      {importPasswordsOpen && (
        <ImportPasswordsModal
          onClose={() => setImportPasswordsOpen(false)}
          onSaved={() => {
            void loadHosts();
          }}
        />
      )}

      {connectingHost && (
        <ConnectionDialog
          label={connectingHost.label}
          error={connectingHost.error}
          onClose={() => setConnectingHost(null)}
          onRetry={connectingHost.retry ?? undefined}
          onCancel={connectingHost.cancel ?? undefined}
        />
      )}
    </>
  );
}

// ─── Empty states ─────────────────────────────────────────────────────────────

interface EmptyHostsStateProps {
  query: string;
  hasHosts: boolean;
  groupFiltered: boolean;
}

function EmptyHostsState({ query, hasHosts, groupFiltered }: EmptyHostsStateProps) {
  if (query.trim()) {
    return (
      <p className="text-[length:var(--text-sm)] text-text-muted py-8 text-center">
        No hosts match &ldquo;{query}&rdquo;
      </p>
    );
  }

  if (groupFiltered) {
    return (
      <p className="text-[length:var(--text-sm)] text-text-muted py-8 text-center">
        No hosts in this group yet.
      </p>
    );
  }

  if (!hasHosts) {
    return (
      <p className="text-[length:var(--text-sm)] text-text-muted py-8 text-center">
        No saved hosts yet. Connect to a server to save it here.
      </p>
    );
  }

  return null;
}
