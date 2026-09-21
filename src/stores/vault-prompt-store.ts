/* Coordinates the single global "Unlock Encrypted Vault" prompt.
 *
 * Both the startup check and a locked-vault connection error feed this store,
 * so only one dialog is ever mounted. A pending request may carry a retry
 * closure that runs after a successful unlock. No secret material is stored
 * here — the master password passes straight through UnlockVaultDialog. */

import { create } from "zustand";

export interface VaultPromptRequest {
  /** Host label shown in the dialog subtitle when the prompt came from a connect. */
  hostLabel?: string;
  /** Runs after the vault unlocks successfully (e.g. retry the connection). */
  onUnlocked?: () => void;
}

interface VaultPromptState {
  pending: VaultPromptRequest | null;
  request: (opts?: VaultPromptRequest) => void;
  clear: () => void;
}

export const useVaultPromptStore = create<VaultPromptState>((set) => ({
  pending: null,
  request: (opts = {}) => set({ pending: { hostLabel: opts.hostLabel, onUnlocked: opts.onUnlocked } }),
  clear: () => set({ pending: null }),
}));
