/*
 * Terminal tab container.
 * Wraps the terminal layout tree and optionally renders the linked explorer side
 * panel with an interactive horizontal resize handle, retaining width per session.
 */

import { useCallback } from "react";
import type { LayoutNode } from "../../types";
import { TerminalArea } from "./TerminalArea";
import { LinkedExplorerPanel } from "./LinkedExplorerPanel";
import { useLinkedExplorerStore } from "../../stores/linked-explorer-store";
import { useResizeHandle } from "../../hooks/use-resize-handle";

interface TerminalTabContainerProps {
  tabId: string;
  layout: LayoutNode;
  isActive: boolean;
}

export function TerminalTabContainer({ tabId, layout, isActive }: TerminalTabContainerProps) {
  const isLinkedOpen = useLinkedExplorerStore((s) => s.openTabIds.has(tabId));
  const panelWidth = useLinkedExplorerStore((s) => s.panelWidth);
  const setPanelWidth = useLinkedExplorerStore((s) => s.setPanelWidth);

  const handleResize = useCallback(
    (delta: number) => {
      // Panel is positioned on the right side, so moving handle to the left
      // (negative delta) expands the panel, while moving right contracts it.
      const currentWidth = useLinkedExplorerStore.getState().panelWidth;
      setPanelWidth(currentWidth - delta);
    },
    [setPanelWidth],
  );

  const resizeHandle = useResizeHandle({
    direction: "horizontal",
    onResize: handleResize,
  });

  return (
    <div className="flex h-full w-full overflow-hidden gap-2">
      <div className="flex-1 min-w-0 h-full overflow-hidden">
        <TerminalArea node={layout} tabId={tabId} />
      </div>

      {isLinkedOpen && (
        <>
          <div
            data-testid="linked-explorer-resize-handle"
            className="relative z-10 flex-shrink-0 w-1.5 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 rounded transition-colors"
            {...resizeHandle}
          />
          <div
            style={{ width: `${panelWidth}px` }}
            className="flex-shrink-0 h-full min-w-[220px] max-w-[80vw] overflow-hidden"
          >
            <LinkedExplorerPanel tabId={tabId} isActive={isActive} />
          </div>
        </>
      )}
    </div>
  );
}
