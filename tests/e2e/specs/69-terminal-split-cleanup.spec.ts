/*
 * E2E tests for terminal split pane and tab cleanup.
 * Verifies that splitting a terminal pane, closing one split pane, and closing the
 * entire terminal tab cleans up SplitContainer DOM nodes, tabs, and session state.
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
import { cmd } from "../helpers/keyboard.js";
import { tabCount, waitForTabCount } from "../helpers/tabs.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("terminal split and tab cleanup", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("cleans up split container when one pane is closed, and removes tab on full close", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "split-clean-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Split terminal with Cmd+D
        await cmd("d");

        await browser.waitUntil(
            async () => (await $$("[data-testid^='terminal-']")).length >= 2,
            { timeout: 10_000, timeoutMsg: "split pane did not appear" },
        );

        const splitContainer = await $("[data-testid='split-container']");
        expect(await splitContainer.isExisting()).to.equal(true);

        // Close one split pane via Cmd+W
        await cmd("w");

        // SplitContainer should unmount and only 1 terminal should remain
        await browser.waitUntil(
            async () => (await $$("[data-testid^='terminal-']")).length === 1,
            { timeout: 10_000, timeoutMsg: "split pane was not cleaned up" },
        );
        expect(await splitContainer.isExisting()).to.equal(false);

        // Close the remaining terminal pane via Cmd+W
        await cmd("w");

        // Tab count should drop back to 1 (Hosts tab only)
        await waitForTabCount(1);
        expect(await tabCount()).to.equal(1);
        await waitForDashboard();
    });
});
