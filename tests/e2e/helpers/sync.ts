// Dataset-sync helpers — drive Settings ▸ Dataset Sync against the sshd-sync
// target (spec 95-sync-push-pull).
//
// The remote dataset directory is wiped with the runner's own `ssh` client over
// the shared e2e key (mounted at /keys). It has to be wiped from here rather
// than by recreating the container: the dataset lives on a named volume that
// outlives the run, so a spec must be able to start from "nothing is published
// at this path" on a stack that is already up.

import { execFile } from "node:child_process";

/** The endpoint the app is pointed at, plus the directory it publishes into. */
export const SYNC_ENDPOINT = {
    host: process.env.SSHD_SYNC_HOST ?? "sshd-sync",
    port: Number(process.env.SSHD_SYNC_PORT ?? 2222),
    username: process.env.SSH_USER ?? "testuser",
    password: process.env.SSH_PASS ?? "testpass",
    remotePath: process.env.SYNC_REMOTE_PATH ?? "/dataset/data",
};

const SSH_KEY_PATH = process.env.SSH_KEY_PATH ?? "/keys/id_ed25519";

/* A push or pull opens an SSH session, derives the dataset key (Argon2id),
 * seals and uploads the bundle, and on pull writes host rows and credentials —
 * tens of seconds are normal, so these waits sit far above the 15 s default
 * WebDriver timeout. */
const SYNC_OP_TIMEOUT = 90_000;
const SYNC_FORM_TIMEOUT = 60_000;

const DATASET_CARD_PREFIX = "settings-sync-dataset-";
const DATASET_ERROR = "[data-testid='settings-sync-dataset-error']";
const PREFLIGHT_WARNING = "[data-testid='settings-sync-preflight-warning']";

/** Presence + visibility, without throwing when the element is absent. */
async function isVisible(selector: string): Promise<boolean> {
    const el = await $(selector);
    return (await el.isExisting()) && (await el.isDisplayed());
}

/**
 * Delete everything under the given dataset directories (and re-create them
 * empty), so the next probe reports "no dataset here yet" and the next push
 * publishes generation 1 again. A spec that publishes to more than one path
 * names them all: the dataset volume outlives the run, so a directory left
 * behind would make the next run read as already published.
 */
export async function cleanSyncRemote(
    paths: string[] = [SYNC_ENDPOINT.remotePath],
): Promise<void> {
    // Single-quoted for the remote shell: the paths are ours, but they must
    // survive a shell either way rather than depending on being tame.
    const quoted = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
    await new Promise<void>((resolve, reject) => {
        execFile(
            "ssh",
            [
                "-i", SSH_KEY_PATH,
                "-o", "BatchMode=yes",
                "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null",
                "-o", "ConnectTimeout=10",
                "-p", String(SYNC_ENDPOINT.port),
                `${SYNC_ENDPOINT.username}@${SYNC_ENDPOINT.host}`,
                `rm -rf ${quoted} && mkdir -p ${quoted}`,
            ],
            (error, _stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            `could not clean the remote dataset directory: ${
                                stderr.trim() || error.message
                            }`,
                        ),
                    );
                    return;
                }
                resolve();
            },
        );
    });
}

/** Open Settings and switch to the Dataset Sync section. */
export async function openSyncSection(): Promise<void> {
    const nav = await $("[aria-label='Settings']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    const section = await $("[data-testid='settings-nav-sync']");
    await section.waitForClickable({ timeout: 10_000 });
    await section.click();
    await (await $("[data-testid='settings-sync-host']")).waitForDisplayed({ timeout: 10_000 });
}

async function setField(testid: string, value: string): Promise<void> {
    const input = await $(`[data-testid='${testid}']`);
    await input.waitForDisplayed({ timeout: 10_000 });
    await input.setValue(value);
}

/** Fill the endpoint form. Password auth is the only mode the sync spec uses. */
export async function configureSyncEndpoint(endpoint = SYNC_ENDPOINT): Promise<void> {
    await setField("settings-sync-host", endpoint.host);
    await setField("settings-sync-port", String(endpoint.port));
    await setField("settings-sync-username", endpoint.username);
    await setField("settings-sync-password", endpoint.password);
    await setField("settings-sync-path", endpoint.remotePath);
}

/**
 * Press "Test connection" and return the rendered result text. A failed probe
 * throws with the reason the panel reported, which is the only place it shows.
 */
export async function testSyncConnection(): Promise<string> {
    const result = "[data-testid='settings-sync-test-result']";
    const failure = "[data-testid='settings-sync-test-error']";

    const button = await $("[data-testid='settings-sync-test']");
    await button.waitForClickable({ timeout: 10_000 });
    await button.click();

    await browser.waitUntil(
        async () => (await isVisible(result)) || (await isVisible(failure)),
        { timeout: SYNC_FORM_TIMEOUT, timeoutMsg: "the connection test reported nothing" },
    );
    if (await isVisible(failure)) {
        throw new Error(`sync connection test failed: ${(await (await $(failure)).getText()).trim()}`);
    }
    return (await (await $(result)).getText()).trim();
}

/**
 * Fill and submit the dataset form, then wait for the save to settle. Returns
 * the save report text, or `null` when the backend rejected the save — the
 * caller reads `syncDatasetError` for the reason.
 */
export async function saveSyncDataset(opts: {
    name: string;
    passphrase: string;
    includeCredentials?: boolean;
    /* Joining a dataset another machine signed is a member's act: the app
     * refuses an owner join it holds no signing key for. */
    role?: "owner" | "member";
}): Promise<string | null> {
    await setField("settings-sync-name", opts.name);
    await setField("settings-sync-passphrase", opts.passphrase);
    if (opts.role) {
        const radio = await $(`[data-testid='settings-sync-role-${opts.role}']`);
        await radio.waitForClickable({ timeout: 10_000 });
        await radio.click();
    }
    if (opts.includeCredentials !== undefined) {
        const toggle = await $("[data-testid='settings-sync-content-hostCredentials']");
        await toggle.waitForExist({ timeout: 10_000 });
        if ((await toggle.isSelected()) !== opts.includeCredentials) {
            await toggle.click();
        }
    }

    const outcome = "[data-testid='settings-sync-save-outcome']";
    const save = await $("[data-testid='settings-sync-save']");
    await save.waitForClickable({ timeout: 10_000 });
    await save.click();

    await browser.waitUntil(
        async () => (await isVisible(outcome)) || (await isVisible(DATASET_ERROR)),
        { timeout: SYNC_FORM_TIMEOUT, timeoutMsg: "the dataset save reported neither an outcome nor an error" },
    );
    return (await isVisible(outcome)) ? (await (await $(outcome)).getText()).trim() : null;
}

/* `settings-sync-dataset-error` shares the card prefix but is a status line,
 * not a saved dataset, so it is filtered out of every card lookup. */
async function datasetCards(): Promise<WebdriverIO.Element[]> {
    const candidates = await $$(`[data-testid^='${DATASET_CARD_PREFIX}']`);
    const cards: WebdriverIO.Element[] = [];
    for (const candidate of candidates) {
        const testid = (await candidate.getAttribute("data-testid")) ?? "";
        if (testid === "settings-sync-dataset-error") continue;
        cards.push(candidate);
    }
    return cards;
}

export async function datasetCardIds(): Promise<string[]> {
    const cards = await datasetCards();
    const ids: string[] = [];
    for (const card of cards) {
        ids.push(((await card.getAttribute("data-testid")) ?? "").slice(DATASET_CARD_PREFIX.length));
    }
    return ids;
}

/** Wait for the saved dataset row to render, and return the ids on the list. */
export async function waitForDatasetCards(): Promise<string[]> {
    await browser.waitUntil(async () => (await datasetCards()).length > 0, {
        timeout: 10_000,
        timeoutMsg: "the saved dataset never appeared in the list",
    });
    return datasetCardIds();
}

/** The dataset-level error text, or null when the last action left none. */
export async function syncDatasetError(): Promise<string | null> {
    if (!(await isVisible(DATASET_ERROR))) return null;
    return (await (await $(DATASET_ERROR)).getText()).trim();
}

/** The credential preflight notice that blocked a push, when it is up. */
async function preflightWarning(): Promise<string | null> {
    if (!(await isVisible(PREFLIGHT_WARNING))) return null;
    return (await (await $(PREFLIGHT_WARNING)).getText()).trim();
}

/**
 * Press "Push now" / "Pull now" and return the rendered summary. A run the UI
 * refused (credential preflight block, generation conflict, wrong passphrase)
 * throws with the reason it displayed, instead of timing out on a summary that
 * will never appear.
 */
export async function syncDatasetAction(action: "push" | "pull"): Promise<string> {
    const result = `[data-testid='settings-sync-${action}-result']`;
    const button = await $(`[data-testid='settings-sync-${action}']`);
    await button.waitForClickable({ timeout: 10_000 });
    await button.click();

    await browser.waitUntil(
        async () =>
            (await isVisible(result)) ||
            (await isVisible(DATASET_ERROR)) ||
            (await isVisible(PREFLIGHT_WARNING)),
        {
            timeout: SYNC_OP_TIMEOUT,
            timeoutMsg: `the ${action} reported nothing within ${SYNC_OP_TIMEOUT / 1000}s`,
        },
    );

    const blocked = await preflightWarning();
    if (blocked) throw new Error(`${action} was blocked before it ran: ${blocked}`);
    const failure = await syncDatasetError();
    if (failure) throw new Error(`${action} failed: ${failure}`);
    return (await (await $(result)).getText()).trim();
}

/**
 * Press "Push now" / "Pull now" on one dataset card and return the rendered
 * summary. Same contract as `syncDatasetAction`, scoped to the card so a
 * two-dataset list pulls the intended row.
 */
export async function syncDatasetCardAction(
  datasetId: string,
  action: "push" | "pull",
): Promise<string> {
  const card = `[data-testid='settings-sync-dataset-${datasetId}']`;
  const result = `${card} [data-testid='settings-sync-${action}-result']`;
  const cardEl = await $(card);
  await cardEl.waitForExist({ timeout: 10_000 });
  const button = await cardEl.$(`[data-testid='settings-sync-${action}']`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();

  await browser.waitUntil(
    async () =>
      (await isVisible(result)) ||
      (await isVisible(DATASET_ERROR)) ||
      (await isVisible(PREFLIGHT_WARNING)),
    {
      timeout: SYNC_OP_TIMEOUT,
      timeoutMsg: `the ${action} reported nothing within ${SYNC_OP_TIMEOUT / 1000}s`,
    },
  );

  const blocked = await preflightWarning();
  if (blocked) throw new Error(`${action} was blocked before it ran: ${blocked}`);
  const failure = await syncDatasetError();
  if (failure) throw new Error(`${action} failed: ${failure}`);
  return (await (await $(result)).getText()).trim();
}

/**
 * Whether the host edit modal reports a stored credential for the host it is
 * showing, read the way the UI decides it: the password field keeps the mask
 * placeholder and the stored-credential banner is rendered. The banner is
 * driven by `vault_has_credential`, so this asserts the backend can read a
 * secret for this host — not merely that a row claims one.
 */
export async function hostModalShowsStoredCredential(): Promise<boolean> {
    const password = await $("[data-testid='host-modal-password']");
    await password.waitForDisplayed({ timeout: 10_000 });
    const placeholder = (await password.getAttribute("placeholder")) ?? "";
    const modalText = await (await $("[data-testid='host-modal']")).getText();
    return !placeholder.includes("Enter password") && modalText.includes("Credential saved in");
}
