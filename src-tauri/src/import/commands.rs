use std::collections::HashSet;
use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use crate::db::{DbError, HostDb, HostGroup, SavedHost};
use crate::types::SshError;

use super::{ImportResult, MobaXtermEntry, SshConfigEntry, SshConfigImportEntry};

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

        let host = SavedHost {
            id: id.clone(),
            label: entry.host_alias.clone(),
            host: entry.hostname.clone(),
            port: entry.port as _,
            username: entry.user.clone(),
            auth_type: if entry.identity_file.is_some() {
                "privateKey".to_string()
            } else {
                "password".to_string()
            },
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
    db: State<'_, Arc<HostDb>>,
) -> Result<ImportResult, DbError> {
    save_imported_hosts_command(entries, Arc::clone(&db), "ssh_config_imported").await
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
 * provenance, so the command span and telemetry must contain counts only. */
#[instrument(skip(entries, db))]
pub async fn import_save_mobaxterm_hosts(
    entries: Vec<SshConfigImportEntry>,
    db: State<'_, Arc<HostDb>>,
) -> Result<ImportResult, DbError> {
    save_imported_hosts_command(entries, Arc::clone(&db), "mobaxterm_imported").await
}

/* Keep source-specific IPC commands thin while preserving a single save path
 * for groups, metadata, ProxyJump linking, deduplication, and diagnostics. */
async fn save_imported_hosts_command(
    entries: Vec<SshConfigImportEntry>,
    db: Arc<HostDb>,
    telemetry_event: &'static str,
) -> Result<ImportResult, DbError> {
    let host_count = entries.len();
    let result = task::spawn_blocking(move || save_imported_hosts(&db, &entries))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?;

    crate::telemetry::capture(
        telemetry_event,
        serde_json::json!({ "host_count": host_count }),
    );
    result
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
    /* Bound SQL parameters are values, not expressions. Generate a real UTC
     * timestamp here so import rows never persist the SQL expression itself. */
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = (seconds / 86_400) as i64;
    let seconds_today = seconds % 86_400;
    let (year, month, day) = civil_date_from_days(days);
    let hour = seconds_today / 3_600;
    let minute = (seconds_today % 3_600) / 60;
    let second = seconds_today % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

fn civil_date_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    // Gregorian civil-date conversion relative to 1970-01-01.
    let shifted = days_since_epoch + 719_468;
    let era = (if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    }) / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    (year, month, day)
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
        save_imported_hosts(&fixture.db, &[existing]).expect("save existing host");

        let mut duplicate = sample_import_entry("duplicate-label");
        duplicate.hostname = "existing.example.com".to_string();
        let mut repeated = duplicate.clone();
        repeated.host_alias = "repeated-label".to_string();
        let unique = sample_import_entry("unique");

        let result = save_imported_hosts(&fixture.db, &[duplicate, repeated, unique])
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

        let error = save_imported_hosts(&fixture.db, &[]).expect_err("host read must fail");
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
        let error = save_imported_hosts(&fixture.db, &[entry]).expect_err("group read must fail");

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

        let result = save_imported_hosts(&fixture.db, &[h1, h2]).expect("save_imported_hosts");
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

        let result = save_imported_hosts(&fixture.db, &[h1]).expect("save_imported_hosts");
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

        let result = save_imported_hosts(&fixture.db, &[h1]).expect("save_imported_hosts");
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

        let result = save_imported_hosts(&fixture.db, &[h1, h2]).expect("save_imported_hosts");
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

        let result = save_imported_hosts(&fixture.db, &[h]).expect("save_imported_hosts");
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

        let result = save_imported_hosts(&fixture.db, &[h]).expect("save_imported_hosts");
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

        let result = save_imported_hosts(&fixture.db, &[h1, h2]).expect("save_imported_hosts");
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
}
