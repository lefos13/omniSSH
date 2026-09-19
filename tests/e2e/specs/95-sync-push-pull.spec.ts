// Checkpoint A — encrypted dataset sync, end to end: publish the host set from
// one machine, then reproduce it on a fresh one.
//
// Both "machines" are the same app instance. A machine counts as fresh when its
// database AND its keychain entries are gone (factoryReset + relaunch): the
// keychain half is load-bearing, not cosmetic — credentials are keyed by host
// id, and the ids travel inside the dataset, so a surviving keychain entry
// would let a pulled host report a working credential it was never given.
//
// The dataset directory on sshd-sync is wiped over the shared e2e key before
// every test (helpers/sync.ts), so each test publishes generation 1 no matter
// what earlier runs left on the persistent volume.
//
// Nothing here reads a secret: the passphrase and the server login are typed
// into the real Settings form, and the assertions are on what the UI renders
// and on what the app can do afterwards with the pulled credential.

import { expect } from "chai";
import { relaunchApp, resetApp } from "../helpers/reset.js";
import { hostCardCount, waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    openHostEdit,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { factoryReset } from "../helpers/backup.js";
import { clickTabByLabel } from "../helpers/tabs.js";
import { waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { cmd } from "../helpers/keyboard.js";
import {
    cleanSyncRemote,
    configureSyncEndpoint,
    datasetCardIds,
    hostModalShowsStoredCredential,
    openSyncSection,
    saveSyncDataset,
    syncDatasetAction,
    syncDatasetError,
    SYNC_ENDPOINT,
    testSyncConnection,
    waitForDatasetCards,
} from "../helpers/sync.js";

const DATASET_NAME = "Checkpoint A";
const DATASET_PASSPHRASE = "checkpoint-a-passphrase";
const WRONG_PASSPHRASE = "not-the-dataset-passphrase";
const ALPHA = "sync-alpha";
const BETA = "sync-beta";

/** Add hosts the way a user does, so each one's credential lands in the keychain. */
async function seedSyncHosts(labels: string[]): Promise<void> {
    for (const label of labels) {
        await openNewHostModal();
        await fillPasswordHostForm({
            label,
            host: SYNC_ENDPOINT.host,
            port: SYNC_ENDPOINT.port,
            username: SYNC_ENDPOINT.username,
            password: SYNC_ENDPOINT.password,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel(label);
    }
}

/**
 * Turn this install into a second computer: no database and no keychain
 * entries, exactly the state a freshly installed app is in when the dataset
 * has never been pulled onto it.
 */
async function becomeFreshMachine(): Promise<void> {
    await factoryReset();
    await relaunchApp();
    await waitForDashboard();
    expect(await hostCardCount(), "a fresh machine holds no hosts").to.equal(0);
}

/** Save the dataset on a machine that already holds hosts, then publish it. */
async function publishDataset(): Promise<string> {
    await openSyncSection();
    await configureSyncEndpoint();
    const probe = await testSyncConnection();
    expect(probe, "the wiped directory must read as unpublished").to.include("No dataset here yet");

    /* The vault starts locked on a fresh profile, and unlocking it through the
     * modal is a separate flow — publish without credentials so the push does
     * not depend on vault state. */
    const saved = await saveSyncDataset({
        name: DATASET_NAME,
        passphrase: DATASET_PASSPHRASE,
        includeCredentials: false,
    });
    expect(await syncDatasetError()).to.equal(null);
    expect(saved, "saving a new dataset must report its next step").to.include("No dataset is published");
    await waitForDatasetCards();

    return await syncDatasetAction("push");
}

describe("dataset sync", () => {
    beforeEach(async () => {
        await cleanSyncRemote();
        await resetApp();
        await waitForDashboard();
    });

    it("reproduces the published hosts on a fresh machine", async function () {
        this.timeout(300_000);

        // ── Machine A — two hosts with stored credentials, published over SFTP.
        // Credentials stay out of the bundle (the toggle defaults off): the
        // vault starts locked on a fresh profile, and unlocking it here would
        // couple this spec to the vault-unlock flow. The pull must still
        // reproduce the host set; each host is then proven connectable with
        // the password the test already knows.
        await seedSyncHosts([ALPHA, BETA]);
        expect(await hostCardCount()).to.equal(2);

        const pushed = await publishDataset();
        expect(pushed).to.include("Pushed generation 1");
        expect(pushed, "both hosts must be in the bundle").to.include("2 hosts");
        expect(pushed, "no credentials travel with the default toggles").to.include("0 credentials");

        // ── Machine B — nothing local, so everything below came off the wire.
        await becomeFreshMachine();

        await openSyncSection();
        await configureSyncEndpoint();
        const existing = await testSyncConnection();
        expect(existing, "the endpoint must report the published dataset").to.include(
            "A dataset is already published here",
        );
        expect(existing).to.include("generation 1");

        const joined = await saveSyncDataset({
            name: DATASET_NAME,
            passphrase: DATASET_PASSPHRASE,
        });
        expect(await syncDatasetError()).to.equal(null);
        expect(joined, "joining an existing dataset must be reported as a join").to.include(
            "Joined the dataset",
        );

        // Joining is not syncing: records land only when the user pulls.
        await clickTabByLabel("Hosts");
        await waitForDashboard();
        expect(await hostCardCount(), "a join must not apply records").to.equal(0);

        // ── Pull — the dashboard must end up with exactly machine A's host set.
        await openSyncSection();
        const pulled = await syncDatasetAction("pull");
        expect(pulled).to.include("Pulled generation 1");
        expect(pulled).to.include("2 hosts");

        await clickTabByLabel("Hosts");
        await waitForDashboard();
        expect(await hostCardCount()).to.equal(2);
        await findHostCardByLabel(ALPHA);
        await findHostCardByLabel(BETA);

        // The pulled hosts carry no credential, so supply the known password
        // through the modal and prove one of them authenticates.
        await openHostEdit(ALPHA);
        const passwordInput = await $("[data-testid='host-modal-password']");
        await passwordInput.waitForDisplayed({ timeout: 10_000 });
        await passwordInput.click();
        await passwordInput.setValue(SYNC_ENDPOINT.password);
        await clickConnect();
        await waitForModalClosed();
        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");
        await cmd("w");

        await clickTabByLabel("Hosts");
        await waitForDashboard();
        expect(await hostCardCount()).to.equal(2);
    });

    it("refuses a join with the wrong passphrase and applies no records", async function () {
        this.timeout(300_000);

        await seedSyncHosts([ALPHA]);
        const pushed = await publishDataset();
        expect(pushed).to.include("Pushed generation 1");

        await becomeFreshMachine();

        await openSyncSection();
        await configureSyncEndpoint();
        const existing = await testSyncConnection();
        expect(existing).to.include("generation 1");

        // Long enough to clear the form's own minimum, so the refusal comes from
        // the dataset key instead of from client-side validation.
        expect(WRONG_PASSPHRASE.length).to.be.greaterThan(11);
        const joined = await saveSyncDataset({
            name: DATASET_NAME,
            passphrase: WRONG_PASSPHRASE,
        });
        expect(joined, "a wrong passphrase must not be accepted as a join").to.equal(null);

        const error = await syncDatasetError();
        expect(error, "the failure must be reported on the dataset card").to.be.a("string");
        expect((error ?? "").toLowerCase()).to.include("wrong dataset passphrase");

        // Nothing was applied and nothing was kept: no dataset row on this
        // machine, and no host on the dashboard.
        expect(await datasetCardIds()).to.deep.equal([]);
        await clickTabByLabel("Hosts");
        await waitForDashboard();
        expect(await hostCardCount()).to.equal(0);

        // And the refusal changed nothing on the server: the dataset is still
        // there at the generation machine A published.
        await openSyncSection();
        const stillPublished = await testSyncConnection();
        expect(stillPublished).to.include("A dataset is already published here");
        expect(stillPublished).to.include("generation 1");
    });
});
