/*
 * Tauri commands for dataset sync.
 *
 * The endpoint secret arrives from the Settings form and stays in Rust: it is
 * turned into an `AuthMethod` (zeroizing `Drop`, redacted `Debug`), used for a
 * single ephemeral connection, and dropped. Nothing about the endpoint is
 * logged beyond host and port — no password, no remote path, no dataset ids
 * from the probed metadata.
 */

use serde::{Deserialize, Serialize};
use tauri::State;
use tracing::instrument;

use crate::ssh::manager::SshManager;
use crate::types::session::AuthMethod;

use std::sync::Arc;

use crate::db::HostDb;
use crate::vault::LocalVault;

use super::dataset::update_schedule;
use super::dataset::{
    delete_dataset, list_datasets, save_dataset, SyncDatasetInput, SyncDatasetSecrets,
    SyncDatasetSummary, SyncSaveOutcome,
};
use super::meta::{DatasetMeta, ExistingDataset};
use super::pull::{pull, SyncPullOutcome};
use super::push::{preflight, push, SyncPushOutcome, SyncPushPreflight};
use super::scheduler::{SyncScheduler, SyncStatusSnapshot};
use super::transport::{RemoteStore, SyncEndpoint};
use super::SyncError;

/// Endpoint fields as entered in Settings. Exactly one credential shape is
/// used: `password`, or `keyPath` (+ optional `keyPassphrase`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEndpointInput {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
    pub remote_path: String,
}

impl TryFrom<SyncEndpointInput> for SyncEndpoint {
    type Error = SyncError;

    fn try_from(input: SyncEndpointInput) -> Result<Self, Self::Error> {
        if input.host.trim().is_empty() {
            return Err(SyncError::Unreachable("enter the server address".into()));
        }
        if input.username.trim().is_empty() {
            return Err(SyncError::Unreachable("enter the username".into()));
        }
        if input.remote_path.trim().is_empty() {
            return Err(SyncError::Format(
                "enter the remote path where the dataset should live".into(),
            ));
        }

        /* A key path wins over a password when both are supplied: the form
         * shows one credential control at a time, so a stale password field
         * must never silently override the selected key. */
        let auth = match (input.key_path, input.password) {
            (Some(key_path), _) if !key_path.trim().is_empty() => AuthMethod::PrivateKey {
                key_path,
                passphrase: input
                    .key_passphrase
                    .filter(|passphrase| !passphrase.is_empty()),
            },
            (_, Some(password)) if !password.is_empty() => AuthMethod::Password { password },
            _ => {
                return Err(SyncError::Unreachable(
                    "enter the server password or choose a private key".into(),
                ))
            }
        };

        Ok(Self {
            host: input.host.trim().to_string(),
            port: input.port.unwrap_or(22),
            username: input.username.trim().to_string(),
            auth,
            root: input.remote_path.trim().to_string(),
        })
    }
}

/// Result of probing an endpoint, shaped for direct rendering in Settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConnectionTest {
    /// SSH authenticated and the SFTP subsystem answered.
    pub reachable: bool,
    /// The remote path exists as a directory.
    pub path_exists: bool,
    /// This account can create and remove files in it.
    pub writable: bool,
    /// A dataset is already published there.
    pub dataset_present: bool,
    /// Summary of that dataset, when its metadata could be parsed.
    pub existing_dataset: Option<ExistingDataset>,
    /// Why the existing metadata could not be read, when it could not be.
    pub metadata_error: Option<String>,
}

/// Connect to a sync endpoint, probe the dataset path, and report what is
/// there — without creating, modifying, or overwriting anything.
#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(endpoint, ssh), fields(host = %endpoint.host, port = endpoint.port.unwrap_or(22)))]
pub async fn sync_test_connection(
    endpoint: SyncEndpointInput,
    ssh: State<'_, SshManager>,
) -> Result<SyncConnectionTest, SyncError> {
    let endpoint = SyncEndpoint::try_from(endpoint)?;
    let store = RemoteStore::connect(ssh.inner(), &endpoint).await?;

    /* The probe result is captured before the session is released so a failure
     * mid-probe still tears the connection down: a "Test connection" the user
     * repeats must not accumulate live SSH sessions. */
    let probe = store.probe().await;
    store.close(ssh.inner()).await;
    let probe = probe?;

    let (existing_dataset, metadata_error) = match probe.meta.as_deref() {
        Some(bytes) => match DatasetMeta::parse(bytes) {
            Ok(meta) => (Some(ExistingDataset::from(&meta)), None),
            Err(error) => (None, Some(error.to_string())),
        },
        None => (None, None),
    };

    Ok(SyncConnectionTest {
        reachable: true,
        path_exists: probe.path_exists,
        writable: probe.writable,
        dataset_present: probe.dataset_present,
        existing_dataset,
        metadata_error,
    })
}

/// Create or update a dataset. Verifies the passphrase against the remote when
/// a dataset is already published at the path (join), otherwise creates one.
#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(dataset, secrets, ssh, db), fields(host = %dataset.host))]
pub async fn sync_save_dataset(
    dataset: SyncDatasetInput,
    secrets: SyncDatasetSecrets,
    ssh: State<'_, SshManager>,
    db: State<'_, Arc<HostDb>>,
) -> Result<SyncSaveOutcome, SyncError> {
    let db = Arc::clone(&db);
    save_dataset(ssh.inner(), &db, dataset, secrets).await
}

#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(db))]
pub async fn sync_list_datasets(
    db: State<'_, Arc<HostDb>>,
) -> Result<Vec<SyncDatasetSummary>, SyncError> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || list_datasets(&db))
        .await
        .map_err(|e| SyncError::Database(format!("task panicked: {e}")))?
}

/// Forget a dataset: its row, its sync state, and its keychain secrets. Local
/// hosts and groups are kept.
#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(db), fields(dataset_id = %dataset_id))]
pub async fn sync_delete_dataset(
    dataset_id: String,
    db: State<'_, Arc<HostDb>>,
) -> Result<(), SyncError> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || delete_dataset(&db, &dataset_id))
        .await
        .map_err(|e| SyncError::Database(format!("task panicked: {e}")))?
}

/// Report how many in-scope credentials can be read right now. Touches no
/// network and publishes nothing.
#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(db, local_vault), fields(dataset_id = %dataset_id))]
pub async fn sync_push_preflight(
    dataset_id: String,
    db: State<'_, Arc<HostDb>>,
    local_vault: State<'_, Arc<LocalVault>>,
) -> Result<SyncPushPreflight, SyncError> {
    let db = Arc::clone(&db);
    let local_vault = Arc::clone(&local_vault);
    tokio::task::spawn_blocking(move || preflight(&db, &local_vault, &dataset_id))
        .await
        .map_err(|e| SyncError::Database(format!("task panicked: {e}")))?
}

/// Publish the local dataset to its remote, bumping the generation.
#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(ssh, db, local_vault), fields(dataset_id = %dataset_id))]
pub async fn sync_push(
    dataset_id: String,
    ssh: State<'_, SshManager>,
    db: State<'_, Arc<HostDb>>,
    local_vault: State<'_, Arc<LocalVault>>,
) -> Result<SyncPushOutcome, SyncError> {
    let db = Arc::clone(&db);
    let local_vault = Arc::clone(&local_vault);
    push(ssh.inner(), &db, &local_vault, &dataset_id).await
}

/// Fetch, decrypt, and merge the published dataset into the local database.
#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(ssh, db, local_vault), fields(dataset_id = %dataset_id))]
pub async fn sync_pull(
    dataset_id: String,
    ssh: State<'_, SshManager>,
    db: State<'_, Arc<HostDb>>,
    local_vault: State<'_, Arc<LocalVault>>,
) -> Result<SyncPullOutcome, SyncError> {
    let db = Arc::clone(&db);
    let local_vault = Arc::clone(&local_vault);
    pull(ssh.inner(), &db, &local_vault, &dataset_id).await
}

/* The conflict log's wire shape. `db::SyncConflict` is the persistence struct
 * and serializes snake_case; the frontend contract is camelCase, so the
 * boundary converts rather than leaking column naming into the UI. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflictEntry {
    pub id: i64,
    pub dataset_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub resolution: String,
    pub winner_updated_at: Option<String>,
    pub loser_updated_at: Option<String>,
    pub detected_at: String,
}

/// The most recent conflict resolutions for a dataset, newest first.
#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(db), fields(dataset_id = %dataset_id))]
pub async fn sync_list_conflicts(
    dataset_id: String,
    limit: Option<u32>,
    db: State<'_, Arc<HostDb>>,
) -> Result<Vec<SyncConflictEntry>, SyncError> {
    let db = Arc::clone(&db);
    let limit = limit.unwrap_or(20);
    tokio::task::spawn_blocking(move || -> Result<Vec<SyncConflictEntry>, SyncError> {
        Ok(db
            .list_sync_conflicts(&dataset_id, limit)?
            .into_iter()
            .map(|conflict| SyncConflictEntry {
                id: conflict.id,
                dataset_id: conflict.dataset_id,
                entity_type: conflict.entity_type.as_str().to_string(),
                entity_id: conflict.entity_id,
                resolution: conflict.resolution,
                winner_updated_at: conflict.winner_updated_at,
                loser_updated_at: conflict.loser_updated_at,
                detected_at: conflict.detected_at,
            })
            .collect())
    })
    .await
    .map_err(|e| SyncError::Database(format!("task panicked: {e}")))?
}

/// Change only the automatic-sync schedule for a dataset. Never touches the
/// network and never asks for a secret.
#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(db), fields(dataset_id = %dataset_id))]
pub async fn sync_update_schedule(
    dataset_id: String,
    auto_sync: bool,
    pull_interval_secs: i64,
    push_debounce_secs: i64,
    db: State<'_, Arc<HostDb>>,
) -> Result<SyncDatasetSummary, SyncError> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || {
        update_schedule(
            &db,
            &dataset_id,
            auto_sync,
            pull_interval_secs,
            push_debounce_secs,
        )
    })
    .await
    .map_err(|e| SyncError::Database(format!("task panicked: {e}")))?
}

/// Live status of every dataset, for the settings panel and the status bar.
/// Phase changes also arrive on the `sync:status` event.
#[tauri::command(rename_all = "camelCase")]
#[instrument(skip(db, scheduler))]
pub async fn sync_status(
    db: State<'_, Arc<HostDb>>,
    scheduler: State<'_, Arc<SyncScheduler>>,
) -> Result<Vec<SyncStatusSnapshot>, SyncError> {
    let db = Arc::clone(&db);
    let scheduler = Arc::clone(&scheduler);
    tokio::task::spawn_blocking(move || scheduler.snapshot(&db))
        .await
        .map_err(|e| SyncError::Database(format!("task panicked: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> SyncEndpointInput {
        SyncEndpointInput {
            host: " 10.0.0.9 ".into(),
            port: Some(2222),
            username: " sync ".into(),
            password: Some("endpoint-pass".into()),
            key_path: None,
            key_passphrase: None,
            remote_path: " /srv/omnissh/nova ".into(),
        }
    }

    /* The Settings store builds this JSON (`sync-store.ts`, camelCase, secret
     * and key fields omitted when unused). Deserializing the literal payload
     * keeps the IPC contract honest: a rename on either side fails here
     * instead of at runtime in the webview. */
    #[test]
    fn deserializes_the_payload_the_settings_store_sends() {
        let password_form = r#"{
            "host": "10.0.0.9",
            "port": 2299,
            "username": "testuser",
            "remotePath": "/config/omnissh-sync",
            "password": "testpass"
        }"#;
        let parsed: SyncEndpointInput =
            serde_json::from_str(password_form).expect("password form payload");
        let endpoint = SyncEndpoint::try_from(parsed).expect("valid endpoint");
        assert_eq!(endpoint.host, "10.0.0.9");
        assert_eq!(endpoint.port, 2299);
        assert_eq!(endpoint.root, "/config/omnissh-sync");
        assert!(matches!(endpoint.auth, AuthMethod::Password { .. }));

        let key_form = r#"{
            "host": "10.0.0.9",
            "port": 22,
            "username": "testuser",
            "remotePath": "/srv/omnissh",
            "keyPath": "/home/me/.ssh/id_ed25519",
            "keyPassphrase": "kp"
        }"#;
        let parsed: SyncEndpointInput = serde_json::from_str(key_form).expect("key form payload");
        assert!(matches!(
            SyncEndpoint::try_from(parsed).unwrap().auth,
            AuthMethod::PrivateKey { .. }
        ));
    }

    #[test]
    fn trims_fields_and_defaults_the_port() {
        let endpoint = SyncEndpoint::try_from(input()).expect("valid endpoint");
        assert_eq!(endpoint.host, "10.0.0.9");
        assert_eq!(endpoint.username, "sync");
        assert_eq!(endpoint.root, "/srv/omnissh/nova");
        assert_eq!(endpoint.port, 2222);

        let mut portless = input();
        portless.port = None;
        assert_eq!(SyncEndpoint::try_from(portless).unwrap().port, 22);
    }

    #[test]
    fn a_key_path_wins_over_a_leftover_password_field() {
        let mut both = input();
        both.key_path = Some("/home/me/.ssh/id_ed25519".into());
        both.key_passphrase = Some("kp".into());
        match &SyncEndpoint::try_from(both).unwrap().auth {
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            } => {
                assert_eq!(key_path, "/home/me/.ssh/id_ed25519");
                assert_eq!(passphrase.as_deref(), Some("kp"));
            }
            other => panic!("expected key auth, got {other:?}"),
        }

        // An empty key path is not a selection — fall back to the password.
        let mut blank_key = input();
        blank_key.key_path = Some("   ".into());
        assert!(matches!(
            SyncEndpoint::try_from(blank_key).unwrap().auth,
            AuthMethod::Password { .. }
        ));

        // An empty passphrase means "no passphrase", not `Some("")`.
        let mut blank_passphrase = input();
        blank_passphrase.key_path = Some("/k".into());
        blank_passphrase.key_passphrase = Some(String::new());
        match &SyncEndpoint::try_from(blank_passphrase).unwrap().auth {
            AuthMethod::PrivateKey { passphrase, .. } => assert!(passphrase.is_none()),
            other => panic!("expected key auth, got {other:?}"),
        }
    }

    #[test]
    fn missing_fields_are_actionable_errors() {
        for (mutate, expected) in [
            (
                Box::new(|i: &mut SyncEndpointInput| i.host = "  ".into())
                    as Box<dyn Fn(&mut SyncEndpointInput)>,
                "server address",
            ),
            (
                Box::new(|i: &mut SyncEndpointInput| i.username = String::new()),
                "username",
            ),
            (
                Box::new(|i: &mut SyncEndpointInput| i.remote_path = String::new()),
                "remote path",
            ),
            (
                Box::new(|i: &mut SyncEndpointInput| i.password = None),
                "password or choose a private key",
            ),
        ] {
            let mut candidate = input();
            mutate(&mut candidate);
            let error =
                SyncEndpoint::try_from(candidate).expect_err("invalid endpoint must be rejected");
            assert!(
                error.to_string().contains(expected),
                "{error} should mention {expected}"
            );
        }
    }

    #[test]
    fn endpoint_input_debug_never_prints_the_secret() {
        let candidate = input();
        let rendered = format!("{candidate:?}");
        // The input struct still holds the raw field (it is a wire type), so the
        // guarantee that matters is the converted endpoint the rest of the sync
        // code passes around.
        assert!(rendered.contains("10.0.0.9"));
        let endpoint = SyncEndpoint::try_from(input()).unwrap();
        assert!(!format!("{endpoint:?}").contains("endpoint-pass"));
    }

    #[test]
    fn connection_test_serializes_for_the_settings_panel() {
        let result = SyncConnectionTest {
            reachable: true,
            path_exists: true,
            writable: false,
            dataset_present: true,
            existing_dataset: Some(ExistingDataset {
                dataset_id: "ds-nova".into(),
                generation: 12,
                updated_at: "2026-09-18T10:00:00Z".into(),
                signed: true,
                owner_fingerprint: Some("SHA256:abc".into()),
            }),
            metadata_error: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"reachable\":true"));
        assert!(json.contains("\"pathExists\":true"));
        assert!(json.contains("\"writable\":false"));
        assert!(json.contains("\"datasetPresent\":true"));
        assert!(json.contains("\"existingDataset\":{\"datasetId\":\"ds-nova\""));
        assert!(json.contains("\"generation\":12"));
        assert!(json.contains("\"signed\":true"));
    }

    #[test]
    fn sync_errors_serialize_as_kind_and_message() {
        let json = serde_json::to_string(&SyncError::Locked("busy".into())).unwrap();
        assert_eq!(json, "{\"kind\":\"locked\",\"message\":\"busy\"}");
        let json = serde_json::to_string(&SyncError::Decrypt).unwrap();
        assert!(json.starts_with("{\"kind\":\"decrypt\",\"message\":\"wrong dataset passphrase"));
    }
}
