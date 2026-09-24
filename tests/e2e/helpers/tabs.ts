// Tab-related helpers for the unified tab bar.

/** Count all rendered tabs (any type). */
export async function tabCount(): Promise<number> {
    const tabs = await $$("[data-tab-type]");
    return tabs.length;
}

/** Count tabs of a specific type. */
export async function tabCountOfType(
    type: "terminal" | "sftp" | "s3" | "page",
): Promise<number> {
    const tabs = await $$(`[data-tab-type='${type}']`);
    return tabs.length;
}

/** Click a tab to activate it. Returns the tab id. */
export async function clickTabByLabel(label: string): Promise<string> {
    const tab = await $(`[data-tab-label='${label}']`);
    await tab.waitForClickable({ timeout: 5_000 });
    await tab.click();
    const id = await tab.getAttribute("data-testid");
    return (id ?? "").replace(/^tab-/, "");
}

/** Wait until at least `n` tabs are present. */
export async function waitForTabCount(n: number, timeoutMs = 15_000): Promise<void> {
    await browser.waitUntil(async () => (await tabCount()) >= n, {
        timeout: timeoutMs,
        timeoutMsg: `tab count never reached ${n}`,
    });
}

/*
 * Reads all rendered tab labels in DOM order.
 * Inspects [data-tab-type] elements in the unified tab bar and extracts their
 * data-tab-label attributes.
 */
export async function domTabOrder(): Promise<string[]> {
    const tabs = await $$("[data-tab-type]");
    const labels: string[] = [];
    for (const tab of tabs) {
        labels.push((await tab.getAttribute("data-tab-label")) ?? "");
    }
    return labels;
}

