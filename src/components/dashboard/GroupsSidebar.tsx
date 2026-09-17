/*
 * Hosts tab group sidebar.
 *
 * A persistent left rail listing every group so switching the active group
 * never requires scrolling the host grid back to the top. Groups are reordered
 * by drag (vertical list) and deleted via a right-click menu, mirroring the
 * previous card-grid behaviour.
 */

import { useCallback, useState } from "react";
import { FolderPlus, Trash2, Server } from "lucide-react";
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
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { HostGroup } from "../../types";
import { ContextMenu } from "../shared/ContextMenu";
import { resolveGroupIcon } from "./GroupModal";

/** Sentinel group id for hosts that belong to no group. */
export const UNGROUPED_ID = "__ungrouped__";

interface GroupsSidebarProps {
  groups: HostGroup[];
  /** Host + S3 counts keyed by group id. */
  hostCountByGroup: Record<string, number>;
  /** Number of hosts and connections with no group. */
  ungroupedCount: number;
  /** Currently filtered group id, `UNGROUPED_ID`, or null for "All Hosts". */
  selectedGroupId: string | null;
  onSelect: (groupId: string | null) => void;
  onDelete: (groupId: string) => void;
  onReorder: (newOrder: HostGroup[]) => void;
  onNewGroup: () => void;
  /** Fixed width in pixels (resizable sidebar); falls back to w-56. */
  width?: number;
  /** When set, rows scroll-navigate instead of filtering. */
  onNavigate?: (groupId: string | null) => void;
}

const ROW_BASE = [
  "group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left",
  "transition-colors duration-[var(--duration-fast)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
].join(" ");

const ROW_IDLE = "text-text-secondary hover:text-text-primary hover:bg-bg-overlay";
const ROW_SELECTED = "bg-accent-muted text-text-primary ring-1 ring-accent/30";

export function GroupsSidebar({
  groups,
  hostCountByGroup,
  ungroupedCount,
  selectedGroupId,
  onSelect,
  onDelete,
  onReorder,
  onNewGroup,
  width,
  onNavigate,
}: GroupsSidebarProps) {
  const [contextMenu, setContextMenu] = useState<{ groupId: string; x: number; y: number } | null>(
    null,
  );

  // Same activation constraints as the host grid: a drag only begins after a
  // deliberate gesture, so a plain click still selects the group.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = groups.findIndex((g) => g.id === active.id);
      const newIndex = groups.findIndex((g) => g.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      onReorder(arrayMove(groups, oldIndex, newIndex));
    },
    [groups, onReorder],
  );

  const totalCount =
    Object.values(hostCountByGroup).reduce((sum, n) => sum + n, 0) + ungroupedCount;

  return (
    <aside
      aria-label="Host groups"
      data-testid="groups-sidebar"
      style={width ? { width } : undefined}
      className={`${width ? "" : "w-56 "}shrink-0 flex flex-col gap-1 p-3 border-r border-border/60 bg-bg-base overflow-hidden`}
    >
      <div className="flex items-center justify-between px-1.5 mb-1">
        <h2 className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted">
          Groups
        </h2>
        <button
          type="button"
          data-testid="new-group-button"
          onClick={onNewGroup}
          title="New Group"
          aria-label="New Group"
          className="inline-flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-bg-overlay transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <FolderPlus size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5 -mx-1 px-1 pb-1">
        {/* All Hosts */}
        <button
          type="button"
          data-testid="group-sidebar-all"
          onClick={() => (onNavigate ? onNavigate(null) : onSelect(null))}
          aria-pressed={selectedGroupId === null}
          className={`${ROW_BASE} ${selectedGroupId === null ? ROW_SELECTED : ROW_IDLE}`}
        >
          <Server size={15} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />
          <span className="flex-1 text-[length:var(--text-sm)] font-medium truncate">All Hosts</span>
          <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums shrink-0">
            {totalCount}
          </span>
        </button>

        {/* Groups (drag to reorder) */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={groups.map((g) => g.id)} strategy={verticalListSortingStrategy}>
            {groups.map((group) => (
              <SortableGroupRow
                key={group.id}
                group={group}
                hostCount={hostCountByGroup[group.id] ?? 0}
                isSelected={selectedGroupId === group.id}
                onSelect={() => (onNavigate ? onNavigate(group.id) : onSelect(group.id))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setContextMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
                }}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* Ungrouped — only when something actually lacks a group */}
        {ungroupedCount > 0 && (
          <button
            type="button"
            data-testid="group-sidebar-ungrouped"
            onClick={() => (onNavigate ? onNavigate(UNGROUPED_ID) : onSelect(UNGROUPED_ID))}
            aria-pressed={selectedGroupId === UNGROUPED_ID}
            className={`${ROW_BASE} ${selectedGroupId === UNGROUPED_ID ? ROW_SELECTED : ROW_IDLE}`}
          >
            <span className="w-[15px] shrink-0 text-center text-text-muted" aria-hidden="true">
              —
            </span>
            <span className="flex-1 text-[length:var(--text-sm)] truncate">Ungrouped</span>
            <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums shrink-0">
              {ungroupedCount}
            </span>
          </button>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          items={[
            {
              label: "Delete Group",
              icon: Trash2,
              danger: true,
              onClick: () => onDelete(contextMenu.groupId),
            },
          ]}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </aside>
  );
}

// ─── Sortable row ─────────────────────────────────────────────────────────────

interface SortableGroupRowProps {
  group: HostGroup;
  hostCount: number;
  isSelected: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function SortableGroupRow({
  group,
  hostCount,
  isSelected,
  onSelect,
  onContextMenu,
}: SortableGroupRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
  });
  const Icon = resolveGroupIcon(group.icon);

  return (
    <button
      ref={setNodeRef}
      type="button"
      // dnd-kit's `attributes` (role/tabindex/aria) must precede our own props
      // so the selection-focused `aria-pressed` below wins over its drag state.
      {...attributes}
      {...listeners}
      data-testid={`group-sidebar-item-${group.id}`}
      data-group-id={group.id}
      data-group-name={group.name}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      aria-pressed={isSelected}
      title={group.name}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 30 : undefined,
      }}
      className={`${ROW_BASE} relative touch-none cursor-grab active:cursor-grabbing ${
        isSelected ? ROW_SELECTED : ROW_IDLE
      }`}
    >
      <Icon
        size={15}
        strokeWidth={1.8}
        className="shrink-0"
        style={{ color: group.color }}
        aria-hidden="true"
      />
      <span className="flex-1 text-[length:var(--text-sm)] truncate">{group.name}</span>
      <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums shrink-0">
        {hostCount}
      </span>
    </button>
  );
}
