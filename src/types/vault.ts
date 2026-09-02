/* IPC-only local-vault contracts carry status and short-lived user input.
 * Host credential location is persisted by Rust and intentionally is not
 * duplicated in browser storage. */

export interface LocalVaultStatus {
  configured: boolean;
  unlocked: boolean;
}

export interface BackupPreflightSummary {
  keychainHostCandidates: number;
  localVaultHosts: number;
  s3Candidates: number;
}

export type CredentialStorage = "keychain" | "localVault";
