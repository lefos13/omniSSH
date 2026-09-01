/*
 * E2E tests for OSC 7 CWD follow and explicit cd dispatch in linked explorer.
 * Verifies that:
 * 1. Navigating linked explorer to /tmp and clicking "cd here" dispatches a cd command
 *    to the terminal, proven by terminal $PWD reflecting /tmp with a unique marker.
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
import {
    activeExplorerPath,
    openEntry,
    waitForActiveExplorer,
} from "../helpers/sftp-ops.js";

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
        const explorerContainer = await waitForActiveExplorer();
        expect(await explorerContainer.getAttribute("data-explorer-transport")).to.equal("sftp");
        const explorerSessionId = await explorerContainer.getAttribute("data-explorer-session-id");
        expect(explorerSessionId).to.be.a("string").and.not.be.empty;
        expect((await explorerContainer.$$('[data-testid="linked-explorer-error"]')).length).to.equal(0);

        // Wait for directory rows in linked explorer
        await browser.waitUntil(
            async () => (await explorerContainer.$$('[data-entry-row="true"]')).length > 0,
            { timeout: 15_000, timeoutMsg: "linked explorer rows did not load" },
        );

        // 2. Navigate linked explorer to /tmp via UI to test explicit cd
        // Click root '/' via home button
        const rootCrumb = await $("[data-testid='explorer-home']");
        await rootCrumb.waitForClickable({ timeout: 10_000 });
        await rootCrumb.click();

        await browser.waitUntil(
            async () => (await explorerContainer.$$('[data-entry-row="true"]')).length > 0,
            { timeout: 15_000 },
        );

        // Double-click 'tmp' directory
        await openEntry("tmp");

        // Wait until linked explorer breadcrumb indicates /tmp
        await browser.waitUntil(
            async () => (await activeExplorerPath()) === "tmp",
            { timeout: 10_000, timeoutMsg: "linked explorer did not enter /tmp" },
        );

        // Click "cd here in terminal" button
        const cdTerminalBtn = await $("[data-testid='linked-explorer-cd-terminal']");
        await cdTerminalBtn.waitForClickable({ timeout: 10_000 });
        await cdTerminalBtn.click();

        // Prove explicit cd changed terminal PWD to /tmp using a unique marker
        const cdMarker = `cd_marker_${Date.now()}`;
        await runCommand(
            sessionId,
            `printf "${cdMarker}:%s\\n" "$PWD"`,
            `${cdMarker}:/tmp`,
        );

        // 3. Test OSC 7 CWD synchronization
        // Open sync menu and enable session-local Bash integration
        await syncStatusBtn.click();
        const bashOption = await $("[data-testid='linked-explorer-sync-bash']");
        await bashOption.waitForClickable({ timeout: 5_000 });
        await bashOption.click();

        // Create a distinct target directory and navigate into it in the terminal
        const uniqueDirName = `sync_dir_${Date.now()}`;
        const oscMarker = `osc_marker_${Date.now()}`;
        await runCommand(
            sessionId,
            `mkdir -p /config/${uniqueDirName} && cd /config/${uniqueDirName} && printf "${oscMarker}:%s\\n" "$PWD"`,
            `${oscMarker}:/config/${uniqueDirName}`,
        );

        // Verify OSC 7 hook caused the linked explorer breadcrumb/path to update to uniqueDirName
        await browser.waitUntil(
            async () => (await activeExplorerPath()) === uniqueDirName,
            {
                timeout: 15_000,
                timeoutMsg: `linked explorer breadcrumb did not update to ${uniqueDirName} via OSC 7 follow`,
            },
        );

        // Verify the synced indicator shows active status
        expect(await syncStatusBtn.getText()).to.include("Synced");
        expect(await explorerContainer.getAttribute("data-explorer-session-id")).to.equal(explorerSessionId);
        expect((await explorerContainer.$$('[data-testid="linked-explorer-error"]')).length).to.equal(0);
    });
});
