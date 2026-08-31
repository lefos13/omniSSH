/*
 * E2E tests for multiple independent explorer connections.
 * Verifies that two separate SFTP explorer sessions can be opened simultaneously
 * from distinct host cards, creating separate SFTP tabs with independent state.
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
import { waitForExplorer } from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

async function saveHost(label: string): Promise<string> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });
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

    it("opens two independent SFTP explorer tabs from different host cards", async () => {
        // Save host 1 and host 2
        const host1Id = await saveHost("host-explorer-1");
        const host2Id = await saveHost("host-explorer-2");

        // Open explorer for Host 1
        const exp1Btn = await $(`[data-testid='host-card-${host1Id}-explorer']`);
        await exp1Btn.waitForClickable({ timeout: 10_000 });
        await exp1Btn.click();
        await waitForExplorer();

        // Switch back to Hosts dashboard
        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.waitForClickable({ timeout: 5_000 });
        await hostsTab.click();
        await waitForDashboard();

        // Open explorer for Host 2
        const exp2Btn = await $(`[data-testid='host-card-${host2Id}-explorer']`);
        await exp2Btn.waitForClickable({ timeout: 10_000 });
        await exp2Btn.click();
        await waitForExplorer();

        // Total 3 tabs: Hosts + 2 SFTP explorer tabs
        await waitForTabCount(3);
        expect(await tabCountOfType("sftp")).to.equal(2);

        // Verify switching between both explorer tabs works cleanly without stale references
        const tab1 = await $(`[data-tab-label='host-explorer-1']`);
        await tab1.waitForClickable({ timeout: 5_000 });
        await tab1.click();
        await waitForExplorer();

        const tab2 = await $(`[data-tab-label='host-explorer-2']`);
        await tab2.waitForClickable({ timeout: 5_000 });
        await tab2.click();
        await waitForExplorer();
    });
});
