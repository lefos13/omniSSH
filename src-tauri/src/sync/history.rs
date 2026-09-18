/*
 * Remote history and rollback (Task 11).
 *
 * The transport archives the generation a push replaces under
 * `history/<generation>.bin` + `.meta.json` and prunes to `HISTORY_KEEP`, so
 * recovering from a bad push means reading one of those generations back.
 *
 * Two operations, with deliberately different requirements:
 *
 * - `list_history` reads only the plaintext metadata copies: when a generation
 *   was published, which client published it, and what it carried. No
 *   passphrase, no bundle download, no decryption.
 * - `rollback` fetches one archived generation, checks everything a pull
 *   checks (owner signature, digest, key wrap), and applies it through
 *   `pull::apply` — the same merge entry point a pull uses — so records this
 *   machine created or changed since that generation survive as conflicts
 *   rather than being erased.
 *
 * The merged result is then published by the normal push path: history is only
 * ever appended to, nothing already on the server is overwritten in place, and
 * other machines converge on the rolled-back content by pulling as usual. The
 * one window that leaves open: a push by another client between the apply and
 * the republish is refused with `Conflict`, and the merged local state simply
 * waits for the next push — exactly like any other local edit.
 *
 * Rollback is owner-only, mirroring `push`: publishing needs the owner signing
 * key, and a member able to rewrite the shared dataset would break AD-8.
 * Nothing here logs a host, path, or credential.
 */

use std::sync::Arc;

use serde::Serialize;
use tracing::instrument;

use crate::db::{HostDb, SyncDataset};
use crate::ssh::manager::SshManager;
use crate::vault::LocalVault;

use super::codec::{open_payload, payload_digest, unwrap_dataset_key, SyncPayload};
use super::dataset::{endpoint_for, SyncContentFlags};
use super::meta::{record_counts_in, DatasetMeta, DatasetRecordCounts};
use super::pull::{self, SyncAppliedCounts};
use super::push::{self, SyncPushOutcome};
use super::secrets;
use super::signing;
use super::transport::{RemoteStore, HISTORY_DIR, HISTORY_KEEP, META_FILE};
use super::SyncError;

/// One generation still retained in `history/`, as the Settings list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryEntry {
    pub generation: u64,
    /* The three facts that identify a generation without decrypting anything.
     * They are absent only when the archived metadata copy is missing or
     * unreadable, which the row states rather than hiding the generation: its
     * bundle is still what a rollback applies. */
    pub updated_at: Option<String>,
    pub writer_client_id: Option<String>,
    pub record_counts: Option<DatasetRecordCounts>,
    /// Whether the generation carried an owner signature.
    pub signed: bool,
    pub owner_fingerprint: Option<String>,
}

impl SyncHistoryEntry {
    fn from_archive(generation: u64, archived: Option<&ArchivedMeta>) -> Self {
        match archived {
            Some(ArchivedMeta { meta, counts }) => Self {
                generation,
                updated_at: Some(meta.updated_at.clone()),
                writer_client_id: Some(meta.writer_client_id.clone()),
                record_counts: counts.clone(),
                signed: meta.signature.is_some(),
                owner_fingerprint: meta.owner_fingerprint.clone(),
            },
            None => Self {
                generation,
                updated_at: None,
                writer_client_id: None,
                record_counts: None,
                signed: false,
                owner_fingerprint: None,
            },
        }
    }
}

/// What the remote currently retains, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryListing {
    pub dataset_id: String,
    /// The generation published right now, which is not itself in history.
    pub current_generation: Option<u64>,
    pub entries: Vec<SyncHistoryEntry>,
}

/// What a rollback applied and what it published instead.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRollbackOutcome {
    pub dataset_id: String,
    /// The retained generation whose content was applied.
    pub rolled_back_to: u64,
    /// The new generation published with the merged result.
    pub generation: u64,
    /// What the merge wrote locally, counted like a pull's.
    pub applied: SyncAppliedCounts,
    pub deleted: usize,
    pub kept_local: usize,
    pub conflicts: usize,
    pub credentials_applied: usize,
    /// The publish that followed the merge.
    pub published: SyncPushOutcome,
}

/// Read one archived generation's plaintext metadata. `None` means the copy is
/// missing or unreadable — never that the generation does not exist.
struct ArchivedMeta {
    meta: DatasetMeta,
    counts: Option<DatasetRecordCounts>,
}

/// List the generations retained on the server.
///
/// Reads only metadata files: a dataset whose passphrase is unavailable — or
/// simply not wanted for a listing — is still fully listable.
#[instrument(skip(ssh, db), fields(dataset_id = %dataset_id))]
pub async fn list_history(
    ssh: &SshManager,
    db: &HostDb,
    dataset_id: &str,
) -> Result<SyncHistoryListing, SyncError> {
    let row = db
        .get_sync_dataset(dataset_id)?
        .ok_or_else(|| SyncError::NotFound(format!("no such sync dataset: {dataset_id}")))?;
    let endpoint = endpoint_for(&row)?;

    let store = RemoteStore::connect(ssh, &endpoint).await?;
    let listing = read_listing(&store, &row.id).await;
    store.close(ssh).await;
    listing
}

/// Roll the dataset back to a retained generation: apply it as a merge, then
/// publish the merged result as a new generation.
///
/// Owner only; a member cannot publish, and rolling back is a publish.
#[instrument(skip(ssh, db, local_vault), fields(dataset_id = %dataset_id, generation = generation))]
pub async fn rollback(
    ssh: &SshManager,
    db: &Arc<HostDb>,
    local_vault: &Arc<LocalVault>,
    dataset_id: &str,
    generation: u64,
) -> Result<SyncRollbackOutcome, SyncError> {
    let row = db
        .get_sync_dataset(dataset_id)?
        .ok_or_else(|| SyncError::NotFound(format!("no such sync dataset: {dataset_id}")))?;
    if row.role != "owner" {
        return Err(SyncError::RoleDenied(
            "this dataset is joined as a member: rolling one back publishes a new generation, which needs the owner role and the owner signing key on this machine".into(),
        ));
    }

    let flags = SyncContentFlags::from_json(&row.content_flags);
    let passphrase = secrets::load_passphrase(&row.id)?;
    let endpoint = endpoint_for(&row)?;

    let store = RemoteStore::connect(ssh, &endpoint).await?;
    let fetched = fetch_archived(&store, &row, generation, &passphrase).await;
    store.close(ssh).await;
    let payload = fetched?;

    /* Same merge a pull runs, so local-only records are kept and a losing copy
     * is logged as a conflict rather than dropped. */
    let db_for_apply = Arc::clone(db);
    let vault_for_apply = Arc::clone(local_vault);
    let dataset_id_owned = row.id.clone();
    let merged = tokio::task::spawn_blocking(move || {
        pull::apply(
            &db_for_apply,
            &vault_for_apply,
            &dataset_id_owned,
            generation,
            flags,
            false,
            payload,
        )
    })
    .await
    .map_err(|e| SyncError::Database(format!("apply task panicked: {e}")))??;

    /* An ordinary push of the merged state: it takes the lock, refuses a
     * generation it did not base itself on, archives the generation it
     * replaces, and bumps the counter — so history grows instead of being
     * rewritten, and the dataset row ends up pointing at the new generation.
     * The row is deliberately left alone by the merge above for this reason. */
    let published = push::push(ssh, db, local_vault, dataset_id).await?;

    Ok(SyncRollbackOutcome {
        dataset_id: row.id,
        rolled_back_to: generation,
        generation: published.generation,
        applied: merged.applied,
        deleted: merged.deleted,
        kept_local: merged.kept_local,
        conflicts: merged.conflicts,
        credentials_applied: merged.credentials_applied,
        published,
    })
}

async fn read_listing(
    store: &RemoteStore,
    dataset_id: &str,
) -> Result<SyncHistoryListing, SyncError> {
    let current_generation = match store.read(META_FILE).await? {
        Some(bytes) => Some(DatasetMeta::parse(&bytes)?.generation),
        None => None,
    };

    let mut archived = Vec::new();
    for generation in store.list_history().await? {
        archived.push((generation, read_archived_meta(store, generation).await?));
    }
    Ok(listing_from(dataset_id, current_generation, archived))
}

/* Shape the reads into the response. Kept apart from the I/O so the ordering
 * and the metadata projection are testable without a server. */
fn listing_from(
    dataset_id: &str,
    current_generation: Option<u64>,
    mut archived: Vec<(u64, Option<ArchivedMeta>)>,
) -> SyncHistoryListing {
    // A directory listing has no order; the row is read newest-first.
    archived.sort_by_key(|archived| std::cmp::Reverse(archived.0));
    SyncHistoryListing {
        dataset_id: dataset_id.to_string(),
        current_generation,
        entries: archived
            .into_iter()
            .map(|(generation, meta)| SyncHistoryEntry::from_archive(generation, meta.as_ref()))
            .collect(),
    }
}

/* A generation whose metadata copy is missing or unreadable still gets a row:
 * the bundle is what a rollback applies, and the row says "details
 * unavailable" rather than hiding a generation that is genuinely there. */
async fn read_archived_meta(
    store: &RemoteStore,
    generation: u64,
) -> Result<Option<ArchivedMeta>, SyncError> {
    let Some(bytes) = store.read(&archive_name(generation, "meta.json")).await? else {
        return Ok(None);
    };
    let Ok(meta) = DatasetMeta::parse(&bytes) else {
        return Ok(None);
    };
    /* Counts live beside the typed fields (`meta` module) so a document written
     * before they existed still parses, and simply lists without them. */
    let counts = record_counts_in(&bytes);
    Ok(Some(ArchivedMeta { meta, counts }))
}

/* Everything a rollback trusts is checked here, before the local database is
 * touched: the remote is still on the generation this machine last saw, the
 * archived pair is the requested generation, the owner signed it (when the
 * dataset is signed at all), the bundle matches its published digest, and the
 * stored passphrase opens the wrap. A wrong passphrase fails on the existing
 * `Decrypt` path with nothing applied. */
async fn fetch_archived(
    store: &RemoteStore,
    row: &SyncDataset,
    generation: u64,
    passphrase: &str,
) -> Result<SyncPayload, SyncError> {
    let current = match store.read(META_FILE).await? {
        Some(bytes) => Some(DatasetMeta::parse(&bytes)?),
        None => None,
    };
    let current = current.ok_or_else(|| {
        SyncError::NotFound("nothing has been published to this dataset yet".into())
    })?;
    if current.dataset_id != row.id {
        return Err(SyncError::Conflict(format!(
            "a different dataset ({}) is published at this path; point this dataset at another directory",
            current.dataset_id
        )));
    }
    if current.generation as i64 != row.last_generation {
        /* Refused before anything local changes: the merge base has to be the
         * published generation, and the republish checks the same thing again
         * under the lock. */
        return Err(SyncError::Conflict(format!(
            "the server is at generation {} and this machine last saw {} — pull before rolling back",
            current.generation, row.last_generation
        )));
    }

    let Some(meta_bytes) = store.read(&archive_name(generation, "meta.json")).await? else {
        return Err(not_retained(generation));
    };
    let Some(bundle) = store.read(&archive_name(generation, "bin")).await? else {
        return Err(not_retained(generation));
    };
    let meta = DatasetMeta::parse(&meta_bytes)?;
    if meta.dataset_id != row.id {
        return Err(SyncError::Conflict(format!(
            "the retained generation {generation} belongs to a different dataset ({})",
            meta.dataset_id
        )));
    }
    if meta.generation != generation {
        return Err(SyncError::Format(format!(
            "the retained metadata for generation {generation} describes generation {}",
            meta.generation
        )));
    }

    /* Verify-then-pin, exactly as a pull: a dataset with a pinned owner rejects
     * an archived generation that owner did not sign. */
    signing::verify_for_pull(row.owner_fingerprint.as_deref(), &meta)?;
    if payload_digest(&bundle) != meta.payload_sha256 {
        return Err(SyncError::Transport(format!(
            "retained generation {generation} does not match its metadata digest — the archived copy is incomplete"
        )));
    }

    let key = unwrap_dataset_key(passphrase, &meta.key_wrap)?;
    open_payload(&key, &bundle)
}

fn not_retained(generation: u64) -> SyncError {
    SyncError::NotFound(format!(
        "generation {generation} is no longer retained on the server — history keeps the last {HISTORY_KEEP} generations"
    ))
}

fn archive_name(generation: u64, extension: &str) -> String {
    format!("{HISTORY_DIR}/{generation}.{extension}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SyncDataset;
    use crate::sync::codec::{generate_dataset_key, wrap_dataset_key};
    use crate::sync::meta::META_FORMAT_VERSION;
    use crate::vault::LocalVault;

    fn row(id: &str, role: &str) -> SyncDataset {
        SyncDataset {
            id: id.into(),
            name: "NOVA".into(),
            host: "10.0.0.9".into(),
            port: 22,
            username: "sync".into(),
            auth_type: "password".into(),
            remote_path: "/srv/omnissh/nova".into(),
            role: role.into(),
            content_flags: "{}".into(),
            scope_mode: "{\"mode\":\"all\"}".into(),
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

    fn archived_meta(generation: u64, updated_at: &str, writer: &str) -> ArchivedMeta {
        let key = generate_dataset_key().unwrap();
        ArchivedMeta {
            meta: DatasetMeta {
                format_version: META_FORMAT_VERSION,
                dataset_id: "ds-1".into(),
                generation,
                payload_sha256: "a".repeat(64),
                key_wrap: wrap_dataset_key("dataset-passphrase", &key).unwrap(),
                updated_at: updated_at.into(),
                writer_client_id: writer.into(),
                owner_fingerprint: None,
                owner_pubkey: None,
                signature: None,
            },
            counts: Some(DatasetRecordCounts {
                hosts: 12,
                tombstones: 2,
                ..DatasetRecordCounts::default()
            }),
        }
    }

    #[test]
    fn history_is_listed_newest_first_with_what_each_generation_carried() {
        let listing = listing_from(
            "ds-1",
            Some(9),
            vec![
                (
                    2,
                    Some(archived_meta(2, "2026-09-17T09:00:00Z", "client-2")),
                ),
                (7, None),
                (
                    5,
                    Some(archived_meta(5, "2026-09-18T09:00:00Z", "client-5")),
                ),
            ],
        );

        assert_eq!(listing.dataset_id, "ds-1");
        assert_eq!(listing.current_generation, Some(9));
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.generation)
                .collect::<Vec<_>>(),
            vec![7, 5, 2]
        );

        let newest = &listing.entries[1];
        assert_eq!(newest.updated_at.as_deref(), Some("2026-09-18T09:00:00Z"));
        assert_eq!(newest.writer_client_id.as_deref(), Some("client-5"));
        assert_eq!(newest.record_counts.as_ref().map(|c| c.hosts), Some(12));
        assert!(!newest.signed, "an unsigned generation says so");

        /* A generation whose metadata copy is gone is still offered: its bundle
         * is what a rollback applies, and the row reports the gap instead of
         * pretending the generation is not there. */
        let unknown = &listing.entries[0];
        assert_eq!(unknown.generation, 7);
        assert_eq!(unknown.updated_at, None);
        assert_eq!(unknown.writer_client_id, None);
        assert_eq!(unknown.record_counts, None);
    }

    /* The role check runs before the endpoint is resolved, so a member row
     * without a stored server secret is refused as a role problem rather than
     * reported as a missing credential. */
    #[tokio::test]
    async fn rollback_refuses_members_and_unknown_datasets_without_connecting() {
        let directory = tempfile::tempdir().expect("temp dir");
        let db = Arc::new(HostDb::new(directory.path()).expect("temp database"));
        db.upsert_sync_dataset(&row("ds-1", "member")).expect("row");

        let error = rollback(
            &SshManager::new(),
            &db,
            &Arc::new(LocalVault::new()),
            "ds-1",
            1,
        )
        .await
        .expect_err("a member may not roll back");
        match error {
            SyncError::RoleDenied(message) => {
                assert!(message.contains("owner role"), "got {message}")
            }
            other => panic!("expected a role denial, got {other:?}"),
        }

        let error = rollback(
            &SshManager::new(),
            &db,
            &Arc::new(LocalVault::new()),
            "ds-missing",
            1,
        )
        .await
        .expect_err("unknown dataset");
        assert!(matches!(error, SyncError::NotFound(_)), "got {error:?}");
        assert!(
            list_history(&SshManager::new(), &db, "ds-missing")
                .await
                .is_err(),
            "listing an unknown dataset is an error, not an empty history"
        );
    }
}

/* Rollback against a real SFTP server, opt-in via `OMNISSH_SYNC_TEST_HOST`
 * (see `sync::push::live`, whose fixture and dataset this reuses).
 *   OMNISSH_SYNC_TEST_HOST=127.0.0.1 OMNISSH_SYNC_TEST_PORT=2299 \
 *     cargo test --lib sync::history::live -- --nocapture --test-threads=1
 */
#[cfg(test)]
mod live {
    use super::*;
    use crate::sync::codec::{open_payload, unwrap_dataset_key};
    use crate::sync::push::live::{endpoint, fixture, Fixture, PASSPHRASE};
    use crate::sync::transport::{DATASET_FILE, META_FILE};
    use crate::vault;

    async fn publish(fixture: &Fixture) -> u64 {
        push::push(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
        )
        .await
        .expect("push")
        .generation
    }

    async fn reader(fixture: &Fixture) -> RemoteStore {
        RemoteStore::connect(&fixture.ssh, &endpoint(fixture))
            .await
            .expect("reader connects")
    }

    async fn cleanup(fixture: &Fixture, store: &RemoteStore) {
        for name in [DATASET_FILE, META_FILE] {
            let _ = store.remove(name).await;
        }
        if let Ok(generations) = store.list_history().await {
            for generation in generations {
                let _ = store.remove(&format!("history/{generation}.bin")).await;
                let _ = store
                    .remove(&format!("history/{generation}.meta.json"))
                    .await;
            }
        }
        let _ = secrets::delete_dataset_secrets(&fixture.dataset_id);
    }

    /* A listing is metadata only: with the stored passphrase deleted, the
     * retained generations still report when they were published, who
     * published them, and what they carried. */
    #[tokio::test]
    async fn lists_retained_generations_without_a_passphrase() {
        let Some(fixture) = fixture() else {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live history check");
            return;
        };
        publish(&fixture).await;
        let store = reader(&fixture).await;
        fixture.db.delete_host("h-2").expect("delete host");
        assert_eq!(publish(&fixture).await, 2);

        // The passphrase is gone; the listing must not need it.
        vault::delete_credential(&secrets::passphrase_key(&fixture.dataset_id))
            .expect("drop the stored passphrase");

        let listing = list_history(&fixture.ssh, &fixture.db, &fixture.dataset_id)
            .await
            .expect("listing does not need a passphrase");
        assert_eq!(listing.current_generation, Some(2));
        assert_eq!(listing.entries.len(), 1);
        let entry = &listing.entries[0];
        assert_eq!(entry.generation, 1);
        assert!(entry.updated_at.is_some(), "a generation is timestamped");
        assert_eq!(
            entry.writer_client_id.as_deref(),
            Some(secrets::client_id(&fixture.db).unwrap().as_str()),
            "the publishing installation is named"
        );
        assert_eq!(
            entry.record_counts.as_ref().map(|counts| counts.hosts),
            Some(2),
            "counts come from metadata, not from the bundle"
        );

        // With the passphrase gone, a rollback cannot unwrap the key.
        let error = rollback(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
            1,
        )
        .await
        .expect_err("no stored passphrase");
        assert!(matches!(error, SyncError::NotFound(_)), "got {error:?}");

        secrets::save_passphrase(&fixture.dataset_id, PASSPHRASE).expect("restore passphrase");
        cleanup(&fixture, &store).await;
        store.close(&fixture.ssh).await;
    }

    /* Push A, change a host and push B, then roll back to A: the host returns to
     * A's content, a record created locally since is kept, and the merged result
     * is published as a NEW generation with both earlier ones still retained. */
    #[tokio::test]
    async fn rollback_applies_the_older_generation_and_publishes_a_new_one() {
        let Some(fixture) = fixture() else {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live history check");
            return;
        };
        assert_eq!(publish(&fixture).await, 1);

        let mut renamed = fixture.db.get_host("h-1").unwrap().expect("host");
        renamed.label = "nova-db-01-renamed".into();
        fixture.db.save_host(&renamed).expect("rename host");
        assert_eq!(publish(&fixture).await, 2);

        /* A host that never travelled: the merge must keep it, and the
         * republish must carry it to the other machines. */
        let mut local_only = fixture.db.get_host("h-1").unwrap().expect("host");
        local_only.id = "h-local".into();
        local_only.label = "never-published".into();
        fixture.db.save_host(&local_only).expect("local-only host");

        let outcome = rollback(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
            1,
        )
        .await
        .expect("rollback");

        assert_eq!(outcome.rolled_back_to, 1);
        assert_eq!(
            outcome.generation, 3,
            "a rollback publishes a new generation"
        );
        assert_eq!(outcome.applied.hosts, 1, "the renamed host came back");
        assert_eq!(
            fixture.db.get_host("h-1").unwrap().expect("host").label,
            "nova-db-01",
            "host content matches generation 1"
        );
        assert!(
            fixture.db.get_host("h-local").unwrap().is_some(),
            "a record this machine created since generation 1 survives"
        );
        assert_eq!(
            fixture
                .db
                .get_sync_dataset(&fixture.dataset_id)
                .unwrap()
                .expect("row")
                .last_generation,
            3
        );

        let store = reader(&fixture).await;
        let published = open_payload(
            &unwrap_dataset_key(
                PASSPHRASE,
                &DatasetMeta::parse(&store.read(META_FILE).await.unwrap().expect("meta"))
                    .expect("meta")
                    .key_wrap,
            )
            .expect("passphrase opens the published key"),
            &store.read(DATASET_FILE).await.unwrap().expect("bundle"),
        )
        .expect("bundle decrypts");
        let hosts = published.sections.hosts.expect("hosts section");
        assert!(hosts.iter().any(|record| record.data.label == "nova-db-01"));
        assert!(hosts
            .iter()
            .any(|record| record.data.label == "never-published"));
        assert!(!hosts
            .iter()
            .any(|record| record.data.label == "nova-db-01-renamed"));

        /* History grew: the generation the rollback replaced is archived, and
         * the one it applied to is still there — nothing was rewritten. */
        assert_eq!(store.list_history().await.unwrap(), vec![1, 2]);

        let listing = list_history(&fixture.ssh, &fixture.db, &fixture.dataset_id)
            .await
            .expect("listing");
        assert_eq!(listing.current_generation, Some(3));
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.generation)
                .collect::<Vec<_>>(),
            vec![2, 1]
        );

        cleanup(&fixture, &store).await;
        store.close(&fixture.ssh).await;
    }

    /* The stored passphrase opens the *published* wrap; a generation written
     * under another passphrase must fail on the existing decrypt path with
     * nothing applied locally. */
    #[tokio::test]
    async fn rollback_refuses_a_passphrase_that_does_not_open_the_generation() {
        let Some(fixture) = fixture() else {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live history check");
            return;
        };
        assert_eq!(publish(&fixture).await, 1);
        let mut renamed = fixture.db.get_host("h-1").unwrap().expect("host");
        renamed.label = "nova-db-01-renamed".into();
        fixture.db.save_host(&renamed).expect("rename host");
        assert_eq!(publish(&fixture).await, 2);

        secrets::save_passphrase(&fixture.dataset_id, "a completely different passphrase")
            .expect("store a wrong passphrase");
        let error = rollback(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
            1,
        )
        .await
        .expect_err("a wrong passphrase must not roll back");
        assert!(matches!(error, SyncError::Decrypt), "got {error:?}");

        // Nothing was applied and nothing was published.
        assert_eq!(
            fixture.db.get_host("h-1").unwrap().expect("host").label,
            "nova-db-01-renamed"
        );
        assert_eq!(
            fixture
                .db
                .get_sync_dataset(&fixture.dataset_id)
                .unwrap()
                .expect("row")
                .last_generation,
            2
        );

        secrets::save_passphrase(&fixture.dataset_id, PASSPHRASE).expect("restore passphrase");
        let store = reader(&fixture).await;
        assert_eq!(
            DatasetMeta::parse(&store.read(META_FILE).await.unwrap().expect("meta"))
                .expect("meta")
                .generation,
            2
        );
        cleanup(&fixture, &store).await;
        store.close(&fixture.ssh).await;
    }

    /* A member row is refused before the endpoint is even resolved. */
    #[tokio::test]
    async fn rollback_is_refused_on_a_member_row() {
        let Some(fixture) = fixture() else {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live history check");
            return;
        };
        assert_eq!(publish(&fixture).await, 1);
        let mut row = fixture
            .db
            .get_sync_dataset(&fixture.dataset_id)
            .unwrap()
            .expect("row");
        row.role = "member".into();
        fixture.db.upsert_sync_dataset(&row).expect("member row");

        let error = rollback(
            &fixture.ssh,
            &fixture.db,
            &fixture.vault,
            &fixture.dataset_id,
            1,
        )
        .await
        .expect_err("a member may not roll back");
        assert!(matches!(error, SyncError::RoleDenied(_)), "got {error:?}");

        let store = reader(&fixture).await;
        cleanup(&fixture, &store).await;
        store.close(&fixture.ssh).await;
    }
}
