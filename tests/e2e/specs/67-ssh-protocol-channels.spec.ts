/*
 * E2E tests for two protocol channels multiplexed over one SSH connection.
 * Verifies that a single SSH connection can concurrently support an interactive
 * terminal shell session and a linked SFTP explorer side panel with live directory listings.
 */

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import {
    runCommand,
    waitForAnyTerminal,
    waitForTerminalText,
} from "../helpers/terminal.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("two protocol channels over one SSH session", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens a linked explorer panel with live listing alongside the active terminal shell", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "multiplex-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Open linked explorer panel via PaneHeader toggle button
        const toggleBtn = await $("[data-testid='pane-linked-explorer-toggle']");
        await toggleBtn.waitForClickable({ timeout: 10_000 });
        await toggleBtn.click();

        // Linked explorer resize handle and panel should appear
        const resizeHandle = await $("[data-testid='linked-explorer-resize-handle']");
        await resizeHandle.waitForDisplayed({ timeout: 15_000 });
        expect(await resizeHandle.isDisplayed()).to.equal(true);

        // Verify the linked explorer protocol channel completes listing
        await browser.waitUntil(
            async () => (await $$("[data-entry-row='true']")).length > 0,
            { timeout: 15_000, timeoutMsg: "linked explorer directory listing never rendered" },
        );
        const entries = await $$("[data-entry-row='true']");
        expect(entries.length).to.be.greaterThan(0);

        // Run terminal commands concurrently while linked explorer is open
        const marker = `multiplex-${Date.now()}`;
        await runCommand(sessionId, `echo '${marker}'`, marker);

        // Re-verify both the terminal and explorer listing remain concurrently present
        expect(await resizeHandle.isDisplayed()).to.equal(true);
        expect((await $$("[data-entry-row='true']")).length).to.be.greaterThan(0);
    });
});
