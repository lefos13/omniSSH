// Reset helper — wipes the app's persisted state and relaunches the Tauri
// process so each test starts from a clean DB.
//
// The suite drives a *debug* build, which stores state in
// `$XDG_DATA_HOME/com.omnissh.desktop-dev` (see `resolve_data_dir` in
// `src-tauri/src/lib.rs`): a debug build never shares a database with an
// installed release. The release and legacy directories are wiped too, so a
// machine that previously ran another binary cannot leak state into a run.
// Deleting the directories is sufficient; the app re-creates the schema on
// startup.

import { rm } from "node:fs/promises";
import { join } from "node:path";

const DATA_ROOT = process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`;

const APP_DATA_DIRS = [
    join(DATA_ROOT, "com.omnissh.desktop-dev"),
    join(DATA_ROOT, "com.omnissh.desktop"),
    join(DATA_ROOT, "com.macnev2013.anyscp"),
];

/**
 * Delete the app's data directory and start a fresh WebDriver session.
 * Call this in a `beforeEach` so tests get full isolation.
 */
export async function resetApp(): Promise<void> {
    // The app process is still alive here and keeps writing to the DB dir
    // (SQLite WAL/journal), so a child file can reappear between rm's unlink
    // pass and the final rmdir → ENOTEMPTY. maxRetries makes rm retry the
    // rmdir with a linear backoff until the writes settle.
    for (const dir of APP_DATA_DIRS) {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    }
    await browser.reloadSession();
}

/**
 * Relaunch the app without touching the DB — used to verify persistence
 * across restarts.
 */
export async function relaunchApp(): Promise<void> {
    await browser.reloadSession();
}
