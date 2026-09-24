import { useRef, useState, useEffect, useCallback, type CSSProperties } from "react";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  X,
  Code,
  Maximize2,
  Columns2,
  Rows2,
  TerminalSquare,
  FolderOpen,
  Cloud,
  Monitor,
  Braces,
  Plug,
  History,
  Settings,
  ArrowUpDown,
  Rocket,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useTabStore, type UnifiedTab, type PageId } from "../../stores/tab-store";
import { useSessionStore, countPanes, getTopDirection } from "../../stores/session-store";
import { useUiStore } from "../../stores/ui-store";
import { closeExplorerSession, resolveExplorerTransport } from "../../lib/explorer-transport";

// Axis-lock modifier keeping drag movement strictly horizontal on the tab strip.
const restrictToHorizontal: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

const MODIFIERS = [restrictToHorizontal];

const DND_ACCESSIBILITY = {
  screenReaderInstructions: {
    draggable:
      "Drag to reorder tabs. To move the active tab with the keyboard, press Command or Control plus Shift plus left or right bracket.",
  },
};

// ─── Icon mapping ───────────────────────────────────────────────────────────

const PAGE_ICONS: Record<PageId, React.ElementType> = {
  hosts: Monitor,
  snippets: Braces,
  "port-forwarding": Plug,
  history: History,
  settings: Settings,
  transfers: ArrowUpDown,
  changelog: Rocket,
};

function getTabIcon(tab: UnifiedTab): React.ElementType {
  if (tab.type === "terminal") return TerminalSquare;
  if (tab.type === "sftp") return FolderOpen;
  if (tab.type === "s3") return Cloud;
  return PAGE_ICONS[tab.page] ?? Monitor;
}

// The snippet palette is bound to Cmd+K on macOS, Ctrl+K elsewhere (see the
// shortcut hook). Show the matching hint rather than a mac-only ⌘.
const IS_MAC =
  typeof navigator !== "undefined" &&
  (navigator.platform.includes("Mac") || navigator.platform === "MacIntel");
const SNIPPET_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl K";

// Browser-style tab-overflow scroll button (shown instead of a scrollbar).
const CHEVRON_BTN =
  "shrink-0 flex items-center justify-center w-6 h-[32px] rounded-md text-text-muted " +
  "hover:text-text-primary hover:bg-bg-overlay disabled:opacity-30 disabled:pointer-events-none " +
  "transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// ─── Component ──────────────────────────────────────────────────────────────

export function UnifiedTabBar() {
  const tabOrder = useTabStore((s) => s.tabOrder);
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const removeTab = useTabStore((s) => s.removeTab);
  const moveTab = useTabStore((s) => s.moveTab);

  const sessions = useSessionStore((s) => s.sessions);
  const terminalTabs = useSessionStore((s) => s.tabs);
  const zoomedPaneId = useSessionStore((s) => s.zoomedPaneId);

  const toggleSnippetPanel = useUiStore((s) => s.toggleSnippetPanel);
  const snippetPanelOpen = useUiStore((s) => s.snippetPanelOpen);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over && active.id !== over.id) {
        moveTab(String(active.id), tabOrder.indexOf(String(over.id)));
      }
    },
    [moveTab, tabOrder],
  );

  // When the tabs overflow, show browser-style chevrons instead of a scrollbar.
  // Both slots render whenever there's overflow (each disabled when its side is
  // exhausted) so the strip width stays stable while scrolling.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflow(max > 1);
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft < max - 1);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateArrows, { passive: true });
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateArrows);
      ro.disconnect();
    };
  }, [updateArrows]);

  // Re-measure after every render: content width changes without a container
  // resize or count change (pane-split indicator, label rename) still flow
  // through a render of this component. The setters bail when unchanged.
  useEffect(updateArrows);

  // Keep the active tab visible — a newly opened tab is appended off-screen
  // right, and with the scrollbar hidden there'd be no hint it exists.
  useEffect(() => {
    scrollRef.current
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabId]);

  const scrollTabs = (dir: -1 | 1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: "smooth" });
  };

  const handleClose = async (tabId: string, tab: UnifiedTab, e: React.MouseEvent) => {
    e.stopPropagation();
    const { invoke } = await import("@tauri-apps/api/core");

    if (tab.type === "terminal") {
      // Disconnect all sessions in the terminal layout tree
      const termTab = terminalTabs.get(tabId);
      if (termTab) {
        const sessionIds = collectLayoutIds(termTab.layout);
        for (const sid of sessionIds) {
          try { await invoke("ssh_disconnect", { sessionId: sid }); } catch { /* ok */ }
          useSessionStore.getState().removeSession(sid);
        }
      }
    } else if (tab.type === "sftp") {
      const { useSftpStore } = await import("../../stores/sftp-store");
      const session = useSftpStore.getState().sessions.get(tabId);
      const transport = resolveExplorerTransport(session, tab.transport) ?? "sftp";
      try { await closeExplorerSession(transport, tabId); } catch { /* ok */ }
      useSftpStore.getState().closeSession(tabId);
    } else if (tab.type === "s3") {
      try { await invoke("s3_disconnect", { s3SessionId: tabId }); } catch { /* ok */ }
      const { useS3Store } = await import("../../stores/s3-store");
      useS3Store.getState().closeSession(tabId);
    }

    removeTab(tabId);
  };

  if (tabOrder.length === 0) return null;

  return (
    <div className="flex items-center h-[var(--tabbar-height)] no-select px-2 pt-2">
      {overflow && (
        <button
          type="button"
          onClick={() => scrollTabs(-1)}
          disabled={!canLeft}
          aria-label="Scroll tabs left"
          className={`${CHEVRON_BTN} mr-1`}
        >
          <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
      <div
        ref={scrollRef}
        className="flex items-center gap-2.5 overflow-x-auto overflow-y-hidden flex-1 min-w-0 [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Open sessions"
      >
        {/*
         * Tab reordering drag-and-drop context.
         * KeyboardSensor is omitted so Space/Enter continues to activate tabs
         * without triggering dnd-kit pick-up; keyboard reordering is handled via
         * Cmd/Ctrl+Shift+[ / ]. MouseSensor (5px) and TouchSensor (250ms press)
         * prevent accidental drags during plain clicks or taps.
         * Transformations are locked to the horizontal axis via restrictToHorizontal.
         */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={MODIFIERS}
          accessibility={DND_ACCESSIBILITY}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={tabOrder}
            strategy={horizontalListSortingStrategy}
          >
            {tabOrder.map((tabId) => {
              const tab = tabs.get(tabId);
              if (!tab) return null;

              const isActive = tabId === activeTabId;

              // Terminal-specific metadata
              let statusDot: string | null = null;
              let paneCount = 1;
              let topDir: "horizontal" | "vertical" | null = null;
              let isZoomed = false;

              if (tab.type === "terminal") {
                const termTab = terminalTabs.get(tabId);
                if (termTab) {
                  paneCount = countPanes(termTab.layout);
                  topDir = getTopDirection(termTab.layout);
                }
                // Status from first session in layout
                const firstSessionId = getFirstSessionIdFromTab(tabId);
                const firstSession = firstSessionId ? sessions.get(firstSessionId) : null;
                const status = firstSession?.status ?? "Disconnected";
                statusDot =
                  status === "Connected"    ? "bg-status-connected" :
                  status === "Connecting"   ? "bg-status-connecting motion-safe:animate-pulse" :
                  status === "Error"        ? "bg-status-error" :
                                              "bg-status-disconnected";
                isZoomed = isActive && zoomedPaneId !== null;
              }

              return (
                <SortableTab
                  key={tabId}
                  tabId={tabId}
                  tab={tab}
                  isActive={isActive}
                  onSelect={() => setActiveTab(tabId)}
                  onClose={(e) => void handleClose(tabId, tab, e)}
                  statusDot={statusDot}
                  paneCount={paneCount}
                  topDir={topDir}
                  isZoomed={isZoomed}
                />
              );
            })}
          </SortableContext>
        </DndContext>
      </div>

      {overflow && (
        <button
          type="button"
          onClick={() => scrollTabs(1)}
          disabled={!canRight}
          aria-label="Scroll tabs right"
          className={`${CHEVRON_BTN} ml-1`}
        >
          <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      )}

      {/* Right actions — only show snippet button when a terminal tab is active.
          A labelled button (with the ⌘K hint) reads as a control instead of a
          stray muted icon, which was easy to miss. */}
      {activeTabId && tabs.get(activeTabId)?.type === "terminal" && (
        <div className="flex items-center gap-1 pl-2 shrink-0">
          <button
            onClick={toggleSnippetPanel}
            title={`Snippets (${SNIPPET_SHORTCUT})`}
            aria-label="Open snippet palette"
            aria-pressed={snippetPanelOpen}
            className={[
              "flex items-center gap-1.5 h-7 px-2 rounded-md border shrink-0",
              "text-[length:var(--text-xs)] font-medium",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              snippetPanelOpen
                ? "bg-accent/15 text-accent border-accent/40"
                : "bg-bg-overlay/60 text-text-secondary border-border/60 hover:text-text-primary hover:bg-bg-overlay hover:border-border",
            ].join(" ")}
          >
            <Code size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>Snippets</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Sortable tab ───────────────────────────────────────────────────────────

/*
 * File-local sortable tab item wrapping the unified tab surface.
 * Spreads dnd-kit attributes first so our explicit role="tab", tabIndex,
 * and aria-selected override dnd-kit's default button semantics.
 * Uses CSS.Translate instead of CSS.Transform to prevent horizontalListSortingStrategy
 * from calculating scaleX distortions on variable-width tabs. The Hosts tab is
 * pinned (disabled: true) so it cannot be picked up or targeted as a drop destination.
 */
interface SortableTabProps {
  tabId: string;
  tab: UnifiedTab;
  isActive: boolean;
  onSelect: () => void;
  onClose: (e: React.MouseEvent) => void;
  statusDot: string | null;
  paneCount: number;
  topDir: "horizontal" | "vertical" | null;
  isZoomed: boolean;
}

function SortableTab({
  tabId,
  tab,
  isActive,
  onSelect,
  onClose,
  statusDot,
  paneCount,
  topDir,
  isZoomed,
}: SortableTabProps) {
  const isHostsTab = tab.type === "page" && tab.page === "hosts";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tabId, disabled: isHostsTab });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 30 : undefined,
  };

  const Icon = getTabIcon(tab);
  const closeable = !isHostsTab;

  return (
    <div
      ref={setNodeRef}
      style={style}
      // dnd-kit attributes spread first so our role="tab", tabIndex, and aria-selected win.
      {...attributes}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      {...listeners}
      data-testid={`tab-${tabId}`}
      data-tab-type={tab.type}
      data-tab-label={tab.label}
      onClick={onSelect}
      // Middle-click closes the tab, like a browser.
      onAuxClick={(e) => {
        if (e.button === 1 && closeable) {
          e.preventDefault();
          onClose(e);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      title={tab.label + (paneCount > 1 ? ` (${paneCount} panes)` : "")}
      className={[
        "group relative flex items-center gap-2 px-3.5 h-[32px] shrink-0 max-w-[220px]",
        "text-[length:var(--text-sm)] leading-none rounded-md cursor-pointer",
        "transition-[color,background-color] duration-[var(--duration-fast)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive
          ? "bg-accent/15 text-accent border border-accent/40"
          : "bg-bg-overlay/80 text-text-secondary border border-border/60 hover:text-text-primary hover:bg-bg-overlay hover:border-border",
      ].join(" ")}
    >
      {/* Tab icon */}
      <Icon
        size={14}
        strokeWidth={1.8}
        className={[
          "shrink-0",
          tab.type === "terminal" && statusDot ? statusDot.replace("bg-", "text-") : "",
          tab.type === "sftp" || tab.type === "s3" ? "text-status-connected" : "",
          tab.type === "page" && isActive ? "text-accent" : "",
          tab.type === "page" && !isActive ? "text-text-muted" : "",
        ].join(" ")}
        aria-hidden="true"
      />

      {/* Label — the wrapper reserves the bold (active) width so
          toggling font-medium on activate/deactivate doesn't resize the
          tab and shift its neighbours (see .label-stable-bold). */}
      <span data-label={tab.label} className="label-stable-bold">
        <span className={`truncate ${isActive ? "font-medium" : ""}`}>
          {tab.label}
        </span>
      </span>

      {/* Split indicator (terminal only) */}
      {tab.type === "terminal" && paneCount === 2 && topDir && (
        <span className="shrink-0 text-text-muted" aria-hidden="true">
          {topDir === "horizontal" ? (
            <Columns2 size={13} strokeWidth={1.8} />
          ) : (
            <Rows2 size={13} strokeWidth={1.8} />
          )}
        </span>
      )}
      {tab.type === "terminal" && paneCount >= 3 && (
        <span className="flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-lg bg-bg-muted text-[10px] font-bold text-text-secondary tabular-nums leading-none shrink-0">
          {paneCount}
        </span>
      )}

      {/* Zoom indicator */}
      {isZoomed && (
        <span className="shrink-0 text-accent" aria-hidden="true" title="Zoomed pane">
          <Maximize2 size={11} strokeWidth={2} />
        </span>
      )}

      {/* Close button */}
      {closeable && (
        <button
          data-testid={`tab-${tabId}-close`}
          onClick={onClose}
          className={[
            "ml-auto p-0.5 -mr-1 rounded-lg shrink-0",
            isActive
              ? "text-accent/60 hover:text-accent hover:bg-accent/10"
              : "text-text-muted hover:text-text-primary hover:bg-bg-muted",
            "opacity-0 group-hover:opacity-100",
            "transition-all duration-[var(--duration-fast)]",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ].join(" ")}
          aria-label={`Close ${tab.label}`}
          tabIndex={-1}
        >
          <X size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function collectLayoutIds(node: import("../../types").LayoutNode): string[] {
  if (node.type === "pane") return [node.sessionId];
  return [...collectLayoutIds(node.children[0]), ...collectLayoutIds(node.children[1])];
}

function getFirstSessionIdFromTab(tabId: string): string | null {
  const tab = useSessionStore.getState().tabs.get(tabId);
  if (!tab) return null;
  let node = tab.layout;
  while (node.type === "split") node = node.children[0];
  return node.sessionId;
}
