import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateVaultDialog } from "./CreateVaultDialog";
import { useLocalVaultStore } from "../../stores/local-vault-store";

describe("CreateVaultDialog", () => {
  beforeEach(() => {
    useLocalVaultStore.setState({
      configured: false,
      unlocked: false,
      loading: false,
      error: null,
      setupVault: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("warns that the master password cannot be recovered and rejects mismatches", () => {
    render(<CreateVaultDialog open onClose={() => {}} />);

    expect(screen.getByTestId("local-vault-warning")).toHaveTextContent("No Password Recovery");
    fireEvent.change(screen.getByTestId("local-vault-master-password"), {
      target: { value: "a secure password" },
    });
    fireEvent.change(screen.getByTestId("local-vault-confirm-password"), {
      target: { value: "a different password" },
    });
    fireEvent.click(screen.getByTestId("local-vault-submit"));

    expect(screen.getByRole("alert")).toHaveTextContent("Passwords do not match");
  });
});
