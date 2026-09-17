/*
 * Server-to-server (relay) file copy.
 *
 * Queues a copy of the selected entries from one explorer session into a
 * directory on another, so the explorer's dual panes can transfer directly when
 * both sides are remote. Progress is reported on the `relay:transfer` event and
 * surfaces in the shared transfers popover/page.
 */

import type { Transport } from "./explorer-transport";

export interface RelayEntriesParams {
  srcSessionId: string;
  srcTransport: Transport;
  dstSessionId: string;
  dstTransport: Transport;
  /** Absolute source paths (files or directories) to copy. */
  paths: string[];
  /** Destination directory on the target session. */
  dstDir: string;
}

/** Returns the queued relay transfer ids. */
export async function relayEntries(params: RelayEntriesParams): Promise<string[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string[]>("relay_transfer_entries", { ...params });
}
