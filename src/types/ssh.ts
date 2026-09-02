export type SessionId = string;
import type { CredentialStorage } from "./vault";

export type AuthMethod =
  | { type: "password"; password: string }
  | { type: "privateKey"; key_path: string; passphrase?: string }
  | { type: "privateKeyData"; key_data: string; passphrase?: string };

export interface HostConfig {
  host: string;
  port: number;
  username: string;
  auth_method: AuthMethod;
  label?: string;
  keep_alive_interval?: number;
  default_shell?: string;
  startup_command?: string;
}

export type ConnectionStatus =
  | "Connecting"
  | "Connected"
  | "Disconnecting"
  | "Disconnected"
  | "Error";

export interface Session {
  id: SessionId;
  hostConfig: HostConfig;
  status: ConnectionStatus;
  statusMessage?: string;
  label: string;
  remoteCwd?: string | null;
  cwdSyncActive?: boolean;
}

export interface SshOutputPayload {
  session_id: string;
  data: number[];
}

export interface SshStatusPayload {
  session_id: string;
  status: { status: ConnectionStatus; message?: string };
}

export interface HostGroup {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  sort_order: number;
  default_username: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedHost {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  auth_type: string; // "password" | "privateKey" | "privateKeyData"
  /** Non-secret credential route; absent legacy values are treated as Keychain. */
  credential_storage?: import("./vault").CredentialStorage;
  group_id: string | null;
  created_at: string;
  updated_at: string;
  // Extended fields
  key_path: string | null;
  color: string | null;
  notes: string | null;
  environment: string | null;          // "production" | "staging" | "dev" | "testing"
  os_type: string | null;              // "linux" | "macos" | "windows" | "freebsd"
  startup_command: string | null;
  proxy_jump: string | null;
  /** Id of another saved host to tunnel through (ProxyJump). */
  proxy_jump_host_id: string | null;
  /** Initial remote directory the file browser opens in (falls back to home). */
  start_directory: string | null;
  keep_alive_interval: number | null;
  default_shell: string | null;
  font_size: number | null;
  last_connected_at: string | null;
  connection_count: number | null;
}

export interface RecentConnection {
  host_id: string;
  host_label: string;
  host: string;
  port: number;
  username: string;
  connected_at: string;
}

export interface ConnectionHistoryEntry {
  id: number;
  host_id: string;
  host_label: string;
  host: string;
  port: number;
  username: string;
  connected_at: string;
}

export interface SshKeyInfo {
  name: string;
  path: string;
  algorithm: string;
  fingerprint: string;
  has_passphrase: boolean;
}

// ─── Host health check ──────────────────────────────────────────────────────

/** Mirrors the Rust `HostHealthStatus` enum (serde camelCase). */
export type HostHealthStatus = "reachable" | "dnsFailed" | "portClosed" | "sshFailed";

/** Result of `ssh_health_check_saved_host`. Mirrors the Rust struct. */
export interface HostHealthCheckResult {
  status: HostHealthStatus;
  message: string;
  latencyMs: number | null;
}

/* OpenSSH and MobaXterm previews share one additive contract so the React
 * importer can preserve metadata while Rust remains the only file parser. */
// ─── SSH Config Import ────────────────────────────────────────────────────────

export interface SshConfigEntry {
  host_alias: string;
  hostname: string | null;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  proxy_jump: string | null;
  keep_alive_interval: number | null;
  is_pattern: boolean;
  already_exists: boolean;
  groupPath?: string | null;
  group_path?: string | null;
  startupCommand?: string | null;
  startup_command?: string | null;
  notes?: string | null;
  warnings?: string[];
  startDirectory?: string | null;
  start_directory?: string | null;
}

export type MobaXtermEntry = SshConfigEntry;

export interface SshConfigImportEntry {
  host_alias: string;
  hostname: string;
  user: string;
  port: number;
  identity_file?: string | null;
  proxy_jump?: string | null;
  keep_alive_interval?: number | null;
  groupPath?: string | null;
  group_path?: string | null;
  startupCommand?: string | null;
  startup_command?: string | null;
  notes?: string | null;
  startDirectory?: string | null;
  start_directory?: string | null;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/* Termius IPC exposes only bounded metadata and opaque identifiers. Credential
 * material is deliberately absent from these frontend contracts and remains
 * inside the Rust preview/commit workflow. */
export interface TermiusPreviewRequest {
  source_path?: string | null;
  metadata_only: boolean;
}

export interface TermiusCommitRequest {
  preview_token: string;
  selected_ids: string[];
  include_credentials: boolean;
  credentials_confirmed: boolean;
  credential_storage: CredentialStorage;
}

export interface TermiusHostPreview {
  id: string;
  label: string;
  address: string;
  username: string;
  port: number;
  group_id: string | null;
  notes: string | null;
  startup_command: string | null;
  start_directory: string | null;
  key_path: string | null;
  proxy: string | null;
  credential_available: boolean;
  has_password: boolean;
  has_private_key: boolean;
  already_exists: boolean;
  warnings: string[];
}

export interface TermiusGroupPreview {
  id: string;
  name: string;
  host_count: number;
}

export interface TermiusPreviewCounts {
  hosts: number;
  groups: number;
  credential_available: number;
  already_exists: number;
}

export interface TermiusPreviewResponse {
  preview_token: string;
  metadata_only: boolean;
  hosts: TermiusHostPreview[];
  groups: TermiusGroupPreview[];
  counts: TermiusPreviewCounts;
  warnings: string[];
}

export interface TermiusCommitResponse {
  imported_hosts: number;
  imported_groups: number;
  skipped_hosts: number;
  credentials_stored: number;
  credentials_in_vault: number;
  credentials_in_keychain: number;
  warnings: string[];
}

export interface TermiusImportError {
  kind: string;
  message: string;
}

export type StoredCredential =
  | { type: "Password"; password: string }
  | { type: "KeyPassphrase"; passphrase: string };
