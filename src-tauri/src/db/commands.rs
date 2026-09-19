use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use super::{
    ConnectionHistoryEntry, DbError, HostDb, HostGroup, HostPluginConfig, RecentConnection,
    ResetKeys, SavedHost,
};

/// Persist (insert or update) a host entry.
///
/// ProxyJump cycles, self-references, and dangling tunnel-host targets are
/// rejected atomically with the write inside [`HostDb::save_host_validated`].
#[tauri::command]
#[instrument(skip(state), fields(id = %host.id))]
pub async fn save_host(host: SavedHost, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.save_host_validated(&host))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return all saved hosts, ordered by label.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_hosts(state: State<'_, Arc<HostDb>>) -> Result<Vec<SavedHost>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_hosts())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Permanently delete a saved host by its UUID string.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_host(id: String, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_host(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Persist a manual host ordering produced by drag-and-drop on the dashboard.
///
/// `ordered_ids` is the full list of host ids in their new display order; each
/// host's `sort_order` is set to its position. Rolls back and returns
/// `DbError::NotFound` if any id is unknown (e.g. a host deleted concurrently).
#[tauri::command]
#[instrument(skip(state), fields(count = ordered_ids.len()))]
pub async fn reorder_hosts(
    ordered_ids: Vec<String>,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.reorder_hosts(&ordered_ids))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Look up a single host by its UUID string.  Returns `None` when not found.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn get_host(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<Option<SavedHost>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.get_host(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Create a new host group.
#[tauri::command]
#[instrument(skip(state), fields(id = %group.id))]
pub async fn create_group(group: HostGroup, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.create_group(&group))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Update an existing host group.
#[tauri::command]
#[instrument(skip(state), fields(id = %group.id))]
pub async fn update_group(group: HostGroup, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.update_group(&group))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Persist a manual group ordering produced by drag-and-drop on the dashboard.
///
/// `ordered_ids` is the full list of group ids in their new display order; each
/// group's `sort_order` is set to its position. Rolls back and returns
/// `DbError::NotFound` if any id is unknown (e.g. a group deleted concurrently).
#[tauri::command]
#[instrument(skip(state), fields(count = ordered_ids.len()))]
pub async fn reorder_groups(
    ordered_ids: Vec<String>,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.reorder_groups(&ordered_ids))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return all host groups, ordered by sort_order then name.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_groups(state: State<'_, Arc<HostDb>>) -> Result<Vec<HostGroup>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_groups())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Permanently delete a host group.  Member hosts are orphaned (their
/// `group_id` is set to NULL) rather than deleted.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_group(id: String, state: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_group(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Delete a host group AND all hosts inside it.
#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_group_with_hosts(
    id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_group_with_hosts(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Record a successful connection for the given host id.  Also prunes the
/// history table to keep at most 50 rows.
#[tauri::command]
#[instrument(skip(state), fields(host_id = %host_id))]
pub async fn record_connection(
    host_id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.record_connection(&host_id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return the most-recent distinct connection per host, ordered newest-first.
/// `limit` caps the number of rows returned.
#[tauri::command]
#[instrument(skip(state), fields(limit = %limit))]
pub async fn list_recent_connections(
    limit: u32,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<RecentConnection>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_recent_connections(limit))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Recent paths (per-host MRU of visited directories) ───────────────────────

/// Record that `path` was visited for a host, keeping only the newest five.
///
/// `path` is deliberately kept out of `#[instrument]`: host filesystem paths
/// must never reach logs.
#[tauri::command]
#[instrument(skip(state))]
pub async fn record_recent_path(
    host_key: String,
    scope: String,
    path: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.record_recent_path(&host_key, &scope, &path))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Return the most-recently-used paths for a host, newest-first.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_recent_paths(
    host_key: String,
    scope: String,
    limit: u32,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<String>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_recent_paths(&host_key, &scope, limit))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Drop the entire recent-paths history for a host.
#[tauri::command]
#[instrument(skip(state))]
pub async fn clear_recent_paths(
    host_key: String,
    scope: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.clear_recent_paths(&host_key, &scope))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Host plugin config (per-host tracker enablement + JSON config) ──────────

/*
 * Persist one plugin row for a host. Config is opaque frontend-owned JSON
 * (ports, paths, kube context) — must never contain secrets. The row is
 * upserted; unknown hosts surface as `NotFound` via the FK, malformed JSON
 * as `Validation`.
 */
#[tauri::command]
#[instrument(skip(state))]
pub async fn set_plugin_config(
    host_id: String,
    plugin_id: String,
    enabled: bool,
    config: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.set_plugin_config(&host_id, &plugin_id, enabled, &config))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// All plugin rows for one host, ordered by plugin id.
#[tauri::command]
#[instrument(skip(state))]
pub async fn list_plugin_configs(
    host_id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<HostPluginConfig>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_plugin_configs(&host_id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Delete one plugin row for a host.
#[tauri::command]
#[instrument(skip(state))]
pub async fn delete_plugin_config(
    host_id: String,
    plugin_id: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_plugin_config(&host_id, &plugin_id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Connection History (full audit log) ──────────────────────────────────────

#[tauri::command]
#[instrument(skip(state))]
pub async fn list_connection_history(
    host_id: Option<String>,
    limit: u32,
    offset: u32,
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<ConnectionHistoryEntry>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.list_connection_history(host_id.as_deref(), limit, offset))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

#[tauri::command]
#[instrument(skip(state), fields(id = %id))]
pub async fn delete_connection_history_entry(
    id: i64,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.delete_connection_history_entry(id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── App Settings ─────────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(state))]
pub async fn save_setting(
    key: String,
    value: String,
    state: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.save_setting(&key, &value))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

#[tauri::command]
#[instrument(skip(state))]
pub async fn load_all_settings(
    state: State<'_, Arc<HostDb>>,
) -> Result<Vec<(String, String)>, DbError> {
    let db = Arc::clone(&state);
    task::spawn_blocking(move || db.load_all_settings())
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Factory reset ─────────────────────────────────────────────────────────────

/// Permanently wipe ALL local data — saved hosts, groups, connection history,
/// snippets, port-forward rules, S3 connections, and app settings — plus their
/// stored credentials in the OS keychain. Returns anySCP to first-launch state.
///
/// This is irreversible; the frontend gates it behind a typed confirmation and
/// relaunches the app afterwards.
#[tauri::command]
#[instrument(skip(state, local_vault))]
pub async fn factory_reset(
    state: State<'_, Arc<HostDb>>,
    local_vault: State<'_, Arc<crate::vault::LocalVault>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&state);
    let local_vault = Arc::clone(&local_vault);
    task::spawn_blocking(move || {
        let keys = db.factory_reset()?;
        purge_reset_secrets(&keys);
        /* Reset removes persisted encrypted values and must also invalidate the
         * in-memory session key before any subsequent first-launch setup. */
        local_vault.lock_session();
        Ok::<(), DbError>(())
    })
    .await
    .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

/// Delete every keychain entry the rows removed by [`HostDb::factory_reset`]
/// owned. Best-effort: a missing entry is fine, and one bad key must not leave
/// the rest behind — the rows are already gone, so this is the last chance to
/// remove them.
///
/// The dataset ids come from the reset and expand through
/// `sync::secrets::dataset_secret_keys`, so a per-dataset secret added later is
/// purged without touching this function. Split out of the command so the purge
/// contract is testable without a Tauri runtime or a real OS keychain.
pub(crate) fn purge_reset_secrets(keys: &ResetKeys) {
    for host_id in &keys.host_ids {
        if let Err(e) = crate::vault::delete_credential(host_id) {
            tracing::warn!(host_id = %host_id, error = %e, "factory reset: keychain purge failed");
        }
    }
    for s3_id in &keys.s3_ids {
        let key = format!("s3:{s3_id}");
        if let Err(e) = crate::vault::delete_credential(&key) {
            tracing::warn!(key = %key, error = %e, "factory reset: keychain purge failed");
        }
    }
    for dataset_id in &keys.sync_dataset_ids {
        if let Err(e) = crate::sync::secrets::delete_dataset_secrets(dataset_id) {
            tracing::warn!(error = %e, "factory reset: sync secret purge failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SyncDataset;
    use crate::sync::secrets;
    use crate::vault::{test_keychain, StoredCredential};

    fn test_db() -> (HostDb, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("anyscp-cmd-{}", uuid::Uuid::new_v4()));
        let db = HostDb::new(&dir).expect("test db");
        (db, dir)
    }

    fn dataset(id: &str) -> SyncDataset {
        SyncDataset {
            id: id.to_string(),
            name: format!("Dataset {id}"),
            host: "192.0.2.10".to_string(),
            port: 2222,
            username: "syncuser".to_string(),
            auth_type: "password".to_string(),
            remote_path: "/srv/omnissh".to_string(),
            role: "owner".to_string(),
            content_flags: "{}".to_string(),
            scope_mode: "all".to_string(),
            auto_sync: false,
            pull_interval_secs: 0,
            push_debounce_secs: 0,
            owner_fingerprint: None,
            kdf_salt: None,
            kdf_m_kib: None,
            kdf_t: None,
            kdf_p: None,
            wrapped_key: None,
            last_generation: 0,
            last_synced_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn sample_host(id: &str) -> crate::db::SavedHost {
        crate::db::SavedHost {
            id: id.to_string(),
            label: format!("Host {id}"),
            host: "192.0.2.1".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_type: "password".to_string(),
            credential_storage: crate::db::CredentialStorage::Keychain,
            group_id: None,
            created_at: "2026-01-01T00:00:00".to_string(),
            updated_at: "2026-01-01T00:00:00".to_string(),
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
            connection_count: Some(0),
        }
    }

    fn seed_secret(key: &str) {
        crate::vault::save_credential(
            key,
            &StoredCredential::Password {
                password: "secret-value".to_string(),
            },
        )
        .expect("seed credential");
    }

    /* A reset must not leave a dataset's secrets in the keychain: the dataset row
     * is gone, so nothing can ever use or rotate them again. Coverage comes from
     * `dataset_secret_keys`, so the assertion is made against the whole
     * `sync:{id}:` namespace rather than the keys a test happened to enumerate —
     * a fourth per-dataset secret is caught by construction rather than by editing
     * this test. */
    #[test]
    fn factory_reset_purges_every_sync_secret_namespace() {
        test_keychain::install();
        let (db, dir) = test_db();
        let dataset_id = format!("ds-{}", uuid::Uuid::new_v4());
        db.upsert_sync_dataset(&dataset(&dataset_id))
            .expect("upsert dataset");
        db.save_host(&sample_host("host-purge")).expect("save host");
        db.save_s3_connection(
            "s3-purge",
            "Bucket",
            "aws",
            "us-east-1",
            None,
            None,
            false,
            None,
            None,
            None,
            None,
        )
        .expect("save s3 connection");

        for key in secrets::dataset_secret_keys(&dataset_id) {
            seed_secret(&key);
        }
        seed_secret("host-purge");
        seed_secret("s3:s3-purge");

        let keys = db.factory_reset().expect("factory_reset");
        assert_eq!(keys.sync_dataset_ids, vec![dataset_id.clone()]);
        purge_reset_secrets(&keys);

        assert!(
            test_keychain::keys_with_prefix(&format!("sync:{dataset_id}:")).is_empty(),
            "no sync secret namespace may survive a reset: {:?}",
            test_keychain::keys_with_prefix(&format!("sync:{dataset_id}:"))
        );
        for key in secrets::dataset_secret_keys(&dataset_id) {
            assert!(!crate::vault::has_credential(&key), "{key} survived");
        }
        // The other keychain namespaces a reset owns are purged too.
        assert!(!crate::vault::has_credential("host-purge"));
        assert!(!crate::vault::has_credential("s3:s3-purge"));

        // A second purge (removing an already-absent dataset) stays quiet.
        purge_reset_secrets(&keys);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_reset_without_datasets_purges_nothing() {
        test_keychain::install();
        // No dataset rows: the reset reports no ids, so no sync key is touched.
        let keys = ResetKeys::default();
        assert!(keys.sync_dataset_ids.is_empty());
        purge_reset_secrets(&keys);
    }
}
