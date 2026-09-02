import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalVaultStore } from "./local-vault-store";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("local-vault-store", () => {
  beforeEach(() => {
    invoke.mockReset();
    useLocalVaultStore.setState({
      configured: false,
      unlocked: false,
      loading: false,
      error: null,
    });
  });

  it("loads the backend vault status without persisting secrets or host identifiers", async () => {
    invoke.mockResolvedValueOnce({ configured: true, unlocked: false });

    await useLocalVaultStore.getState().loadStatus();

    expect(invoke).toHaveBeenCalledWith("local_vault_status");
    expect(useLocalVaultStore.getState()).toMatchObject({
      configured: true,
      unlocked: false,
    });
  });

  it("forwards master passwords only to the setup and unlock IPC commands", async () => {
    invoke.mockResolvedValue(undefined);

    await useLocalVaultStore.getState().setupVault("master-password");
    await useLocalVaultStore.getState().lockVault();
    await useLocalVaultStore.getState().unlockVault("master-password");

    expect(invoke).toHaveBeenNthCalledWith(1, "local_vault_setup", {
      masterPassword: "master-password",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "local_vault_lock");
    expect(invoke).toHaveBeenNthCalledWith(3, "local_vault_unlock", {
      masterPassword: "master-password",
    });
  });

  it("forwards current and replacement master passwords without retaining either", async () => {
    invoke.mockResolvedValue(undefined);

    await useLocalVaultStore
      .getState()
      .changeMasterPassword("current-master-password", "replacement-master-password");

    expect(invoke).toHaveBeenCalledWith("local_vault_change_master_password", {
      currentMasterPassword: "current-master-password",
      newMasterPassword: "replacement-master-password",
    });
    expect(useLocalVaultStore.getState()).not.toHaveProperty("masterPassword");
  });
});
