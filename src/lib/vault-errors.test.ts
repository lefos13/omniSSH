import { beforeEach, describe, expect, it, vi } from "vitest";
import { isVaultLockedError, handleVaultLockedError } from "./vault-errors";
import { useVaultPromptStore } from "../stores/vault-prompt-store";

describe("vault-errors", () => {
  beforeEach(() => {
    useVaultPromptStore.getState().clear();
  });

  it("recognizes only the serialized vault_locked kind", () => {
    expect(isVaultLockedError({ kind: "vault_locked", message: "locked" })).toBe(true);
    expect(isVaultLockedError({ kind: "connection_failed", message: "locked" })).toBe(false);
    expect(isVaultLockedError(new Error("Local vault is locked"))).toBe(false);
    expect(isVaultLockedError("vault_locked")).toBe(false);
    expect(isVaultLockedError(null)).toBe(false);
    expect(isVaultLockedError(undefined)).toBe(false);
  });

  it("opens the unlock prompt and defers the retry until unlock succeeds", () => {
    const retry = vi.fn();

    const handled = handleVaultLockedError(
      { kind: "vault_locked", message: "Local vault is locked; unlock it before connecting" },
      "software-tools",
      retry,
    );

    expect(handled).toBe(true);
    expect(useVaultPromptStore.getState().pending?.hostLabel).toBe("software-tools");
    expect(retry).not.toHaveBeenCalled();

    useVaultPromptStore.getState().pending?.onUnlocked?.();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("leaves non-vault errors to the caller's generic handling", () => {
    const retry = vi.fn();

    expect(handleVaultLockedError({ kind: "connection_failed" }, "host", retry)).toBe(false);

    expect(useVaultPromptStore.getState().pending).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });
});
