/*
 * Publishing a dataset.
 *
 * Order matters, and every step here exists to make a push either fully
 * visible to other clients or not visible at all:
 *
 *  1. take the writer lock (SFTP `O_EXCL`, stale after 60 s)
 *  2. read the remote metadata and check the generation we based ourselves on
 *  3. collect + seal locally (nothing remote is touched yet)
 *  4. archive the generation that is being replaced into `history/`
 *  5. publish `dataset.bin`, then `dataset.meta.json` — bundle first, so a
 *     crash between the two leaves readers on the previous, still-consistent
 *     metadata rather than pointing them at a bundle that is not there
 *  6. prune history, release the lock, disconnect
 *  7. only then record the new base state locally
 *
 * A generation mismatch (someone else published in between) aborts before any
 * remote write with `SyncError::Conflict`, because merging is the pull path's
 * job — a push must never resolve a conflict by overwriting.
 */

use std::sync::Arc;

use serde::Serialize;
use tracing::instrument;

use crate::db::{HostDb, SyncEntityType, SyncRecordState};
use crate::ssh::manager::SshManager;
use crate::vault::LocalVault;

use super::codec::{payload_digest, seal_payload, unwrap_dataset_key};
use super::collect::{collect, credential_preflight, CollectStats};
use super::dataset::{endpoint_for, pack_wrapped_key, row_wrap, SyncContentFlags};
use super::meta::{DatasetMeta, META_FORMAT_VERSION};
use super::scope::{self, ResolvedScope};
use super::secrets;
use super::signing;
use super::transport::{RemoteStore, DATASET_FILE, HISTORY_KEEP, LOCK_STALE_AFTER, META_FILE};
use super::SyncError;

/// What a push published.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushOutcome {
    pub dataset_id: String,
    pub generation: u64,
    pub hosts: usize,
    pub groups: usize,
    pub snippets: usize,
    pub snippet_folders: usize,
    pub port_forwards: usize,
    pub s3_connections: usize,
    pub host_plugins: usize,
    pub app_settings: bool,
    pub tombstones: usize,
    /// Hosts that left this dataset's scope with this push (Task 8).
    pub scope_removals: usize,
    pub credentials_included: usize,
}

impl SyncPushOutcome {
    fn new(dataset_id: &str, generation: u64, stats: CollectStats) -> Self {
        Self {
            dataset_id: dataset_id.to_string(),
            generation,
            hosts: stats.hosts,
            groups: stats.groups,
            snippets: stats.snippets,
            snippet_folders: stats.snippet_folders,
            port_forwards: stats.port_forwards,
            s3_connections: stats.s3_connections,
            host_plugins: stats.host_plugins,
            app_settings: stats.app_settings,
            tombstones: stats.tombstones,
            scope_removals: stats.scope_removals,
            credentials_included: stats.credentials_included,
        }
    }
}

/// Readability of in-scope secrets, reported before a push touches anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushPreflight {
    pub dataset_id: String,
    pub include_credentials: bool,
    pub vault_locked: bool,
    pub hosts_in_scope: usize,
    pub credentials_readable: usize,
    pub credentials_blocked: usize,
    /* Whether the account for this dataset can create files at the remote
     * root, probed with a create+remove round-trip (AD-8). A member row that
     * reports writable here is the server not enforcing read-only, and the UI
     * says so with the remote-side fix. */
    pub remote_writable: bool,
}

pub async fn preflight(
    ssh: &SshManager,
    db: &HostDb,
    local_vault: &LocalVault,
    dataset_id: &str,
) -> Result<SyncPushPreflight, SyncError> {
    let row = db
        .get_sync_dataset(dataset_id)?
        .ok_or_else(|| SyncError::NotFound(format!("no such sync dataset: {dataset_id}")))?;
    let flags = SyncContentFlags::from_json(&row.content_flags);
    let scope = scope::resolve_row(db, &row)?;
    let (hosts_in_scope, readable, blocked) = credential_preflight(db, local_vault, &scope, flags)?;

    /* The write probe connects: a real create+remove at the dataset root says
     * whether this account could publish, which is exactly what a member row
     * must warn about. The session is released before returning either way. */
    let endpoint = endpoint_for(&row)?;
    let store = RemoteStore::connect(ssh, &endpoint).await?;
    let probe = store.probe().await;
    store.close(ssh).await;
    let remote_writable = probe?.writable;

    Ok(SyncPushPreflight {
        dataset_id: row.id,
        include_credentials: flags.includes_credentials(),
        /* Only reported as locked when it actually blocks this push: a dataset
         * that does not carry credentials does not care about the vault. */
        vault_locked: flags.includes_credentials() && !local_vault.is_unlocked(),
        hosts_in_scope,
        credentials_readable: readable,
        credentials_blocked: blocked,
        remote_writable,
    })
}

#[instrument(skip(ssh, db, local_vault), fields(dataset_id = %dataset_id))]
pub async fn push(
    ssh: &SshManager,
    db: &Arc<HostDb>,
    local_vault: &Arc<LocalVault>,
    dataset_id: &str,
) -> Result<SyncPushOutcome, SyncError> {
    let row = db
        .get_sync_dataset(dataset_id)?
        .ok_or_else(|| SyncError::NotFound(format!("no such sync dataset: {dataset_id}")))?;
    if row.role != "owner" {
        return Err(SyncError::RoleDenied(
            "this dataset is joined as a member, which can pull but not publish — publishing needs the owner role and the owner signing key on this machine".into(),
        ));
    }

    let flags = SyncContentFlags::from_json(&row.content_flags);
    let scope = scope::resolve_row(db, &row)?;
    if flags.includes_credentials() && !local_vault.is_unlocked() {
        /* Fail before connecting: publishing a dataset that claims to carry
         * credentials while silently omitting the App Vault ones would leave
         * the other machine with unusable hosts. */
        let counts = credential_preflight(db, local_vault, &scope, flags)?;
        if counts.2 > 0 {
            return Err(SyncError::Vault(
                "unlock the App Vault to include credentials in this dataset".into(),
            ));
        }
    }

    let passphrase = secrets::load_passphrase(&row.id)?;
    let endpoint = endpoint_for(&row)?;
    let store = RemoteStore::connect(ssh, &endpoint).await?;

    let published = publish(
        &store,
        db,
        local_vault,
        &row.id,
        row.last_generation,
        flags,
        scope,
        &passphrase,
        row_wrap(&row),
        secrets::client_id(db)?,
    )
    .await;

    // The lock is released on every path, including a failed publish.
    let _ = store.release_lock().await;
    store.close(ssh).await;
    let published = published?;

    /* Local bookkeeping happens only after the remote accepted the bundle, so
     * a failed publish leaves the base state describing what is actually on the
     * server. */
    let states: Vec<SyncRecordState> = published
        .bases
        .into_iter()
        .map(|base| SyncRecordState {
            dataset_id: row.id.clone(),
            entity_type: base.entity_type,
            entity_id: base.entity_id,
            remote_revision: base.revision,
            base_hash: base.hash,
            // The owner's own records stay editable; `managed` is the member-side
            // read-only marker (AD-9).
            managed: false,
            synced_at: String::new(),
        })
        .collect();
    db.upsert_sync_record_state(&states)?;

    /* The hosts that left the scope keep their local rows and credentials; this
     * dataset only stops claiming them, which is exactly what the `scopeRemovals`
     * records just published told every other client to do. */
    for host_id in &published.scope_removals {
        db.clear_sync_record_state(&row.id, Some((SyncEntityType::Host, host_id.as_str())))?;
    }

    let mut updated = row.clone();
    updated.last_generation = published.outcome.generation as i64;
    updated.owner_fingerprint = Some(published.owner_fingerprint.clone());
    updated.last_synced_at = Some(chrono::Utc::now().to_rfc3339());
    db.upsert_sync_dataset(&updated)?;

    Ok(published.outcome)
}

/// What a passphrase rotation published: the dataset and its new generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRotateOutcome {
    pub dataset_id: String,
    pub generation: u64,
}

/* Owner-only passphrase rotation (Task 9). The dataset key is rewrapped — the
 * payload bytes are untouched — and the new wrap is published as a fresh
 * signed generation with the previous one archived to `history/`. Members
 * still holding the old passphrase fail the wrap afterwards on the existing
 * `Decrypt` ("wrong dataset passphrase") path, never with a corrupt apply. */
#[instrument(skip(ssh, db, local_vault, new_passphrase), fields(dataset_id = %dataset_id))]
pub async fn rotate_passphrase(
    ssh: &SshManager,
    db: &Arc<HostDb>,
    local_vault: &Arc<LocalVault>,
    dataset_id: &str,
    new_passphrase: &str,
) -> Result<SyncRotateOutcome, SyncError> {
    let row = db
        .get_sync_dataset(dataset_id)?
        .ok_or_else(|| SyncError::NotFound(format!("no such sync dataset: {dataset_id}")))?;
    if row.role != "owner" {
        return Err(SyncError::RoleDenied(
            "only the dataset owner can rotate the passphrase — members pull but never publish"
                .into(),
        ));
    }
    secrets::validate_passphrase(new_passphrase)?;
    let current_passphrase = secrets::load_passphrase(&row.id)?;
    let flags = SyncContentFlags::from_json(&row.content_flags);
    if flags.includes_credentials() && !local_vault.is_unlocked() {
        return Err(SyncError::Vault(
            "unlock the App Vault to rotate a dataset that carries credentials".into(),
        ));
    }

    let endpoint = endpoint_for(&row)?;
    let store = RemoteStore::connect(ssh, &endpoint).await?;
    let rotated = rotate(
        &store,
        &row.id,
        row.last_generation,
        &current_passphrase,
        new_passphrase,
        secrets::client_id(db)?,
    )
    .await;
    let _ = store.release_lock().await;
    store.close(ssh).await;
    let (generation, key_wrap, owner_fingerprint) = rotated?;

    /* The row and the stored passphrase move together only after the remote
     * accepted the new wrap: a failed rotation must leave the old passphrase
     * opening the published generation. */
    let mut updated = row.clone();
    updated.last_generation = generation as i64;
    updated.owner_fingerprint = Some(owner_fingerprint);
    updated.kdf_salt = Some(key_wrap.salt.clone());
    updated.kdf_m_kib = Some(key_wrap.m_kib);
    updated.kdf_t = Some(key_wrap.t);
    updated.kdf_p = Some(key_wrap.p);
    updated.wrapped_key = Some(pack_wrapped_key(&key_wrap));
    updated.updated_at = chrono::Utc::now().to_rfc3339();
    db.upsert_sync_dataset(&updated)?;
    secrets::save_passphrase(&row.id, new_passphrase)?;

    Ok(SyncRotateOutcome {
        dataset_id: row.id,
        generation,
    })
}

/* Split out so the caller releases the lock and disconnects on every path,
 * like `publish`. Returns the new generation, wrap, and fingerprint. */
async fn rotate(
    store: &RemoteStore,
    dataset_id: &str,
    base_generation: i64,
    current_passphrase: &str,
    new_passphrase: &str,
    writer_client_id: String,
) -> Result<(u64, super::codec::KeyWrap, String), SyncError> {
    store.ensure_root().await?;
    store.acquire_lock(LOCK_STALE_AFTER).await?;

    let remote_meta = match store.read(META_FILE).await? {
        Some(bytes) => Some(DatasetMeta::parse(&bytes)?),
        None => None,
    };
    let remote_meta = remote_meta.ok_or_else(|| {
        SyncError::NotFound(
            "nothing has been published to this dataset yet — push before rotating".into(),
        )
    })?;
    if remote_meta.dataset_id != dataset_id {
        return Err(SyncError::Conflict(format!(
            "a different dataset ({}) is published at this path; point this dataset at another directory",
            remote_meta.dataset_id
        )));
    }
    if remote_meta.generation as i64 != base_generation {
        return Err(SyncError::Conflict(format!(
            "the server is at generation {} and this machine last saw {base_generation} — pull before rotating",
            remote_meta.generation
        )));
    }

    /* Unwrapping with the current passphrase proves it opens the published
     * wrap; a wrong one fails here on `Decrypt`, before anything is written. */
    let dataset_key = unwrap_dataset_key(current_passphrase, &remote_meta.key_wrap)?;
    let key_wrap = super::codec::wrap_dataset_key(new_passphrase, &dataset_key)?;

    let generation = remote_meta.generation.saturating_add(1);
    /* The payload is untouched, so the digest carries over — and with it the
     * proviso that the signature stays valid across the rotation. */
    let mut meta = DatasetMeta {
        format_version: META_FORMAT_VERSION,
        dataset_id: dataset_id.to_string(),
        generation,
        payload_sha256: remote_meta.payload_sha256.clone(),
        key_wrap: key_wrap.clone(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        writer_client_id,
        owner_fingerprint: None,
        owner_pubkey: None,
        signature: None,
    };
    let owner_key = owner_signing_key(dataset_id, Some(&remote_meta))?;
    let (owner_fingerprint, signature) = signing::sign(&meta, &owner_key)?;
    meta.owner_fingerprint = Some(owner_fingerprint.clone());
    meta.owner_pubkey = Some(signing::public_key_b64(&owner_key));
    meta.signature = Some(signature);
    let meta_bytes = meta.to_bytes()?;

    if let Some(previous_bundle) = store.read(DATASET_FILE).await? {
        let previous_meta_bytes = remote_meta.to_bytes()?;
        store
            .archive_generation(
                remote_meta.generation,
                &previous_bundle,
                &previous_meta_bytes,
            )
            .await?;
    }
    store.write_atomic(META_FILE, &meta_bytes).await?;
    store.prune_history(HISTORY_KEEP).await?;

    Ok((generation, key_wrap, owner_fingerprint))
}

/// What one publish produced: the report, the base state to record, and the
/// hosts this dataset dropped from its scope.
struct Published {
    outcome: SyncPushOutcome,
    bases: Vec<super::collect::CollectedBase>,
    scope_removals: Vec<String>,
    /* The owner fingerprint the published generation is signed with, so the
     * row keeps the pin it advertises to joining members. */
    owner_fingerprint: String,
}

/* The owner key for one publish (Task 9, AD-8). A signed remote demands the
 * matching local key — publishing unsigned over it, or silently re-keying,
 * would break every member's pin. An unsigned remote takes the local key,
 * generated on first use, so the first owner push is the first signed one. */
fn owner_signing_key(
    dataset_id: &str,
    remote_meta: Option<&DatasetMeta>,
) -> Result<ed25519_dalek::SigningKey, SyncError> {
    if let Some(remote_fingerprint) = remote_meta
        .as_ref()
        .and_then(|meta| meta.owner_fingerprint.as_deref())
    {
        let seed = secrets::load_signing_seed(dataset_id).map_err(|_| {
            SyncError::Crypto(
                "this dataset is signed on the server but this machine does not hold the owner signing key — publish from the machine that created it".into(),
            )
        })?;
        let key = signing::signing_key_from_seed(seed.as_slice())?;
        if signing::fingerprint(&key.verifying_key()) != remote_fingerprint {
            return Err(SyncError::Crypto(
                "this machine's owner signing key does not match the published dataset — publish from the machine that created it".into(),
            ));
        }
        return Ok(key);
    }
    match secrets::load_signing_seed(dataset_id) {
        Ok(seed) => signing::signing_key_from_seed(seed.as_slice()),
        Err(SyncError::NotFound(_)) => {
            let (seed, _) = signing::generate_keypair()?;
            secrets::save_signing_seed(dataset_id, seed.as_slice())?;
            signing::signing_key_from_seed(seed.as_slice())
        }
        Err(error) => Err(error),
    }
}
/* Split out so the caller can guarantee lock release and disconnect with a
 * single `?`-free tail: everything in here may fail, and the caller's cleanup
 * must run regardless. */
#[allow(clippy::too_many_arguments)]
async fn publish(
    store: &RemoteStore,
    db: &Arc<HostDb>,
    local_vault: &Arc<LocalVault>,
    dataset_id: &str,
    base_generation: i64,
    flags: SyncContentFlags,
    scope: ResolvedScope,
    passphrase: &str,
    row_key_wrap: Option<super::codec::KeyWrap>,
    writer_client_id: String,
) -> Result<Published, SyncError> {
    store.ensure_root().await?;
    store.acquire_lock(LOCK_STALE_AFTER).await?;

    let remote_meta = match store.read(META_FILE).await? {
        Some(bytes) => Some(DatasetMeta::parse(&bytes)?),
        None => None,
    };

    // The wrap that protects this dataset: the remote's when published, else ours.
    let key_wrap = match remote_meta.as_ref() {
        Some(meta) => {
            if meta.dataset_id != dataset_id {
                return Err(SyncError::Conflict(format!(
                    "a different dataset ({}) is published at this path; point this dataset at another directory",
                    meta.dataset_id
                )));
            }
            if meta.generation as i64 != base_generation {
                return Err(SyncError::Conflict(format!(
                    "the server is at generation {} and this machine last saw {base_generation} — pull before pushing",
                    meta.generation
                )));
            }
            meta.key_wrap.clone()
        }
        None => row_key_wrap.ok_or_else(|| {
            SyncError::NotFound(
                "this dataset has no encryption key on this machine — re-save it in Settings"
                    .into(),
            )
        })?,
    };
    let dataset_key = unwrap_dataset_key(passphrase, &key_wrap)?;

    let generation = remote_meta
        .as_ref()
        .map(|meta| meta.generation)
        .unwrap_or(base_generation.max(0) as u64)
        .saturating_add(1);

    // Collecting and sealing touch the DB and the CPU, never the network.
    let db_for_collect = Arc::clone(db);
    let vault_for_collect = Arc::clone(local_vault);
    let dataset_id_owned = dataset_id.to_string();
    let collected = tokio::task::spawn_blocking(move || {
        collect(
            &db_for_collect,
            &vault_for_collect,
            &dataset_id_owned,
            generation,
            flags,
            &scope,
        )
    })
    .await
    .map_err(|e| SyncError::Database(format!("collect task panicked: {e}")))??;

    let bundle = seal_payload(&dataset_key, &collected.payload)?;
    let mut meta = DatasetMeta {
        format_version: META_FORMAT_VERSION,
        dataset_id: dataset_id.to_string(),
        generation,
        payload_sha256: payload_digest(&bundle),
        key_wrap,
        updated_at: chrono::Utc::now().to_rfc3339(),
        writer_client_id,
        owner_fingerprint: None,
        owner_pubkey: None,
        signature: None,
    };
    /* Every owner-published generation is signed; single-user unsigned
     * datasets stay readable on the pull path, which pins nothing for them. */
    let owner_key = owner_signing_key(dataset_id, remote_meta.as_ref())?;
    let (owner_fingerprint, signature) = signing::sign(&meta, &owner_key)?;
    meta.owner_fingerprint = Some(owner_fingerprint.clone());
    meta.owner_pubkey = Some(signing::public_key_b64(&owner_key));
    meta.signature = Some(signature);
    let meta_bytes = meta.to_bytes()?;

    /* Archive the generation being replaced before overwriting it, so a bad
     * push is recoverable from `history/` (Task 11) rather than lost. */
    if let (Some(previous_meta), Some(previous_bundle)) =
        (remote_meta.as_ref(), store.read(DATASET_FILE).await?)
    {
        let previous_meta_bytes = previous_meta.to_bytes()?;
        store
            .archive_generation(
                previous_meta.generation,
                &previous_bundle,
                &previous_meta_bytes,
            )
            .await?;
    }

    store.write_atomic(DATASET_FILE, &bundle).await?;
    store.write_atomic(META_FILE, &meta_bytes).await?;
    store.prune_history(HISTORY_KEEP).await?;

    Ok(Published {
        outcome: SyncPushOutcome::new(dataset_id, generation, collected.stats),
        bases: collected.bases,
        scope_removals: collected.scope_removals,
        owner_fingerprint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_reports_every_section_count() {
        let stats = CollectStats {
            hosts: 4,
            groups: 2,
            snippets: 7,
            snippet_folders: 1,
            port_forwards: 3,
            s3_connections: 1,
            host_plugins: 5,
            app_settings: true,
            tombstones: 2,
            scope_removals: 1,
            credentials_included: 4,
            credentials_blocked: 0,
        };
        let outcome = SyncPushOutcome::new("ds-nova", 9, stats);
        let json = serde_json::to_string(&outcome).unwrap();

        assert!(json.contains("\"datasetId\":\"ds-nova\""));
        assert!(json.contains("\"generation\":9"));
        assert!(json.contains("\"hosts\":4"));
        assert!(json.contains("\"snippetFolders\":1"));
        assert!(json.contains("\"appSettings\":true"));
        assert!(json.contains("\"credentialsIncluded\":4"));
        /* A host leaving the scope is reported apart from a deletion: the two
         * mean opposite things on the receiving machine. */
        assert!(json.contains("\"scopeRemovals\":1"));
        assert!(json.contains("\"tombstones\":2"));
        // A blocked-credential count belongs to the preflight, not the outcome.
        assert!(!json.contains("credentialsBlocked"));
    }

    #[test]
    fn preflight_serializes_for_the_push_dialog() {
        let preflight = SyncPushPreflight {
            dataset_id: "ds-nova".into(),
            include_credentials: true,
            vault_locked: true,
            hosts_in_scope: 12,
            credentials_readable: 8,
            credentials_blocked: 4,
            remote_writable: true,
        };
        let json = serde_json::to_string(&preflight).unwrap();
        assert!(json.contains("\"datasetId\":\"ds-nova\""));
        assert!(json.contains("\"includeCredentials\":true"));
        assert!(json.contains("\"vaultLocked\":true"));
        assert!(json.contains("\"hostsInScope\":12"));
        assert!(json.contains("\"credentialsBlocked\":4"));
        assert!(json.contains("\"remoteWritable\":true"));
    }
}

/* End-to-end publish against a real SFTP server, opt-in like the transport
 * live check (`OMNISSH_SYNC_TEST_HOST`). It exercises the whole push path —
 * temp database, keychain secrets, generation chain, history, conflict
 * detection — and then decrypts what landed on the server to prove the bytes
 * are the dataset we meant to publish.
 *
 *   docker run -d --rm -p 2299:2222 -e USER_NAME=testuser \
 *     -e USER_PASSWORD=testpass -e PASSWORD_ACCESS=true \
 *     lscr.io/linuxserver/openssh-server:latest
 *   OMNISSH_SYNC_TEST_HOST=127.0.0.1 OMNISSH_SYNC_TEST_PORT=2299 \
 *     cargo test --lib sync::push::live -- --nocapture --test-threads=1
 */
#[cfg(test)]
mod live {
    use super::*;
    use crate::db::{CredentialStorage, HostGroup, SavedHost, SyncDataset};
    use crate::sync::codec::{open_payload, unwrap_dataset_key};
    use crate::sync::dataset::{pack_wrapped_key, SyncContentFlags};
    use crate::sync::secrets;
    use crate::sync::transport::{RemoteStore, SyncEndpoint, DATASET_FILE, META_FILE};
    use crate::types::session::AuthMethod;
    use crate::vault::StoredCredential;

    const PASSPHRASE: &str = "live-dataset-passphrase";

    struct Fixture {
        db: Arc<HostDb>,
        vault: Arc<LocalVault>,
        ssh: SshManager,
        dataset_id: String,
        root: String,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Option<Fixture> {
        let host = std::env::var("OMNISSH_SYNC_TEST_HOST").ok()?;
        let port: u16 = std::env::var("OMNISSH_SYNC_TEST_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(2222);
        let dataset_id = format!("live-{}", uuid::Uuid::new_v4());
        let root = format!("/config/omnissh-push-{dataset_id}");

        let dir = tempfile::tempdir().expect("temp dir");
        let db = Arc::new(HostDb::new(dir.path()).expect("temp database"));

        db.create_group(&HostGroup {
            id: "g-nova".into(),
            name: "NOVA".into(),
            color: "#6366f1".into(),
            icon: None,
            sort_order: 0,
            default_username: None,
            created_at: String::new(),
            updated_at: String::new(),
        })
        .expect("group");
        for (id, label) in [("h-1", "nova-db-01"), ("h-2", "nova-web-01")] {
            db.save_host(&SavedHost {
                id: id.into(),
                label: label.into(),
                host: "10.0.0.5".into(),
                port: 22,
                username: "deployer".into(),
                auth_type: "password".into(),
                credential_storage: CredentialStorage::Keychain,
                group_id: Some("g-nova".into()),
                created_at: String::new(),
                updated_at: String::new(),
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
            })
            .expect("host");
        }

        // Dataset row + key, exactly as `save_dataset` would have written them.
        let key = crate::sync::codec::generate_dataset_key().expect("key");
        let wrap = crate::sync::codec::wrap_dataset_key(PASSPHRASE, &key).expect("wrap");
        db.upsert_sync_dataset(&SyncDataset {
            id: dataset_id.clone(),
            name: "Live NOVA".into(),
            host: host.clone(),
            port,
            username: std::env::var("OMNISSH_SYNC_TEST_USER").unwrap_or_else(|_| "testuser".into()),
            auth_type: "password".into(),
            remote_path: root.clone(),
            role: "owner".into(),
            content_flags: SyncContentFlags::default().to_json().expect("flags"),
            scope_mode: "{\"mode\":\"all\"}".into(),
            auto_sync: false,
            pull_interval_secs: 0,
            push_debounce_secs: 0,
            owner_fingerprint: None,
            kdf_salt: Some(wrap.salt.clone()),
            kdf_m_kib: Some(wrap.m_kib),
            kdf_t: Some(wrap.t),
            kdf_p: Some(wrap.p),
            wrapped_key: Some(pack_wrapped_key(&wrap)),
            last_generation: 0,
            last_synced_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        })
        .expect("dataset row");

        secrets::save_server_secret(
            &dataset_id,
            &StoredCredential::Password {
                password: std::env::var("OMNISSH_SYNC_TEST_PASS")
                    .unwrap_or_else(|_| "testpass".into()),
            },
        )
        .expect("server secret");
        secrets::save_passphrase(&dataset_id, PASSPHRASE).expect("passphrase");

        Some(Fixture {
            db,
            vault: Arc::new(LocalVault::new()),
            ssh: SshManager::new(),
            dataset_id,
            root,
            _dir: dir,
        })
    }

    fn endpoint(fixture: &Fixture) -> SyncEndpoint {
        SyncEndpoint {
            host: std::env::var("OMNISSH_SYNC_TEST_HOST").unwrap_or_default(),
            port: std::env::var("OMNISSH_SYNC_TEST_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(2222),
            username: std::env::var("OMNISSH_SYNC_TEST_USER").unwrap_or_else(|_| "testuser".into()),
            auth: AuthMethod::Password {
                password: std::env::var("OMNISSH_SYNC_TEST_PASS")
                    .unwrap_or_else(|_| "testpass".into()),
            },
            root: fixture.root.clone(),
        }
    }

    #[tokio::test]
    async fn publishes_a_decryptable_dataset_and_chains_generations() {
        let Some(fixture) = fixture() else {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live push check");
            return;
        };

        let first = push(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
        )
        .await
        .expect("first push");
        assert_eq!(first.generation, 1);
        assert_eq!(first.hosts, 2);
        assert_eq!(first.groups, 1);
        assert!(first.app_settings, "app settings are on by default");
        assert_eq!(
            first.credentials_included, 0,
            "credentials are off by default"
        );

        // The row now tracks the published generation.
        let row = fixture
            .db
            .get_sync_dataset(&fixture.dataset_id)
            .unwrap()
            .expect("row");
        assert_eq!(row.last_generation, 1);
        assert!(row.last_synced_at.is_some());

        // Read the published objects back and decrypt them.
        let store = RemoteStore::connect(&fixture.ssh, &endpoint(&fixture))
            .await
            .expect("reader connects");
        let meta_bytes = store.read(META_FILE).await.unwrap().expect("metadata");
        let bundle = store.read(DATASET_FILE).await.unwrap().expect("bundle");
        let meta = DatasetMeta::parse(&meta_bytes).expect("metadata parses");

        assert_eq!(meta.dataset_id, fixture.dataset_id);
        assert_eq!(meta.generation, 1);
        assert_eq!(meta.payload_sha256, payload_digest(&bundle));
        // The plaintext metadata must not leak host data.
        let meta_text = String::from_utf8(meta_bytes).unwrap();
        assert!(!meta_text.contains("nova-db-01"));
        assert!(!meta_text.contains(PASSPHRASE));

        let key = unwrap_dataset_key(PASSPHRASE, &meta.key_wrap).expect("passphrase opens the key");
        let payload = open_payload(&key, &bundle).expect("bundle decrypts");
        let hosts = payload.sections.hosts.expect("hosts section");
        assert_eq!(hosts.len(), 2);
        assert!(hosts.iter().any(|record| record.data.label == "nova-db-01"));
        assert!(hosts.iter().all(|record| record.revision == 1));
        assert!(hosts.iter().all(|record| record.credential.is_none()));
        assert_eq!(payload.generation, 1);

        // An unchanged second push chains the generation and archives the first.
        let second = push(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
        )
        .await
        .expect("second push");
        assert_eq!(second.generation, 2);
        assert_eq!(store.list_history().await.unwrap(), vec![1]);

        /* Republishing unchanged records must not look like an edit on the
         * other machine: revisions stay put across a generation bump. */
        let bundle = store.read(DATASET_FILE).await.unwrap().expect("bundle");
        let payload = open_payload(&key, &bundle).expect("bundle decrypts");
        assert!(payload
            .sections
            .hosts
            .expect("hosts")
            .iter()
            .all(|record| record.revision == 1));

        // A local edit bumps only that record's revision.
        let mut edited = fixture.db.get_host("h-1").unwrap().expect("host");
        edited.label = "nova-db-01-renamed".into();
        fixture.db.save_host(&edited).expect("edit host");
        let third = push(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
        )
        .await
        .expect("third push");
        assert_eq!(third.generation, 3);
        let payload = open_payload(
            &key,
            &store.read(DATASET_FILE).await.unwrap().expect("bundle"),
        )
        .expect("bundle decrypts");
        let hosts = payload.sections.hosts.expect("hosts");
        let renamed = hosts
            .iter()
            .find(|record| record.id == "h-1")
            .expect("edited host");
        let untouched = hosts
            .iter()
            .find(|record| record.id == "h-2")
            .expect("untouched host");
        assert_eq!(renamed.data.label, "nova-db-01-renamed");
        assert_eq!(renamed.revision, 2, "the edited record advances");
        assert_eq!(untouched.revision, 1, "its neighbour does not");

        // A delete travels as a tombstone.
        fixture.db.delete_host("h-2").expect("delete host");
        let fourth = push(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
        )
        .await
        .expect("fourth push");
        assert_eq!(fourth.hosts, 1);
        assert_eq!(fourth.tombstones, 1);
        let payload = open_payload(
            &key,
            &store.read(DATASET_FILE).await.unwrap().expect("bundle"),
        )
        .expect("bundle decrypts");
        assert_eq!(payload.tombstones.len(), 1);
        assert_eq!(payload.tombstones[0].entity_id, "h-2");
        assert_eq!(payload.tombstones[0].entity_type, "host");

        /* Stale-generation guard: rewind the local row as if another machine
         * had published in between. The push must refuse instead of clobbering. */
        let mut stale = fixture
            .db
            .get_sync_dataset(&fixture.dataset_id)
            .unwrap()
            .expect("row");
        stale.last_generation = 1;
        fixture.db.upsert_sync_dataset(&stale).expect("rewind row");
        let conflict = push(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
        )
        .await;
        match conflict {
            Err(SyncError::Conflict(message)) => {
                assert!(message.contains("pull before pushing"), "got {message}")
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
        // The refused push left the server untouched.
        let meta = DatasetMeta::parse(&store.read(META_FILE).await.unwrap().expect("metadata"))
            .expect("metadata");
        assert_eq!(meta.generation, 4);
        // …and released the lock it took.
        assert!(store.read("dataset.lock").await.unwrap().is_none());

        // Clean up remote objects and keychain secrets.
        for name in [DATASET_FILE, META_FILE] {
            store.remove(name).await.expect("remove object");
        }
        for generation in store.list_history().await.unwrap() {
            store
                .remove(&format!("history/{generation}.bin"))
                .await
                .expect("remove archived bundle");
            store
                .remove(&format!("history/{generation}.meta.json"))
                .await
                .expect("remove archived meta");
        }
        store.close(&fixture.ssh).await;
        secrets::delete_dataset_secrets(&fixture.dataset_id).expect("purge secrets");
    }
}
