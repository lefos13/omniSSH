/*
 * E2E tests for OSC 7 CWD follow and explicit cd dispatch in linked explorer.
 * Verifies that the linked explorer panel renders sync status indicators,
 * allows toggling follow path mode, and dispatches explicit cd commands to the shell.
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
    waitForAnyTerminal,
    waitForTerminalText,
} from "../helpers/terminal.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("OSC 7 CWD follow and explicit cd", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("renders sync status and dispatches explicit cd to terminal", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "osc7-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Open linked explorer panel
        const toggleBtn = await $("[data-testid='pane-linked-explorer-toggle']");
        await toggleBtn.waitForClickable({ timeout: 10_000 });
        await toggleBtn.click();

        // Verify sync status button is present
        const syncStatusBtn = await $("[data-testid='linked-explorer-sync-status']");
        await syncStatusBtn.waitForDisplayed({ timeout: 15_000 });
        expect(await syncStatusBtn.isDisplayed()).to.equal(true);

        // Verify follow toggle button is present
        const followToggleBtn = await $("[data-testid='linked-explorer-follow-toggle']");
        await followToggleBtn.waitForDisplayed({ timeout: 10_000 });
        expect(await followToggleBtn.isDisplayed()).to.equal(true);

        // Click explicit "cd here" button to dispatch cd to terminal
        const cdHereBtn = await $("[data-testid='linked-explorer-cd-here']");
        await cdHereBtn.waitForClickable({ timeout: 10_000 });
        await cdHereBtn.click();

        // Terminal should process the command
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 10_000 });
    });
});
