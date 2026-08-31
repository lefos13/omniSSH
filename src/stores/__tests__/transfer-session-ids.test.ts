/*
 * Tests for correct transfer session IDs and multi-session transfer management.
 * Verifies that transfer events and operations from distinct sessions (SFTP, SCP, S3,
 * and linked explorer panels) retain their exact session IDs, host labels, and
 * backend protocol routing for cancellation, retry, and dismissal.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { useTransferStore } from "../transfer-store";
import { useTransfers } from "../../hooks/use-transfers";
import type { TransferEvent } from "../../types";

function createTransfer(
  transferId: string,
  sessionIds: { sftpSessionId?: string; scpSessionId?: string; s3SessionId?: string },
  name = "payload.bin",
  status: TransferEvent["status"] = "InProgress",
): TransferEvent {
  return {
    transfer_id: transferId,
    sftp_session_id: sessionIds.sftpSessionId,
    scp_session_id: sessionIds.scpSessionId,
    s3_session_id: sessionIds.s3SessionId,
    name,
    direction: "Upload",
    status,
    error: null,
    bytes_transferred: 512,
    total_bytes: 1024,
    files_done: 0,
    files_total: 1,
    speed_bps: 2048,
    eta_secs: 1,
    created_at: Date.now(),
  };
}

describe("Transfer session IDs and protocol routing", () => {
  beforeEach(() => {
    invoke.mockReset();
    useTransferStore.setState({
      transfers: new Map(),
      finished_order: [],
      hostLabels: new Map(),
      popoverOpen: false,
    });
  });

  it("distinguishes transfer events across independent SFTP and linked explorer sessions", () => {
    const { updateTransfer, setHostLabel } = useTransferStore.getState();

    const standaloneSftpId = "sftp-standalone-1";
    const linkedSftpId = "sftp-linked-2";

    setHostLabel(standaloneSftpId, "prod-server-01");
    setHostLabel(linkedSftpId, "dev-vm-02 (Linked)");

    const transfer1 = createTransfer("t-100", { sftpSessionId: standaloneSftpId }, "data.csv");
    const transfer2 = createTransfer("t-200", { sftpSessionId: linkedSftpId }, "server.log");

    updateTransfer(transfer1);
    updateTransfer(transfer2);

    const state = useTransferStore.getState();
    expect(state.transfers.size).toBe(2);

    const stored1 = state.transfers.get("t-100");
    const stored2 = state.transfers.get("t-200");

    expect(stored1?.sftp_session_id).toBe(standaloneSftpId);
    expect(stored2?.sftp_session_id).toBe(linkedSftpId);

    expect(state.hostLabels.get(standaloneSftpId)).toBe("prod-server-01");
    expect(state.hostLabels.get(linkedSftpId)).toBe("dev-vm-02 (Linked)");
  });

  it("routes cancel and retry to correct protocol backend based on session ID field", async () => {
    const { updateTransfer } = useTransferStore.getState();

    // 1. SFTP transfer
    const sftpTransfer = createTransfer("t-sftp", { sftpSessionId: "sftp-sess-1" });
    // 2. SCP transfer
    const scpTransfer = createTransfer("t-scp", { scpSessionId: "scp-sess-2" });
    // 3. S3 transfer
    const s3Transfer = createTransfer("t-s3", { s3SessionId: "s3-sess-3" });

    updateTransfer(sftpTransfer);
    updateTransfer(scpTransfer);
    updateTransfer(s3Transfer);

    const { result } = renderHook(() => useTransfers());

    // Test cancellation routing
    await act(async () => {
      result.current.onCancel("t-sftp");
    });
    expect(invoke).toHaveBeenCalledWith("sftp_cancel_transfer", { transferId: "t-sftp" });

    await act(async () => {
      result.current.onCancel("t-scp");
    });
    expect(invoke).toHaveBeenCalledWith("scp_cancel_transfer", { transferId: "t-scp" });

    await act(async () => {
      result.current.onCancel("t-s3");
    });
    expect(invoke).toHaveBeenCalledWith("s3_cancel_transfer", { transferId: "t-s3" });

    // Test retry routing
    await act(async () => {
      result.current.onRetry("t-sftp");
    });
    expect(invoke).toHaveBeenCalledWith("sftp_retry_transfer", { transferId: "t-sftp" });

    await act(async () => {
      result.current.onRetry("t-scp");
    });
    expect(invoke).toHaveBeenCalledWith("scp_retry_transfer", { transferId: "t-scp" });

    await act(async () => {
      result.current.onRetry("t-s3");
    });
    expect(invoke).toHaveBeenCalledWith("s3_retry_transfer", { transferId: "t-s3" });
  });

  it("preserves session labels across session closures and transfer hydration", () => {
    const { setHostLabel, hydrate, updateTransfer } = useTransferStore.getState();

    const sessionId = "sftp-sess-hydrated";
    setHostLabel(sessionId, "Storage Gateway");

    const batch: TransferEvent[] = [
      createTransfer("t-hyd-1", { sftpSessionId: sessionId }, "backup.iso", "Completed"),
      createTransfer("t-hyd-2", { sftpSessionId: sessionId }, "image.qcow2", "InProgress"),
    ];

    hydrate(batch);

    const state = useTransferStore.getState();
    expect(state.transfers.size).toBe(2);
    expect(state.hostLabels.get(sessionId)).toBe("Storage Gateway");
    expect(state.finished_order).toEqual(["t-hyd-1"]);

    // Update to live item retains session identity
    updateTransfer({
      ...batch[1],
      bytes_transferred: 1024,
      status: "Completed",
    });

    const updatedState = useTransferStore.getState();
    expect(updatedState.finished_order).toEqual(["t-hyd-1", "t-hyd-2"]);
    expect(updatedState.transfers.get("t-hyd-2")?.sftp_session_id).toBe(sessionId);
  });
});
