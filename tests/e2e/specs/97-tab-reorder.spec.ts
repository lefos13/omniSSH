// Tab reordering — verifies drag-and-drop reordering in the unified tab bar,
// the pinned Hosts tab invariant, and keyboard reordering via Cmd/Ctrl+Shift+[ / ].

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { cmdShift } from "../helpers/keyboard.js";
import { dragOnto } from "../helpers/reorder.js";
import {
    clickTabByLabel,
    domTabOrder,
    waitForTabCount,
} from "../helpers/tabs.js";

/*
 * Opens a page tab via its sidebar navigation button and waits for the tab
 * to appear in the unified tab bar.
 */
async function openPageTab(label: "Snippets" | "History" | "Settings"): Promise<void> {
    const nav = await $(`[aria-label='${label}']`);
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    const tab = await $(`[data-tab-label='${label}']`);
    await tab.waitForExist({ timeout: 10_000 });
}

/*
 * Opens Snippets, History, and Settings page tabs so the tab bar contains:
 * ["Hosts", "Snippets", "History", "Settings"].
 */
async function openThreePageTabs(): Promise<void> {
    await openPageTab("Snippets");
    await waitForTabCount(2);
    await openPageTab("History");
    await waitForTabCount(3);
    await openPageTab("Settings");
    await waitForTabCount(4);
    expect(await domTabOrder()).to.deep.equal([
        "Hosts",
        "Snippets",
        "History",
        "Settings",
    ]);
}

describe("tab reordering", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("drags first non-Hosts tab onto the last tab", async () => {
        await openThreePageTabs();

        // Drag first non-Hosts tab ("Snippets") onto the last tab ("Settings")
        const firstNonHosts = await $("[data-tab-label='Snippets']");
        const lastTab = await $("[data-tab-label='Settings']");
        await dragOnto(firstNonHosts, lastTab);

        const expectedOrder = ["Hosts", "History", "Settings", "Snippets"];
        await browser.waitUntil(
            async () => {
                const order = await domTabOrder();
                return JSON.stringify(order) === JSON.stringify(expectedOrder);
            },
            {
                timeout: 5_000,
                timeoutMsg: `Tab order never matched ${JSON.stringify(expectedOrder)}`,
            },
        );
        expect(await domTabOrder()).to.deep.equal(expectedOrder);
    });

    it("drags the last tab onto Hosts leaving Hosts first, and ignores dragging Hosts", async () => {
        await openThreePageTabs();

        // Drag the last tab ("Settings") onto Hosts (index 0).
        // Hosts is pinned and disabled in sortable; Settings lands at index 1.
        const settingsTab = await $("[data-tab-label='Settings']");
        const hostsTab = await $("[data-tab-label='Hosts']");
        await dragOnto(settingsTab, hostsTab);

        const expectedOrder = ["Hosts", "Settings", "Snippets", "History"];
        await browser.waitUntil(
            async () => {
                const order = await domTabOrder();
                return JSON.stringify(order) === JSON.stringify(expectedOrder);
            },
            {
                timeout: 5_000,
                timeoutMsg: `Tab order never matched ${JSON.stringify(expectedOrder)}`,
            },
        );
        expect(await domTabOrder()).to.deep.equal(expectedOrder);

        // Drag Hosts onto another tab ("Snippets").
        // Hosts is disabled for dragging, so the tab order remains unchanged.
        const reacquiredHostsTab = await $("[data-tab-label='Hosts']");
        const snippetsTab = await $("[data-tab-label='Snippets']");
        await dragOnto(reacquiredHostsTab, snippetsTab);

        await browser.pause(300);
        expect(await domTabOrder()).to.deep.equal(expectedOrder);
    });

    it("moves the active tab with Cmd/Ctrl+Shift+[ and ] keyboard shortcuts", async () => {
        await openThreePageTabs();

        // Activate "History" (middle tab at index 2)
        await clickTabByLabel("History");
        const historyTab = await $("[data-tab-label='History']");
        await browser.waitUntil(
            async () => (await historyTab.getAttribute("aria-selected")) === "true",
            { timeout: 5_000, timeoutMsg: "History tab did not become active" },
        );

        // Move right with Cmd/Ctrl+Shift+] -> moves to index 3
        await cmdShift("]");
        const rightOrder = ["Hosts", "Snippets", "Settings", "History"];
        await browser.waitUntil(
            async () => {
                const order = await domTabOrder();
                return JSON.stringify(order) === JSON.stringify(rightOrder);
            },
            { timeout: 5_000, timeoutMsg: `Tab order never matched ${JSON.stringify(rightOrder)}` },
        );
        expect(await domTabOrder()).to.deep.equal(rightOrder);
        expect(await historyTab.getAttribute("aria-selected")).to.equal("true");

        // Move back left with Cmd/Ctrl+Shift+[ -> moves back to index 2
        await cmdShift("[");
        const backOrder = ["Hosts", "Snippets", "History", "Settings"];
        await browser.waitUntil(
            async () => {
                const order = await domTabOrder();
                return JSON.stringify(order) === JSON.stringify(backOrder);
            },
            { timeout: 5_000, timeoutMsg: `Tab order never matched ${JSON.stringify(backOrder)}` },
        );
        expect(await domTabOrder()).to.deep.equal(backOrder);
        expect(await historyTab.getAttribute("aria-selected")).to.equal("true");

        // Move left again to index 1
        await cmdShift("[");
        const index1Order = ["Hosts", "History", "Snippets", "Settings"];
        await browser.waitUntil(
            async () => {
                const order = await domTabOrder();
                return JSON.stringify(order) === JSON.stringify(index1Order);
            },
            { timeout: 5_000, timeoutMsg: `Tab order never matched ${JSON.stringify(index1Order)}` },
        );
        expect(await domTabOrder()).to.deep.equal(index1Order);
        expect(await historyTab.getAttribute("aria-selected")).to.equal("true");

        // At index 1, Cmd/Ctrl+Shift+[ does nothing (Hosts at index 0 is pinned, no wrap)
        await cmdShift("[");
        await browser.pause(300);
        expect(await domTabOrder()).to.deep.equal(index1Order);
        expect(await historyTab.getAttribute("aria-selected")).to.equal("true");
    });
});
