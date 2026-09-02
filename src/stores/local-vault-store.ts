/* This store mirrors only backend vault session status. Master passwords pass
 * directly through each action and are never retained in Zustand or storage. */

import { create } from "zustand";
import type { LocalVaultStatus } from "../types/vault";

function messageFrom(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: string }).message);
  }
  return fallback;
}

interface LocalVaultState extends LocalVaultStatus {
  loading: boolean;
  error: string | null;
  loadStatus: () => Promise<LocalVaultStatus>;
  setupVault: (masterPassword: string) => Promise<void>;
  unlockVault: (masterPassword: string) => Promise<void>;
  lockVault: () => Promise<void>;
}

export const useLocalVaultStore = create<LocalVaultState>((set) => ({
  configured: false,
  unlocked: false,
  loading: false,
  error: null,

  loadStatus: async () => {
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const status = await invoke<LocalVaultStatus>("local_vault_status");
      set({ ...status, loading: false });
      return status;
    } catch (error) {
      const message = messageFrom(error, "Failed to load encrypted vault status");
      set({ loading: false, error: message });
      throw error;
    }
  },

  setupVault: async (masterPassword) => {
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("local_vault_setup", { masterPassword });
      set({ configured: true, unlocked: true, loading: false });
    } catch (error) {
      set({ loading: false, error: messageFrom(error, "Failed to create encrypted vault") });
      throw error;
    }
  },

  unlockVault: async (masterPassword) => {
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("local_vault_unlock", { masterPassword });
      set({ unlocked: true, loading: false });
    } catch (error) {
      set({ loading: false, error: messageFrom(error, "Incorrect master password") });
      throw error;
    }
  },

  lockVault: async () => {
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("local_vault_lock");
      set({ unlocked: false, loading: false });
    } catch (error) {
      set({ loading: false, error: messageFrom(error, "Failed to lock encrypted vault") });
      throw error;
    }
  },
}));
