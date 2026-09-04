/*
 * Dual-pane host explorer transfer E2E tests.
 *
 * Proves the dual-pane workflow in the real Tauri desktop application:
 * 1. Opening a host explorer tab mounts both local (left) and remote (right) panes.
 * 2. Local-to-remote file and recursive-folder transfer via the center action rail
 *    (Copy selected to remote) and verification in the remote filesystem.
 * 3. Remote-to-local file and recursive-folder transfer via the center action rail
 *    (Copy selected to local) and byte-for-byte verification on the local filesystem.
 * 4. Transparent SCP fallback compatibility on SFTP-disabled hosts.
 */

import { expect } from "chai";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import {
    clickCopyToLocal,
    clickCopyToRemote,
    deleteEntry,
    navigateLocalToPath,
    navigateUp,
    openEntry,
    selectLocalEntries,
    selectRemoteEntries,
    waitForEntry,
    waitForExplorer,
    waitForLocalEntry,
    waitForLocalExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSHD_SCP_HOST = process.env.SSHD_SCP_HOST ?? "sshd-scp";
const SSHD_SCP_PORT = Number(process.env.SSHD_SCP_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("dual-pane host explorer transfers", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("renders dual panes and executes bidirectional transfers over SFTP", async () => {
        // 1. Configure and open host explorer for SFTP target
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "dual-sftp-host",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("dual-sftp-host");

        const hostId = await getHostId("dual-sftp-host");
        const expBtn = await $(`[data-testid='host-card-${hostId}-explorer']`);
        await expBtn.waitForClickable({ timeout: 10_000 });
        await expBtn.click();
        await waitForExplorer();
        await waitForLocalExplorer();
        // 2. Verify dual-pane layout: local pane on the left, remote on the right
        const localPane = await $('[data-explorer-pane="local"]');
        const remotePane = await $('[data-explorer-pane="remote"]');

        expect(await localPane.isDisplayed()).to.equal(true);
        expect(await remotePane.isDisplayed()).to.equal(true);

        const sessionId = await remotePane.getAttribute("data-explorer-session-id");
        expect(sessionId).to.be.a("string").and.not.be.empty;
        expect(await remotePane.getAttribute("data-explorer-transport")).to.equal("sftp");

        const localLoc = await localPane.getLocation();
        const remoteLoc = await remotePane.getLocation();
        expect(localLoc.x).to.be.lessThan(remoteLoc.x);

        // 3. Local → Remote transfer: create deterministic local fixtures
        const stamp = Date.now();
        const localUploadDir = await mkdtemp(join(tmpdir(), `e2e-dual-up-${stamp}-`));

        const fileName = `payload-${stamp}.txt`;
        const fileContent = `hello from dual-pane upload ${stamp}\n`;
        await writeFile(join(localUploadDir, fileName), fileContent, "utf8");

        const folderName = `folder-${stamp}`;
        const nestedDir = join(localUploadDir, folderName);
        await mkdir(nestedDir, { recursive: true });
        const nestedFileName = `nested-${stamp}.txt`;
        const nestedContent = `nested content ${stamp}\n`;
        await writeFile(join(nestedDir, nestedFileName), nestedContent, "utf8");

        // Navigate LOCAL pane to fixture directory using local path input
        await navigateLocalToPath(localUploadDir);
        await waitForLocalEntry(fileName);
        await waitForLocalEntry(folderName);

        // Select entries in local pane and copy to remote via center action rail
        await selectLocalEntries([fileName, folderName]);
        await clickCopyToRemote();

        // Verify top-level file and folder appear in remote pane
        await browser.waitUntil(
            async () => {
                const el1 = await $(`[data-entry-name='${fileName}']`);
                const el2 = await $(`[data-entry-name='${folderName}']`);
                return (await el1.isExisting()) && (await el2.isExisting());
            },
            { timeout: 20_000, timeoutMsg: "uploaded entries never appeared in remote explorer" },
        );
        await waitForEntry(fileName);
        await waitForEntry(folderName);

        // Enter the uploaded folder remotely to verify nested directory structure
        await openEntry(folderName);
        await waitForEntry(nestedFileName);

        // Navigate back up to remote root/home directory
        await navigateUp();
        await waitForEntry(fileName);
        await waitForEntry(folderName);

        // 4. Remote → Local transfer: create dedicated destination directory
        const localDownloadDir = await mkdtemp(join(tmpdir(), `e2e-dual-down-${stamp}-`));
        await navigateLocalToPath(localDownloadDir);

        // Select remote entries and copy to local via center action rail
        await selectRemoteEntries([fileName, folderName]);
        await clickCopyToLocal();

        // Wait for downloaded files to appear on local disk and verify byte-for-byte content
        const downloadedFilePath = join(localDownloadDir, fileName);
        const downloadedNestedPath = join(localDownloadDir, folderName, nestedFileName);

        await browser.waitUntil(
            async () => {
                try {
                    const fText = await readFile(downloadedFilePath, "utf8");
                    const nText = await readFile(downloadedNestedPath, "utf8");
                    return fText === fileContent && nText === nestedContent;
                } catch {
                    return false;
                }
            },
            { timeout: 20_000, timeoutMsg: "downloaded files never matched expected content on disk" },
        );

        const localReadText = await readFile(downloadedFilePath, "utf8");
        expect(localReadText).to.equal(fileContent);

        const nestedReadText = await readFile(downloadedNestedPath, "utf8");
        expect(nestedReadText).to.equal(nestedContent);

        // Verify local pane refreshed and displays the downloaded entries
        await waitForLocalEntry(fileName);
        await waitForLocalEntry(folderName);

        // Cleanup remote test fixtures
        await deleteEntry(fileName);
        await deleteEntry(folderName);
    });

    it("renders dual panes and transfers files under SCP fallback", async () => {
        // 1. Configure and open host explorer for SCP-only target (SFTP disabled)
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "dual-scp-host",
            host: SSHD_SCP_HOST,
            port: SSHD_SCP_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("dual-scp-host");

        const hostId = await getHostId("dual-scp-host");
        const expBtn = await $(`[data-testid='host-card-${hostId}-explorer']`);
        await expBtn.waitForClickable({ timeout: 10_000 });
        await expBtn.click();
        await waitForExplorer();
        await waitForLocalExplorer();
        // 2. Verify dual panes and SCP transport attribute
        const localPane = await $('[data-explorer-pane="local"]');
        const remotePane = await $('[data-explorer-pane="remote"]');

        expect(await localPane.isDisplayed()).to.equal(true);
        expect(await remotePane.isDisplayed()).to.equal(true);
        expect(await remotePane.getAttribute("data-explorer-transport")).to.equal("scp");

        // 3. Local → Remote transfer over SCP
        const stamp = Date.now();
        const scpLocalDir = await mkdtemp(join(tmpdir(), `e2e-dual-scp-${stamp}-`));
        const scpFileName = `scp-file-${stamp}.txt`;
        const scpFileContent = `scp fallback transfer ${stamp}\n`;
        await writeFile(join(scpLocalDir, scpFileName), scpFileContent, "utf8");

        await navigateLocalToPath(scpLocalDir);
        await waitForLocalEntry(scpFileName);

        await selectLocalEntries([scpFileName]);
        await clickCopyToRemote();

        await browser.waitUntil(
            async () => {
                const el = await $(`[data-entry-name='${scpFileName}']`);
                return await el.isExisting();
            },
            { timeout: 20_000, timeoutMsg: `SCP uploaded file '${scpFileName}' never appeared remotely` },
        );
        await waitForEntry(scpFileName);

        // Cleanup remote fixture
        await deleteEntry(scpFileName);
    });
});
