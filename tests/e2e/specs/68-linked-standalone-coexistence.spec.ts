/*
 * E2E tests for linked explorer and standalone explorer coexistence.
 * Verifies that a terminal tab with an active linked explorer side panel can coexist
 * alongside a standalone Explorer tab without interference across tab switches,
 * asserting connected transport metadata and directory listings on both sides.
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
import { waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { tabCountOfType, waitForTabCount } from "../helpers/tabs.js";
import {
    activeExplorerPath,
    waitForActiveExplorer,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

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
        const card = await findHostCardByLabel("coexist-host");
        await card.click();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // 3. Open linked explorer panel
        const toggleBtn = await $("[data-testid='pane-linked-explorer-toggle']");
        await toggleBtn.waitForClickable({ timeout: 10_000 });
        await toggleBtn.click();

        const resizeHandle = await $("[data-testid='linked-explorer-resize-handle']");
        await resizeHandle.waitForDisplayed({ timeout: 15_000 });

        // Before switching away, require connected transport, entries, and absence of error
        const linkedTransport = await waitForActiveExplorer();
        expect(await linkedTransport.getAttribute("data-explorer-transport")).to.equal("sftp");
        const linkedSessionId = await linkedTransport.getAttribute("data-explorer-session-id");
        expect(linkedSessionId).to.be.a("string").and.not.be.empty;
        expect((await linkedTransport.$$('[data-testid="linked-explorer-error"]')).length).to.equal(0);
        await browser.waitUntil(
            async () => (await linkedTransport.$$('[data-entry-row="true"]')).length > 0,
            { timeout: 15_000, timeoutMsg: "linked explorer directory listing never rendered" },
        );
        const linkedEntries = await linkedTransport.$$('[data-entry-row="true"]');
        expect(await linkedEntries[0].getAttribute("data-entry-name")).to.match(/\S/);
        expect(await activeExplorerPath()).to.equal("config");

        // 4. Switch back to Hosts dashboard and open a standalone Explorer tab
        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.waitForClickable({ timeout: 5_000 });
        await hostsTab.click();
        await waitForDashboard();

        const explorerBtn = await $(`[data-testid='host-card-${hostId}-explorer']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();
        await waitForExplorer();

        const standaloneExplorer = await waitForActiveExplorer();
        expect(await standaloneExplorer.getAttribute("data-explorer-transport")).to.equal("sftp");
        const standaloneSessionId = await standaloneExplorer.getAttribute("data-explorer-session-id");
        expect(standaloneSessionId).to.be.a("string").and.not.be.empty;
        expect(standaloneSessionId).not.to.equal(linkedSessionId);
        await browser.waitUntil(
            async () => (await standaloneExplorer.$$('[data-entry-row="true"]')).length > 0,
            { timeout: 15_000, timeoutMsg: "standalone explorer directory listing never rendered" },
        );
        const standaloneEntries = await standaloneExplorer.$$('[data-entry-row="true"]');
        expect(await standaloneEntries[0].getAttribute("data-entry-name")).to.match(/\S/);
        expect(await activeExplorerPath()).to.equal("config");

        // 5. Verify tab count: Hosts + Terminal + Standalone SFTP
        await waitForTabCount(3);
        expect(await tabCountOfType("terminal")).to.equal(1);
        expect(await tabCountOfType("sftp")).to.equal(1);

        // 6. Switch back to Terminal tab and verify linked panel is still connected with listings
        const terminalTab = await $("[data-tab-type='terminal']");
        await terminalTab.waitForClickable({ timeout: 5_000 });
        await terminalTab.click();

        const activeResizeHandle = await $("[data-testid='linked-explorer-resize-handle']");
        await activeResizeHandle.waitForDisplayed({ timeout: 10_000 });
        expect(await activeResizeHandle.isDisplayed()).to.equal(true);

        const activeLinkedExplorer = await waitForActiveExplorer();
        expect(await activeLinkedExplorer.getAttribute("data-explorer-transport")).to.equal("sftp");
        expect(await activeLinkedExplorer.getAttribute("data-explorer-session-id")).to.equal(linkedSessionId);
        expect((await activeLinkedExplorer.$$('[data-testid="linked-explorer-error"]')).length).to.equal(0);
        await browser.waitUntil(
            async () => (await activeLinkedExplorer.$$('[data-entry-row="true"]')).length > 0,
            { timeout: 15_000, timeoutMsg: "linked explorer directory listing missing after switch back" },
        );
        expect((await activeLinkedExplorer.$$('[data-entry-row="true"]')).length).to.be.greaterThan(0);
        expect(await activeExplorerPath()).to.equal("config");

        // 7. Switch to Standalone Explorer tab and verify it renders separately
        const sftpTab = await $("[data-tab-type='sftp']");
        await sftpTab.waitForClickable({ timeout: 5_000 });
        await sftpTab.click();
        await waitForExplorer();
        const activeStandaloneExplorer = await waitForActiveExplorer();
        expect(await activeStandaloneExplorer.getAttribute("data-explorer-transport")).to.equal("sftp");
        expect(await activeStandaloneExplorer.getAttribute("data-explorer-session-id")).to.equal(standaloneSessionId);
        await browser.waitUntil(
            async () => (await activeStandaloneExplorer.$$('[data-entry-row="true"]')).length > 0,
            { timeout: 15_000, timeoutMsg: "standalone explorer directory listing missing after switch back" },
        );
        expect((await activeStandaloneExplorer.$$('[data-entry-row="true"]')).length).to.be.greaterThan(0);
        expect(await activeExplorerPath()).to.equal("config");
    });
});
