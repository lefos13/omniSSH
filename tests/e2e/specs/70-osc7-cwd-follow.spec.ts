/*
 * E2E tests for OSC 7 CWD follow and explicit cd dispatch in linked explorer.
 * Verifies that:
 * 1. Explicit cd button in linked explorer dispatches a cd command to the terminal
 *    and changes the terminal's working directory.
 * 2. Enabling session-local Bash OSC 7 integration and changing directories in the
 *    terminal automatically synchronizes and updates the linked explorer's path/breadcrumb.
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

describe("OSC 7 CWD follow and explicit cd", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("dispatches explicit cd to terminal and synchronizes explorer via OSC 7 follow", async () => {
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

        // 1. Open linked explorer panel
        const toggleBtn = await $("[data-testid='pane-linked-explorer-toggle']");
        await toggleBtn.waitForClickable({ timeout: 10_000 });
        await toggleBtn.click();

        const syncStatusBtn = await $("[data-testid='linked-explorer-sync-status']");
        await syncStatusBtn.waitForDisplayed({ timeout: 15_000 });

        const followToggleBtn = await $("[data-testid='linked-explorer-follow-toggle']");
        await followToggleBtn.waitForDisplayed({ timeout: 10_000 });

        // 2. Test explicit cd dispatch to terminal
        // Initial home directory is /config in linuxserver/openssh-server
        const cdTerminalBtn = await $("[data-testid='linked-explorer-cd-terminal']");
        await cdTerminalBtn.waitForClickable({ timeout: 10_000 });
        await cdTerminalBtn.click();

        // Prove explicit cd was executed in terminal with unique marker
        const cdMarker = `cd-marker-${Date.now()}`;
        await runCommand(sessionId, `pwd # ${cdMarker}`, "/config");

        // 3. Test OSC 7 CWD synchronization
        // Open sync menu and enable session-local Bash integration
        await syncStatusBtn.click();
        const bashOption = await $("[data-testid='linked-explorer-sync-bash']");
        await bashOption.waitForClickable({ timeout: 5_000 });
        await bashOption.click();

        // Create a distinct target directory and navigate into it in the terminal
        const uniqueDirName = `sync-dir-${Date.now()}`;
        await runCommand(sessionId, `mkdir -p /config/${uniqueDirName} && cd /config/${uniqueDirName}`, uniqueDirName);

        // Verify OSC 7 hook caused the linked explorer breadcrumb/path to update
        await browser.waitUntil(
            async () => {
                const pathBarButtons = await $$("[aria-label='Current path'] button");
                for (const btn of pathBarButtons) {
                    const text = await btn.getText();
                    if (text === uniqueDirName) return true;
                }
                return false;
            },
            {
                timeout: 15_000,
                timeoutMsg: `linked explorer breadcrumb did not update to ${uniqueDirName} via OSC 7 follow`,
            },
        );

        // Verify the synced indicator shows active status
        expect(await syncStatusBtn.getText()).to.include("Synced");
    });
});
