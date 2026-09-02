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

export interface MigrationPreflightSummary {
  migratable: number;
  alreadyInVault: number;
  nonMigratable: number;
}

export interface BulkMigrationFailure {
  hostId: string;
  hostLabel: string;
  error: string;
}

export interface BulkMigrationResult {
  migrated: number;
  skipped: number;
  failed: BulkMigrationFailure[];
}
