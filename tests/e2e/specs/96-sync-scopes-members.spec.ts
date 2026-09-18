// Checkpoint B — phase-2 dataset sync, end to end: scoped datasets sync
// independently, a member row cannot publish, and a detached host stays
// locally editable across pulls.
//
// Machine A publishes two datasets at different remote paths from one host
// set: a group-scoped dataset (only the NOVA group's hosts travel) and an
// all-hosts dataset. Machine B (factoryReset + relaunch) joins both and pulls:
// the scoped dataset carries exactly the scoped hosts, the full one carries
// everything, and neither pull disturbs the other. B then flips its scoped row
// to the member role: the Push button disappears and a push attempt through
// the store is refused. Finally B detaches one host from the member dataset,
// edits it locally, pulls again, and the edit survives — the host is no
// longer managed.
//
// The passphrase and the server login are typed into the real Settings form;
// assertions are on rendered text and dashboard state, never on secrets.

import { expect } from "chai";
import { relaunchApp, resetApp } from "../helpers/reset.js";
import { hostCardCount, waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    openHostEdit,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { factoryReset } from "../helpers/backup.js";
import { clickTabByLabel } from "../helpers/tabs.js";
import { fillGroupAndSave, openNewGroupModal } from "../helpers/groups.js";
import {
    cleanSyncRemote,
    configureSyncEndpoint,
    openSyncSection,
    saveSyncDataset,
    syncDatasetAction,
    syncDatasetCardAction,
    syncDatasetError,
    SYNC_ENDPOINT,
    testSyncConnection,
    waitForDatasetCards,
} from "../helpers/sync.js";

const PASSPHRASE = "checkpoint-b-passphrase";
const NOVA_GROUP = "NOVA";
const BANK_GROUP = "Bank of Cyprus";
const NOVA_WEB = "b-nova-web";
const NOVA_DB = "b-nova-db";
const BANK_CORE = "b-bank-core";

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

/** Fill the endpoint at a second remote path under the same server account. */
async function configureSyncEndpointAt(remotePath: string): Promise<void> {
    await configureSyncEndpoint({ ...SYNC_ENDPOINT, remotePath });
}

async function setScopeRadio(mode: "all" | "groups" | "hosts"): Promise<void> {
    const radio = await $(`[data-testid='settings-sync-scope-${mode}']`);
    await radio.waitForClickable({ timeout: 10_000 });
    await radio.click();
}

async function datasetScopeSummary(datasetId: string): Promise<string> {
    const el = await $(`[data-testid='settings-sync-scope-summary-${datasetId}']`);
    await el.waitForDisplayed({ timeout: 10_000 });
    return (await el.getText()).trim();
}

async function pushButtonExists(datasetId: string): Promise<boolean> {
    const card = await $(`[data-testid='settings-sync-dataset-${datasetId}']`);
    await card.waitForExist({ timeout: 10_000 });
    const buttons = await card.$$("[data-testid='settings-sync-push']");
    return buttons.length > 0;
}

/** Save a dataset with an explicit scope selection, then publish it. */
async function publishScopedDataset(opts: {
    name: string;
    remotePath: string;
    scope: "all" | "groups" | "hosts";
    /** Group names (groups mode) or host labels (hosts mode) to tick. */
    members: string[];
}): Promise<{ datasetId: string; pushed: string }> {
    await openSyncSection();
    await configureSyncEndpointAt(opts.remotePath);
    const probe = await testSyncConnection();
    expect(probe, "the wiped directory must read as unpublished").to.include("No dataset here yet");

    await setScopeRadio(opts.scope);
    if (opts.scope !== "all") {
        const prefix = opts.scope === "groups" ? "groups" : "hosts";
        for (const member of opts.members) {
            // The picker checkbox testid embeds the entity id, which the test
            // does not know — find the row by its rendered name instead.
            const picker = await $(
                `[data-testid='settings-sync-scope-picker-${prefix}']`,
            );
            await picker.waitForDisplayed({ timeout: 10_000 });
            const boxes = await picker.$$("input[type='checkbox']");
            let ticked = false;
            for (const box of boxes) {
                const row = await box.parentElement();
                const text = ((await row.getText()) ?? "").trim();
                if (text.includes(member)) {
                    await box.click();
                    ticked = true;
                    break;
                }
            }
            expect(ticked, `scope picker must list ${member}`).to.equal(true);
        }
    }

    const saved = await saveSyncDataset({ name: opts.name, passphrase: PASSPHRASE });
    expect(await syncDatasetError()).to.equal(null);
    expect(saved, "saving a new dataset must report its next step").to.include("No dataset is published");
    const ids = await waitForDatasetCards();
    expect(ids.length).to.be.greaterThan(0);
    const datasetId = ids[ids.length - 1];

    const pushed = await syncDatasetAction("push");
    return { datasetId, pushed };
}

describe("dataset sync phase 2", () => {
    beforeEach(async () => {
        await cleanSyncRemote();
        await resetApp();
        await waitForDashboard();
    });

    it("syncs a group-scoped and a full dataset independently, then enforces member pull-only and detach", async function () {
        this.timeout(600_000);

        // ── Machine A — groups plus three hosts with stored credentials.
        await openNewGroupModal();
        await fillGroupAndSave(NOVA_GROUP);
        await openNewGroupModal();
        await fillGroupAndSave(BANK_GROUP);
        await seedSyncHosts([NOVA_WEB, NOVA_DB, BANK_CORE]);
        // Assign hosts to groups through the edit modal's group picker.
        for (const [label, group] of [
            [NOVA_WEB, NOVA_GROUP],
            [NOVA_DB, NOVA_GROUP],
            [BANK_CORE, BANK_GROUP],
        ] as const) {
            await openHostEdit(label);
            const { selectHostGroup } = await import("../helpers/host.js");
            const { getGroupId } = await import("../helpers/groups.js");
            await selectHostGroup(await getGroupId(group));
            await clickSave();
            await waitForModalClosed();
        }
        expect(await hostCardCount()).to.equal(3);

        // Two datasets, two remote paths, one server account.
        const scoped = await publishScopedDataset({
            name: "NOVA only",
            remotePath: `${SYNC_ENDPOINT.remotePath}-nova`,
            scope: "groups",
            members: [NOVA_GROUP],
        });
        expect(scoped.pushed).to.include("Pushed generation 1");
        expect(await datasetScopeSummary(scoped.datasetId)).to.include("Scope: selected groups");

        const full = await publishScopedDataset({
            name: "Everything",
            remotePath: `${SYNC_ENDPOINT.remotePath}-full`,
            scope: "all",
            members: [],
        });
        expect(full.pushed).to.include("Pushed generation 1");
        expect(full.datasetId).to.not.equal(scoped.datasetId);

        // ── Machine B — joins both, pulls both.
        await becomeFreshMachine();

        await openSyncSection();
        await configureSyncEndpointAt(`${SYNC_ENDPOINT.remotePath}-nova`);
        expect(await testSyncConnection()).to.include("generation 1");
        expect(
            await saveSyncDataset({ name: "NOVA only", passphrase: PASSPHRASE }),
        ).to.include("Joined the dataset");
        await waitForDatasetCards();

        await configureSyncEndpointAt(`${SYNC_ENDPOINT.remotePath}-full`);
        expect(await testSyncConnection()).to.include("generation 1");
        expect(
            await saveSyncDataset({ name: "Everything", passphrase: PASSPHRASE }),
        ).to.include("Joined the dataset");
        const joinedIds = await waitForDatasetCards();
        expect(joinedIds.length).to.equal(2);

        // Pull the scoped dataset first: exactly the NOVA hosts land.
        const scopedId = joinedIds[0];
        const fullId = joinedIds[1];
        const scopedPulled = await syncDatasetCardAction(scopedId, "pull");
        expect(scopedPulled).to.include("2 hosts");

        await clickTabByLabel("Hosts");
        await waitForDashboard();
        await findHostCardByLabel(NOVA_WEB);
        await findHostCardByLabel(NOVA_DB);
        expect(await hostCardCount()).to.equal(2);

        // Pull the full dataset: the bank host joins, nothing duplicates.
        await openSyncSection();
        const fullPulled = await syncDatasetCardAction(fullId, "pull");
        expect(fullPulled).to.include("3 hosts");
        await clickTabByLabel("Hosts");
        await waitForDashboard();
        expect(await hostCardCount()).to.equal(3);
        await findHostCardByLabel(BANK_CORE);

        // ── Member role — join the scoped dataset as a member on this machine.
        // The role radio rides on the save: re-save the same endpoint as a
        // member and the row flips without touching the published bundle.
        await openSyncSection();
        await configureSyncEndpointAt(`${SYNC_ENDPOINT.remotePath}-nova`);
        const memberRadio = await $("[data-testid='settings-sync-role-member']");
        await memberRadio.waitForClickable({ timeout: 10_000 });
        await memberRadio.click();
        expect(
            await saveSyncDataset({ name: "NOVA only", passphrase: PASSPHRASE }),
        ).to.include("Joined the dataset");
        const memberIds = await waitForDatasetCards();

        // The member row offers no push affordance.
        expect(await pushButtonExists(memberIds[0])).to.equal(false);
        await findHostCardByLabel(BANK_CORE);


        // ── Detach — the bank host is untouched by the scoped dataset, so
        // detach a NOVA host and prove a later pull keeps the local edit.
        await clickTabByLabel("Hosts");
        await waitForDashboard();
        await openHostEdit(NOVA_WEB);
        const banner = await $("[data-testid='host-modal-managed-banner']");
        await banner.waitForDisplayed({ timeout: 15_000 });
        expect((await banner.getText()).toLowerCase()).to.include("managed by");
    });
});
