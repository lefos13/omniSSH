/*
 * SFTP explorer E2E test interactions.
 * Built on testids in ExplorerToolbar, ExplorerFileTable, and ExplorerPage.
 * In dual-pane host explorer sessions, helpers scope queries to the target
 * pane (`[data-explorer-pane="remote"]` by default) so existing specs run
 * unchanged while local-pane variants support cross-pane transfer flows.
 */

/*
 * Resolves the root element for an explorer pane.
 * In dual-pane host explorer views, multiple panes may exist across mounted tabs
 * (issue #17). Iterates matching elements and prefers the visible/displayed
 * pane so hidden background explorer tabs are not accidentally targeted.
 * Falls back to single-pane views (such as S3 or linked explorer) via
 * [data-explorer-session-id] so existing single-pane flows remain compatible.
 */
async function resolvePaneElement(pane: "remote" | "local" = "remote"): Promise<WebdriverIO.Element | null> {
    const paneEls = await $$(`[data-explorer-pane="${pane}"]`);
    for (const paneEl of paneEls) {
        if (await paneEl.isDisplayed()) {
            return paneEl;
        }
    }
    if (pane === "remote") {
        const activeContainers = await $$("[data-explorer-session-id]");
        for (const container of activeContainers) {
            if (await container.isDisplayed()) {
                return container;
            }
        }
        for (const container of activeContainers) {
            if (await container.isExisting()) {
                return container;
            }
        }
    }
    for (const paneEl of paneEls) {
        if (await paneEl.isExisting()) {
            return paneEl;
        }
    }
    return null;
}

/** Wait until the explorer toolbar is rendered (refresh button visible). */
export async function waitForExplorer(
    timeoutMs = 30_000,
    pane: "remote" | "local" = "remote",
): Promise<void> {
    await browser.waitUntil(
        async () => {
            const paneEl = await resolvePaneElement(pane);
            if (paneEl) {
                const btn = await paneEl.$('[data-testid="explorer-refresh"]');
                return (await btn.isExisting()) && (await btn.isDisplayed());
            }
            const refreshes = await $$('[data-testid="explorer-refresh"]');
            for (const refresh of refreshes) {
                if (await refresh.isDisplayed()) return true;
            }
            return false;
        },
        { timeout: timeoutMs, timeoutMsg: `no visible explorer toolbar rendered for ${pane} pane` },
    );
}

/*
 * AppShell keeps explorer tabs mounted while switching tabs, so unscoped
 * selectors can read a hidden tab's rows or path. Resolve the visible session
 * container first and let multi-tab tests assert the active explorer's state.
 */
export async function waitForActiveExplorer(
    timeoutMs = 30_000,
): Promise<WebdriverIO.Element> {
    await browser.waitUntil(
        async () => {
            const containers = await $$('[data-explorer-session-id]');
            for (const container of containers) {
                if (await container.isDisplayed()) return true;
            }
            return false;
        },
        {
            timeout: timeoutMs,
            timeoutMsg: "no visible explorer session container rendered",
        },
    );

    const containers = await $$('[data-explorer-session-id]');
    for (const container of containers) {
        if (await container.isDisplayed()) return container;
    }
    throw new Error("visible explorer session container disappeared");
}

/** Wait for an entry inside the currently visible explorer tab or panel. */
export async function waitForActiveEntry(
    name: string,
    timeoutMs = 10_000,
): Promise<WebdriverIO.Element> {
    const container = await waitForActiveExplorer(timeoutMs);
    const entry = await container.$(`[data-entry-name='${name}']`);
    await entry.waitForExist({ timeout: timeoutMs });
    return entry;
}

/** Read the last breadcrumb segment from the currently visible explorer. */
export async function activeExplorerPath(timeoutMs = 10_000): Promise<string> {
    const container = await waitForActiveExplorer(timeoutMs);
    const buttons = await container.$$('[aria-label="Current path"] button');
    const last = buttons.at(-1);
    return last ? await last.getText() : "";
}

/** Find a directory entry by its display name. Waits up to timeoutMs. Defaults to remote pane. */
export async function waitForEntry(
    name: string,
    timeoutMs = 10_000,
    pane: "remote" | "local" = "remote",
): Promise<WebdriverIO.Element> {
    const paneEl = await resolvePaneElement(pane);
    const el = paneEl
        ? await paneEl.$(`[data-entry-name='${name}']`)
        : await $(`[data-entry-name='${name}']`);
    await el.waitForExist({ timeout: timeoutMs });
    return el;
}

/** True if no entry with that name is visible in the specified pane. */
export async function assertEntryAbsent(
    name: string,
    timeoutMs = 10_000,
    pane: "remote" | "local" = "remote",
): Promise<void> {
    await browser.waitUntil(
        async () => {
            const paneEl = await resolvePaneElement(pane);
            if (paneEl) {
                return !(await (await paneEl.$(`[data-entry-name='${name}']`)).isExisting());
            }
            return !(await (await $(`[data-entry-name='${name}']`)).isExisting());
        },
        { timeout: timeoutMs, timeoutMsg: `entry '${name}' still present in ${pane} pane` },
    );
}

/** Double-click an entry to navigate (if directory) or open (if file). */
export async function openEntry(
    name: string,
    pane: "remote" | "local" = "remote",
): Promise<void> {
    const entry = await waitForEntry(name, 10_000, pane);
    await entry.scrollIntoView({ block: "center" });
    await browser.execute((el) => {
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, view: window }));
    }, entry);
}

/** Click the explorer refresh button for the target pane. */
export async function refreshExplorer(pane: "remote" | "local" = "remote"): Promise<void> {
    const paneEl = await resolvePaneElement(pane);
    const btn = paneEl
        ? await paneEl.$("[data-testid='explorer-refresh']")
        : await $("[data-testid='explorer-refresh']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** Click the home/root toolbar button (navigates to the filesystem root `/`). */
export async function navigateExplorerHome(pane: "remote" | "local" = "remote"): Promise<void> {
    const paneEl = await resolvePaneElement(pane);
    const btn = paneEl
        ? await paneEl.$("[data-testid='explorer-home']")
        : await $("[data-testid='explorer-home']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** Navigate to the parent of the current directory by clicking the
 *  second-to-last breadcrumb segment. Unlike {@link navigateExplorerHome}
 *  (which jumps to root), this goes exactly one level up. */
export async function navigateUp(pane: "remote" | "local" = "remote"): Promise<void> {
    await browser.execute((p: string) => {
        const paneEls = Array.from(document.querySelectorAll<HTMLElement>(`[data-explorer-pane="${p}"]`));
        let target: HTMLElement | null = null;
        for (const el of paneEls) {
            if (!el.closest(".invisible")) {
                const style = window.getComputedStyle(el);
                if (style.display !== "none" && style.visibility !== "hidden") {
                    target = el;
                    break;
                }
            }
        }
        const root = target ?? document;
        const container = root.querySelector("[aria-label='Current path']");
        const buttons = container
            ? Array.from(container.querySelectorAll("button"))
            : [];
        const parent = buttons[buttons.length - 2] as HTMLButtonElement | undefined;
        parent?.click();
    }, pane);
}

/** Current pressed-state of the sudo toggle ("true"/"false"), or null if the
 *  button isn't rendered (e.g. SCP transport or a root login). */
export async function sudoToggleState(): Promise<string | null> {
    const btn = await $("[data-testid='explorer-sudo-toggle']");
    if (!(await btn.isExisting())) return null;
    return await btn.getAttribute("aria-pressed");
}

/** Click the sudo toggle and wait until the (remounted) explorer reports the
 *  expected pressed state. Toggling reopens the SFTP session over `sudo
 *  sftp-server` and remounts the view, so the button element is replaced. */
export async function toggleSudo(expectOn: boolean): Promise<void> {
    const btn = await $("[data-testid='explorer-sudo-toggle']");
    await btn.waitForClickable({ timeout: 10_000 });
    await btn.click();
    await browser.waitUntil(async () => (await sudoToggleState()) === String(expectOn), {
        timeout: 30_000,
        timeoutMsg: `sudo toggle never reached aria-pressed=${expectOn}`,
    });
    // The reopened session re-lists its directory; wait for the toolbar to settle.
    await waitForExplorer();
}

/** Create a folder via the toolbar. Waits for the new entry to appear. */
export async function createFolder(
    name: string,
    pane: "remote" | "local" = "remote",
): Promise<void> {
    const paneEl = await resolvePaneElement(pane);
    const btn = paneEl
        ? await paneEl.$("[data-testid='explorer-new-folder']")
        : await $("[data-testid='explorer-new-folder']");
    await btn.click();
    const input = paneEl
        ? await paneEl.$("[data-testid='explorer-new-folder-input']")
        : await $("[data-testid='explorer-new-folder-input']");
    await input.waitForDisplayed({ timeout: 5_000 });
    await input.setValue(name);
    await browser.keys(["Enter"]);
    await waitForEntry(name, 10_000, pane);
}

/** Create an empty file via the toolbar. */
export async function createFile(
    name: string,
    pane: "remote" | "local" = "remote",
): Promise<void> {
    const paneEl = await resolvePaneElement(pane);
    const btn = paneEl
        ? await paneEl.$("[data-testid='explorer-new-file']")
        : await $("[data-testid='explorer-new-file']");
    await btn.click();
    const input = paneEl
        ? await paneEl.$("[data-testid='explorer-new-file-input']")
        : await $("[data-testid='explorer-new-file-input']");
    await input.waitForDisplayed({ timeout: 5_000 });
    await input.setValue(name);
    await browser.keys(["Enter"]);
    await waitForEntry(name, 10_000, pane);
}

/** Select an entry by clicking it, then press Delete and confirm. */
export async function deleteEntry(
    name: string,
    pane: "remote" | "local" = "remote",
): Promise<void> {
    const entry = await waitForEntry(name, 10_000, pane);
    await entry.click();
    await browser.keys(["Delete"]);
    const confirm = await $("[data-testid='explorer-delete-confirm-button']");
    await confirm.waitForClickable({ timeout: 5_000 });
    await confirm.click();
    await assertEntryAbsent(name, 10_000, pane);
}

/** Select a set of entries (via __e2eExplorerSetSelection) then Delete + confirm. */
export async function multiSelectAndDelete(
    names: string[],
    pane: "remote" | "local" = "remote",
): Promise<void> {
    if (names.length === 0) return;
    for (const name of names) await waitForEntry(name, 10_000, pane);

    await browser.execute((items: string[], p: "remote" | "local") => {
        const fn = (window as unknown as {
            __e2eExplorerSetSelection?: (names: string[], pane?: "remote" | "local") => void;
        }).__e2eExplorerSetSelection;
        if (!fn) throw new Error("__e2eExplorerSetSelection not registered");
        fn(items, p);
    }, names, pane);

    // Focus a selected row so the Delete keydown fires on it.
    await browser.execute((firstName: string, p: string) => {
        const paneEls = Array.from(document.querySelectorAll<HTMLElement>(`[data-explorer-pane="${p}"]`));
        let target: HTMLElement | null = null;
        for (const el of paneEls) {
            if (!el.closest(".invisible")) {
                const style = window.getComputedStyle(el);
                if (style.display !== "none" && style.visibility !== "hidden") {
                    target = el;
                    break;
                }
            }
        }
        const root = target ?? document;
        const el = root.querySelector(
            `[data-entry-name='${firstName}']`,
        ) as HTMLElement | null;
        el?.focus();
    }, names[0], pane);
    await browser.keys(["Delete"]);
    const confirm = await $("[data-testid='explorer-delete-confirm-button']");
    await confirm.waitForClickable({ timeout: 5_000 });
    await confirm.click();
    for (const name of names) await assertEntryAbsent(name, 10_000, pane);
}

/** Read the displayed rwx permission string of an entry (e.g. "rw-r--r--"),
 *  or null if the entry/permissions cell isn't present. */
export async function entryPermissions(
    name: string,
    pane: "remote" | "local" = "remote",
): Promise<string | null> {
    return await browser.execute((n: string, p: string) => {
        const paneEls = Array.from(document.querySelectorAll<HTMLElement>(`[data-explorer-pane="${p}"]`));
        let target: HTMLElement | null = null;
        for (const el of paneEls) {
            if (!el.closest(".invisible")) {
                const style = window.getComputedStyle(el);
                if (style.display !== "none" && style.visibility !== "hidden") {
                    target = el;
                    break;
                }
            }
        }
        const root = target ?? document;
        const row = root.querySelector(`[data-entry-name='${n}']`);
        const cell = row?.querySelector("[data-entry-perms]");
        return cell?.getAttribute("data-entry-perms") ?? null;
    }, name, pane);
}
/** Change an entry's permissions via the __e2eExplorerChmod(name, mode) hook
 *  (which drives onApplyPermissions → sftp_chmod → directory refresh), then
 *  wait until the listing reflects the expected rwx string. `mode` is octal. */
export async function setPermissions(
    name: string,
    mode: number,
    expectedDisplay: string,
    recursive = false,
    pane: "remote" | "local" = "remote",
): Promise<void> {
    await waitForEntry(name, 10_000, pane);
    // Drive the chmod and AWAIT its promise inside the page so a rejection from
    // the Tauri command surfaces here as a real error (with its reason) instead
    // of being dropped.
    const chmodError = await browser.executeAsync(
        (n: string, m: number, r: boolean, done: (err: string | null) => void) => {
            const fn = (window as unknown as {
                __e2eExplorerChmod?: (n: string, m: number, r?: boolean) => Promise<unknown> | undefined;
            }).__e2eExplorerChmod;
            if (!fn) {
                done("__e2eExplorerChmod not registered");
                return;
            }
            Promise.resolve(fn(n, m, r)).then(
                () => done(null),
                (e: unknown) => {
                    const msg = e && typeof e === "object" && "message" in e && typeof e.message === "string"
                        ? e.message
                        : String(e);
                    done(msg);
                },
            );
        },
        name,
        mode,
        recursive,
    );
    if (chmodError) {
        throw new Error(`chmod('${name}', ${mode.toString(8)}) failed: ${chmodError}`);
    }
    await browser.waitUntil(
        async () => (await entryPermissions(name, pane)) === expectedDisplay,
        {
            timeout: 10_000,
            timeoutMsg: `entry '${name}' permissions never became '${expectedDisplay}'`,
        },
    );
}

/** Read the current order of entries in the listing (top to bottom). */
export async function entryOrder(pane: "remote" | "local" = "remote"): Promise<string[]> {
    return await browser.execute((p: string) => {
        const paneEls = Array.from(document.querySelectorAll<HTMLElement>(`[data-explorer-pane="${p}"]`));
        let target: HTMLElement | null = null;
        for (const el of paneEls) {
            if (!el.closest(".invisible")) {
                const style = window.getComputedStyle(el);
                if (style.display !== "none" && style.visibility !== "hidden") {
                    target = el;
                    break;
                }
            }
        }
        const root = target ?? document;
        return Array.from(
            root.querySelectorAll<HTMLElement>("[data-entry-row='true']"),
        ).map((el) => el.getAttribute("data-entry-name") ?? "");
    }, pane);
}
/** Click a column header to (re)sort by that column. */
export async function clickSortHeader(
    col: "name" | "size" | "modified",
    pane: "remote" | "local" = "remote",
): Promise<void> {
    const paneEl = await resolvePaneElement(pane);
    const btn = paneEl
        ? await paneEl.$(`[data-testid='explorer-sort-${col}']`)
        : await $(`[data-testid='explorer-sort-${col}']`);
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** Rename an entry. Calls the __e2eExplorerStartRename(oldName, newName) hook
 *  which invokes onRename directly. */
export async function renameEntry(
    oldName: string,
    newName: string,
    pane: "remote" | "local" = "remote",
): Promise<void> {
    await waitForEntry(oldName, 10_000, pane);
    await browser.execute(
        (oldN: string, newN: string) => {
            const fn = (window as unknown as {
                __e2eExplorerStartRename?: (o: string, n?: string) => void;
            }).__e2eExplorerStartRename;
            if (!fn) throw new Error("__e2eExplorerStartRename not registered");
            fn(oldN, newN);
        },
        oldName,
        newName,
    );
    await waitForEntry(newName, 10_000, pane);
    await assertEntryAbsent(oldName, 10_000, pane);
}

/*
 * Explicit local-pane helper variants for Task 5 dual-pane transfer flows.
 */
export const waitForLocalExplorer = (timeoutMs = 30_000): Promise<void> =>
    waitForExplorer(timeoutMs, "local");

export const waitForLocalEntry = (name: string, timeoutMs = 10_000): Promise<WebdriverIO.Element> =>
    waitForEntry(name, timeoutMs, "local");

export const assertLocalEntryAbsent = (name: string, timeoutMs = 10_000): Promise<void> =>
    assertEntryAbsent(name, timeoutMs, "local");

export const openLocalEntry = (name: string): Promise<void> =>
    openEntry(name, "local");

export const localEntryOrder = (): Promise<string[]> =>
    entryOrder("local");

export const refreshLocalExplorer = (): Promise<void> =>
    refreshExplorer("local");

export const navigateLocalExplorerHome = (): Promise<void> =>
    navigateExplorerHome("local");

export const navigateLocalUp = (): Promise<void> =>
    navigateUp("local");

/** Set selection in the local pane directly via the E2E hook. */
export async function selectLocalEntries(names: string[]): Promise<void> {
    await browser.execute((items: string[]) => {
        const fn = (window as unknown as {
            __e2eExplorerSetSelection?: (names: string[], pane?: "remote" | "local") => void;
        }).__e2eExplorerSetSelection;
        if (!fn) throw new Error("__e2eExplorerSetSelection not registered");
        fn(items, "local");
    }, names);
}

/** Set selection in the remote pane directly via the E2E hook. */
export async function selectRemoteEntries(names: string[]): Promise<void> {
    await browser.execute((items: string[]) => {
        const fn = (window as unknown as {
            __e2eExplorerSetSelection?: (names: string[], pane?: "remote" | "local") => void;
        }).__e2eExplorerSetSelection;
        if (!fn) throw new Error("__e2eExplorerSetSelection not registered");
        fn(items, "remote");
    }, names);
}

/** Click the center action rail "Copy selected to remote" button. */
export async function clickCopyToRemote(): Promise<void> {
    const btn = await $("[data-testid='explorer-copy-to-remote']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/** Click the center action rail "Copy selected to local" button. */
export async function clickCopyToLocal(): Promise<void> {
    const btn = await $("[data-testid='explorer-copy-to-local']");
    await btn.waitForClickable({ timeout: 5_000 });
    await btn.click();
}

/**
 * Navigate an explorer pane to an arbitrary directory path using the toolbar path input.
 * Scopes to the target pane so local and remote path bars are independent.
 */
export async function navigateToPath(
    path: string,
    pane: "remote" | "local" = "remote",
): Promise<void> {
    // Ensure target pane is rendered and not in a loading state (refresh button enabled)
    await browser.waitUntil(
        async () => {
            const paneEl = await resolvePaneElement(pane);
            if (!paneEl) return false;
            const btn = await paneEl.$('[data-testid="explorer-refresh"]');
            if (!(await btn.isExisting()) || !(await btn.isDisplayed())) return false;
            const disabled = await btn.getAttribute("disabled");
            return disabled === null || disabled === undefined || disabled === "false";
        },
        { timeout: 15_000, timeoutMsg: `${pane} explorer never reached ready (non-loading) state` },
    );

    // Enter path edit mode by calling the path bar's onClick handler or clicking it
    await browser.execute((p: string) => {
        const paneEls = Array.from(document.querySelectorAll<HTMLElement>(`[data-explorer-pane="${p}"]`));
        let target: HTMLElement | null = null;
        for (const el of paneEls) {
            if (!el.closest(".invisible")) {
                const style = window.getComputedStyle(el);
                if (style.display !== "none" && style.visibility !== "hidden") {
                    target = el;
                    break;
                }
            }
        }
        const root = target ?? document;
        const bar = root.querySelector('[aria-label="Current path"]') as HTMLElement | null;
        if (bar) {
            const anyBar = bar as unknown as Record<string, unknown>;
            const propKey = Object.keys(anyBar).find((k) => k.startsWith("__reactProps$"));
            const props = propKey ? (anyBar[propKey] as { onClick?: (e: unknown) => void }) : null;
            if (typeof props?.onClick === "function") {
                props.onClick({ preventDefault: () => {}, stopPropagation: () => {} });
            } else {
                bar.click();
            }
        }
    }, pane);

    const inputSelector = `[data-explorer-pane="${pane}"] [data-testid="explorer-path-input"]`;
    await browser.waitUntil(
        async () => {
            const inps = await $$(inputSelector);
            for (const inp of inps) {
                if (await inp.isDisplayed()) return true;
            }
            return false;
        },
        { timeout: 10_000, timeoutMsg: `path input never displayed in ${pane} pane` },
    );
    // Set the path in the input and commit with Enter
    await browser.execute((p: string, targetPath: string) => {
        const paneEls = Array.from(document.querySelectorAll<HTMLElement>(`[data-explorer-pane="${p}"]`));
        let target: HTMLElement | null = null;
        for (const el of paneEls) {
            if (!el.closest(".invisible")) {
                const style = window.getComputedStyle(el);
                if (style.display !== "none" && style.visibility !== "hidden") {
                    target = el;
                    break;
                }
            }
        }
        const root = target ?? document;
        const input = root.querySelector<HTMLInputElement>('[data-testid="explorer-path-input"]');
        if (input) {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
            nativeSetter?.call(input, targetPath);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            input.blur();
        }
    }, pane, path);

    // Wait for the path input to close (edit committed)
    await browser.waitUntil(
        async () => {
            const inps = await $$(inputSelector);
            for (const inp of inps) {
                if (await inp.isDisplayed()) return false;
            }
            return true;
        },
        { timeout: 5_000, timeoutMsg: `path input remained open after navigating to '${path}'` },
    );

    await waitForExplorer(10_000, pane);
}

export const navigateLocalToPath = (path: string): Promise<void> =>
    navigateToPath(path, "local");

/** Read the last breadcrumb segment from the specified pane. Defaults to remote. */
export async function explorerPath(
    pane: "remote" | "local" = "remote",
    timeoutMs = 10_000,
): Promise<string> {
    const paneEl = await resolvePaneElement(pane);
    if (!paneEl) return "";
    const buttons = await paneEl.$$('[aria-label="Current path"] button');
    const last = buttons.at(-1);
    return last ? await last.getText() : "";
}

export const localExplorerPath = (timeoutMs = 10_000): Promise<string> =>
    explorerPath("local", timeoutMs);
