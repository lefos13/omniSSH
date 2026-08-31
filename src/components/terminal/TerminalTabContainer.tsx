/*
 * Terminal tab container.
 * Wraps the terminal layout tree and optionally renders the linked explorer side
 * panel with an interactive horizontal resize handle, retaining width per session.
 * Supports mouse drag and keyboard navigation (ArrowLeft / ArrowRight / Home / End).
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

const MIN_WIDTH = 220;
const MAX_WIDTH = 800;
const KEYBOARD_STEP = 20;

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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPanelWidth(panelWidth + KEYBOARD_STEP);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPanelWidth(panelWidth - KEYBOARD_STEP);
      } else if (e.key === "Home") {
        e.preventDefault();
        setPanelWidth(MAX_WIDTH);
      } else if (e.key === "End") {
        e.preventDefault();
        setPanelWidth(MIN_WIDTH);
      }
    },
    [panelWidth, setPanelWidth],
  );

  return (
    <div className="flex h-full w-full overflow-hidden gap-2">
      <div className="flex-1 min-w-0 h-full overflow-hidden">
        <TerminalArea node={layout} tabId={tabId} />
      </div>

      {isLinkedOpen && (
        <>
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label="Resize linked file explorer"
            aria-valuenow={panelWidth}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={MAX_WIDTH}
            data-testid="linked-explorer-resize-handle"
            className="relative z-10 flex-shrink-0 w-1.5 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded transition-colors"
            onKeyDown={handleKeyDown}
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
