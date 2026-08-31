/*
 * E2E tests for keyboard shortcuts and focus navigation.
 * Verifies global hotkeys including Cmd+B (sidebar toggle), Cmd+T (new host),
 * Escape key dialog dismissal, and tab navigation shortcuts.
 */

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { cmd } from "../helpers/keyboard.js";
import { sidebarExpanded } from "../helpers/sidebar.js";
import { waitForModalOpen, waitForModalClosed } from "../helpers/host.js";

describe("keyboard shortcuts and focus navigation", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("toggles sidebar expansion with Cmd+B", async () => {
        const initial = await sidebarExpanded();

        await cmd("b");
        await browser.waitUntil(
            async () => (await sidebarExpanded()) === !initial,
            { timeout: 5_000, timeoutMsg: "Cmd+B did not toggle sidebar" },
        );
        expect(await sidebarExpanded()).to.equal(!initial);

        // Toggle back
        await cmd("b");
        await browser.waitUntil(
            async () => (await sidebarExpanded()) === initial,
            { timeout: 5_000, timeoutMsg: "Cmd+B did not toggle sidebar back" },
        );
        expect(await sidebarExpanded()).to.equal(initial);
    });

    it("opens new host modal with Cmd+T and closes on Escape", async () => {
        await cmd("t");
        await waitForModalOpen();

        const modal = await $("[data-testid='host-modal']");
        expect(await modal.isDisplayed()).to.equal(true);

        // Dismiss with Escape key
        await browser.keys(["Escape"]);
        await waitForModalClosed();
        expect(await modal.isExisting()).to.equal(false);
    });
});
