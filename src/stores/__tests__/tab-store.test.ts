/*
 * Unit tests for tab store moveTab action.
 * Verifies tab reordering, boundary clamping, the pinned Hosts tab invariant,
 * state reference stability on no-ops, and active tab preservation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore, pageTabId, type UnifiedTab } from "../tab-store";

const hostsTab: UnifiedTab = {
  type: "page",
  id: pageTabId("hosts"),
  label: "Hosts",
  page: "hosts",
};

const snippetsTab: UnifiedTab = {
  type: "page",
  id: pageTabId("snippets"),
  label: "Snippets",
  page: "snippets",
};

const historyTab: UnifiedTab = {
  type: "page",
  id: pageTabId("history"),
  label: "History",
  page: "history",
};

const settingsTab: UnifiedTab = {
  type: "page",
  id: pageTabId("settings"),
  label: "Settings",
  page: "settings",
};

describe("useTabStore.moveTab", () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: new Map([
        [hostsTab.id, hostsTab],
        [snippetsTab.id, snippetsTab],
        [historyTab.id, historyTab],
        [settingsTab.id, settingsTab],
      ]),
      tabOrder: [hostsTab.id, snippetsTab.id, historyTab.id, settingsTab.id],
      activeTabId: historyTab.id,
    });
  });

  it("moves a tab to the right", () => {
    useTabStore.getState().moveTab(snippetsTab.id, 2);
    expect(useTabStore.getState().tabOrder).toEqual([
      hostsTab.id,
      historyTab.id,
      snippetsTab.id,
      settingsTab.id,
    ]);
  });

  it("moves a tab to the left", () => {
    useTabStore.getState().moveTab(settingsTab.id, 1);
    expect(useTabStore.getState().tabOrder).toEqual([
      hostsTab.id,
      settingsTab.id,
      snippetsTab.id,
      historyTab.id,
    ]);
  });

  it("clamps past both ends", () => {
    // Clamping past the right end
    useTabStore.getState().moveTab(snippetsTab.id, 100);
    expect(useTabStore.getState().tabOrder).toEqual([
      hostsTab.id,
      historyTab.id,
      settingsTab.id,
      snippetsTab.id,
    ]);

    // Clamping past the left end (clamped to minIndex=1 due to pinned Hosts)
    useTabStore.getState().moveTab(snippetsTab.id, -10);
    expect(useTabStore.getState().tabOrder).toEqual([
      hostsTab.id,
      snippetsTab.id,
      historyTab.id,
      settingsTab.id,
    ]);
  });

  it("cannot move the Hosts tab", () => {
    const initialState = useTabStore.getState();
    useTabStore.getState().moveTab(hostsTab.id, 2);
    const afterState = useTabStore.getState();

    expect(afterState).toBe(initialState);
    expect(afterState.tabOrder).toEqual([
      hostsTab.id,
      snippetsTab.id,
      historyTab.id,
      settingsTab.id,
    ]);
  });

  it("cannot displace the Hosts tab from index 0", () => {
    // Moving historyTab (initially at index 2) to index 0 clamps to index 1
    useTabStore.getState().moveTab(historyTab.id, 0);
    expect(useTabStore.getState().tabOrder).toEqual([
      hostsTab.id,
      historyTab.id,
      snippetsTab.id,
      settingsTab.id,
    ]);
    expect(useTabStore.getState().tabOrder[0]).toBe(hostsTab.id);

    // Moving snippetsTab (now at index 2) to 0 clamps to 1
    useTabStore.getState().moveTab(snippetsTab.id, 0);
    expect(useTabStore.getState().tabOrder[0]).toBe(hostsTab.id);
  });

  it("returns the exact same state reference for unknown id and same-index moves", () => {
    const beforeUnknown = useTabStore.getState();
    useTabStore.getState().moveTab("unknown-id", 2);
    const afterUnknown = useTabStore.getState();
    expect(afterUnknown).toBe(beforeUnknown);

    const beforeSame = useTabStore.getState();
    // snippetsTab is at index 1
    useTabStore.getState().moveTab(snippetsTab.id, 1);
    const afterSame = useTabStore.getState();
    expect(afterSame).toBe(beforeSame);

    // Attempting to move tab at index 1 to 0 also clamps to 1 (same index)
    const beforeClampedSame = useTabStore.getState();
    useTabStore.getState().moveTab(snippetsTab.id, 0);
    const afterClampedSame = useTabStore.getState();
    expect(afterClampedSame).toBe(beforeClampedSame);
  });

  it("leaves activeTabId and tabs map unchanged after a move", () => {
    expect(useTabStore.getState().activeTabId).toBe(historyTab.id);
    const initialTabs = useTabStore.getState().tabs;

    useTabStore.getState().moveTab(snippetsTab.id, 3);

    const currentState = useTabStore.getState();
    expect(currentState.activeTabId).toBe(historyTab.id);
    expect(currentState.tabs).toBe(initialTabs);
  });

  it("allows moving to index 0 if Hosts is not at index 0", () => {
    useTabStore.setState({
      tabs: new Map([
        [snippetsTab.id, snippetsTab],
        [historyTab.id, historyTab],
      ]),
      tabOrder: [snippetsTab.id, historyTab.id],
      activeTabId: snippetsTab.id,
    });

    useTabStore.getState().moveTab(historyTab.id, 0);
    expect(useTabStore.getState().tabOrder).toEqual([
      historyTab.id,
      snippetsTab.id,
    ]);
  });
});
