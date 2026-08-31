/*
 * E2E tests for linked explorer and standalone explorer coexistence.
 * Verifies that a terminal tab with an active linked explorer side panel can coexist
 * alongside a standalone Explorer tab without interference across tab switches.
 */

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { tabCountOfType, waitForTabCount } from "../helpers/tabs.js";
import { waitForExplorer } from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("linked and standalone explorer coexistence", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("maintains linked explorer panel and standalone explorer tab concurrently", async () => {
        // 1. Save host so Explorer button works from host card
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "coexist-host",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("coexist-host");
        const hostId = await getHostId("coexist-host");

        // 2. Connect terminal session from card
        const connectBtn = await $(`[data-testid='host-card-${hostId}-connect']`);
        await connectBtn.waitForClickable({ timeout: 10_000 });
        await connectBtn.click();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // 3. Open linked explorer panel
        const toggleBtn = await $("[data-testid='pane-linked-explorer-toggle']");
        await toggleBtn.waitForClickable({ timeout: 10_000 });
        await toggleBtn.click();

        const resizeHandle = await $("[data-testid='linked-explorer-resize-handle']");
        await resizeHandle.waitForDisplayed({ timeout: 15_000 });

        // 4. Switch back to Hosts dashboard and open a standalone Explorer tab
        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.click();
        await waitForDashboard();

        const explorerBtn = await $(`[data-testid='host-card-${hostId}-explorer']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();
        await waitForExplorer();

        // 5. Verify tab count: Hosts + Terminal + Standalone SFTP
        await waitForTabCount(3);
        expect(await tabCountOfType("terminal")).to.equal(1);
        expect(await tabCountOfType("sftp")).to.equal(1);

        // 6. Switch back to Terminal tab and verify linked panel is still open
        const terminalTab = await $("[data-tab-type='terminal']");
        await terminalTab.click();
        await resizeHandle.waitForDisplayed({ timeout: 10_000 });
        expect(await resizeHandle.isDisplayed()).to.equal(true);

        // 7. Switch to Standalone Explorer tab and verify it renders
        const sftpTab = await $("[data-tab-type='sftp']");
        await sftpTab.click();
        await waitForExplorer();
    });
});
