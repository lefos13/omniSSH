import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultPromptStore } from "./vault-prompt-store";

describe("vault-prompt-store", () => {
  beforeEach(() => {
    useVaultPromptStore.setState({ pending: null });
  });

  it("starts with no pending prompt", () => {
    expect(useVaultPromptStore.getState().pending).toBeNull();
  });

  it("stores the host label and retry for a locked-vault connect", () => {
    const onUnlocked = vi.fn();

    useVaultPromptStore.getState().request({ hostLabel: "software-tools", onUnlocked });

    expect(useVaultPromptStore.getState().pending).toEqual({
      hostLabel: "software-tools",
      onUnlocked,
    });
  });

  it("supports a bare request for the startup unlock check", () => {
    useVaultPromptStore.getState().request();

    expect(useVaultPromptStore.getState().pending).toEqual({
      hostLabel: undefined,
      onUnlocked: undefined,
    });
  });

  it("clears the pending prompt", () => {
    useVaultPromptStore.getState().request({ hostLabel: "prod" });

    useVaultPromptStore.getState().clear();

    expect(useVaultPromptStore.getState().pending).toBeNull();
  });
});
