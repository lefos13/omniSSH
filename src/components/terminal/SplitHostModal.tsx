/*
 * Split terminal host picker modal.
 * Allows users to choose an existing saved host to connect and split side-by-side
 * or stacked with the currently focused terminal pane. Supports instant search,
 * direction toggling (horizontal/vertical), and keyboard navigation.
 */

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Search,
  Columns2,
  Rows2,
  X,
  Loader2,
  AlertCircle,
  Terminal,
  Clock,
} from "lucide-react";
import { useHostsStore } from "../../stores/hosts-store";
import { useSessionStore } from "../../stores/session-store";
import { useUiStore } from "../../stores/ui-store";
import { ModalBackdrop } from "../shared/ModalBackdrop";
import type { SavedHost, HostConfig, SplitDirection } from "../../types";
import { getHostColor, ENV_BADGE_CLASSES, ENV_LABELS, isEnvironmentValue } from "../dashboard/HostCard";

export function SplitHostModal() {
  const { open, targetSessionId, direction: initialDirection } = useUiStore((s) => s.splitModal);
  const closeSplitModal = useUiStore((s) => s.closeSplitModal);
  const { hosts, loadHosts, recordConnection } = useHostsStore();

  const [direction, setDirection] = useState<SplitDirection>(initialDirection || "horizontal");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Sync initial direction from store when opened
  useEffect(() => {
    if (open) {
      setDirection(initialDirection || "horizontal");
      setQuery("");
      setSelectedIndex(0);
      setConnectingHostId(null);
      setConnectError(null);
      void loadHosts();
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [open, initialDirection, loadHosts]);

  // Filter hosts by label, host, username, environment, or tags
  const filteredHosts = useMemo(() => {
    const list = Array.isArray(hosts) ? hosts : [];
    const q = query.trim().toLowerCase();
    if (!q) {
      // Sort recently connected hosts first, then alphabetical
      return [...list].sort((a, b) => {
        if (a.last_connected_at && b.last_connected_at) {
          return new Date(b.last_connected_at).getTime() - new Date(a.last_connected_at).getTime();
        }
        if (a.last_connected_at) return -1;
        if (b.last_connected_at) return 1;
        return (a.label || a.host).localeCompare(b.label || b.host);
      });
    }
    return list.filter((h) => {
      const matchLabel = h.label?.toLowerCase().includes(q);
      const matchHost = h.host.toLowerCase().includes(q);
      const matchUser = h.username.toLowerCase().includes(q);
      const matchEnv = h.environment?.toLowerCase().includes(q);
      const matchNotes = h.notes?.toLowerCase().includes(q);
      return matchLabel || matchHost || matchUser || matchEnv || matchNotes;
    });
  }, [hosts, query]);

  // Reset selected index when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll<HTMLButtonElement>('[role="option"]');
    const activeItem = items[selectedIndex];
    if (typeof activeItem?.scrollIntoView === "function") {
      activeItem.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Connect to selected host and create split pane
  const handleConnect = useCallback(
    async (host: SavedHost) => {
      if (!targetSessionId || connectingHostId) return;

      setConnectingHostId(host.id);
      setConnectError(null);

      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const attemptId = crypto.randomUUID();
        const newSessionId = await invoke<string>("connect_saved_host", {
          hostId: host.id,
          attemptId,
        });

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

        void recordConnection(host.id);
        useSessionStore.getState().splitPane(direction, targetSessionId, newSessionId, hostConfig);
        closeSplitModal();
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : err && typeof err === "object" && "message" in err
              ? String((err as { message: string }).message)
              : "Connection failed. Check host and credentials.";
        setConnectError(msg);
      } finally {
        setConnectingHostId(null);
      }
    },
    [targetSessionId, connectingHostId, direction, recordConnection, closeSplitModal],
  );

  // Global modal keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (connectingHostId) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (filteredHosts.length === 0 ? 0 : (prev + 1) % filteredHosts.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filteredHosts.length === 0 ? 0 : (prev - 1 + filteredHosts.length) % filteredHosts.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = filteredHosts[selectedIndex];
      if (selected) {
        void handleConnect(selected);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeSplitModal();
    }
  };

  if (!open) return null;

  return (
    <ModalBackdrop
      onClose={closeSplitModal}
      closeDisabled={Boolean(connectingHostId)}
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] p-4 bg-black/60 backdrop-blur-sm animate-[fade-in_var(--duration-fast)_ease-out]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Split terminal with host"
        data-testid="split-host-modal"
        onKeyDown={handleKeyDown}
        className="w-full max-w-lg bg-bg-surface border border-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh] animate-[scale-in_var(--duration-fast)_ease-out]"
      >
        {/* ─── Header: Direction & Close ─── */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg-surface/90 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-text-primary">Split Terminal</span>
            <div className="flex items-center bg-bg-base border border-border/80 rounded-md p-0.5 text-xs">
              <button
                type="button"
                data-testid="split-host-dir-horizontal"
                onClick={() => setDirection("horizontal")}
                className={[
                  "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                  direction === "horizontal"
                    ? "bg-accent text-text-inverse shadow-xs"
                    : "text-text-muted hover:text-text-primary",
                ].join(" ")}
                title="Split Right"
              >
                <Columns2 size={12} strokeWidth={2} />
                <span>Right</span>
              </button>
              <button
                type="button"
                data-testid="split-host-dir-vertical"
                onClick={() => setDirection("vertical")}
                className={[
                  "flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                  direction === "vertical"
                    ? "bg-accent text-text-inverse shadow-xs"
                    : "text-text-muted hover:text-text-primary",
                ].join(" ")}
                title="Split Down"
              >
                <Rows2 size={12} strokeWidth={2} />
                <span>Down</span>
              </button>
            </div>
          </div>

          <button
            type="button"
            data-testid="split-host-close"
            onClick={closeSplitModal}
            disabled={Boolean(connectingHostId)}
            aria-label="Close dialog"
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-muted transition-colors disabled:opacity-50"
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>

        {/* ─── Search input ─── */}
        <div className="flex items-center px-3.5 h-11 border-b border-border shrink-0 gap-2 bg-bg-base/40">
          <Search size={15} className="text-text-muted shrink-0" />
          <input
            ref={searchInputRef}
            data-testid="split-host-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={Boolean(connectingHostId)}
            placeholder="Search hosts by name, user, IP, environment..."
            className="flex-1 bg-transparent text-[length:var(--text-sm)] text-text-primary placeholder:text-text-muted outline-none disabled:opacity-50"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="p-1 text-text-muted hover:text-text-primary rounded text-xs"
            >
              Clear
            </button>
          )}
        </div>

        {/* ─── Connection error banner ─── */}
        {connectError && (
          <div
            data-testid="split-host-error"
            className="flex items-center justify-between gap-2 px-3 py-2 bg-status-error/10 border-b border-status-error/20 text-status-error text-[11px]"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <AlertCircle size={14} className="shrink-0" />
              <span className="truncate">{connectError}</span>
            </div>
            <button
              type="button"
              onClick={() => setConnectError(null)}
              className="px-1.5 py-0.5 rounded text-[10px] hover:bg-status-error/20 shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* ─── Host list ─── */}
        <div
          ref={listRef}
          role="listbox"
          aria-label="Saved hosts"
          data-testid="split-host-list"
          className="flex-1 overflow-y-auto min-h-0 divide-y divide-border/30 p-1"
        >
          {filteredHosts.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center text-text-muted gap-2">
              <Terminal size={24} strokeWidth={1.5} className="opacity-40" />
              <p className="text-xs">No matching saved hosts found.</p>
            </div>
          ) : (
            filteredHosts.map((host, idx) => {
              const isSelected = idx === selectedIndex;
              const isConnecting = connectingHostId === host.id;
              const displayName = host.label || host.host;
              const avatarColor = host.color || getHostColor(host.host);
              const env = host.environment && isEnvironmentValue(host.environment) ? host.environment : null;

              return (
                <button
                  key={host.id}
                  role="option"
                  aria-selected={isSelected}
                  data-testid={`split-host-item-${host.id}`}
                  type="button"
                  disabled={Boolean(connectingHostId)}
                  onClick={() => void handleConnect(host)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={[
                    "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors duration-[var(--duration-fast)]",
                    isSelected
                      ? "bg-accent/10 border border-accent/30 text-text-primary"
                      : "hover:bg-bg-muted text-text-secondary border border-transparent",
                    isConnecting ? "opacity-75 pointer-events-none" : "",
                  ].join(" ")}
                >
                  {/* Host initial avatar */}
                  <span
                    style={{ backgroundColor: avatarColor }}
                    className="w-6 h-6 rounded-md flex items-center justify-center text-white text-[11px] font-bold shrink-0 shadow-xs"
                  >
                    {displayName.charAt(0).toUpperCase()}
                  </span>

                  {/* Host details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[length:var(--text-sm)] font-medium text-text-primary truncate">
                        {displayName}
                      </span>
                      {env && (
                        <span
                          className={`text-[9px] font-bold px-1 py-0.5 rounded leading-none ${ENV_BADGE_CLASSES[env]}`}
                        >
                          {ENV_LABELS[env]}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-text-muted truncate">
                      {host.username}@{host.host}:{host.port}
                    </div>
                  </div>

                  {/* Connecting spinner or last connected hint */}
                  {isConnecting ? (
                    <div className="flex items-center gap-1.5 text-accent text-xs font-medium shrink-0">
                      <Loader2 size={13} className="animate-spin" />
                      <span>Connecting...</span>
                    </div>
                  ) : host.last_connected_at ? (
                    <div className="flex items-center gap-1 text-[10px] text-text-muted shrink-0" title="Recently connected">
                      <Clock size={11} className="opacity-60" />
                    </div>
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        {/* ─── Footer hints ─── */}
        <div className="flex items-center justify-between px-3.5 py-2 border-t border-border text-[11px] text-text-muted bg-bg-surface/80 shrink-0">
          <div className="flex items-center gap-2">
            <span>
              <kbd className="font-mono bg-bg-muted px-1 py-0.5 rounded border border-border/60 text-[10px]">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="font-mono bg-bg-muted px-1 py-0.5 rounded border border-border/60 text-[10px]">↵</kbd> split
            </span>
            <span>
              <kbd className="font-mono bg-bg-muted px-1 py-0.5 rounded border border-border/60 text-[10px]">esc</kbd> close
            </span>
          </div>
          <span className="text-[10px] text-text-muted font-mono">
            {direction === "horizontal" ? "Splitting Right" : "Splitting Down"}
          </span>
        </div>
      </div>
    </ModalBackdrop>
  );
}
