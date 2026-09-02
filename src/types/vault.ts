/* IPC-only local-vault contracts carry status and short-lived user input.
 * Host credential location is persisted by Rust and intentionally is not
 * duplicated in browser storage. */

export interface LocalVaultStatus {
  configured: boolean;
  unlocked: boolean;
}

export type CredentialStorage = "keychain" | "localVault";
