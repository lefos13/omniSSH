/* The verification modal is the safety gate for tracker actions: the
 * displayed command must equal the invoked command, and cancel must invoke
 * nothing. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActionVerificationModal } from "./ActionVerificationModal";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const ACTION = { command: "docker restart 'web'", label: "Restart container", hostLabel: "prod-1" };

describe("ActionVerificationModal", () => {
  beforeEach(() => invokeMock.mockReset());

  it("displays the exact command for review", () => {
    render(<ActionVerificationModal action={ACTION} sessionId="s1" onClose={() => {}} onExecuted={() => {}} />);
    expect(screen.getByTestId("action-verification-command")).toHaveTextContent("docker restart 'web'");
  });

  it("confirm invokes exactly the displayed string", async () => {
    invokeMock.mockResolvedValue({ stdout: "web\n", stderr: "", exitCode: 0 });
    const onExecuted = vi.fn();
    render(<ActionVerificationModal action={ACTION} sessionId="s1" onClose={() => {}} onExecuted={onExecuted} />);
    fireEvent.click(screen.getByTestId("action-verification-confirm"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith("ssh_exec_command", { sessionId: "s1", command: "docker restart 'web'" });
    expect(onExecuted).toHaveBeenCalledWith("web\n");
  });

  it("cancel invokes nothing", () => {
    const onClose = vi.fn();
    render(<ActionVerificationModal action={ACTION} sessionId="s1" onClose={onClose} onExecuted={() => {}} />);
    fireEvent.click(screen.getByTestId("action-verification-cancel"));
    expect(invokeMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces a non-zero exit as an error without closing", async () => {
    invokeMock.mockResolvedValue({ stdout: "", stderr: "no such container", exitCode: 1 });
    const onClose = vi.fn();
    render(<ActionVerificationModal action={ACTION} sessionId="s1" onClose={onClose} onExecuted={() => {}} />);
    fireEvent.click(screen.getByTestId("action-verification-confirm"));
    await waitFor(() => expect(screen.getByTestId("action-verification-error")).toHaveTextContent("no such container"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
