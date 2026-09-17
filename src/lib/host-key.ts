/*
 * Stable identity keys for per-host frontend state.
 *
 * Saved hosts key off their persisted id so history survives address edits and
 * renames. Quick (unsaved) connections fall back to the connection address,
 * which is the only stable identity they have.
 */

export function hostKeyFor(options: {
  savedHostId?: string | null;
  username: string;
  host: string;
  port: number;
}): string {
  if (options.savedHostId) return `host:${options.savedHostId}`;
  return `addr:${options.username}@${options.host}:${options.port}`;
}

/** Key for an S3 connection, which is identified by its saved connection id. */
export function s3HostKey(connectionId: string): string {
  return `s3:${connectionId}`;
}

/**
 * Explorer sessions carry the saved host id (and the owning SSH session id as a
 * fallback), so they resolve to the same key as the terminal session for that
 * host and share one recent-path history.
 */
export function explorerHostKey(session: {
  savedHostId?: string;
  sshSessionId: string;
}): string {
  return session.savedHostId ? `host:${session.savedHostId}` : `ssh:${session.sshSessionId}`;
}
