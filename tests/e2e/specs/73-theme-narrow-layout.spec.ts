/*
 * E2E tests for theme toggling and narrow/responsive layout controls.
 * Verifies unconditional dark/light theme switching in appearance settings,
 * and asserts narrow viewport (720px) layout measurements and absence of horizontal overflow.
 */

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { clickCollapseToggle, sidebarExpanded } from "../helpers/sidebar.js";

async function openSettingsAppearance(): Promise<void> {
    const nav = await $("[aria-label='Settings']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();

    const appearanceTab = await $("[data-testid='settings-nav-appearance']");
    await appearanceTab.waitForClickable({ timeout: 10_000 });
    await appearanceTab.click();
}

describe("theme and narrow layout", () => {
    beforeEach(async () => {
        await resetApp();
    });

    it("unconditionally switches theme modes and supports narrow layout viewport without overflow", async () => {
        await openSettingsAppearance();

        // 1. Unconditionally switch to light theme
        const lightThemeRadio = await $("[data-testid='s-light-theme-light']");
        await lightThemeRadio.waitForClickable({ timeout: 10_000 });
        await lightThemeRadio.click();

        await browser.waitUntil(
            async () =>
                (await browser.execute(() => document.documentElement.dataset.theme)) === "light",
            { timeout: 5_000, timeoutMsg: "data-theme did not update to light" },
        );
        const lightTheme = await browser.execute(() => document.documentElement.dataset.theme);
        expect(lightTheme).to.equal("light");

        // 2. Unconditionally switch back to dark theme
        const darkThemeRadio = await $("[data-testid='s-light-theme-dark']");
        await darkThemeRadio.waitForClickable({ timeout: 10_000 });
        await darkThemeRadio.click();

        await browser.waitUntil(
            async () =>
                (await browser.execute(() => document.documentElement.dataset.theme)) === "dark",
            { timeout: 5_000, timeoutMsg: "data-theme did not update to dark" },
        );
        const darkTheme = await browser.execute(() => document.documentElement.dataset.theme);
        expect(darkTheme).to.equal("dark");

        // 3. Narrow layout responsiveness test at 720px width
        const originalSize = await browser.getWindowSize();
        try {
            await browser.setWindowSize(720, 600);

            // Assert no horizontal scroll overflow on document at 720px width
            const noHorizontalOverflow = await browser.execute(() => {
                return document.documentElement.scrollWidth <= document.documentElement.clientWidth;
            });
            expect(noHorizontalOverflow).to.equal(true);

            // Verify sidebar toggle operates cleanly under narrow width
            const initialExpanded = await sidebarExpanded();
            await clickCollapseToggle();
            await browser.waitUntil(
                async () => (await sidebarExpanded()) === !initialExpanded,
                { timeout: 5_000, timeoutMsg: "sidebar failed to toggle in narrow viewport" },
            );
            expect(await sidebarExpanded()).to.equal(!initialExpanded);

            // Verify appearance theme control element remains displayed within viewport
            const themeControl = await $("#s-light-theme");
            expect(await themeControl.isDisplayedInViewport()).to.equal(true);
        } finally {
            // Restore original window dimensions
            await browser.setWindowSize(originalSize.width, originalSize.height);
        }
    });
});
