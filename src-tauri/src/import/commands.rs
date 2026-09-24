use std::collections::HashSet;
use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use crate::db::{CredentialStorage, DbError, HostDb, HostGroup, SavedHost};
use crate::types::SshError;
use crate::vault::{LocalVault, StoredCredential, VaultError};

use super::password_file::ParsedPasswordFile;
use super::{
    ImportResult, MobaXtermEntry, PasswordFileFailure, PasswordFileMatch, PasswordFilePreview,
    PasswordFileSaveResult, PasswordFileStatus, SshConfigEntry, SshConfigImportEntry,
};

/// Parse SSH config and return a preview of importable hosts.
#[tauri::command]
/* Do not instrument user-selected paths or parsed host configuration. */
#[instrument(skip(path, db))]
pub async fn import_parse_ssh_config(
    path: Option<String>,
    db: State<'_, Arc<HostDb>>,
) -> Result<Vec<SshConfigEntry>, SshError> {
    let db = Arc::clone(&db);

    task::spawn_blocking(move || {
        // Get existing hosts for duplicate detection
        let existing = existing_host_keys(&db)?;

        super::parse_ssh_config(path.as_deref(), &existing)
    })
    .await
    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
}

/* Save a batch of imported host entries into the database.
 * Resolves optional group paths against existing HostGroups or creates
 * new ones (cached to prevent duplicate group creation within a run),
 * maps startup commands and notes, and resolves single-hop ProxyJump targets. */
pub fn save_imported_hosts(
    db: &HostDb,
    entries: &[SshConfigImportEntry],
    credential_storage: Option<crate::db::CredentialStorage>,
) -> Result<ImportResult, DbError> {
    let mut imported = 0u32;
    let mut skipped = 0u32;
    let mut errors = Vec::new();

    /* Enforce the import contract at the persistence boundary as well as in
     * the preview parser. This keeps repeated or concurrently selected
     * entries from creating duplicate hosts when a caller bypasses the UI. */
    let existing_keys = db
        .list_hosts()?
        .into_iter()
        .map(|host| (host.host, host.username, host.port))
        .collect::<HashSet<_>>();
    let mut seen_import_keys = HashSet::new();

    // Group name → group id cache for the import run.
    // Seeded with pre-existing groups so identical group paths reuse existing groups.
    let mut group_cache: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let existing_groups = db.list_groups()?;
    let mut next_sort_order: i32 = existing_groups
        .iter()
        .map(|g| g.sort_order)
        .max()
        .map_or(0, |m| m + 1);
    for g in existing_groups {
        group_cache.insert(g.name, g.id);
    }

    // alias (Host block name) → generated host id, for ProxyJump resolution.
    let mut alias_to_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    // (host id, alias, raw ProxyJump value) tuples that still need resolving.
    let mut pending_jumps: Vec<(String, String, String)> = Vec::new();

    for entry in entries {
        let dedup_key = (entry.hostname.clone(), entry.user.clone(), entry.port);
        if existing_keys.contains(&dedup_key) || !seen_import_keys.insert(dedup_key.clone()) {
            skipped += 1;
            continue;
        }

        let now = timestamp_now();
        let id = uuid::Uuid::new_v4().to_string();

        /* Resolve an optional group_path to a HostGroup ID. If the group
         * already exists in the database or was created earlier in this
         * import run, reuse its ID. Otherwise, create a new HostGroup with
         * default visual settings and append it after existing groups. */
        let group_id = match entry
            .group_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(group_name) => {
                if let Some(cached_id) = group_cache.get(group_name) {
                    Some(cached_id.clone())
                } else {
                    let new_group_id = uuid::Uuid::new_v4().to_string();
                    let group = HostGroup {
                        id: new_group_id.clone(),
                        name: group_name.to_string(),
                        color: "#6366f1".to_string(),
                        icon: Some("Folder".to_string()),
                        sort_order: next_sort_order,
                        default_username: None,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    };
                    match db.create_group(&group) {
                        Ok(()) => {
                            next_sort_order += 1;
                            group_cache.insert(group_name.to_string(), new_group_id.clone());
                            Some(new_group_id)
                        }
                        Err(e) => {
                            errors
                                .push(format!("{}: group creation failed: {e}", entry.host_alias));
                            None
                        }
                    }
                }
            }
            None => None,
        };

        let auth_type = if entry.identity_file.is_some() {
            "privateKey".to_string()
        } else {
            "password".to_string()
        };
        let storage = if auth_type == "password" {
            credential_storage.unwrap_or_default()
        } else {
            Default::default()
        };

        let host = SavedHost {
            id: id.clone(),
            label: entry.host_alias.clone(),
            host: entry.hostname.clone(),
            port: entry.port as _,
            username: entry.user.clone(),
            auth_type,
            credential_storage: storage,
            key_path: entry.identity_file.clone(),
            group_id,
            color: None,
            notes: entry.notes.clone(),
            environment: None,
            os_type: None,
            startup_command: entry.startup_command.clone(),
            proxy_jump: entry.proxy_jump.clone(),
            proxy_jump_host_id: None,
            start_directory: entry.start_directory.clone(),
            keep_alive_interval: entry.keep_alive_interval,
            default_shell: None,
            font_size: None,
            terminal_theme: None,
            last_connected_at: None,
            connection_count: None,
            created_at: now.clone(),
            updated_at: now,
        };

        match db.save_host(&host) {
            Ok(()) => {
                imported += 1;
                alias_to_id.insert(entry.host_alias.clone(), id.clone());
                if let Some(pj) = entry.proxy_jump.as_ref().filter(|s| !s.trim().is_empty()) {
                    pending_jumps.push((id, entry.host_alias.clone(), pj.clone()));
                }
            }
            Err(e) => {
                seen_import_keys.remove(&dedup_key);
                errors.push(format!("{}: {e}", entry.host_alias));
                skipped += 1;
            }
        }
    }

    // Second pass: resolve each parsed ProxyJump value against the imported
    // (and pre-existing) hosts, then link via proxy_jump_host_id. Matching is
    // best-effort — an unresolved jump simply leaves the free-text proxy_jump
    // field in place without breaking the import. Linking goes through the
    // *validated* setter so a config with mutually-referencing ProxyJump
    // directives (A→B, B→A) can never persist a connect-breaking cycle.
    let existing_hosts = db.list_hosts()?;
    for (host_id, alias, jump_value) in pending_jumps {
        // Multi-hop chains (`jump1,jump2`) are retained as free-text but not
        // auto-linked: a single proxy_jump_host_id can't express the chain,
        // and guessing which hop is adjacent to the target risks a wrong link.
        if jump_value.contains(',') {
            continue;
        }
        let Some(jump_id) = resolve_jump_target(&jump_value, &alias_to_id, &existing_hosts) else {
            continue;
        };
        match db.set_proxy_jump_host_validated(&host_id, &jump_id) {
            Ok(()) => {}
            // A self-reference / cycle is an expected best-effort skip; only
            // surface genuine write failures so they aren't silently lost.
            Err(DbError::Validation(_)) => {}
            Err(e) => errors.push(format!("{alias}: tunnel link not created: {e}")),
        }
    }

    Ok(ImportResult {
        imported,
        skipped,
        errors,
    })
}

/// Save selected SSH config entries as SavedHosts.
#[tauri::command]
/* Imported entries can contain hosts, commands, credentials, and key paths. */
#[instrument(skip(entries, db))]
pub async fn import_save_ssh_hosts(
    entries: Vec<SshConfigImportEntry>,
    credential_storage: Option<crate::db::CredentialStorage>,
    db: State<'_, Arc<HostDb>>,
) -> Result<ImportResult, DbError> {
    save_imported_hosts_command(entries, credential_storage, Arc::clone(&db)).await
}

/// Parse a MobaXterm `.mxtsessions` or `MobaXterm.ini` file and return a
/// preview using the same host-entry contract as OpenSSH imports.
#[tauri::command]
/* Keep native file access and parsing in Rust; the UI receives only the
 * bounded, version-tolerant preview representation. */
#[instrument(skip(path, db))]
pub async fn import_parse_mobaxterm(
    path: String,
    db: State<'_, Arc<HostDb>>,
) -> Result<Vec<MobaXtermEntry>, SshError> {
    let db = Arc::clone(&db);

    task::spawn_blocking(move || {
        let existing = existing_host_keys(&db)?;

        super::parse_mobaxterm(&path, &existing)
    })
    .await
    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
}

/// Save selected MobaXterm entries as SavedHosts through the shared import
/// persistence contract.
#[tauri::command]
/* MobaXterm previews can carry key paths, startup commands, notes, and proxy
 * provenance, so the command span must contain counts only. */
#[instrument(skip(entries, db))]
pub async fn import_save_mobaxterm_hosts(
    entries: Vec<SshConfigImportEntry>,
    credential_storage: Option<crate::db::CredentialStorage>,
    db: State<'_, Arc<HostDb>>,
) -> Result<ImportResult, DbError> {
    save_imported_hosts_command(entries, credential_storage, Arc::clone(&db)).await
}

/// Preview which saved hosts a password file matches.
#[tauri::command]
/* The password file contains plaintext passwords, so the command span skips the path
 * and the response carries host ids, labels, and statuses only. */
#[instrument(skip(path, db))]
pub async fn import_preview_password_file(
    path: String,
    db: State<'_, Arc<HostDb>>,
) -> Result<PasswordFilePreview, SshError> {
    let db = Arc::clone(&db);

    task::spawn_blocking(move || {
        let parsed = super::password_file::read_password_file(&path)?;

        /* The keychain probe is prompt-free: it asks the OS whether the item
         * exists rather than reading the secret behind it. */
        preview_password_file(&db, &parsed, |host_id| {
            crate::vault::credential_exists(host_id).unwrap_or(false)
        })
    })
    .await
    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
}

/* Match a parsed password file against saved hosts.
 *
 * A `user@host` entry satisfies every saved host with that host
 * (case-insensitive) and username, on any port, so one entry can produce
 * several rows. Keys in the file twice with different passwords are
 * conflicts: they never surface as matches, and the count explains why a host
 * the user expected is missing instead of silently writing nothing. */
pub fn preview_password_file(
    db: &HostDb,
    parsed: &ParsedPasswordFile,
    keychain_has: impl Fn(&str) -> bool,
) -> Result<PasswordFilePreview, SshError> {
    let hosts = db
        .list_hosts()
        .map_err(|error| SshError::IoError(format!("Cannot read saved hosts: {error}")))?;

    /* Entries are unique per (user, host) after parsing, so a key set is enough
     * to tell which entries matched no saved host. */
    let mut matched_entry_keys: HashSet<(String, String)> = HashSet::new();
    let mut matches: Vec<PasswordFileMatch> = Vec::new();

    for host in &hosts {
        if parsed.is_conflict(&host.username, &host.host) {
            continue;
        }
        let Some(entry) = parsed.find(&host.username, &host.host) else {
            continue;
        };
        matched_entry_keys.insert((entry.user.clone(), entry.host.to_ascii_lowercase()));

        let status = if host.auth_type != "password" {
            PasswordFileStatus::KeyAuth
        } else {
            let has_stored_password = match host.credential_storage {
                CredentialStorage::LocalVault => db
                    .get_local_vault_credential(&host.id)
                    .map_err(|error| {
                        SshError::IoError(format!("Cannot read saved hosts: {error}"))
                    })?
                    .is_some(),
                CredentialStorage::Keychain => keychain_has(&host.id),
            };
            if has_stored_password {
                PasswordFileStatus::Replaces
            } else {
                PasswordFileStatus::New
            }
        };

        matches.push(PasswordFileMatch {
            host_id: host.id.clone(),
            host_label: host.label.clone(),
            username: host.username.clone(),
            host: host.host.clone(),
            port: host.port,
            storage: host.credential_storage,
            status,
        });
    }

    matches.sort_by(|a, b| {
        a.host_label
            .cmp(&b.host_label)
            .then_with(|| a.port.cmp(&b.port))
    });

    let unmatched_entries = parsed
        .entries
        .iter()
        .filter(|entry| {
            !matched_entry_keys.contains(&(entry.user.clone(), entry.host.to_ascii_lowercase()))
        })
        .count() as u32;

    Ok(PasswordFilePreview {
        matches,
        unmatched_entries,
        conflicts: parsed.conflicts.len() as u32,
        malformed_lines: parsed.malformed_lines.len() as u32,
    })
}

/// Save passwords from a password file into each selected host's storage.
#[tauri::command]
/* The password file holds plaintext passwords, so the command span skips the path, the
 * host id list, and the managed state, and the response reports per-host
 * outcomes without any secret. */
#[instrument(skip(path, host_ids, db, local_vault))]
pub async fn import_save_password_file(
    path: String,
    host_ids: Vec<String>,
    db: State<'_, Arc<HostDb>>,
    local_vault: State<'_, Arc<LocalVault>>,
) -> Result<PasswordFileSaveResult, SshError> {
    let db = Arc::clone(&db);
    let local_vault = Arc::clone(&local_vault);

    task::spawn_blocking(move || {
        let parsed = super::password_file::read_password_file(&path)?;
        save_password_file(&db, &parsed, &host_ids, &KeychainSink, &local_vault)
    })
    .await
    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
}

/* The keychain destination is a parameter rather than a direct call so a test
 * can inject a failing store; the App Vault takes the managed vault directly
 * because its write needs the session key and the database. */
pub(crate) trait PasswordSink {
    fn save(&self, host_id: &str, credential: &StoredCredential) -> Result<(), VaultError>;
}

/// Writes to the OS keychain, overwriting any existing entry for the host.
struct KeychainSink;

impl PasswordSink for KeychainSink {
    fn save(&self, host_id: &str, credential: &StoredCredential) -> Result<(), VaultError> {
        crate::vault::save_credential(host_id, credential)
    }
}

/* Write a matched password file into the storage each selected host is
 * already configured for.
 *
 * The file is re-parsed by the caller, so only hosts that still match a
 * password-auth host by username and host are written; everything else is
 * counted as skipped. Writes are best-effort per host: a failing store records
 * a failure and the remaining hosts still run, which keeps a locked App Vault
 * from blocking keychain-configured hosts in the same run. The host's stored
 * `credential_storage` marker is never changed — each destination writes the
 * storage that marker already points at, and neither falls back to the other. */
pub(crate) fn save_password_file(
    db: &HostDb,
    parsed: &ParsedPasswordFile,
    host_ids: &[String],
    keychain: &impl PasswordSink,
    local_vault: &LocalVault,
) -> Result<PasswordFileSaveResult, SshError> {
    let mut result = PasswordFileSaveResult {
        stored_in_keychain: 0,
        stored_in_vault: 0,
        skipped: 0,
        failed: Vec::new(),
    };
    let mut visited: HashSet<&str> = HashSet::new();

    for host_id in host_ids {
        /* A repeated id would write the same host twice and inflate the counts;
         * the first pass already decided its outcome. */
        if !visited.insert(host_id.as_str()) {
            continue;
        }

        let host = match db.get_host(host_id) {
            Ok(Some(host)) => host,
            Ok(None) => {
                result.skipped += 1;
                continue;
            }
            Err(error) => {
                result.failed.push(PasswordFileFailure {
                    host_id: host_id.clone(),
                    host_label: host_id.clone(),
                    error: error.to_string(),
                });
                continue;
            }
        };

        /* Key-auth hosts cannot take a password, and a key the parser dropped
         * as a conflict has no password left to write. */
        if host.auth_type != "password" || parsed.is_conflict(&host.username, &host.host) {
            result.skipped += 1;
            continue;
        }

        /* An entry that no longer matches this host — the file changed between
         * preview and save — must not write an unrelated password. */
        let Some(entry) = parsed.find(&host.username, &host.host) else {
            result.skipped += 1;
            continue;
        };

        /* One plaintext copy serves whichever store this host uses. It is
         * dropped as soon as the destination returns: `StoredCredential`
         * zeroizes on drop, so the secret never outlives the write instead of
         * being held for the rest of the loop. */
        let credential = StoredCredential::Password {
            password: entry.password.to_string(),
        };
        let outcome = match host.credential_storage {
            CredentialStorage::Keychain => keychain.save(&host.id, &credential),
            /* The vault encrypts in memory, upserts the ciphertext, and purges
             * any stale keychain copy. A locked vault fails here per host. */
            CredentialStorage::LocalVault => {
                crate::vault::store_host_credential_in_vault(db, local_vault, &host.id, &credential)
            }
        };
        drop(credential);

        match outcome {
            Ok(()) => {
                if host.credential_storage == CredentialStorage::Keychain {
                    result.stored_in_keychain += 1;
                } else {
                    result.stored_in_vault += 1;
                }
            }
            Err(error) => result.failed.push(PasswordFileFailure {
                host_id: host.id.clone(),
                host_label: host.label.clone(),
                error: error.to_string(),
            }),
        }
    }

    Ok(result)
}

/* Keep source-specific IPC commands thin while preserving a single save path
 * for groups, metadata, ProxyJump linking, deduplication, and diagnostics. */
async fn save_imported_hosts_command(
    entries: Vec<SshConfigImportEntry>,
    credential_storage: Option<crate::db::CredentialStorage>,
    db: Arc<HostDb>,
) -> Result<ImportResult, DbError> {
    task::spawn_blocking(move || save_imported_hosts(&db, &entries, credential_storage))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/* Preview duplicate detection must fail closed when the host index cannot be
 * read; an empty fallback would make a broken database look importable. */
fn existing_host_keys(db: &HostDb) -> Result<Vec<(String, String, u16)>, SshError> {
    db.list_hosts()
        .map_err(|error| SshError::IoError(format!("Cannot read saved hosts: {error}")))
        .map(|hosts| {
            hosts
                .into_iter()
                .map(|host| (host.host, host.username, host.port))
                .collect()
        })
}

pub(crate) fn timestamp_now() -> String {
    format_timestamp(chrono::Utc::now())
}

fn format_timestamp(value: chrono::DateTime<chrono::Utc>) -> String {
    /* RFC 3339 UTC output keeps persisted timestamps comparable and delegates
     * leap-year/calendar behavior to the already-used chrono implementation. */
    value.format("%Y-%m-%dT%H:%M:%S.000Z").to_string()
}

/// Resolve a single-hop `ProxyJump` directive value to a saved-host id.
///
/// SSH config ProxyJump values come in several shapes: a bare `Host` alias
/// (`database`), `user@host`, or `user@host:port`. Resolution order:
///
///   1. an exact alias match among the just-imported hosts (this run) — first on
///      the raw value, then on the normalised token (with any `user@`/`:port`
///      stripped). Aliases are unique within a run, so these are unambiguous.
///   2. a *unique* label/hostname match among all saved hosts, comparing both the
///      raw value and the normalised token. If more than one distinct host
///      matches, the value is ambiguous and we return `None` rather than guess.
///
/// Returns `None` when nothing matches (or the match is ambiguous) — the import
/// then leaves the free-text `proxy_jump` field untouched.
fn resolve_jump_target(
    jump_value: &str,
    alias_to_id: &std::collections::HashMap<String, String>,
    existing_hosts: &[SavedHost],
) -> Option<String> {
    let value = jump_value.trim();

    // Normalised token: strip `user@` and `:port` (e.g. `admin@bastion:2222` → `bastion`).
    let without_user = value.rsplit('@').next().unwrap_or(value);
    let host_part = without_user.split(':').next().unwrap_or(without_user);

    // 1. Exact alias match among freshly imported hosts (unique within a run).
    if let Some(id) = alias_to_id.get(value) {
        return Some(id.clone());
    }
    if host_part != value {
        if let Some(id) = alias_to_id.get(host_part) {
            return Some(id.clone());
        }
    }

    // 2. Unique label/hostname match among all saved hosts. Collect distinct host
    //    ids so a collision (e.g. two accounts on one bastion sharing a hostname,
    //    or duplicate labels) is detected and skipped rather than silently
    //    linking the alphabetically-first host.
    let mut matched: Option<&str> = None;
    for h in existing_hosts {
        let is_match =
            h.label == value || h.label == host_part || h.host == host_part || h.host == value;
        if !is_match {
            continue;
        }
        match matched {
            None => matched = Some(&h.id),
            Some(existing) if existing == h.id => {}
            Some(_) => return None, // ambiguous — more than one distinct host matches
        }
    }

    matched.map(|id| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::collections::HashMap;

    /// Minimal SavedHost for resolution tests (only id/label/host are consulted).
    fn host(id: &str, label: &str, hostname: &str) -> SavedHost {
        SavedHost {
            id: id.to_string(),
            label: label.to_string(),
            host: hostname.to_string(),
            port: 22,
            username: "u".to_string(),
            auth_type: "password".to_string(),
            credential_storage: Default::default(),
            group_id: None,
            key_path: None,
            color: None,
            notes: None,
            environment: None,
            os_type: None,
            startup_command: None,
            proxy_jump: None,
            proxy_jump_host_id: None,
            start_directory: None,
            keep_alive_interval: None,
            default_shell: None,
            font_size: None,
            terminal_theme: None,
            last_connected_at: None,
            connection_count: None,
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
        }
    }

    fn aliases(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(a, id)| (a.to_string(), id.to_string()))
            .collect()
    }

    #[test]
    fn resolves_bare_alias_from_this_run() {
        let a = aliases(&[("bastion", "id-b")]);
        assert_eq!(
            resolve_jump_target("bastion", &a, &[]).as_deref(),
            Some("id-b")
        );
    }

    #[test]
    fn resolves_user_at_host_and_port_via_alias() {
        let a = aliases(&[("bastion", "id-b")]);
        assert_eq!(
            resolve_jump_target("admin@bastion", &a, &[]).as_deref(),
            Some("id-b")
        );
        assert_eq!(
            resolve_jump_target("admin@bastion:2222", &a, &[]).as_deref(),
            Some("id-b")
        );
    }

    #[test]
    fn resolves_label_and_hostname_among_existing() {
        let hosts = vec![host("id-1", "DB Box", "10.0.0.5")];
        // Label match (raw value).
        assert_eq!(
            resolve_jump_target("DB Box", &HashMap::new(), &hosts).as_deref(),
            Some("id-1")
        );
        // Hostname match after stripping user@ and :port.
        assert_eq!(
            resolve_jump_target("ops@10.0.0.5:22", &HashMap::new(), &hosts).as_deref(),
            Some("id-1")
        );
    }

    #[test]
    fn ambiguous_hostname_collision_returns_none() {
        // Two distinct hosts share a hostname — linking either would be a guess.
        let hosts = vec![
            host("id-1", "prod-a", "10.0.0.5"),
            host("id-2", "prod-b", "10.0.0.5"),
        ];
        assert_eq!(
            resolve_jump_target("10.0.0.5", &HashMap::new(), &hosts),
            None
        );
    }

    #[test]
    fn this_run_alias_wins_over_existing_label_collision() {
        let a = aliases(&[("x", "fresh")]);
        let hosts = vec![host("old", "x", "1.2.3.4")];
        assert_eq!(
            resolve_jump_target("x", &a, &hosts).as_deref(),
            Some("fresh")
        );
    }

    #[test]
    fn unmatched_value_returns_none() {
        assert_eq!(resolve_jump_target("nope", &HashMap::new(), &[]), None);
    }

    struct TestDb {
        db: HostDb,
        path: std::path::PathBuf,
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn test_db() -> TestDb {
        let dir = std::env::temp_dir().join(format!("anyscp_import_test_{}", uuid::Uuid::new_v4()));
        let db = HostDb::new(&dir).expect("HostDb::new");
        TestDb { db, path: dir }
    }

    fn sample_import_entry(alias: &str) -> SshConfigImportEntry {
        SshConfigImportEntry {
            host_alias: alias.to_string(),
            hostname: format!("{alias}.example.com"),
            user: "root".to_string(),
            port: 22,
            identity_file: None,
            proxy_jump: None,
            keep_alive_interval: None,
            group_path: None,
            startup_command: None,
            notes: None,
            start_directory: None,
        }
    }

    fn sample_group(id: &str, name: &str, sort_order: i32) -> HostGroup {
        HostGroup {
            id: id.to_string(),
            name: name.to_string(),
            color: "#6366f1".to_string(),
            icon: Some("Folder".to_string()),
            sort_order,
            default_username: None,
            created_at: "2026-01-01T00:00:00".to_string(),
            updated_at: "2026-01-01T00:00:00".to_string(),
        }
    }

    #[test]
    fn deduplicates_existing_and_repeated_import_keys() {
        let fixture = test_db();
        let existing = sample_import_entry("existing");
        save_imported_hosts(&fixture.db, &[existing], None).expect("save existing host");

        let mut duplicate = sample_import_entry("duplicate-label");
        duplicate.hostname = "existing.example.com".to_string();
        let mut repeated = duplicate.clone();
        repeated.host_alias = "repeated-label".to_string();
        let unique = sample_import_entry("unique");

        let result = save_imported_hosts(&fixture.db, &[duplicate, repeated, unique], None)
            .expect("save deduplicated entries");
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 2);
        assert!(result.errors.is_empty());
        assert_eq!(fixture.db.list_hosts().expect("list hosts").len(), 2);
    }

    /* A broken host index must abort the import before any rows are written;
     * silently treating the read as empty would defeat persistence dedup. */
    #[test]
    fn propagates_existing_host_read_errors() {
        let fixture = test_db();
        let connection =
            rusqlite::Connection::open(fixture.path.join("anyscp.db")).expect("open test database");
        connection
            .execute_batch("DROP TABLE saved_hosts")
            .expect("drop host table");

        let error = save_imported_hosts(&fixture.db, &[], None).expect_err("host read must fail");
        assert!(error.to_string().contains("no such table"));
    }

    /* A missing group index must stop the batch before a host is written;
     * falling back to an empty group list would lose the requested grouping. */
    #[test]
    fn propagates_group_index_errors_without_writing_hosts() {
        let fixture = test_db();
        let connection =
            rusqlite::Connection::open(fixture.path.join("anyscp.db")).expect("open test database");
        connection
            .execute_batch("DROP TABLE host_groups")
            .expect("drop group table");

        let mut entry = sample_import_entry("must-not-save");
        entry.group_path = Some("Imported".to_string());
        let error =
            save_imported_hosts(&fixture.db, &[entry], None).expect_err("group read must fail");

        assert!(error.to_string().contains("no such table"));
        assert!(fixture.db.list_hosts().expect("list hosts").is_empty());
    }

    #[test]
    fn two_hosts_sharing_group_path_creates_one_group_and_assigns_id() {
        let fixture = test_db();
        let mut h1 = sample_import_entry("web1");
        h1.group_path = Some("Production / Web".to_string());
        let mut h2 = sample_import_entry("web2");
        h2.group_path = Some("Production / Web".to_string());

        let result =
            save_imported_hosts(&fixture.db, &[h1, h2], None).expect("save_imported_hosts");
        assert_eq!(result.imported, 2);
        assert_eq!(result.skipped, 0);
        assert!(result.errors.is_empty());

        let groups = fixture.db.list_groups().expect("list_groups");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Production / Web");
        assert_eq!(groups[0].color, "#6366f1");
        assert_eq!(groups[0].icon.as_deref(), Some("Folder"));

        let hosts = fixture.db.list_hosts().expect("list_hosts");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].group_id.as_deref(), Some(groups[0].id.as_str()));
        assert_eq!(hosts[1].group_id.as_deref(), Some(groups[0].id.as_str()));
    }

    #[test]
    fn pre_existing_group_reused_not_duplicated() {
        let fixture = test_db();
        let existing = sample_group("grp-staging", "Staging", 0);
        fixture.db.create_group(&existing).expect("create_group");

        let mut h1 = sample_import_entry("stage1");
        h1.group_path = Some("Staging".to_string());

        let result = save_imported_hosts(&fixture.db, &[h1], None).expect("save_imported_hosts");
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 0);
        assert!(result.errors.is_empty());

        let groups = fixture.db.list_groups().expect("list_groups");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, "grp-staging");
        assert_eq!(groups[0].name, "Staging");

        let hosts = fixture.db.list_hosts().expect("list_hosts");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].group_id.as_deref(), Some("grp-staging"));
    }

    #[test]
    fn absent_group_path_leaves_group_id_none() {
        let fixture = test_db();
        let h1 = sample_import_entry("standalone");

        let result = save_imported_hosts(&fixture.db, &[h1], None).expect("save_imported_hosts");
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 0);

        let groups = fixture.db.list_groups().expect("list_groups");
        assert!(groups.is_empty());

        let hosts = fixture.db.list_hosts().expect("list_hosts");
        assert_eq!(hosts.len(), 1);
        assert!(hosts[0].group_id.is_none());
    }

    #[test]
    fn whitespace_group_path_treated_as_absent() {
        let fixture = test_db();
        let mut h1 = sample_import_entry("h1");
        h1.group_path = Some("   ".to_string());
        let mut h2 = sample_import_entry("h2");
        h2.group_path = Some("".to_string());

        let result =
            save_imported_hosts(&fixture.db, &[h1, h2], None).expect("save_imported_hosts");
        assert_eq!(result.imported, 2);

        let groups = fixture.db.list_groups().expect("list_groups");
        assert!(groups.is_empty());

        let hosts = fixture.db.list_hosts().expect("list_hosts");
        assert_eq!(hosts.len(), 2);
        assert!(hosts[0].group_id.is_none());
        assert!(hosts[1].group_id.is_none());
    }

    #[test]
    fn host_saved_without_new_fields_behaves_exactly_as_before() {
        let fixture = test_db();
        let mut h = sample_import_entry("legacy");
        h.identity_file = Some("/home/user/.ssh/id_ed25519".to_string());
        h.keep_alive_interval = Some(60);

        let result = save_imported_hosts(&fixture.db, &[h], None).expect("save_imported_hosts");
        assert_eq!(result.imported, 1);

        let hosts = fixture.db.list_hosts().expect("list_hosts");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].label, "legacy");
        assert_eq!(hosts[0].auth_type, "privateKey");
        assert_eq!(
            hosts[0].key_path.as_deref(),
            Some("/home/user/.ssh/id_ed25519")
        );
        assert_eq!(hosts[0].keep_alive_interval, Some(60));
        assert!(hosts[0].group_id.is_none());
        assert!(hosts[0].startup_command.is_none());
        assert!(hosts[0].notes.is_none());
        assert!(hosts[0].start_directory.is_none());
    }

    #[test]
    fn startup_command_and_notes_persisted() {
        let fixture = test_db();
        let mut h = sample_import_entry("devbox");
        h.startup_command = Some("tmux attach || tmux".to_string());
        h.notes = Some("Development jump machine".to_string());
        h.start_directory = Some("/srv/www".to_string());

        let result = save_imported_hosts(&fixture.db, &[h], None).expect("save_imported_hosts");
        assert_eq!(result.imported, 1);

        let hosts = fixture.db.list_hosts().expect("list_hosts");
        assert_eq!(hosts.len(), 1);
        assert_eq!(
            hosts[0].startup_command.as_deref(),
            Some("tmux attach || tmux")
        );
        assert_eq!(hosts[0].notes.as_deref(), Some("Development jump machine"));
        assert_eq!(hosts[0].start_directory.as_deref(), Some("/srv/www"));
    }

    #[test]
    fn new_group_sort_order_places_after_existing_groups() {
        let fixture = test_db();
        fixture
            .db
            .create_group(&sample_group("g1", "First", 5))
            .expect("create g1");
        fixture
            .db
            .create_group(&sample_group("g2", "Second", 10))
            .expect("create g2");

        let mut h1 = sample_import_entry("srv1");
        h1.group_path = Some("Third".to_string());
        let mut h2 = sample_import_entry("srv2");
        h2.group_path = Some("Fourth".to_string());

        let result =
            save_imported_hosts(&fixture.db, &[h1, h2], None).expect("save_imported_hosts");
        assert_eq!(result.imported, 2);

        let groups = fixture.db.list_groups().expect("list_groups");
        assert_eq!(groups.len(), 4);
        let third = groups.iter().find(|g| g.name == "Third").unwrap();
        let fourth = groups.iter().find(|g| g.name == "Fourth").unwrap();
        assert_eq!(third.sort_order, 11);
        assert_eq!(fourth.sort_order, 12);
    }

    #[test]
    fn serde_absent_option_fields_deserialize_to_none_and_alias_works() {
        let json_minimal = r#"{
            "host_alias": "srv1",
            "hostname": "1.2.3.4",
            "user": "admin",
            "port": 22
        }"#;
        let entry: SshConfigImportEntry =
            serde_json::from_str(json_minimal).expect("deserialize minimal");
        assert_eq!(entry.host_alias, "srv1");
        assert_eq!(entry.hostname, "1.2.3.4");
        assert_eq!(entry.user, "admin");
        assert_eq!(entry.port, 22);
        assert!(entry.identity_file.is_none());
        assert!(entry.proxy_jump.is_none());
        assert!(entry.keep_alive_interval.is_none());
        assert!(entry.group_path.is_none());
        assert!(entry.startup_command.is_none());
        assert!(entry.notes.is_none());
        assert!(entry.start_directory.is_none());

        let json_camel_case = r#"{
            "host_alias": "srv2",
            "hostname": "1.2.3.5",
            "user": "ubuntu",
            "port": 2222,
            "groupPath": "Cloud / AWS",
            "startupCommand": "bash",
            "notes": "EC2 instance",
            "startDirectory": "/srv/app"
        }"#;
        let entry_camel: SshConfigImportEntry =
            serde_json::from_str(json_camel_case).expect("deserialize camelCase");
        assert_eq!(entry_camel.group_path.as_deref(), Some("Cloud / AWS"));
        assert_eq!(entry_camel.startup_command.as_deref(), Some("bash"));
        assert_eq!(entry_camel.notes.as_deref(), Some("EC2 instance"));
        assert_eq!(entry_camel.start_directory.as_deref(), Some("/srv/app"));
    }

    #[test]
    fn timestamp_format_handles_epoch_and_leap_day_boundaries() {
        let epoch = chrono::Utc.timestamp_opt(0, 0).single().unwrap();
        assert_eq!(format_timestamp(epoch), "1970-01-01T00:00:00.000Z");

        let leap_day = chrono::Utc
            .with_ymd_and_hms(2024, 2, 29, 23, 59, 59)
            .single()
            .unwrap();
        assert_eq!(format_timestamp(leap_day), "2024-02-29T23:59:59.000Z");
    }

    /* ── MobaXterm password preview ────────────────────────────────────────── */

    /// Saved host with explicit login identity, auth type, and credential route
    /// so preview statuses can be exercised per storage backend.
    fn routed_host(
        id: &str,
        label: &str,
        hostname: &str,
        username: &str,
        port: u16,
        auth_type: &str,
        credential_storage: CredentialStorage,
    ) -> SavedHost {
        SavedHost {
            username: username.to_string(),
            port,
            auth_type: auth_type.to_string(),
            credential_storage,
            ..host(id, label, hostname)
        }
    }

    fn parsed(line: &str) -> ParsedPasswordFile {
        super::super::password_file::parse_password_bytes(line.as_bytes())
            .expect("parse password fixture")
    }

    /// Every combination of storage backend and credential presence, plus the
    /// key-auth skip, in one pass over a single password file.
    #[test]
    fn password_file_preview_statuses_cover_both_storages() {
        let fixture = test_db();
        fixture
            .db
            .save_host(&routed_host(
                "kc-new",
                "Keychain new",
                "kc-new.example",
                "alice",
                22,
                "password",
                CredentialStorage::Keychain,
            ))
            .expect("save kc-new");
        fixture
            .db
            .save_host(&routed_host(
                "kc-old",
                "Keychain replaces",
                "kc-old.example",
                "alice",
                22,
                "password",
                CredentialStorage::Keychain,
            ))
            .expect("save kc-old");
        fixture
            .db
            .save_host(&routed_host(
                "vault-new",
                "Vault new",
                "vault-new.example",
                "alice",
                22,
                "password",
                CredentialStorage::LocalVault,
            ))
            .expect("save vault-new");
        fixture
            .db
            .save_host(&routed_host(
                "vault-old",
                "Vault replaces",
                "vault-old.example",
                "alice",
                22,
                "password",
                CredentialStorage::LocalVault,
            ))
            .expect("save vault-old");
        fixture
            .db
            .save_host(&routed_host(
                "key-auth",
                "Key auth",
                "key-auth.example",
                "alice",
                22,
                "privateKey",
                CredentialStorage::Keychain,
            ))
            .expect("save key-auth");
        fixture
            .db
            .save_local_vault_credential("vault-old", b"stored ciphertext")
            .expect("save vault blob");

        let file = parsed(
            "alice@kc-new.example = one\n\
             alice@kc-old.example = two\n\
             alice@vault-new.example = three\n\
             alice@vault-old.example = four\n\
             alice@key-auth.example = five",
        );

        let preview = preview_password_file(&fixture.db, &file, |host_id| host_id == "kc-old")
            .expect("preview");

        assert_eq!(preview.matches.len(), 5);
        let status = |host_id: &str| {
            preview
                .matches
                .iter()
                .find(|m| m.host_id == host_id)
                .expect("match row")
                .status
        };
        assert_eq!(status("kc-new"), PasswordFileStatus::New);
        assert_eq!(status("kc-old"), PasswordFileStatus::Replaces);
        assert_eq!(status("vault-new"), PasswordFileStatus::New);
        assert_eq!(status("vault-old"), PasswordFileStatus::Replaces);
        /* Key auth wins even when a keychain entry exists for the host. */
        assert_eq!(status("key-auth"), PasswordFileStatus::KeyAuth);

        let storage_of = |host_id: &str| {
            preview
                .matches
                .iter()
                .find(|m| m.host_id == host_id)
                .expect("match row")
                .storage
        };
        assert_eq!(storage_of("vault-old"), CredentialStorage::LocalVault);
        assert_eq!(storage_of("kc-old"), CredentialStorage::Keychain);

        /* Matches are ordered by label, then port. */
        let labels: Vec<&str> = preview
            .matches
            .iter()
            .map(|m| m.host_label.as_str())
            .collect();
        assert_eq!(
            labels,
            vec![
                "Key auth",
                "Keychain new",
                "Keychain replaces",
                "Vault new",
                "Vault replaces",
            ]
        );
    }

    /// The password file has no port, so one key lands on every saved host that shares
    /// the host and username.
    #[test]
    fn password_file_preview_matches_every_port() {
        let fixture = test_db();
        for (id, port) in [("port-22", 22u16), ("port-2222", 2222u16)] {
            fixture
                .db
                .save_host(&routed_host(
                    id,
                    id,
                    "multi.example",
                    "deploy",
                    port,
                    "password",
                    CredentialStorage::Keychain,
                ))
                .expect("save host");
        }

        let file = parsed("deploy@multi.example = secret");
        let preview = preview_password_file(&fixture.db, &file, |_| false).expect("preview");

        assert_eq!(preview.matches.len(), 2);
        assert_eq!(preview.matches[0].host_id, "port-22");
        assert_eq!(preview.matches[0].port, 22);
        assert_eq!(preview.matches[1].host_id, "port-2222");
        assert_eq!(preview.matches[1].port, 2222);
        assert_eq!(preview.unmatched_entries, 0);
    }

    /// Host matching ignores case, while the username stays exact.
    #[test]
    fn password_file_preview_matches_host_case_insensitively_only() {
        let fixture = test_db();
        fixture
            .db
            .save_host(&routed_host(
                "mixed-case",
                "Mixed case",
                "Web.Example.COM",
                "Alice",
                22,
                "password",
                CredentialStorage::Keychain,
            ))
            .expect("save host");

        let matched = parsed("Alice@web.example.com = secret");
        let preview = preview_password_file(&fixture.db, &matched, |_| false).expect("preview");
        assert_eq!(preview.matches.len(), 1);
        assert_eq!(preview.matches[0].host_id, "mixed-case");

        let other_user = parsed("alice@web.example.com = secret");
        let preview = preview_password_file(&fixture.db, &other_user, |_| false).expect("preview");
        assert!(preview.matches.is_empty());
        assert_eq!(preview.unmatched_entries, 1);
    }

    /// A key exported twice with different passwords is refused and counted
    /// instead of surfacing as a row the save step would have to reject.
    #[test]
    fn password_file_preview_excludes_conflicts() {
        let fixture = test_db();
        fixture
            .db
            .save_host(&routed_host(
                "conflicted",
                "Conflicted",
                "conflict.example",
                "alice",
                22,
                "password",
                CredentialStorage::Keychain,
            ))
            .expect("save conflicted host");
        fixture
            .db
            .save_host(&routed_host(
                "clean",
                "Clean",
                "clean.example",
                "alice",
                22,
                "password",
                CredentialStorage::Keychain,
            ))
            .expect("save clean host");

        let file = parsed(
            "alice@conflict.example = first\n\
             alice@conflict.example = second\n\
             alice@clean.example = only",
        );

        let preview = preview_password_file(&fixture.db, &file, |_| false).expect("preview");

        assert_eq!(preview.conflicts, 1);
        assert_eq!(preview.matches.len(), 1);
        assert_eq!(preview.matches[0].host_id, "clean");
        assert_eq!(preview.unmatched_entries, 0);
        assert_eq!(preview.malformed_lines, 0);
    }

    /// Entries that match nothing are reported so the user can tell a partial
    /// match from a silently ignored file.
    #[test]
    fn password_file_preview_counts_unmatched_entries() {
        let fixture = test_db();
        fixture
            .db
            .save_host(&routed_host(
                "known",
                "Known",
                "known.example",
                "alice",
                22,
                "password",
                CredentialStorage::Keychain,
            ))
            .expect("save host");

        let file = parsed(
            "alice@known.example = one\n\
             alice@unknown.example = two\n\
             bob@known.example = three\n\
             broken line",
        );

        let preview = preview_password_file(&fixture.db, &file, |_| false).expect("preview");

        assert_eq!(preview.matches.len(), 1);
        assert_eq!(preview.unmatched_entries, 2);
        assert_eq!(preview.malformed_lines, 1);
    }

    /// The preview is the only thing the frontend receives, so its wire shape
    /// must not leak the plaintext values or even a password-bearing key.
    #[test]
    fn password_file_preview_wire_shape_omits_secrets() {
        let fixture = test_db();
        fixture
            .db
            .save_host(&routed_host(
                "wire-keychain",
                "Wire keychain",
                "wire.example",
                "alice",
                22,
                "password",
                CredentialStorage::Keychain,
            ))
            .expect("save keychain host");
        fixture
            .db
            .save_host(&routed_host(
                "wire-vault",
                "Wire vault",
                "wire-vault.example",
                "alice",
                22,
                "password",
                CredentialStorage::LocalVault,
            ))
            .expect("save vault host");
        fixture
            .db
            .save_host(&routed_host(
                "wire-key-auth",
                "Wire key auth",
                "wire-key.example",
                "alice",
                22,
                "privateKey",
                CredentialStorage::Keychain,
            ))
            .expect("save key-auth host");

        let file = parsed(
            "alice@wire.example = fixture-keychain-secret\n\
             alice@wire-vault.example = fixture-vault-secret\n\
             alice@wire-key.example = fixture-ignored-secret",
        );
        let preview = preview_password_file(&fixture.db, &file, |_| false).expect("preview");
        let json = serde_json::to_string(&preview).expect("serialize preview");

        assert!(!json.contains("fixture-keychain-secret"));
        assert!(!json.contains("fixture-vault-secret"));
        assert!(!json.contains("fixture-ignored-secret"));
        assert!(!json.contains("\"password\""));
        assert!(json.contains("\"keyAuth\""));
        assert!(json.contains("\"new\""));
        assert!(json.contains("\"localVault\""));
        assert!(json.contains("\"unmatched_entries\":0"));
    }

    /* ── Password file save ──────────────────────────────────────────── */

    /* Records every write and can fail on the nth call, so per-host isolation
     * and the overwrite path can be asserted without a real credential store.
     * Keeping the written password lets a test prove exactly what was sent. */
    struct FakePasswordSink {
        saved: std::cell::RefCell<Vec<(String, String)>>,
        calls: std::cell::Cell<usize>,
        fail_at: Option<usize>,
    }

    impl FakePasswordSink {
        fn new(fail_at: Option<usize>) -> Self {
            Self {
                saved: std::cell::RefCell::new(Vec::new()),
                calls: std::cell::Cell::new(0),
                fail_at,
            }
        }

        fn saved(&self) -> Vec<(String, String)> {
            self.saved.borrow().clone()
        }
    }

    impl PasswordSink for FakePasswordSink {
        fn save(&self, host_id: &str, credential: &StoredCredential) -> Result<(), VaultError> {
            let call = self.calls.get() + 1;
            self.calls.set(call);
            match credential {
                StoredCredential::Password { password } => self
                    .saved
                    .borrow_mut()
                    .push((host_id.to_string(), password.clone())),
                other => panic!("unexpected credential: {other:?}"),
            }
            if self.fail_at == Some(call) {
                Err(VaultError::Keychain(
                    "synthetic keychain failure".to_string(),
                ))
            } else {
                Ok(())
            }
        }
    }

    /// Ids in these tests are unique per run so the process-global test
    /// keychain cannot collide with a parallel test.
    fn unique_host_id(prefix: &str) -> String {
        format!("{prefix}-{}", uuid::Uuid::new_v4())
    }

    /// A password-auth host on the keychain route, named by its unique id so
    /// the file fixture can be built from the same value.
    fn keychain_password_host(id: &str, label: &str) -> SavedHost {
        routed_host(
            id,
            label,
            &format!("{id}.example"),
            "alice",
            22,
            "password",
            CredentialStorage::Keychain,
        )
    }

    /// An unlocked vault whose session key lives only in memory: writes and
    /// their read-back share one key, so a round trip needs no vault metadata.
    fn unlocked_vault() -> LocalVault {
        let vault = LocalVault::new();
        vault.set_session_key([0; 32]).expect("set session key");
        vault
    }

    /// A new password reaches the keychain, and the host's storage marker is
    /// exactly what the user configured before the step ran.
    #[test]
    fn password_file_save_writes_new_keychain_password() {
        crate::vault::test_keychain::install();
        let fixture = test_db();
        let host_id = unique_host_id("save-new");
        fixture
            .db
            .save_host(&keychain_password_host(&host_id, "New password"))
            .expect("save host");
        let file = parsed(&format!("alice@{host_id}.example = fixture-new-secret"));

        let result = save_password_file(
            &fixture.db,
            &file,
            std::slice::from_ref(&host_id),
            &KeychainSink,
            &unlocked_vault(),
        )
        .expect("save passwords");

        assert_eq!(result.stored_in_keychain, 1);
        assert_eq!(result.stored_in_vault, 0);
        assert_eq!(result.skipped, 0);
        assert!(result.failed.is_empty());

        let stored = crate::vault::get_credential(&host_id).expect("read back credential");
        match &stored {
            StoredCredential::Password { password } => assert_eq!(password, "fixture-new-secret"),
            other => panic!("unexpected credential: {other:?}"),
        }
        assert_eq!(
            fixture
                .db
                .get_host(&host_id)
                .expect("get host")
                .expect("host present")
                .credential_storage,
            CredentialStorage::Keychain
        );

        crate::vault::delete_credential(&host_id).expect("cleanup");
    }

    /// An existing keychain password is replaced by the file's value.
    #[test]
    fn password_file_save_overwrites_existing_password() {
        crate::vault::test_keychain::install();
        let fixture = test_db();
        let host_id = unique_host_id("save-replace");
        fixture
            .db
            .save_host(&keychain_password_host(&host_id, "Replace password"))
            .expect("save host");
        crate::vault::save_credential(
            &host_id,
            &StoredCredential::Password {
                password: "fixture-previous".to_string(),
            },
        )
        .expect("seed credential");
        let file = parsed(&format!("alice@{host_id}.example = fixture-replacement"));

        let result = save_password_file(
            &fixture.db,
            &file,
            std::slice::from_ref(&host_id),
            &KeychainSink,
            &unlocked_vault(),
        )
        .expect("save passwords");

        assert_eq!(result.stored_in_keychain, 1);
        assert!(result.failed.is_empty());
        let stored = crate::vault::get_credential(&host_id).expect("read back credential");
        match &stored {
            StoredCredential::Password { password } => assert_eq!(password, "fixture-replacement"),
            other => panic!("unexpected credential: {other:?}"),
        }

        crate::vault::delete_credential(&host_id).expect("cleanup");
    }

    /// Key-auth hosts, keys the parser dropped as conflicts, hosts whose
    /// username no longer matches, and ids that no longer exist are counted as
    /// skipped and never written. A repeated id is not counted twice.
    #[test]
    fn password_file_save_skips_unwritable_targets() {
        crate::vault::test_keychain::install();
        let fixture = test_db();
        let key_id = unique_host_id("skip-key");
        let conflict_id = unique_host_id("skip-conflict");
        let user_id = unique_host_id("skip-user");
        let ghost_id = unique_host_id("ghost");

        fixture
            .db
            .save_host(&routed_host(
                &key_id,
                "Key auth",
                &format!("{key_id}.example"),
                "alice",
                22,
                "privateKey",
                CredentialStorage::Keychain,
            ))
            .expect("save key-auth host");
        fixture
            .db
            .save_host(&keychain_password_host(&conflict_id, "Conflicted"))
            .expect("save conflicted host");
        fixture
            .db
            .save_host(&routed_host(
                &user_id,
                "Username changed",
                &format!("{user_id}.example"),
                "bob",
                22,
                "password",
                CredentialStorage::Keychain,
            ))
            .expect("save renamed host");

        let file = parsed(&format!(
            "alice@{key_id}.example = fixture-key-auth\n\
             alice@{conflict_id}.example = fixture-first\n\
             alice@{conflict_id}.example = fixture-second\n\
             alice@{user_id}.example = fixture-renamed\n\
             alice@{ghost_id}.example = fixture-ghost",
        ));

        let host_ids = vec![
            key_id.clone(),
            conflict_id.clone(),
            user_id.clone(),
            ghost_id.clone(),
            key_id.clone(),
        ];
        let result = save_password_file(
            &fixture.db,
            &file,
            &host_ids,
            &KeychainSink,
            &unlocked_vault(),
        )
        .expect("save passwords");

        assert_eq!(result.stored_in_keychain, 0);
        assert_eq!(result.stored_in_vault, 0);
        assert_eq!(result.skipped, 4);
        assert!(result.failed.is_empty());
        assert!(!crate::vault::has_credential(&key_id));
        assert!(!crate::vault::has_credential(&conflict_id));
        assert!(!crate::vault::has_credential(&user_id));
    }

    /// A host the user did not tick keeps whatever credential it already had,
    /// even when the same password file entry matches it.
    #[test]
    fn password_file_save_leaves_unselected_hosts_untouched() {
        crate::vault::test_keychain::install();
        let fixture = test_db();
        let selected_id = unique_host_id("selected");
        let unselected_id = unique_host_id("unselected");
        fixture
            .db
            .save_host(&keychain_password_host(&selected_id, "Selected"))
            .expect("save selected host");
        fixture
            .db
            .save_host(&keychain_password_host(&unselected_id, "Unselected"))
            .expect("save unselected host");
        crate::vault::save_credential(
            &unselected_id,
            &StoredCredential::Password {
                password: "fixture-untouched".to_string(),
            },
        )
        .expect("seed unselected credential");

        /* Both hosts share host and username, so only the ticked id decides. */
        let file = parsed(&format!(
            "alice@{selected_id}.example = fixture-selected\n\
             alice@{unselected_id}.example = fixture-would-replace",
        ));
        let result = save_password_file(
            &fixture.db,
            &file,
            std::slice::from_ref(&selected_id),
            &KeychainSink,
            &unlocked_vault(),
        )
        .expect("save passwords");

        assert_eq!(result.stored_in_keychain, 1);
        let selected =
            crate::vault::get_credential(&selected_id).expect("read selected credential");
        match &selected {
            StoredCredential::Password { password } => assert_eq!(password, "fixture-selected"),
            other => panic!("unexpected credential: {other:?}"),
        }
        let untouched =
            crate::vault::get_credential(&unselected_id).expect("read unselected credential");
        match &untouched {
            StoredCredential::Password { password } => assert_eq!(password, "fixture-untouched"),
            other => panic!("unexpected credential: {other:?}"),
        }

        crate::vault::delete_credential(&selected_id).expect("cleanup");
        crate::vault::delete_credential(&unselected_id).expect("cleanup");
    }

    /// One failing store records a labeled failure and the remaining hosts are
    /// still written; no failure text carries a password.
    #[test]
    fn password_file_save_records_a_failure_and_writes_the_rest() {
        let fixture = test_db();
        let first_id = unique_host_id("partial-first");
        let second_id = unique_host_id("partial-second");
        let third_id = unique_host_id("partial-third");
        for (id, label) in [
            (&first_id, "First"),
            (&second_id, "Second"),
            (&third_id, "Third"),
        ] {
            fixture
                .db
                .save_host(&keychain_password_host(id, label))
                .expect("save host");
        }

        let file = parsed(&format!(
            "alice@{first_id}.example = fixture-one\n\
             alice@{second_id}.example = fixture-two\n\
             alice@{third_id}.example = fixture-three",
        ));
        let sink = FakePasswordSink::new(Some(2));
        let result = save_password_file(
            &fixture.db,
            &file,
            &[first_id.clone(), second_id.clone(), third_id.clone()],
            &sink,
            &unlocked_vault(),
        )
        .expect("save passwords");

        assert_eq!(result.stored_in_keychain, 2);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].host_id, second_id);
        assert_eq!(result.failed[0].host_label, "Second");
        assert!(
            result.failed[0]
                .error
                .contains("synthetic keychain failure"),
            "unexpected error: {}",
            result.failed[0].error
        );
        assert!(!result.failed[0].error.contains("fixture-two"));

        let written = sink.saved();
        assert_eq!(written.len(), 3);
        assert!(written.contains(&(first_id, "fixture-one".to_string())));
        assert!(written.contains(&(third_id, "fixture-three".to_string())));

        /* The wire shape reports counts, ids, labels, and error text only. */
        let json = serde_json::to_string(&result).expect("serialize result");
        assert!(!json.contains("fixture-one"));
        assert!(!json.contains("fixture-two"));
        assert!(!json.contains("fixture-three"));
        assert!(json.contains("\"stored_in_keychain\":2"));
    }

    /// A vault-configured host — a password-auth host whose marker points at
    /// the App Vault, named by its unique id so the file fixture can be built
    /// from the same value.
    fn vault_password_host(id: &str, label: &str) -> SavedHost {
        routed_host(
            id,
            label,
            &format!("{id}.example"),
            "alice",
            22,
            "password",
            CredentialStorage::LocalVault,
        )
    }

    /// Read one host's password back through the resolver the connection path
    /// uses, so the assertion covers the stored ciphertext and the marker.
    fn resolved_password(db: &HostDb, vault: &LocalVault, host_id: &str) -> String {
        let stored = crate::vault::resolve_host_credential(
            db,
            vault,
            host_id,
            CredentialStorage::LocalVault,
        )
        .expect("resolve vault credential");
        match &stored {
            StoredCredential::Password { password } => password.clone(),
            other => panic!("unexpected credential: {other:?}"),
        }
    }

    /// An unlocked vault takes the password as ciphertext, the resolver reads
    /// it back, and no plaintext copy is left in the keychain.
    #[test]
    fn password_file_save_writes_vault_password_without_keychain_copy() {
        crate::vault::test_keychain::install();
        let fixture = test_db();
        let vault = unlocked_vault();
        let host_id = unique_host_id("save-vault");
        fixture
            .db
            .save_host(&vault_password_host(&host_id, "Vault host"))
            .expect("save vault host");
        let file = parsed(&format!("alice@{host_id}.example = fixture-vault-secret"));

        let result = save_password_file(
            &fixture.db,
            &file,
            std::slice::from_ref(&host_id),
            &KeychainSink,
            &vault,
        )
        .expect("save passwords");

        assert_eq!(result.stored_in_vault, 1);
        assert_eq!(result.stored_in_keychain, 0);
        assert_eq!(result.skipped, 0);
        assert!(result.failed.is_empty());
        assert_eq!(
            resolved_password(&fixture.db, &vault, &host_id),
            "fixture-vault-secret"
        );
        /* The keychain must never hold a copy of a vault-configured password. */
        assert!(!crate::vault::has_credential(&host_id));
        assert_eq!(
            fixture
                .db
                .get_host(&host_id)
                .expect("get host")
                .expect("host present")
                .credential_storage,
            CredentialStorage::LocalVault
        );
    }

    /// An existing vault blob is replaced by the file's value.
    #[test]
    fn password_file_save_replaces_existing_vault_blob() {
        crate::vault::test_keychain::install();
        let fixture = test_db();
        let vault = unlocked_vault();
        let host_id = unique_host_id("replace-vault");
        fixture
            .db
            .save_host(&vault_password_host(&host_id, "Replace vault"))
            .expect("save vault host");
        crate::vault::store_host_credential_in_vault(
            &fixture.db,
            &vault,
            &host_id,
            &StoredCredential::Password {
                password: "fixture-previous".to_string(),
            },
        )
        .expect("seed vault blob");
        assert_eq!(
            resolved_password(&fixture.db, &vault, &host_id),
            "fixture-previous"
        );

        let file = parsed(&format!("alice@{host_id}.example = fixture-replacement"));
        let result = save_password_file(
            &fixture.db,
            &file,
            std::slice::from_ref(&host_id),
            &KeychainSink,
            &vault,
        )
        .expect("save passwords");

        assert_eq!(result.stored_in_vault, 1);
        assert!(result.failed.is_empty());
        assert_eq!(
            resolved_password(&fixture.db, &vault, &host_id),
            "fixture-replacement"
        );
        assert!(!crate::vault::has_credential(&host_id));
    }

    /// A run that covers both storages routes each host to its own marker and
    /// counts them separately.
    #[test]
    fn password_file_save_stores_both_storages_in_one_run() {
        crate::vault::test_keychain::install();
        let fixture = test_db();
        let vault = unlocked_vault();
        let vault_id = unique_host_id("mixed-vault");
        let keychain_id = unique_host_id("mixed-keychain");
        fixture
            .db
            .save_host(&vault_password_host(&vault_id, "Mixed vault"))
            .expect("save vault host");
        fixture
            .db
            .save_host(&keychain_password_host(&keychain_id, "Mixed keychain"))
            .expect("save keychain host");
        let file = parsed(&format!(
            "alice@{vault_id}.example = fixture-to-vault\n\
             alice@{keychain_id}.example = fixture-to-keychain",
        ));

        let result = save_password_file(
            &fixture.db,
            &file,
            &[vault_id.clone(), keychain_id.clone()],
            &KeychainSink,
            &vault,
        )
        .expect("save passwords");

        assert_eq!(result.stored_in_vault, 1);
        assert_eq!(result.stored_in_keychain, 1);
        assert_eq!(result.skipped, 0);
        assert!(result.failed.is_empty());
        assert_eq!(
            resolved_password(&fixture.db, &vault, &vault_id),
            "fixture-to-vault"
        );
        assert!(crate::vault::has_credential(&keychain_id));
        assert!(!crate::vault::has_credential(&vault_id));

        crate::vault::delete_credential(&keychain_id).expect("cleanup");
    }

    /// A locked vault fails its own hosts with the locked message and leaves
    /// the keychain-configured hosts in the same run untouched by that failure.
    /// Nothing is written to the keychain as a fallback.
    #[test]
    fn password_file_save_reports_locked_vault_and_still_writes_keychain() {
        crate::vault::test_keychain::install();
        let fixture = test_db();
        /* No session key: the vault is locked. */
        let vault = LocalVault::new();
        let vault_id = unique_host_id("locked-vault");
        let keychain_id = unique_host_id("locked-keychain");
        fixture
            .db
            .save_host(&vault_password_host(&vault_id, "Locked vault"))
            .expect("save vault host");
        fixture
            .db
            .save_host(&keychain_password_host(&keychain_id, "Still written"))
            .expect("save keychain host");
        let file = parsed(&format!(
            "alice@{vault_id}.example = fixture-locked\n\
             alice@{keychain_id}.example = fixture-written",
        ));

        let result = save_password_file(
            &fixture.db,
            &file,
            &[vault_id.clone(), keychain_id.clone()],
            &KeychainSink,
            &vault,
        )
        .expect("save passwords");

        assert_eq!(result.stored_in_vault, 0);
        assert_eq!(result.stored_in_keychain, 1);
        assert_eq!(result.skipped, 0);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].host_id, vault_id);
        assert_eq!(result.failed[0].host_label, "Locked vault");
        assert!(
            result.failed[0].error.contains("Local vault is locked"),
            "unexpected error: {}",
            result.failed[0].error
        );
        assert!(!result.failed[0].error.contains("fixture-locked"));

        /* The locked host keeps no credential anywhere, and no vault blob was
         * written for it. */
        assert!(!crate::vault::has_credential(&vault_id));
        assert!(fixture
            .db
            .get_local_vault_credential(&vault_id)
            .expect("read vault blob")
            .is_none());
        assert!(crate::vault::has_credential(&keychain_id));

        crate::vault::delete_credential(&keychain_id).expect("cleanup");
    }
}
