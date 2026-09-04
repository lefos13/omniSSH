/*
 * Component tests for ExplorerTransferActions rail.
 *
 * Verifies that:
 * 1. "Copy selected to remote" renders with accessible label and direction icon.
 * 2. Disabled when selection count is 0, destination directory is unknown, or busy.
 * 3. Shows busy spinner with aria-busy when enqueue is in flight.
 * 4. Calls onCopyToRemote when activated.
 * 5. Accommodates the reverse "Copy selected to local" button when provided (Task 3).
 */

import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExplorerTransferActions } from "./ExplorerTransferActions";

describe("ExplorerTransferActions", () => {
  it("renders copy-to-remote button with count and accessible label", () => {
    const onCopyToRemote = vi.fn();
    render(
      <ExplorerTransferActions
        localSelectedCount={3}
        hasRemoteDir={true}
        busy={false}
        onCopyToRemote={onCopyToRemote}
      />,
    );

    const btn = screen.getByTestId("explorer-copy-to-remote");
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute("aria-label", "Copy selected to remote (3 items)");
    expect(btn).toHaveAttribute("title", "Copy selected to remote (3 items)");
    expect(btn).toHaveAttribute("aria-busy", "false");

    fireEvent.click(btn);
    expect(onCopyToRemote).toHaveBeenCalledTimes(1);
  });

  it("uses singular label for exactly 1 item", () => {
    render(
      <ExplorerTransferActions
        localSelectedCount={1}
        hasRemoteDir={true}
        busy={false}
        onCopyToRemote={() => {}}
      />,
    );

    const btn = screen.getByTestId("explorer-copy-to-remote");
    expect(btn).toHaveAttribute("aria-label", "Copy selected to remote (1 item)");
    expect(btn).toHaveAttribute("title", "Copy selected to remote (1 item)");
  });

  it("is disabled when selection count is 0", () => {
    render(
      <ExplorerTransferActions
        localSelectedCount={0}
        hasRemoteDir={true}
        busy={false}
        onCopyToRemote={() => {}}
      />,
    );

    const btn = screen.getByTestId("explorer-copy-to-remote");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-label", "Copy selected to remote (0 items)");
  });

  it("is disabled when remote directory is not known", () => {
    render(
      <ExplorerTransferActions
        localSelectedCount={2}
        hasRemoteDir={false}
        busy={false}
        onCopyToRemote={() => {}}
      />,
    );

    const btn = screen.getByTestId("explorer-copy-to-remote");
    expect(btn).toBeDisabled();
  });

  it("is disabled and displays aria-busy when busy is true", () => {
    render(
      <ExplorerTransferActions
        localSelectedCount={2}
        hasRemoteDir={true}
        busy={true}
        onCopyToRemote={() => {}}
      />,
    );

    const btn = screen.getByTestId("explorer-copy-to-remote");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
  });

  it("renders reverse copy-to-local button when onCopyToLocal is provided", () => {
    const onCopyToLocal = vi.fn();
    render(
      <ExplorerTransferActions
        localSelectedCount={1}
        remoteSelectedCount={4}
        hasRemoteDir={true}
        hasLocalDir={true}
        busy={false}
        onCopyToRemote={() => {}}
        onCopyToLocal={onCopyToLocal}
      />,
    );

    const localBtn = screen.getByTestId("explorer-copy-to-local");
    expect(localBtn).toBeInTheDocument();
    expect(localBtn).not.toBeDisabled();
    expect(localBtn).toHaveAttribute("aria-label", "Copy selected to local (4 items)");

    fireEvent.click(localBtn);
    expect(onCopyToLocal).toHaveBeenCalledTimes(1);
  });
});
