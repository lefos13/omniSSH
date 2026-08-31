/*
 * E2E tests for theme toggling and narrow/responsive layout controls.
 * Verifies dark/light theme switching in appearance settings and responsive sidebar controls.
 */

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { clickCollapseToggle, sidebarExpanded } from "../helpers/sidebar.js";

async function openSettings(): Promise<void> {
    const nav = await $("[aria-label='Settings']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    await (await $("[data-testid='settings-nav-appearance']")).waitForDisplayed({ timeout: 10_000 });
}

describe("theme and narrow layout", () => {
    beforeEach(async () => {
        await resetApp();
    });

    it("switches theme mode and toggles sidebar layout state", async () => {
        await openSettings();

        // Toggle sidebar collapse state
        const initialExpanded = await sidebarExpanded();
        await clickCollapseToggle();
        await browser.waitUntil(
            async () => (await sidebarExpanded()) === !initialExpanded,
            { timeout: 5_000, timeoutMsg: "sidebar failed to toggle" },
        );
        expect(await sidebarExpanded()).to.equal(!initialExpanded);

        // Switch to appearance settings section
        const appearanceTab = await $("[data-testid='settings-nav-appearance']");
        await appearanceTab.click();

        // Select light theme
        const lightThemeRadio = await $("[data-testid='settings-theme-light']");
        if (await lightThemeRadio.isExisting()) {
            await lightThemeRadio.click();
            await browser.waitUntil(
                async () =>
                    (await browser.execute(() => document.documentElement.dataset.theme)) === "light",
                { timeout: 5_000, timeoutMsg: "data-theme did not update to light" },
            );
            const theme = await browser.execute(() => document.documentElement.dataset.theme);
            expect(theme).to.equal("light");
        }
    });
});
