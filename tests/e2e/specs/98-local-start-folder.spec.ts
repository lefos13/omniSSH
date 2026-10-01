/*
 * E2E tests for dual-pane Explorer local start folder resolution.
 *
 * Verifies that the local (left) pane resolves start folders in order:
 * 1. Host-specific local folder override (if configured).
 * 2. Global "Default local folder" (Settings -> Explorer).
 * 3. User home directory fallback with an error toast when configured folders are missing.
 * Also verifies that both configurations persist across application restarts.
 */

import { expect } from "chai";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { relaunchApp, resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openHostEdit,
    openHostModalTab,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import {
    assertLocalEntryAbsent,
    localExplorerPath,
    waitForExplorer,
    waitForLocalEntry,
    waitForLocalExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

/*
 * Create and save a new password-authenticated SSH host for testing.
 */
async function createHost(label: string): Promise<string> {
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

/*
 * Open the dual-pane Explorer for the given host and wait for both toolbars.
 */
async function openHostExplorer(hostId: string): Promise<void> {
    const expBtn = await $(`[data-testid='host-card-${hostId}-explorer']`);
    await expBtn.waitForClickable({ timeout: 10_000 });
    await expBtn.click();
    await waitForExplorer();
    await waitForLocalExplorer();
}

describe("local start folder resolution and persistence", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens local pane in host folder when both host folder and global default are set", async () => {
        const stamp = Date.now();
        const hostDir = await mkdtemp(join(tmpdir(), `e2e-host-${stamp}-`));
        const globalDir = await mkdtemp(join(tmpdir(), `e2e-global-${stamp}-`));

        const hostFile = `host-${stamp}.txt`;
        const globalFile = `global-${stamp}.txt`;
        await writeFile(join(hostDir, hostFile), `host content ${stamp}\n`, "utf8");
        await writeFile(join(globalDir, globalFile), `global content ${stamp}\n`, "utf8");

        const hostId = await createHost("host-override");

        await browser.execute((dir: string) => {
            const w = window as unknown as { __e2eSetExplorerDefaultLocalDir?: (d: string) => void };
            w.__e2eSetExplorerDefaultLocalDir?.(dir);
        }, globalDir);

        await browser.execute((id: string, dir: string) => {
            const w = window as unknown as { __e2eSetHostLocalDir?: (h: string, d: string | null) => void };
            w.__e2eSetHostLocalDir?.(id, dir);
        }, hostId, hostDir);

        await openHostExplorer(hostId);

        const expectedSegment = basename(hostDir);
        await browser.waitUntil(
            async () => (await localExplorerPath()) === expectedSegment,
            { timeout: 10_000, timeoutMsg: `local pane did not open at host directory '${expectedSegment}'` },
        );
        expect(await localExplorerPath()).to.equal(expectedSegment);

        const hostEntry = await waitForLocalEntry(hostFile);
        expect(await hostEntry.isExisting()).to.equal(true);
        await assertLocalEntryAbsent(globalFile);
    });

    it("falls back to global default local folder when host has no override", async () => {
        const stamp = Date.now();
        const globalDir = await mkdtemp(join(tmpdir(), `e2e-global-default-${stamp}-`));
        const globalFile = `global-default-${stamp}.txt`;
        await writeFile(join(globalDir, globalFile), `global default content ${stamp}\n`, "utf8");

        await browser.execute((dir: string) => {
            const w = window as unknown as { __e2eSetExplorerDefaultLocalDir?: (d: string) => void };
            w.__e2eSetExplorerDefaultLocalDir?.(dir);
        }, globalDir);

        const hostId = await createHost("host-no-override");

        await openHostExplorer(hostId);

        const expectedSegment = basename(globalDir);
        await browser.waitUntil(
            async () => (await localExplorerPath()) === expectedSegment,
            { timeout: 10_000, timeoutMsg: `local pane did not open at global default directory '${expectedSegment}'` },
        );
        expect(await localExplorerPath()).to.equal(expectedSegment);

        const globalEntry = await waitForLocalEntry(globalFile);
        expect(await globalEntry.isExisting()).to.equal(true);
    });

    it("falls back to home directory and displays error toast when configured folder is missing or deleted", async () => {
        const stamp = Date.now();
        const deletedDir = await mkdtemp(join(tmpdir(), `e2e-deleted-${stamp}-`));
        await rm(deletedDir, { recursive: true, force: true });

        const hostId = await createHost("host-missing-folder");

        await browser.execute((id: string, dir: string) => {
            const w = window as unknown as { __e2eSetHostLocalDir?: (h: string, d: string | null) => void };
            w.__e2eSetHostLocalDir?.(id, dir);
        }, hostId, deletedDir);

        await openHostExplorer(hostId);

        const alert = await $('[role="alert"]');
        await alert.waitForDisplayed({ timeout: 10_000 });
        const toastMessage = await alert.getText();
        expect(toastMessage).to.include(`Local start folder not found: ${deletedDir}. Opened `);
        expect(toastMessage).to.include(" instead.");
        const expectedHomeSegment = basename(homedir());
        await browser.waitUntil(
            async () => (await localExplorerPath()) === expectedHomeSegment,
            { timeout: 10_000, timeoutMsg: `local pane did not fall back to home directory '${expectedHomeSegment}'` },
        );
        expect(await localExplorerPath()).to.equal(expectedHomeSegment);
    });

    it("persists local start folder configurations across app restart", async () => {
        const stamp = Date.now();
        const persistHostDir = await mkdtemp(join(tmpdir(), `e2e-persist-host-${stamp}-`));
        const persistDefaultDir = await mkdtemp(join(tmpdir(), `e2e-persist-default-${stamp}-`));

        const persistFile = `persist-${stamp}.txt`;
        await writeFile(join(persistHostDir, persistFile), `persisted content ${stamp}\n`, "utf8");

        const hostId = await createHost("host-persist");

        await browser.execute((dir: string) => {
            const w = window as unknown as { __e2eSetExplorerDefaultLocalDir?: (d: string) => void };
            w.__e2eSetExplorerDefaultLocalDir?.(dir);
        }, persistDefaultDir);

        await browser.execute((id: string, dir: string) => {
            const w = window as unknown as { __e2eSetHostLocalDir?: (h: string, d: string | null) => void };
            w.__e2eSetHostLocalDir?.(id, dir);
        }, hostId, persistHostDir);

        // Allow SQLite persistence to settle before restarting
        await browser.pause(500);

        await relaunchApp();
        await waitForDashboard();

        // 1. Verify global default persisted in Settings UI
        const nav = await $("[aria-label='Settings']");
        await nav.waitForClickable({ timeout: 10_000 });
        await nav.click();

        const explorerNav = await $("[data-testid='settings-nav-explorer']");
        await explorerNav.waitForClickable({ timeout: 10_000 });
        await explorerNav.click();

        const defaultDirInput = await $("[data-testid='settings-default-local-dir']");
        await defaultDirInput.waitForDisplayed({ timeout: 10_000 });
        expect(await defaultDirInput.getValue()).to.equal(persistDefaultDir);

        // 2. Verify per-host folder persisted in HostEditModal
        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.waitForClickable({ timeout: 5_000 });
        await hostsTab.click();
        await waitForDashboard();

        await openHostEdit("host-persist");
        await openHostModalTab("connection");
        const hostFolderInput = await $("[data-testid='host-modal-local-start-folder']");
        await hostFolderInput.waitForDisplayed({ timeout: 5_000 });
        expect(await hostFolderInput.getValue()).to.equal(persistHostDir);

        const cancelBtn = await $("[data-testid='host-modal-cancel']");
        await cancelBtn.click();
        await waitForModalClosed();

        // 3. Verify opening explorer lands in the persisted host folder
        await openHostExplorer(hostId);

        const expectedSegment = basename(persistHostDir);
        await browser.waitUntil(
            async () => (await localExplorerPath()) === expectedSegment,
            { timeout: 10_000, timeoutMsg: `local pane did not open at persisted directory '${expectedSegment}'` },
        );
        expect(await localExplorerPath()).to.equal(expectedSegment);
        const entry = await waitForLocalEntry(persistFile);
        expect(await entry.isExisting()).to.equal(true);
    });
});
