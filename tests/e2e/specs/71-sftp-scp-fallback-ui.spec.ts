/*
 * E2E tests for SFTP to SCP fallback UI flow.
 * Verifies that connecting to an SSH target with SFTP disabled automatically falls back
 * to SCP transport, rendering the directory listing and setting data-explorer-transport='scp'.
 */

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";

const SSHD_SCP_HOST = process.env.SSHD_SCP_HOST ?? "sshd-scp";
const SSHD_SCP_PORT = Number(process.env.SSHD_SCP_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP to SCP fallback UI", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("falls back to SCP transport and sets data-explorer-transport='scp'", async () => {
        // Save host pointing to sshd-scp target
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "scp-fallback-target",
            host: SSHD_SCP_HOST,
            port: SSHD_SCP_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("scp-fallback-target");

        const hostId = await getHostId("scp-fallback-target");

        // Click Explorer button on card
        const explorerBtn = await $(`[data-testid='host-card-${hostId}-explorer']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();

        // Wait for explorer tab to open
        await browser.waitUntil(
            async () =>
                (await $("[data-tab-type='sftp']").then((el) => el.isExisting())) === true,
            { timeout: 30_000, timeoutMsg: "SCP-fallback explorer tab never opened" },
        );

        // Explicitly assert that the explorer view has transport='scp' attribute
        const explorerContainer = await $("[data-explorer-transport='scp']");
        await explorerContainer.waitForDisplayed({
            timeout: 20_000,
            timeoutMsg: "data-explorer-transport='scp' attribute not found on container",
        });
        expect(await explorerContainer.isDisplayed()).to.equal(true);

        // Verify directory rows render under SCP fallback
        await browser.waitUntil(
            async () => (await $$("[data-entry-row='true']")).length > 0,
            { timeout: 20_000, timeoutMsg: "no entries rendered under SCP fallback" },
        );

        const entries = await $$("[data-entry-row='true']");
        expect(entries.length).to.be.greaterThan(0);
    });
});
