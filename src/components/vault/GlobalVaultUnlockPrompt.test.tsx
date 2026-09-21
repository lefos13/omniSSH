import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalVaultUnlockPrompt } from "./GlobalVaultUnlockPrompt";
import { useVaultPromptStore } from "../../stores/vault-prompt-store";
import { useLocalVaultStore } from "../../stores/local-vault-store";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("GlobalVaultUnlockPrompt", () => {
  beforeEach(() => {
    invoke.mockReset();
    useVaultPromptStore.setState({ pending: null });
    useLocalVaultStore.setState({ configured: true, unlocked: false, loading: false, error: null });
  });

  it("stays closed until a prompt is requested", () => {
    render(<GlobalVaultUnlockPrompt />);

    expect(screen.queryByTestId("local-vault-unlock-dialog")).not.toBeInTheDocument();
  });

  it("unlocks the vault and runs the pending retry", async () => {
    invoke.mockResolvedValue(undefined);
    const onUnlocked = vi.fn();
    useVaultPromptStore.getState().request({ hostLabel: "software-tools", onUnlocked });

    render(<GlobalVaultUnlockPrompt />);

    expect(await screen.findByTestId("local-vault-unlock-dialog")).toBeInTheDocument();
    expect(screen.getByText(/Unlock vault to access software-tools/)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("local-vault-unlock-password"), {
      target: { value: "master-password" },
    });
    fireEvent.click(screen.getByTestId("local-vault-unlock-submit"));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("local_vault_unlock", { masterPassword: "master-password" });
    });
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(useVaultPromptStore.getState().pending).toBeNull();
  });

  it("drops the retry when the prompt is dismissed", async () => {
    const onUnlocked = vi.fn();
    useVaultPromptStore.getState().request({ hostLabel: "prod", onUnlocked });

    render(<GlobalVaultUnlockPrompt />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(onUnlocked).not.toHaveBeenCalled();
    expect(useVaultPromptStore.getState().pending).toBeNull();
  });
});
