import { create } from "zustand";

interface UiState {
  sidebarExpanded: boolean;
  sidebarWidth: number;
  quickConnectOpen: boolean;
  editingHostId: string | null;
  snippetPanelOpen: boolean;
  snippetPanelPinned: boolean;
  splitModal: {
    open: boolean;
    targetSessionId: string | null;
    direction: "horizontal" | "vertical";
  };
  /* One-shot cross-page deeplink request: pages unmount when their tab is not
   * active, so a Settings link that should open a Hosts-tab modal stores the
   * intent here. The Hosts dashboard consumes it on mount and clears it. */
  pendingHostsImport: "connections" | null;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setQuickConnectOpen: (open: boolean) => void;
  setEditingHostId: (id: string | null) => void;
  toggleSnippetPanel: () => void;
  toggleSnippetPanelPinned: () => void;
  openSplitModal: (targetSessionId: string, direction?: "horizontal" | "vertical") => void;
  closeSplitModal: () => void;
  requestHostsImport: () => void;
  consumeHostsImport: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarExpanded: false,
  sidebarWidth: 240,
  quickConnectOpen: false,
  editingHostId: null,
  snippetPanelOpen: false,
  snippetPanelPinned: false,
  splitModal: {
    open: false,
    targetSessionId: null,
    direction: "horizontal",
  },
  pendingHostsImport: null,

  toggleSidebar: () =>
    set((s) => ({ sidebarExpanded: !s.sidebarExpanded })),

  setSidebarWidth: (width) =>
    set({ sidebarWidth: Math.max(180, Math.min(400, width)) }),

  setQuickConnectOpen: (open) =>
    set({ quickConnectOpen: open }),

  setEditingHostId: (id) =>
    set({ editingHostId: id }),

  toggleSnippetPanel: () =>
    set((s) => ({ snippetPanelOpen: !s.snippetPanelOpen })),

  toggleSnippetPanelPinned: () =>
    set((s) => ({ snippetPanelPinned: !s.snippetPanelPinned })),

  openSplitModal: (targetSessionId, direction = "horizontal") =>
    set({
      splitModal: {
        open: true,
        targetSessionId,
        direction,
      },
    }),

  closeSplitModal: () =>
    set((s) => ({
      splitModal: {
        ...s.splitModal,
        open: false,
      },
    })),

  requestHostsImport: () => set({ pendingHostsImport: "connections" }),

  consumeHostsImport: () => set({ pendingHostsImport: null }),
}));

// E2E test hook — lets WebDriver tests open the HostEditModal for a given
// host id without having to drive the right-click context menu (which is
// flaky in WebKitWebDriver). No production code reads this.
if (typeof window !== "undefined") {
  (window as unknown as { __e2eOpenHostEdit?: (id: string | null) => void })
    .__e2eOpenHostEdit = (id) => useUiStore.getState().setEditingHostId(id);
}
