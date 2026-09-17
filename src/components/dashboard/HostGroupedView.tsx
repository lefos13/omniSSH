/*
 * Grouped (tree) viewer for the Hosts dashboard.
 * Renders one collapsible section per group — group header first, then the
 * group's hosts and S3 connections — plus a trailing Ungrouped section when
 * anything lacks a group. Hosts reuse HostListRow for full action parity;
 * S3 connections reuse S3Card in a compact grid. Sections expose stable DOM
 * ids (`group-section-<id>`) so the groups sidebar can scroll-navigate.
 */

import { useState } from "react";
import { ChevronDown, Server } from "lucide-react";
import type { HostGroup, SavedHost, S3Connection, SplitDirection } from "../../types";
import { HostListRow } from "./HostListRow";
import { S3Card } from "./S3Card";
import { UNGROUPED_ID } from "./GroupsSidebar";
import { resolveGroupIcon } from "./GroupModal";

export interface GroupedSection {
  group: HostGroup | null;
  hosts: SavedHost[];
  s3: S3Connection[];
}

interface HostGroupedViewProps {
  groups: HostGroup[];
  hostsByGroup: Map<string | null, SavedHost[]>;
  s3ByGroup: Map<string | null, S3Connection[]>;
  onConnect: (host: SavedHost) => void;
  onExplore: (host: SavedHost) => void;
  onEdit: (hostId: string) => void;
  onDelete: (hostId: string) => void;
  onDuplicate: (host: SavedHost) => void;
  onSplit: (host: SavedHost, direction: SplitDirection) => void;
  onS3Connect: (conn: S3Connection) => void;
  onS3Edit: (conn: S3Connection) => void;
  onS3Duplicate: (conn: S3Connection) => void;
  onS3Delete: (conn: S3Connection) => void;
}

function sectionId(group: HostGroup | null): string {
  return group ? `group-section-${group.id}` : `group-section-${UNGROUPED_ID}`;
}

export function HostGroupedView({
  groups,
  hostsByGroup,
  s3ByGroup,
  onConnect,
  onExplore,
  onEdit,
  onDelete,
  onDuplicate,
  onSplit,
  onS3Connect,
  onS3Edit,
  onS3Duplicate,
  onS3Delete,
}: HostGroupedViewProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sections: GroupedSection[] = [
    ...groups.map((group) => ({
      group,
      hosts: hostsByGroup.get(group.id) ?? [],
      s3: s3ByGroup.get(group.id) ?? [],
    })),
    ...((hostsByGroup.get(null) ?? []).length > 0 || (s3ByGroup.get(null) ?? []).length > 0
      ? [{ group: null, hosts: hostsByGroup.get(null) ?? [], s3: s3ByGroup.get(null) ?? [] }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="hosts-grouped-view">
      {sections.map(({ group, hosts, s3 }) => {
        const id = sectionId(group);
        const isCollapsed = collapsed.has(id);
        const total = hosts.length + s3.length;
        const Icon = group ? resolveGroupIcon(group.icon) : Server;
        const name = group ? group.name : "Ungrouped";
        return (
          <section key={id} id={id} data-testid={id} aria-label={name} className="scroll-mt-4">
            <button
              type="button"
              data-testid={`${id}-toggle`}
              onClick={() => toggle(id)}
              aria-expanded={!isCollapsed}
              aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${name}`}
              className="w-full flex items-center gap-2.5 px-1 py-1.5 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon
                size={15}
                strokeWidth={1.8}
                className="shrink-0"
                style={group ? { color: group.color } : undefined}
                aria-hidden="true"
              />
              <span className="text-[length:var(--text-xs)] font-semibold uppercase tracking-widest text-text-muted truncate">
                {name}
              </span>
              <span className="text-[length:var(--text-2xs)] text-text-muted tabular-nums shrink-0">
                {total}
              </span>
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={`shrink-0 text-text-muted transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
              />
            </button>
            {!isCollapsed && (
              <div className="flex flex-col gap-2 mt-1.5">
                {hosts.map((host) => (
                  <HostListRow
                    key={host.id}
                    host={host}
                    onConnect={onConnect}
                    onExplore={onExplore}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onDuplicate={onDuplicate}
                    onSplit={onSplit}
                  />
                ))}
                {s3.length > 0 && (
                  <div className="grid grid-cols-2 gap-2.5">
                    {s3.map((conn) => (
                      <S3Card
                        key={conn.id}
                        conn={conn}
                        onConnect={onS3Connect}
                        onEdit={onS3Edit}
                        onDuplicate={onS3Duplicate}
                        onDelete={onS3Delete}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
