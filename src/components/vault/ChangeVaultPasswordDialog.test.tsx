import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeVaultPasswordDialog } from "./ChangeVaultPasswordDialog";
import { useLocalVaultStore } from "../../stores/local-vault-store";

describe("ChangeVaultPasswordDialog", () => {
  beforeEach(() => {
    useLocalVaultStore.setState({
      configured: true,
      unlocked: true,
      loading: false,
      error: null,
      changeMasterPassword: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("requires a matching replacement master password before submitting", () => {
    render(<ChangeVaultPasswordDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByTestId("local-vault-change-current-password"), {
      target: { value: "current-master-password" },
    });
    fireEvent.change(screen.getByTestId("local-vault-change-new-password"), {
      target: { value: "replacement-master-password" },
    });
    fireEvent.change(screen.getByTestId("local-vault-change-confirm-password"), {
      target: { value: "a-different-master-password" },
    });
    fireEvent.click(screen.getByTestId("local-vault-change-submit"));

    expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match");
  });
});
