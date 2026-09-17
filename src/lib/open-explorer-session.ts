/*
 * Open an explorer (SFTP/SCP) session for a saved host.
 *
 * Shared by the dashboard's "Explorer" action and the explorer's left-pane
 * host picker. Connects a bare (no-PTY) SSH session and opens a file channel on
 * it, preferring SFTP and transparently falling back to SCP when the server has
 * the SFTP subsystem disabled — the user never picks a transport.
 *
 * The bare connection exists only for the explorer, so Rust owns its lifetime
 * (`ownsSsh: true`) and releases it with the final channel.
 */

import type { Transport } from "./explorer-transport";
import { closeExplorerSession } from "./explorer-transport";

export interface OpenedExplorerSession {
  /** SFTP/SCP session id to register in the sftp store. */
  sftpSessionId: string;
  /** Underlying no-PTY SSH session id. */
  sshSessionId: string;
  transport: Transport;
}

export interface OpenExplorerOptions {
  /** Caller-generated attempt id so an in-flight connect can be cancelled. */
  attemptId: string;
  /** Polled at each step; when true the partial connection is torn down. */
  isCancelled?: () => boolean;
}

/**
 * Resolves to the opened session, or `null` when the attempt was cancelled
 * mid-flight (in which case everything opened so far has been released).
 */
export async function openExplorerSessionForHost(
  hostId: string,
  options: OpenExplorerOptions,
): Promise<OpenedExplorerSession | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const cancelled = () => options.isCancelled?.() ?? false;

  const sshSessionId = await invoke<string>("connect_saved_host_no_pty", {
    hostId,
    attemptId: options.attemptId,
  });
  if (cancelled()) {
    // The handshake settled before the cancel landed — drop the bare
    // connection, otherwise nothing references it again.
    void invoke("ssh_disconnect", { sessionId: sshSessionId });
    return null;
  }

  let sftpSessionId: string;
  let transport: Transport = "sftp";
  try {
    sftpSessionId = await invoke<string>("sftp_open", { sessionId: sshSessionId, ownsSsh: true });
  } catch (sftpErr) {
    try {
      sftpSessionId = await invoke<string>("scp_open", { sessionId: sshSessionId, ownsSsh: true });
      transport = "scp";
    } catch {
      // Both transports failed — release the connection and surface the
      // original SFTP error, which is the more actionable one.
      void invoke("ssh_disconnect", { sessionId: sshSessionId });
      throw sftpErr;
    }
  }

  if (cancelled()) {
    // Cancel landed while the explorer channel was opening — drop the explorer
    // session and the connection beneath it.
    void closeExplorerSession(transport, sftpSessionId);
    void invoke("ssh_disconnect", { sessionId: sshSessionId });
    return null;
  }

  return { sftpSessionId, sshSessionId, transport };
}
