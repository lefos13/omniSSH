/*
 * E2E tests for keyboard shortcuts and focus navigation.
 * Verifies that the global Cmd+T launch can be cancelled with Escape without
 * leaving the host modal mounted.
 */

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { cmd } from "../helpers/keyboard.js";
import { waitForModalOpen, waitForModalClosed } from "../helpers/host.js";

describe("keyboard shortcuts and focus navigation", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("dismisses the new-host modal with Escape after keyboard launch", async () => {
        await cmd("t");
        await waitForModalOpen();

        const modal = await $("[data-testid='host-modal']");
        expect(await modal.isDisplayed()).to.equal(true);

        // Dismiss with Escape key
        await browser.keys(["Escape"]);
        await waitForModalClosed();
        expect((await $$("[data-testid='host-modal']")).length).to.equal(0);
    });
});
