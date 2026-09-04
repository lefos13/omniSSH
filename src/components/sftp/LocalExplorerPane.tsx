/*
 * Local filesystem explorer pane.
 *
 * Renders the local filesystem left pane for standalone host explorer tabs.
 * Manages local directory listing state, breadcrumb/typed navigation, refresh,
 * loading skeletons, and error presentation. Uses the dynamic import invoke
 * pattern so backend IPC can be mocked in unit and integration tests.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AlertCircle } from "lucide-react";
import { ExplorerToolbar, ExplorerFileTable } from "../explorer";
import { createLocalProvider, toLocalExplorerEntry } from "../../providers/local-provider";
import type { LocalDirectoryListing } from "../../types/local-fs";
import type { ExplorerEntry } from "../../types/explorer";

interface LocalExplorerPaneProps {
  /** Whether the parent explorer tab is currently active/visible. */
  isActive?: boolean;
  /** Optional custom class name. */
  className?: string;
  /** Optional initial path to start at instead of user home. */
  initialPath?: string;
  /** Owning host session ID. Namespaces the local provider per tab. */
  hostSessionId?: string;
  /** Owning host session ID alias matching sftpSessionId. */
  sftpSessionId?: string;
  /** Callback invoked when selection in the local file table changes. */
  onSelectionChange?: (entries: ExplorerEntry[]) => void;
  /** Optional callback when current path changes. */
  onCurrentPathChange?: (path: string) => void;
  /** Optional callback when directory listing changes. */
  onListingChange?: (listing: LocalDirectoryListing | null) => void;
  /** Optional token or signal counter that triggers a directory reload when changed. */
  reloadSignal?: number;
  /** Optional token or signal counter alias that triggers a directory reload when changed. */
  reloadToken?: number;
}

/*
 * Extract human-readable error string from backend rejection payload.
 */
function errorMessage(err: unknown, fallback = "Unexpected error"): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: string }).message);
  }
  return typeof err === "string" ? err : fallback;
}
/*
 * Dynamic import helper for `@tauri-apps/api/core` with promise memoization.
 * In Vitest test runners, concurrent unmemoized dynamic imports can race and
 * resolve to undefined namespaces; memoizing the import promise ensures
 * consistent resolution across mounted pane instances.
 */
let invokePromise: Promise<(<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>) | undefined> | null = null;
async function getInvoke() {
  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core").then((m) => m?.invoke);
  }
  const inv = await invokePromise;
  if (!inv) {
    const mod = await import("@tauri-apps/api/core");
    return mod?.invoke;
  }
  return inv;
}

export function LocalExplorerPane({
  isActive = true,
  className = "",
  initialPath,
  hostSessionId,
  sftpSessionId,
  onSelectionChange,
  onCurrentPathChange,
  onListingChange,
  reloadSignal,
  reloadToken,
}: LocalExplorerPaneProps) {
  const [currentPath, setCurrentPath] = useState<string>(initialPath ?? "");
  const [homePath, setHomePath] = useState<string>("");
  const [listing, setListing] = useState<LocalDirectoryListing | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "size" | "modified">("name");
  const [sortAsc, setSortAsc] = useState<boolean>(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const currentPathRef = useRef<string>(currentPath);
  currentPathRef.current = currentPath;


  const owningId = hostSessionId ?? sftpSessionId;
  const localSessionId = owningId ? `local:${owningId}` : "local";

  const provider = useMemo(
    () =>
      createLocalProvider({
        sessionId: localSessionId,
        homePath,
        rootPath: listing?.segments[0]?.path,
        rootLabel: listing?.segments[0]?.label,
        parentPath: () => listing?.parent ?? (listing?.segments[0]?.path ?? "/"),
      }),
    [localSessionId, homePath, listing?.segments, listing?.parent],
  );

  const explorerEntries = useMemo(
    () => (listing ? listing.entries.map(toLocalExplorerEntry) : []),
    [listing],
  );

  const segments = useMemo(
    () => listing?.segments ?? [{ label: currentPath || "/", path: currentPath || "/" }],
    [listing?.segments, currentPath],
  );

  /*
   * Fetch local directory listing via Tauri command and update component state.
   */
  const loadDirectory = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const invoke = await getInvoke();
      if (!invoke) throw new Error("Tauri invoke unavailable");
      const list = await invoke<LocalDirectoryListing>("local_list_dir", { path });
      setListing(list);
      setCurrentPath(list.path);
      onListingChange?.(list);
      onCurrentPathChange?.(list.path);
    } catch (err) {
      setError(errorMessage(err));
      if (path) setCurrentPath(path);
    } finally {
      setLoading(false);
    }
  }, []);
  /*
   * Reload current local directory when parent triggers a reload signal or token.
   * Tracks previous counter value to avoid redundant loads on initial mount.
   */
  const lastSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const signal = reloadSignal ?? reloadToken;
    if (signal === undefined) return;
    if (lastSignalRef.current === undefined) {
      lastSignalRef.current = signal;
      return;
    }
    if (signal !== lastSignalRef.current) {
      lastSignalRef.current = signal;
      const path = currentPathRef.current;
      if (path) {
        void loadDirectory(path);
      }
    }
  }, [reloadSignal, reloadToken, loadDirectory]);


  /*
   * Initialize local pane at user home directory on mount.
   */
  useEffect(() => {
    let cancelled = false;

    async function init() {
      setLoading(true);
      setError(null);
      try {
        const invoke = await getInvoke();
        if (!invoke) throw new Error("Tauri invoke unavailable");
        const home = await invoke<string>("local_home_dir");
        if (cancelled) return;
        setHomePath(home);
        const target = currentPath || home;
        setCurrentPath(target);
        const list = await invoke<LocalDirectoryListing>("local_list_dir", { path: target });
        if (cancelled) return;
        setListing(list);
        setCurrentPath(list.path);
        onListingChange?.(list);
        onCurrentPathChange?.(list.path);
      } catch (err) {
        if (!cancelled) {
          setError(errorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reset search when current path changes
  useEffect(() => {
    setSearchQuery("");
  }, [currentPath]);

  // Focus search input on Cmd/Ctrl+F when this pane has focus and tab is active
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        if (containerRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          const input = containerRef.current?.querySelector<HTMLInputElement>(
            'input[data-testid="explorer-search-input"]',
          );
          input?.focus();
          input?.select();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isActive]);

  return (
    <div
      ref={containerRef}
      className={`flex flex-col h-full overflow-hidden relative ${className}`}
      data-explorer-pane="local"
    >
      <ExplorerToolbar
        provider={provider}
        currentPath={currentPath}
        segments={segments}
        loading={loading}
        onRefresh={() => void loadDirectory(currentPath)}
        onNavigate={(path) => void loadDirectory(path)}
        onNewFile={() => {}}
        onNewFolder={() => {}}
        onUpload={() => {}}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* Error banner */}
      {error && (
        <div
          data-testid="local-explorer-error"
          className="flex items-center gap-2.5 px-4 py-2.5 bg-status-error/10 border-b border-status-error/20 text-status-error shrink-0"
        >
          <AlertCircle size={15} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          <p className="text-[length:var(--text-sm)]">{error}</p>
        </div>
      )}

      <ExplorerFileTable
        pane="local"
        isActive={isActive}
        provider={provider}
        entries={explorerEntries}
        sortBy={sortBy}
        sortAsc={sortAsc}
        onSortChange={(col, asc) => {
          setSortBy(col);
          setSortAsc(asc);
        }}
        clipboard={null}
        onSetClipboard={() => {}}
        onNavigate={(path) => void loadDirectory(path)}
        onDownload={() => {}}
        onDelete={async () => {}}
        currentPath={currentPath}
        loading={loading}
        searchQuery={searchQuery}
        onClearSearch={() => setSearchQuery("")}
        onSelectionChange={onSelectionChange}
      />
    </div>
  );
}
