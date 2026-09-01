/*
 * E2E tests for multiple independent explorer connections.
 * Verifies that two separate SFTP explorer sessions configured with distinct start
 * directories (/etc vs /tmp) maintain isolated, nonempty session IDs, directory listings,
 * and path states across tab switches without cross-contamination.
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
import { tabCountOfType, waitForTabCount } from "../helpers/tabs.js";
import {
    activeExplorerPath,
    waitForActiveEntry,
    waitForActiveExplorer,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

async function saveHostWithStartDir(label: string, startDir: string): Promise<string> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });

    const startDirInput = await $("[data-testid='host-modal-start-directory']");
    await startDirInput.click();
    await startDirInput.setValue(startDir);

    await clickSave();
    await waitForModalClosed();
    await findHostCardByLabel(label);
    return await getHostId(label);
}

describe("two independent explorer connections", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens two independent SFTP explorer tabs and maintains separate session IDs and directory states", async () => {
        // 1. Save host 1 (/etc) and host 2 (/var)
        const host1Id = await saveHostWithStartDir("host-etc", "/etc");
        const host2Id = await saveHostWithStartDir("host-var", "/var");

        // 2. Open explorer for Host 1 (should land in /etc)
        const exp1Btn = await $(`[data-testid='host-card-${host1Id}-explorer']`);
        await exp1Btn.waitForClickable({ timeout: 10_000 });
        await exp1Btn.click();
        await waitForExplorer();

        // /etc/passwd is stable content on the linuxserver test target.
        const container1 = await waitForActiveExplorer();
        expect(await container1.getAttribute("data-explorer-transport")).to.equal("sftp");
        expect((await container1.$$('[data-testid="explorer-error"]')).length).to.equal(0);
        const passwdEntry = await waitForActiveEntry("passwd");
        expect(await passwdEntry.getAttribute("data-entry-name")).to.equal("passwd");
        expect(await activeExplorerPath()).to.equal("etc");

        // Capture session ID from the active explorer container.
        const sessionId1 = await container1.getAttribute("data-explorer-session-id");
        expect(sessionId1).to.be.a("string").and.not.be.empty;

        // 3. Switch back to Hosts dashboard
        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.waitForClickable({ timeout: 5_000 });
        await hostsTab.click();
        await waitForDashboard();

        // 4. Open explorer for Host 2 (should land in /var)
        const exp2Btn = await $(`[data-testid='host-card-${host2Id}-explorer']`);
        await exp2Btn.waitForClickable({ timeout: 10_000 });
        await exp2Btn.click();
        await waitForExplorer();

        const container2 = await waitForActiveExplorer();
        expect(await container2.getAttribute("data-explorer-transport")).to.equal("sftp");
        expect((await container2.$$('[data-testid="explorer-error"]')).length).to.equal(0);
        await browser.waitUntil(
            async () => (await container2.$$('[data-entry-row="true"]')).length > 0,
            { timeout: 20_000, timeoutMsg: "second explorer directory listing never rendered" },
        );
        const varEntries = await container2.$$('[data-entry-row="true"]');
        expect(varEntries.length).to.be.greaterThan(0);
        expect(await activeExplorerPath()).to.equal("var");

        // Capture session ID from the second active explorer container.
        const sessionId2 = await container2.getAttribute("data-explorer-session-id");
        expect(sessionId2).to.be.a("string").and.not.be.empty;
        expect(sessionId1).not.to.equal(sessionId2);

        // Total 3 tabs: Hosts + 2 SFTP explorer tabs
        await waitForTabCount(3);
        expect(await tabCountOfType("sftp")).to.equal(2);

        // 5. Switch back to Host 1 explorer tab and verify it preserves sessionId1 and /etc
        const tab1 = await $(`[data-tab-label='host-etc']`);
        await tab1.waitForClickable({ timeout: 5_000 });
        await tab1.click();
        await waitForExplorer();

        const activeContainer1 = await waitForActiveExplorer();
        expect(await activeContainer1.getAttribute("data-explorer-session-id")).to.equal(sessionId1);
        expect(await activeContainer1.getAttribute("data-explorer-transport")).to.equal("sftp");

        const passwdEntryAgain = await waitForActiveEntry("passwd");
        expect(await passwdEntryAgain.getAttribute("data-entry-name")).to.equal("passwd");
        expect(await activeExplorerPath()).to.equal("etc");

        // 6. Switch back to Host 2 explorer tab and verify it preserves sessionId2 and /var
        const tab2 = await $(`[data-tab-label='host-var']`);
        await tab2.waitForClickable({ timeout: 5_000 });
        await tab2.click();
        await waitForExplorer();

        const activeContainer2 = await waitForActiveExplorer();
        expect(await activeContainer2.getAttribute("data-explorer-session-id")).to.equal(sessionId2);
        expect(await activeContainer2.getAttribute("data-explorer-transport")).to.equal("sftp");

        expect(await activeExplorerPath()).to.equal("var");
        expect((await activeContainer2.$$('[data-entry-row="true"]')).length).to.be.greaterThan(0);
    });
});
