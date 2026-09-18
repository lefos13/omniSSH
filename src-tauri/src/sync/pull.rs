/*
 * Pulling a dataset.
 *
 * Read-only against the remote: fetch the metadata and the bundle, verify the
 * published digest, unwrap the dataset key with the stored passphrase, decrypt,
 * then merge record by record against the base state (`sync::merge`).
 *
 * Application order follows the foreign keys — groups before hosts, snippet
 * folders before snippets, hosts before their port-forward rules and plugin
 * rows — so an incoming record never references a parent that has not arrived
 * yet. Deletes run after the writes for the same reason (`ON DELETE CASCADE`
 * cleans children, and a cascaded child is covered by its parent's tombstone).
 *
 * Failure model, stated plainly: each record is written through the existing
 * per-entity accessor, so a pull is a sequence of small transactions rather than
 * one big one. Base state is recorded only for records that were actually
 * written, which makes a partially applied pull safe to re-run: the records that
 * landed are already at base and the rest are simply applied again.
 *
 * `scopeRemovals` is applied last and is not a delete: it tells this machine to
 * stop claiming a host for this dataset, so the base state goes while the host
 * row, its credential, and its children stay exactly where they are.
 *
 * Managed hosts (AD-9): when this machine's role for the dataset is `member`,
 * every applied host is stamped `managed=true`, which makes the validated save
 * path reject edits until the user detaches. Owner pulls stamp `managed=false`
 * — the owner is the source of truth and stays editable. Hosts cover the same
 * rule as groups, snippets, and the rest: only hosts are marked, because only
 * hosts have an editor lock behind the flag.
 *
 * Detach is an opt-out, not a delete: `sync_detached` rows (written by
 * `sync_detach_host`) make pull skip the record entirely — never applied, never
 * re-managed — while the local row stays untouched. To re-add a host, delete
 * its opt-out row (`sync_reattach_host`, exposed in the host UI as "Re-attach")
 * and the next pull applies and re-manages it normally.
 *
 * Nothing here logs a host, path, or credential.
 */

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Serialize;
use tracing::instrument;

use crate::db::{CredentialStorage, HostDb, SyncEntityType, SyncRecordState};
use crate::ssh::manager::SshManager;
use crate::vault::{self, LocalVault};

use super::codec::{
    content_digest, open_payload, payload_digest, unwrap_dataset_key, Record, SyncPayload,
    APP_SETTINGS_DENY_LIST,
};
use super::dataset::{endpoint_for, SyncContentFlags};
use super::merge::{merge_kind, Base, Decision, LocalItem, MergeConflict, MergePlan, RemoteItem};
use super::meta::DatasetMeta;
use super::scope;
use super::secrets;
use super::signing;
use super::transport::{RemoteStore, DATASET_FILE, META_FILE};
use super::SyncError;

/// Records written locally, per content kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAppliedCounts {
    pub hosts: usize,
    pub groups: usize,
    pub snippets: usize,
    pub snippet_folders: usize,
    pub port_forwards: usize,
    pub s3_connections: usize,
    pub host_plugins: usize,
    pub app_settings: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullOutcome {
    pub dataset_id: String,
    pub generation: u64,
    pub applied: SyncAppliedCounts,
    pub deleted: usize,
    /// Records where the local copy won (a local-only edit, or a conflict the
    /// local side won). They travel on the next push.
    pub kept_local: usize,
    pub conflicts: usize,
    pub credentials_applied: usize,
    /* True when the generation just pulled was published by a *different*
     * installation. Two machines auto-syncing one dataset converge, but a
     * simultaneous edit to the same record resolves by newest timestamp — the
     * older edit loses. The UI says so instead of leaving the user to discover
     * it from the conflict log. */
    pub published_by_another_machine: bool,
}

#[instrument(skip(ssh, db, local_vault), fields(dataset_id = %dataset_id))]
pub async fn pull(
    ssh: &SshManager,
    db: &Arc<HostDb>,
    local_vault: &Arc<LocalVault>,
    dataset_id: &str,
) -> Result<SyncPullOutcome, SyncError> {
    let row = db
        .get_sync_dataset(dataset_id)?
        .ok_or_else(|| SyncError::NotFound(format!("no such sync dataset: {dataset_id}")))?;
    let passphrase = secrets::load_passphrase(&row.id)?;
    let endpoint = endpoint_for(&row)?;

    let store = RemoteStore::connect(ssh, &endpoint).await?;
    let fetched = fetch(&store).await;
    store.close(ssh).await;
    let (meta, bundle) = fetched?;

    if meta.dataset_id != row.id {
        return Err(SyncError::Conflict(format!(
            "a different dataset ({}) is published at this path",
            meta.dataset_id
        )));
    }
    /* The digest is checked before spending Argon2 time: a truncated or
     * mismatched bundle is a transport problem, not a wrong passphrase, and
     * must not be reported as one. */
    let digest = payload_digest(&bundle);
    if digest != meta.payload_sha256 {
        return Err(SyncError::Transport(
            "the published dataset does not match its metadata digest — it may still be uploading"
                .into(),
        ));
    }
    /* Owner verification runs before any decryption or apply: a bundle the
     * pinned owner did not sign is rejected whole, and nothing is written.
     * Returns the fingerprint to pin when this row has none yet. */
    let pin = signing::verify_for_pull(row.owner_fingerprint.as_deref(), &meta)?;

    let key = unwrap_dataset_key(&passphrase, &meta.key_wrap)?;
    let payload = open_payload(&key, &bundle)?;

    let flags = SyncContentFlags::from_json(&row.content_flags);
    let member_managed = row.role == "member";
    let db_for_apply = Arc::clone(db);
    let vault_for_apply = Arc::clone(local_vault);
    let dataset_id_owned = row.id.clone();
    let generation = meta.generation;
    let outcome = tokio::task::spawn_blocking(move || {
        apply(
            &db_for_apply,
            &vault_for_apply,
            &dataset_id_owned,
            generation,
            flags,
            member_managed,
            payload,
        )
    })
    .await
    .map_err(|e| SyncError::Database(format!("apply task panicked: {e}")))??;

    /* Attribution uses this installation's stable id, not the transport's
     * per-connection one: the question is "did another machine write this?",
     * which a fresh id per connect could never answer. */
    let published_by_another_machine = {
        let db_for_id = Arc::clone(db);
        let ours = tokio::task::spawn_blocking(move || secrets::client_id(&db_for_id))
            .await
            .map_err(|e| SyncError::Database(format!("client id task panicked: {e}")))??;
        !meta.writer_client_id.is_empty() && meta.writer_client_id != ours
    };

    let mut updated = row;
    updated.last_generation = generation as i64;
    /* Joining pins the owner's fingerprint on the first successful pull, so a
     * later bundle signed by another key is rejected above. */
    if updated.owner_fingerprint.is_none() {
        updated.owner_fingerprint = pin;
    }
    updated.last_synced_at = Some(chrono::Utc::now().to_rfc3339());
    updated.updated_at = chrono::Utc::now().to_rfc3339();
    db.upsert_sync_dataset(&updated)?;

    Ok(SyncPullOutcome {
        published_by_another_machine,
        ..outcome
    })
}

async fn fetch(store: &RemoteStore) -> Result<(DatasetMeta, Vec<u8>), SyncError> {
    let meta = store.read(META_FILE).await?.ok_or_else(|| {
        SyncError::NotFound("nothing has been published to this dataset yet".into())
    })?;
    let bundle = store.read(DATASET_FILE).await?.ok_or_else(|| {
        SyncError::NotFound(
            "this dataset's metadata exists but its encrypted bundle is missing".into(),
        )
    })?;
    Ok((DatasetMeta::parse(&meta)?, bundle))
}

// ─── Apply ───────────────────────────────────────────────────────────────────

/// Per-kind working set: the merge inputs plus the resulting plan.
struct KindMerge {
    plan: MergePlan,
}

/* Merging needs the same three inputs for every kind, so the per-kind code
 * below only supplies "what is local" and "what is remote"; everything else —
 * base lookup, tombstone slicing, and the decision table — is shared. */
fn merge_for<T: Serialize>(
    entity_type: SyncEntityType,
    locals: Vec<LocalItem>,
    remotes: &[Record<T>],
    base: &Base,
    remote_tombstones: &BTreeMap<String, String>,
    local_tombstones: &BTreeMap<String, String>,
) -> Result<KindMerge, SyncError> {
    let mut remote_items = Vec::with_capacity(remotes.len());
    for record in remotes {
        remote_items.push(RemoteItem {
            id: record.id.clone(),
            hash: content_digest(&record.data)?,
            updated_at: record.updated_at.clone(),
            revision: record.revision,
        });
    }
    Ok(KindMerge {
        plan: merge_kind(
            entity_type,
            &locals,
            &remote_items,
            base,
            remote_tombstones,
            local_tombstones,
        ),
    })
}

fn local_items<T: Serialize>(
    rows: &[T],
    id_of: impl Fn(&T) -> String,
    updated_at_of: impl Fn(&T) -> String,
) -> Result<Vec<LocalItem>, SyncError> {
    rows.iter()
        .map(|row| {
            Ok(LocalItem {
                id: id_of(row),
                hash: content_digest(row)?,
                updated_at: updated_at_of(row),
            })
        })
        .collect()
}

fn base_for(db: &HostDb, dataset_id: &str, entity_type: SyncEntityType) -> Result<Base, SyncError> {
    Ok(db
        .list_sync_record_state(dataset_id)?
        .into_iter()
        .filter(|state| state.entity_type == entity_type)
        .map(|state| (state.entity_id, (state.remote_revision, state.base_hash)))
        .collect())
}

fn tombstones_of(
    entries: &[(SyncEntityType, String, String)],
    entity_type: SyncEntityType,
) -> BTreeMap<String, String> {
    entries
        .iter()
        .filter(|(kind, _, _)| *kind == entity_type)
        .map(|(_, id, at)| (id.clone(), at.clone()))
        .collect()
}

struct ApplyState<'a> {
    db: &'a HostDb,
    dataset_id: &'a str,
    /* True when this machine pulls as a dataset member: applied hosts are
     * stamped `managed=true` and become read-only until detached. Owners keep
     * `managed=false` — they are the source of truth. */
    member_managed: bool,
    states: Vec<SyncRecordState>,
    conflicts: Vec<MergeConflict>,
    deleted: usize,
    kept_local: usize,
    credentials_applied: usize,
}

impl ApplyState<'_> {
    fn record_base(&mut self, entity_type: SyncEntityType, id: &str, revision: u64, hash: String) {
        /* Only hosts carry the read-only marker: groups, snippets, rules, and
         * the rest apply the same merge path but stay editable, because only
         * hosts have an editor lock behind the flag. */
        let managed = self.member_managed && entity_type == SyncEntityType::Host;
        self.states.push(SyncRecordState {
            dataset_id: self.dataset_id.to_string(),
            entity_type,
            entity_id: id.to_string(),
            remote_revision: revision as i64,
            base_hash: hash,
            managed,
            synced_at: String::new(),
        });
    }

    fn drop_base(&mut self, entity_type: SyncEntityType, id: &str) -> Result<(), SyncError> {
        self.db
            .clear_sync_record_state(self.dataset_id, Some((entity_type, id)))?;
        Ok(())
    }
}

/// Where a pulled credential is written on *this* machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialTarget {
    Keychain,
    LocalVault,
}

/* This machine's preference, honoured only when it can actually be honoured:
 * writing a vault marker while the vault is locked would persist a host whose
 * secret cannot be decrypted, so a locked (or unconfigured) vault falls back to
 * the keychain, which needs no session key. */
fn preferred_credential_target(
    db: &HostDb,
    local_vault: &LocalVault,
) -> Result<CredentialTarget, SyncError> {
    let prefers_vault =
        db.get_setting("default_credential_storage")?.as_deref() == Some("localVault");
    Ok(if prefers_vault && local_vault.is_unlocked() {
        CredentialTarget::LocalVault
    } else {
        CredentialTarget::Keychain
    })
}

/* The App Vault's user-facing paths (reveal, change master password) are built
 * around password credentials, so a non-password secret — a private-key
 * passphrase — stays in the keychain even on a vault-preferring machine rather
 * than becoming a record no existing UI can handle. */
fn credential_target_for(
    preferred: CredentialTarget,
    credential: Option<&crate::vault::StoredCredential>,
) -> CredentialTarget {
    match credential {
        Some(crate::vault::StoredCredential::Password { .. }) | None => preferred,
        Some(_) => CredentialTarget::Keychain,
    }
}

fn apply(
    db: &HostDb,
    local_vault: &LocalVault,
    dataset_id: &str,
    generation: u64,
    flags: SyncContentFlags,
    member_managed: bool,
    payload: SyncPayload,
) -> Result<SyncPullOutcome, SyncError> {
    let flags = flags.normalized();
    let mut applied = SyncAppliedCounts::default();
    let mut state = ApplyState {
        db,
        dataset_id,
        member_managed,
        states: Vec::new(),
        conflicts: Vec::new(),
        deleted: 0,
        kept_local: 0,
        credentials_applied: 0,
    };
    let preferred_target = preferred_credential_target(db, local_vault)?;

    let remote_tombstones: Vec<(SyncEntityType, String, String)> = payload
        .tombstones
        .iter()
        .filter_map(|tombstone| {
            SyncEntityType::from_db(tombstone.entity_type.clone())
                .ok()
                .map(|kind| {
                    (
                        kind,
                        tombstone.entity_id.clone(),
                        tombstone.deleted_at.clone(),
                    )
                })
        })
        .collect();
    let local_tombstones: Vec<(SyncEntityType, String, String)> = db
        .list_sync_tombstones(None)?
        .into_iter()
        .map(|tombstone| {
            (
                tombstone.entity_type,
                tombstone.entity_id,
                tombstone.deleted_at,
            )
        })
        .collect();

    // ── Groups (parents of hosts) ────────────────────────────────────────────
    if let Some(remotes) = payload.sections.groups.as_ref().filter(|_| flags.groups) {
        let rows = db.list_groups()?;
        let locals = local_items(&rows, |g| g.id.clone(), |g| g.updated_at.clone())?;
        let existing: BTreeMap<&str, ()> = rows.iter().map(|g| (g.id.as_str(), ())).collect();
        let merged = merge_for(
            SyncEntityType::Group,
            locals,
            remotes,
            &base_for(db, dataset_id, SyncEntityType::Group)?,
            &tombstones_of(&remote_tombstones, SyncEntityType::Group),
            &tombstones_of(&local_tombstones, SyncEntityType::Group),
        )?;
        for decision in &merged.plan.decisions {
            match decision {
                Decision::Apply { id, revision } => {
                    let record = remotes
                        .iter()
                        .find(|record| &record.id == id)
                        .ok_or_else(|| SyncError::Format(format!("missing group record {id}")))?;
                    if existing.contains_key(id.as_str()) {
                        db.update_group(&record.data)?;
                    } else {
                        db.create_group(&record.data)?;
                    }
                    let hash = content_digest(&record.data)?;
                    state.record_base(SyncEntityType::Group, id, *revision, hash);
                    applied.groups += 1;
                }
                Decision::Delete { id } => {
                    db.delete_group(id)?;
                    state.drop_base(SyncEntityType::Group, id)?;
                    state.deleted += 1;
                }
                Decision::KeepLocal { .. } => state.kept_local += 1,
            }
        }
        state.conflicts.extend(merged.plan.conflicts);
    }

    // ── Hosts ────────────────────────────────────────────────────────────────
    if let Some(remotes) = payload.sections.hosts.as_ref().filter(|_| flags.hosts) {
        let rows = db.list_hosts()?;
        let locals = local_items(&rows, |h| h.id.clone(), |h| h.updated_at.clone())?;
        let merged = merge_for(
            SyncEntityType::Host,
            locals,
            remotes,
            &base_for(db, dataset_id, SyncEntityType::Host)?,
            &tombstones_of(&remote_tombstones, SyncEntityType::Host),
            &tombstones_of(&local_tombstones, SyncEntityType::Host),
        )?;
        for decision in &merged.plan.decisions {
            match decision {
                Decision::Apply { id, revision } => {
                    /* Detached records are opted out, not deleted: the user took
                     * the row back, so pull neither applies nor re-manages it.
                     * Local Only records were never in the remote, hence were
                     * never detached for this dataset, and bypass this check. */
                    if db.is_sync_detached(dataset_id, SyncEntityType::Host, id)? {
                        state.kept_local += 1;
                        continue;
                    }
                    let record = remotes
                        .iter()
                        .find(|record| &record.id == id)
                        .ok_or_else(|| SyncError::Format(format!("missing host record {id}")))?;
                    /* The incoming row carries the *publisher's* storage
                     * marker, which says nothing about where this machine keeps
                     * secrets: the target comes from this machine's preference,
                     * its vault state, and the credential's own shape. */
                    let target =
                        credential_target_for(preferred_target, record.credential.as_ref());
                    let mut host = record.data.clone();
                    host.credential_storage = match target {
                        CredentialTarget::LocalVault => CredentialStorage::LocalVault,
                        CredentialTarget::Keychain => CredentialStorage::Keychain,
                    };
                    db.save_host(&host)?;
                    if let Some(credential) = record.credential.as_ref() {
                        match target {
                            /* Straight to vault ciphertext: the pulled secret is
                             * already in memory, so a keychain hop would write
                             * the plaintext into a second OS-managed store only
                             * to delete it again — extra authorization prompts
                             * and a window where the secret sits somewhere the
                             * user never asked for. */
                            CredentialTarget::LocalVault => {
                                vault::store_host_credential_in_vault(
                                    db,
                                    local_vault,
                                    id,
                                    credential,
                                )?;
                            }
                            CredentialTarget::Keychain => vault::save_credential(id, credential)?,
                        }
                        state.credentials_applied += 1;
                    }
                    let hash = content_digest(&record.data)?;
                    state.record_base(SyncEntityType::Host, id, *revision, hash);
                    applied.hosts += 1;
                }
                Decision::Delete { id } => {
                    /* A detached-then-remotely-deleted record stays local: the
                     * opt-out outranks the tombstone, and the tombstone still
                     * applies on re-attach. */
                    if db.is_sync_detached(dataset_id, SyncEntityType::Host, id)? {
                        state.kept_local += 1;
                        continue;
                    }
                    db.delete_host(id)?;
                    let _ = vault::delete_credential(id);
                    state.drop_base(SyncEntityType::Host, id)?;
                    state.deleted += 1;
                }
                Decision::KeepLocal { .. } => state.kept_local += 1,
            }
        }
    }

    // ── Snippet folders, then snippets ───────────────────────────────────────
    if let Some(remotes) = payload
        .sections
        .snippet_folders
        .as_ref()
        .filter(|_| flags.snippet_folders)
    {
        let rows = db.list_snippet_folders()?;
        let locals = local_items(&rows, |f| f.id.clone(), |f| f.updated_at.clone())?;
        let merged = merge_for(
            SyncEntityType::SnippetFolder,
            locals,
            remotes,
            &base_for(db, dataset_id, SyncEntityType::SnippetFolder)?,
            &tombstones_of(&remote_tombstones, SyncEntityType::SnippetFolder),
            &tombstones_of(&local_tombstones, SyncEntityType::SnippetFolder),
        )?;
        for decision in &merged.plan.decisions {
            match decision {
                Decision::Apply { id, revision } => {
                    let record = remotes
                        .iter()
                        .find(|record| &record.id == id)
                        .ok_or_else(|| SyncError::Format(format!("missing folder record {id}")))?;
                    db.save_snippet_folder(&record.data)?;
                    let hash = content_digest(&record.data)?;
                    state.record_base(SyncEntityType::SnippetFolder, id, *revision, hash);
                    applied.snippet_folders += 1;
                }
                Decision::Delete { id } => {
                    db.delete_snippet_folder(id)?;
                    state.drop_base(SyncEntityType::SnippetFolder, id)?;
                    state.deleted += 1;
                }
                Decision::KeepLocal { .. } => state.kept_local += 1,
            }
        }
        state.conflicts.extend(merged.plan.conflicts);
    }

    if let Some(remotes) = payload
        .sections
        .snippets
        .as_ref()
        .filter(|_| flags.snippets)
    {
        let rows = db.list_snippets(None)?;
        let locals = local_items(&rows, |s| s.id.clone(), |s| s.updated_at.clone())?;
        let merged = merge_for(
            SyncEntityType::Snippet,
            locals,
            remotes,
            &base_for(db, dataset_id, SyncEntityType::Snippet)?,
            &tombstones_of(&remote_tombstones, SyncEntityType::Snippet),
            &tombstones_of(&local_tombstones, SyncEntityType::Snippet),
        )?;
        for decision in &merged.plan.decisions {
            match decision {
                Decision::Apply { id, revision } => {
                    let record = remotes
                        .iter()
                        .find(|record| &record.id == id)
                        .ok_or_else(|| SyncError::Format(format!("missing snippet record {id}")))?;
                    db.save_snippet(&record.data)?;
                    let hash = content_digest(&record.data)?;
                    state.record_base(SyncEntityType::Snippet, id, *revision, hash);
                    applied.snippets += 1;
                }
                Decision::Delete { id } => {
                    db.delete_snippet(id)?;
                    state.drop_base(SyncEntityType::Snippet, id)?;
                    state.deleted += 1;
                }
                Decision::KeepLocal { .. } => state.kept_local += 1,
            }
        }
        state.conflicts.extend(merged.plan.conflicts);
    }

    // ── Port-forward rules (children of hosts) ───────────────────────────────
    if let Some(remotes) = payload
        .sections
        .port_forwards
        .as_ref()
        .filter(|_| flags.port_forwards)
    {
        let rows = db.list_pf_rules(None)?;
        let locals = local_items(&rows, |r| r.id.clone(), |r| r.updated_at.clone())?;
        let merged = merge_for(
            SyncEntityType::PortForward,
            locals,
            remotes,
            &base_for(db, dataset_id, SyncEntityType::PortForward)?,
            &tombstones_of(&remote_tombstones, SyncEntityType::PortForward),
            &tombstones_of(&local_tombstones, SyncEntityType::PortForward),
        )?;
        let existing: BTreeMap<&str, ()> = rows.iter().map(|r| (r.id.as_str(), ())).collect();
        for decision in &merged.plan.decisions {
            match decision {
                Decision::Apply { id, revision } => {
                    let record =
                        remotes
                            .iter()
                            .find(|record| &record.id == id)
                            .ok_or_else(|| {
                                SyncError::Format(format!("missing port-forward record {id}"))
                            })?;
                    let rule = &record.data;
                    if !existing.contains_key(id.as_str()) {
                        db.create_pf_rule(
                            &rule.id,
                            rule.host_id.as_deref(),
                            rule.label.as_deref(),
                            rule.description.as_deref(),
                            rule.forward_type.as_str(),
                            &rule.bind_address,
                            rule.local_port,
                            &rule.remote_host,
                            rule.remote_port,
                            rule.auto_start,
                        )?;
                    } else {
                        db.update_pf_rule(
                            &rule.id,
                            rule.label.as_deref(),
                            rule.description.as_deref(),
                            &rule.bind_address,
                            rule.local_port,
                            &rule.remote_host,
                            rule.remote_port,
                            rule.auto_start,
                        )?;
                    }
                    let hash = content_digest(&record.data)?;
                    state.record_base(SyncEntityType::PortForward, id, *revision, hash);
                    applied.port_forwards += 1;
                }
                Decision::Delete { id } => {
                    db.delete_pf_rule(id)?;
                    state.drop_base(SyncEntityType::PortForward, id)?;
                    state.deleted += 1;
                }
                Decision::KeepLocal { .. } => state.kept_local += 1,
            }
        }
        state.conflicts.extend(merged.plan.conflicts);
    }

    // ── S3 connections ───────────────────────────────────────────────────────
    if let Some(remotes) = payload
        .sections
        .s3_connections
        .as_ref()
        .filter(|_| flags.s3_connections)
    {
        let rows = db.list_s3_connections()?;
        let locals = local_items(&rows, |c| c.id.clone(), |c| c.updated_at.clone())?;
        let merged = merge_for(
            SyncEntityType::S3Connection,
            locals,
            remotes,
            &base_for(db, dataset_id, SyncEntityType::S3Connection)?,
            &tombstones_of(&remote_tombstones, SyncEntityType::S3Connection),
            &tombstones_of(&local_tombstones, SyncEntityType::S3Connection),
        )?;
        for decision in &merged.plan.decisions {
            match decision {
                Decision::Apply { id, revision } => {
                    let record = remotes
                        .iter()
                        .find(|record| &record.id == id)
                        .ok_or_else(|| SyncError::Format(format!("missing S3 record {id}")))?;
                    let connection = &record.data;
                    db.save_s3_connection(
                        &connection.id,
                        &connection.label,
                        &connection.provider,
                        &connection.region,
                        connection.endpoint.as_deref(),
                        connection.bucket.as_deref(),
                        connection.path_style,
                        connection.group_id.as_deref(),
                        connection.color.as_deref(),
                        connection.environment.as_deref(),
                        connection.notes.as_deref(),
                    )?;
                    if let Some(credential) = record.credential.as_ref() {
                        vault::save_credential(&format!("s3:{}", connection.id), credential)?;
                        state.credentials_applied += 1;
                    }
                    let hash = content_digest(&record.data)?;
                    state.record_base(SyncEntityType::S3Connection, id, *revision, hash);
                    applied.s3_connections += 1;
                }
                Decision::Delete { id } => {
                    db.delete_s3_connection(id)?;
                    let _ = vault::delete_credential(&format!("s3:{id}"));
                    state.drop_base(SyncEntityType::S3Connection, id)?;
                    state.deleted += 1;
                }
                Decision::KeepLocal { .. } => state.kept_local += 1,
            }
        }
        state.conflicts.extend(merged.plan.conflicts);
    }

    // ── Per-host plugin config (children of hosts) ───────────────────────────
    if let Some(remotes) = payload
        .sections
        .host_plugins
        .as_ref()
        .filter(|_| flags.host_plugins)
    {
        let mut rows = Vec::new();
        for host in db.list_hosts()? {
            rows.extend(db.list_plugin_configs(&host.id)?);
        }
        let locals = local_items(
            &rows,
            |c| format!("{}:{}", c.host_id, c.plugin_id),
            // Plugin rows have no struct-level clock; the row is small and
            // opaque, so its content hash carries the whole decision.
            |_| String::new(),
        )?;
        let merged = merge_for(
            SyncEntityType::HostPlugin,
            locals,
            remotes,
            &base_for(db, dataset_id, SyncEntityType::HostPlugin)?,
            &tombstones_of(&remote_tombstones, SyncEntityType::HostPlugin),
            &tombstones_of(&local_tombstones, SyncEntityType::HostPlugin),
        )?;
        for decision in &merged.plan.decisions {
            match decision {
                Decision::Apply { id, revision } => {
                    let record = remotes
                        .iter()
                        .find(|record| &record.id == id)
                        .ok_or_else(|| SyncError::Format(format!("missing plugin record {id}")))?;
                    let config = &record.data;
                    /* A plugin row is a child of its host: if the host is not
                     * in this dataset (or has not arrived), skip rather than
                     * fail the whole pull on a foreign-key error. */
                    if db.get_host(&config.host_id)?.is_none() {
                        continue;
                    }
                    db.set_plugin_config(
                        &config.host_id,
                        &config.plugin_id,
                        config.enabled,
                        &config.config,
                    )?;
                    let hash = content_digest(&record.data)?;
                    state.record_base(SyncEntityType::HostPlugin, id, *revision, hash);
                    applied.host_plugins += 1;
                }
                Decision::Delete { id } => {
                    if let Some((host_id, plugin_id)) = id.split_once(':') {
                        let _ = db.delete_plugin_config(host_id, plugin_id);
                        state.deleted += 1;
                    }
                    state.drop_base(SyncEntityType::HostPlugin, id)?;
                }
                Decision::KeepLocal { .. } => state.kept_local += 1,
            }
        }
        state.conflicts.extend(merged.plan.conflicts);
    }

    // ── App settings (one synthetic record) ──────────────────────────────────
    if let Some(record) = payload
        .sections
        .app_settings
        .as_ref()
        .filter(|_| flags.app_settings)
    {
        let hash = content_digest(record)?;
        let base = base_for(db, dataset_id, SyncEntityType::AppSettings)?;
        let unchanged = base
            .get("appSettings")
            .map(|(_, base_hash)| *base_hash == hash)
            .unwrap_or(false);
        if !unchanged {
            for (key, value) in &record.entries {
                /* The deny-list is enforced on both sides: a payload written by
                 * an older or patched build must not be able to point this
                 * machine's editor at a binary that does not exist here. */
                if APP_SETTINGS_DENY_LIST.contains(&key.as_str()) {
                    continue;
                }
                db.save_setting(key, value)?;
            }
            let revision = base
                .get("appSettings")
                .map(|(revision, _)| *revision as u64 + 1)
                .unwrap_or(1);
            state.record_base(SyncEntityType::AppSettings, "appSettings", revision, hash);
            applied.app_settings = true;
        }
    }

    /* Scope removals last, and before the base state is written: a host that
     * left the writer's scope arrives with no record and no tombstone, so the
     * only thing that tells this machine to stop claiming it for this dataset
     * is this list. The host row, its credential, and its child rules stay —
     * they may belong to another dataset, or to no dataset at all. */
    scope::apply_scope_removals(db, dataset_id, &payload.scope_removals)?;

    db.upsert_sync_record_state(&state.states)?;
    let conflict_rows: Vec<crate::db::SyncConflict> = state
        .conflicts
        .iter()
        .map(|conflict| crate::db::SyncConflict {
            id: 0,
            dataset_id: dataset_id.to_string(),
            entity_type: conflict.entity_type,
            entity_id: conflict.entity_id.clone(),
            resolution: conflict.resolution.clone(),
            winner_updated_at: conflict.winner_updated_at.clone(),
            loser_updated_at: conflict.loser_updated_at.clone(),
            detected_at: String::new(),
        })
        .collect();
    db.record_sync_conflicts(&conflict_rows)?;

    Ok(SyncPullOutcome {
        dataset_id: dataset_id.to_string(),
        generation,
        applied,
        deleted: state.deleted,
        kept_local: state.kept_local,
        conflicts: state.conflicts.len(),
        credentials_applied: state.credentials_applied,
        // Filled in by `pull` once the metadata's writer has been compared with
        // this installation's id; `apply` never sees the metadata.
        published_by_another_machine: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{SavedHost, SyncDataset};

    #[test]
    fn outcome_serializes_for_the_pull_panel() {
        let outcome = SyncPullOutcome {
            dataset_id: "ds-nova".into(),
            generation: 12,
            applied: SyncAppliedCounts {
                hosts: 3,
                groups: 1,
                snippets: 0,
                snippet_folders: 0,
                port_forwards: 2,
                s3_connections: 0,
                host_plugins: 0,
                app_settings: true,
            },
            deleted: 1,
            kept_local: 2,
            conflicts: 1,
            credentials_applied: 3,
            published_by_another_machine: true,
        };
        let json = serde_json::to_string(&outcome).unwrap();

        assert!(json.contains("\"datasetId\":\"ds-nova\""));
        assert!(json.contains("\"generation\":12"));
        assert!(json.contains("\"applied\":{\"hosts\":3"));
        assert!(json.contains("\"snippetFolders\":0"));
        assert!(json.contains("\"appSettings\":true"));
        assert!(json.contains("\"keptLocal\":2"));
        assert!(json.contains("\"credentialsApplied\":3"));
    }

    #[test]
    fn the_credential_target_follows_this_machine_not_the_publisher() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("temp database");
        let vault = LocalVault::new();

        // Default machine: no preference recorded → keychain.
        assert_eq!(
            preferred_credential_target(&db, &vault).unwrap(),
            CredentialTarget::Keychain
        );

        // Prefers the vault, but it is locked: writing a vault marker would
        // persist a host whose secret cannot be decrypted.
        db.save_setting("default_credential_storage", "localVault")
            .expect("setting");
        assert_eq!(
            preferred_credential_target(&db, &vault).unwrap(),
            CredentialTarget::Keychain
        );

        vault.set_session_key([5; 32]).expect("unlock");
        assert_eq!(
            preferred_credential_target(&db, &vault).unwrap(),
            CredentialTarget::LocalVault
        );
    }

    #[test]
    fn only_password_credentials_go_into_the_vault() {
        let password = crate::vault::StoredCredential::Password {
            password: "pw".into(),
        };
        let key_passphrase = crate::vault::StoredCredential::KeyPassphrase {
            passphrase: "kp".into(),
        };

        assert_eq!(
            credential_target_for(CredentialTarget::LocalVault, Some(&password)),
            CredentialTarget::LocalVault
        );
        /* The vault's reveal / rekey paths are built around passwords, so a
         * key passphrase stays in the keychain rather than becoming a record no
         * existing UI can handle. */
        assert_eq!(
            credential_target_for(CredentialTarget::LocalVault, Some(&key_passphrase)),
            CredentialTarget::Keychain
        );
        // A host with no credential still records the machine's preference, so
        // a later password save lands where the user expects.
        assert_eq!(
            credential_target_for(CredentialTarget::LocalVault, None),
            CredentialTarget::LocalVault
        );
        assert_eq!(
            credential_target_for(CredentialTarget::Keychain, Some(&password)),
            CredentialTarget::Keychain
        );
    }

    /* Member pulls mark applied hosts managed; owner pulls never do. The db
     * gate tests cover the save rejection itself — these pin the stamping. */
    fn tests_host(id: &str) -> SavedHost {
        SavedHost {
            id: id.into(),
            label: format!("Host {id}"),
            host: "10.0.0.5".into(),
            port: 22,
            username: "deployer".into(),
            auth_type: "password".into(),
            credential_storage: CredentialStorage::Keychain,
            group_id: None,
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: "2026-09-03T00:00:00Z".into(),
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
        }
    }

    #[test]
    fn member_pull_marks_hosts_managed_owner_pull_does_not() {
        use crate::sync::codec::{Record, SyncPayload};
        use crate::sync::dataset::SyncContentFlags;

        fn host_record(id: &str) -> Record<SavedHost> {
            let data = tests_host(id);
            Record {
                id: data.id.clone(),
                revision: 3,
                updated_at: data.updated_at.clone(),
                deleted: false,
                credential: None,
                data,
            }
        }

        fn dataset_row(id: &str, role: &str, dir: &tempfile::TempDir) -> HostDb {
            let db = HostDb::new(dir.path()).expect("temp database");
            db.upsert_sync_dataset(&SyncDataset {
                id: id.into(),
                name: "NOVA".into(),
                host: "10.0.0.9".into(),
                port: 2222,
                username: "sync".into(),
                auth_type: "password".into(),
                remote_path: format!("/srv/omnissh/{id}"),
                role: role.into(),
                content_flags: SyncContentFlags::default().to_json().unwrap(),
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
                created_at: "2026-09-01T00:00:00Z".into(),
                updated_at: "2026-09-01T00:00:00Z".into(),
            })
            .expect("dataset row");
            db
        }

        fn payload() -> SyncPayload {
            let mut payload = SyncPayload::new("ds-x", 4);
            payload.sections.hosts = Some(vec![host_record("h-1")]);
            payload.sections.groups = Some(vec![]);
            payload
        }

        let vault = LocalVault::new();
        let flags = SyncContentFlags::default();

        let member_dir = tempfile::tempdir().expect("temp dir");
        let member_db = dataset_row("ds-x", "member", &member_dir);
        let outcome =
            apply(&member_db, &vault, "ds-x", 4, flags, true, payload()).expect("member apply");
        assert_eq!(outcome.applied.hosts, 1);
        let states = member_db.list_sync_record_state("ds-x").expect("state");
        assert_eq!(states.len(), 1);
        assert!(states[0].managed, "member pulls stamp managed=true");

        let owner_dir = tempfile::tempdir().expect("temp dir");
        let owner_db = dataset_row("ds-x", "owner", &owner_dir);
        let outcome =
            apply(&owner_db, &vault, "ds-x", 4, flags, false, payload()).expect("owner apply");
        assert_eq!(outcome.applied.hosts, 1);
        let states = owner_db.list_sync_record_state("ds-x").expect("state");
        assert_eq!(states.len(), 1);
        assert!(!states[0].managed, "owner pulls keep managed=false");
    }

    #[test]
    fn detached_host_is_never_applied_or_remanaged() {
        use crate::sync::codec::{Record, SyncPayload};
        use crate::sync::dataset::SyncContentFlags;

        let dir = tempfile::tempdir().expect("temp dir");
        let db = HostDb::new(dir.path()).expect("temp database");
        db.upsert_sync_dataset(&SyncDataset {
            id: "ds-x".into(),
            name: "NOVA".into(),
            host: "10.0.0.9".into(),
            port: 2222,
            username: "sync".into(),
            auth_type: "password".into(),
            remote_path: "/srv/omnissh/ds-x".into(),
            role: "member".into(),
            content_flags: SyncContentFlags::default().to_json().unwrap(),
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
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: "2026-09-01T00:00:00Z".into(),
        })
        .expect("dataset row");

        let vault = LocalVault::new();
        let flags = SyncContentFlags::default();
        let mut payload = SyncPayload::new("ds-x", 4);
        let data = tests_host("h-9");
        payload.sections.hosts = Some(vec![Record {
            id: data.id.clone(),
            revision: 2,
            updated_at: "2026-09-04T00:00:00Z".into(),
            deleted: false,
            credential: None,
            data,
        }]);

        db.detach_sync_host("ds-x", "h-9").expect("detach");
        let outcome = apply(&db, &vault, "ds-x", 4, flags, true, payload.clone())
            .expect("apply with opt-out");
        assert_eq!(outcome.applied.hosts, 0, "detached records are skipped");
        assert!(db.get_host("h-9").expect("lookup").is_none());
        assert!(
            db.list_sync_record_state("ds-x").expect("state").is_empty(),
            "detached records are never re-managed"
        );

        db.reattach_sync_host("ds-x", "h-9").expect("re-attach");
        let outcome = apply(&db, &vault, "ds-x", 4, flags, true, payload).expect("re-apply");
        assert_eq!(outcome.applied.hosts, 1);
        let states = db.list_sync_record_state("ds-x").expect("state");
        assert_eq!(states.len(), 1);
        assert!(states[0].managed);
    }
}

/* Two-machine round trip against a real SFTP server, opt-in via
 * `OMNISSH_SYNC_TEST_HOST` (see `sync::transport::live`). Machine A publishes,
 * machine B — a separate database pointed at the same dataset — pulls, edits,
 * and publishes back. This is the scenario the whole feature exists for, so it
 * is checked against real bytes on a real server rather than a mock.
 *
 *   OMNISSH_SYNC_TEST_HOST=127.0.0.1 OMNISSH_SYNC_TEST_PORT=2299 \
 *     cargo test --lib sync::pull::live -- --nocapture --test-threads=1
 */
#[cfg(test)]
mod live {
    use super::*;
    use crate::db::{HostGroup, SavedHost, SyncDataset};
    use crate::sync::codec::{generate_dataset_key, wrap_dataset_key, KeyWrap};
    use crate::sync::dataset::pack_wrapped_key;
    use crate::sync::push::push;
    use crate::types::session::AuthMethod;
    use crate::vault::StoredCredential;

    const PASSPHRASE: &str = "two-machine-passphrase";

    struct Machine {
        db: Arc<HostDb>,
        vault: Arc<LocalVault>,
        ssh: SshManager,
        _dir: tempfile::TempDir,
    }

    fn env(key: &str, fallback: &str) -> String {
        std::env::var(key).unwrap_or_else(|_| fallback.to_string())
    }

    /// A machine with its own database, joined to `dataset_id` with `wrap`.
    fn machine(dataset_id: &str, root: &str, wrap: &KeyWrap) -> Machine {
        let dir = tempfile::tempdir().expect("temp dir");
        let db = Arc::new(HostDb::new(dir.path()).expect("temp database"));
        db.upsert_sync_dataset(&SyncDataset {
            id: dataset_id.to_string(),
            name: "Live NOVA".into(),
            host: env("OMNISSH_SYNC_TEST_HOST", "127.0.0.1"),
            port: env("OMNISSH_SYNC_TEST_PORT", "2222")
                .parse()
                .unwrap_or(2222),
            username: env("OMNISSH_SYNC_TEST_USER", "testuser"),
            auth_type: "password".into(),
            remote_path: root.to_string(),
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
            wrapped_key: Some(pack_wrapped_key(wrap)),
            last_generation: 0,
            last_synced_at: None,
            created_at: String::new(),
            updated_at: String::new(),
        })
        .expect("dataset row");
        Machine {
            db,
            vault: Arc::new(LocalVault::new()),
            ssh: SshManager::new(),
            _dir: dir,
        }
    }

    fn host(id: &str, label: &str, updated_at: &str) -> SavedHost {
        SavedHost {
            id: id.into(),
            label: label.into(),
            host: "10.0.0.5".into(),
            port: 22,
            username: "deployer".into(),
            auth_type: "password".into(),
            credential_storage: CredentialStorage::Keychain,
            group_id: Some("g-nova".into()),
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: updated_at.into(),
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
        }
    }

    fn label_of(machine: &Machine, id: &str) -> Option<String> {
        machine
            .db
            .get_host(id)
            .expect("host lookup")
            .map(|host| host.label)
    }

    async fn cleanup(machine: &Machine, root: &str, dataset_id: &str) {
        let endpoint = crate::sync::transport::SyncEndpoint {
            host: env("OMNISSH_SYNC_TEST_HOST", "127.0.0.1"),
            port: env("OMNISSH_SYNC_TEST_PORT", "2222")
                .parse()
                .unwrap_or(2222),
            username: env("OMNISSH_SYNC_TEST_USER", "testuser"),
            auth: AuthMethod::Password {
                password: env("OMNISSH_SYNC_TEST_PASS", "testpass"),
            },
            root: root.to_string(),
        };
        if let Ok(store) = RemoteStore::connect(&machine.ssh, &endpoint).await {
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
            store.close(&machine.ssh).await;
        }
        let _ = secrets::delete_dataset_secrets(dataset_id);
    }

    #[tokio::test]
    async fn a_second_machine_reproduces_edits_deletes_and_conflicts() {
        if std::env::var("OMNISSH_SYNC_TEST_HOST").is_err() {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live pull check");
            return;
        }

        let dataset_id = format!("live-pull-{}", uuid::Uuid::new_v4());
        let root = format!("/config/omnissh-pull-{dataset_id}");
        let key = generate_dataset_key().expect("key");
        let wrap = wrap_dataset_key(PASSPHRASE, &key).expect("wrap");

        secrets::save_server_secret(
            &dataset_id,
            &StoredCredential::Password {
                password: env("OMNISSH_SYNC_TEST_PASS", "testpass"),
            },
        )
        .expect("server secret");
        secrets::save_passphrase(&dataset_id, PASSPHRASE).expect("passphrase");

        let a = machine(&dataset_id, &root, &wrap);
        let b = machine(&dataset_id, &root, &wrap);

        a.db.create_group(&HostGroup {
            id: "g-nova".into(),
            name: "NOVA".into(),
            color: "#6366f1".into(),
            icon: None,
            sort_order: 0,
            default_username: None,
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: "2026-09-01T00:00:00Z".into(),
        })
        .expect("group");
        a.db.save_host(&host("h-1", "nova-db-01", "2026-09-02T00:00:00Z"))
            .expect("host 1");
        a.db.save_host(&host("h-2", "nova-web-01", "2026-09-02T00:00:00Z"))
            .expect("host 2");

        let outcome = async {
            // ── A publishes, B pulls it from scratch ─────────────────────────
            let pushed = push(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A publishes");
            assert_eq!(pushed.generation, 1);

            let pulled = pull(&b.ssh, &b.db, &b.vault, &dataset_id)
                .await
                .expect("B pulls");
            assert_eq!(pulled.generation, 1);
            assert_eq!(
                pulled.applied.hosts, 2,
                "both hosts land on the new machine"
            );
            assert_eq!(pulled.applied.groups, 1);
            assert_eq!(pulled.conflicts, 0);
            assert_eq!(label_of(&b, "h-1").as_deref(), Some("nova-db-01"));
            assert_eq!(
                b.db.list_groups().unwrap().len(),
                1,
                "the group arrived with its hosts"
            );
            assert_eq!(
                b.db.get_host("h-1").unwrap().unwrap().group_id.as_deref(),
                Some("g-nova"),
                "group membership survives the round trip"
            );

            // A second pull with nothing new applies nothing at all.
            let idempotent = pull(&b.ssh, &b.db, &b.vault, &dataset_id)
                .await
                .expect("B pulls again");
            assert_eq!(idempotent.applied.hosts, 0, "re-pulling is a no-op");
            assert_eq!(idempotent.conflicts, 0);

            // ── B edits and publishes; A pulls the change ────────────────────
            b.db.save_host(&host("h-1", "nova-db-01-from-B", "2026-09-05T00:00:00Z"))
                .expect("B edits");
            let pushed = push(&b.ssh, &b.db, &b.vault, &dataset_id)
                .await
                .expect("B publishes");
            assert_eq!(pushed.generation, 2);

            let pulled = pull(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A pulls");
            assert_eq!(pulled.applied.hosts, 1, "only the edited host is rewritten");
            assert_eq!(pulled.conflicts, 0, "a one-sided edit is not a conflict");
            assert_eq!(label_of(&a, "h-1").as_deref(), Some("nova-db-01-from-B"));

            // ── Both edit the same host; the newer copy wins and is logged ───
            a.db.save_host(&host("h-2", "renamed-on-A", "2026-09-07T00:00:00Z"))
                .expect("A edits h-2");
            b.db.save_host(&host("h-2", "renamed-on-B", "2026-09-09T00:00:00Z"))
                .expect("B edits h-2");
            push(&b.ssh, &b.db, &b.vault, &dataset_id)
                .await
                .expect("B publishes the conflicting edit");

            let pulled = pull(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A pulls the conflict");
            assert_eq!(pulled.conflicts, 1);
            assert_eq!(
                label_of(&a, "h-2").as_deref(),
                Some("renamed-on-B"),
                "the newer (remote) copy wins"
            );
            let logged =
                a.db.list_sync_conflicts(&dataset_id, 10)
                    .expect("conflicts");
            assert_eq!(logged.len(), 1);
            assert_eq!(logged[0].entity_id, "h-2");
            assert_eq!(logged[0].resolution, "kept the newer remote copy");
            assert_eq!(
                logged[0].loser_updated_at.as_deref(),
                Some("2026-09-07T00:00:00Z"),
                "the losing copy's timestamp is kept for the user"
            );

            // ── A local-only edit survives a pull and is not a conflict ──────
            a.db.save_host(&host("h-1", "local-only-on-A", "2026-09-11T00:00:00Z"))
                .expect("A edits h-1");
            let pulled = pull(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A pulls again");
            assert_eq!(pulled.conflicts, 0);
            assert!(pulled.kept_local >= 1);
            assert_eq!(
                label_of(&a, "h-1").as_deref(),
                Some("local-only-on-A"),
                "a local edit is never silently overwritten by an older remote copy"
            );

            // ── A delete travels as a tombstone ──────────────────────────────
            b.db.delete_host("h-2").expect("B deletes h-2");
            push(&b.ssh, &b.db, &b.vault, &dataset_id)
                .await
                .expect("B publishes the delete");
            let pulled = pull(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A pulls the delete");
            assert_eq!(pulled.deleted, 1);
            assert!(
                a.db.get_host("h-2").unwrap().is_none(),
                "the remote delete removed the host locally"
            );

            // A host that was never in the dataset is untouched by any pull.
            a.db.save_host(&SavedHost {
                group_id: None,
                ..host("h-local", "never-shared", "2026-09-12T00:00:00Z")
            })
            .expect("local-only host");
            pull(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A pulls once more");
            assert!(
                a.db.get_host("h-local").unwrap().is_some(),
                "records outside the dataset are never deleted by a pull"
            );

            /* ── Credentials: opt in, publish, and receive on two machines
             * with different storage preferences. A's secret is in the OS
             * keychain; C prefers the keychain, D prefers the unlocked App
             * Vault and must end up with ciphertext, not a keychain entry. */
            let mut with_credentials = a.db.get_sync_dataset(&dataset_id).unwrap().unwrap();
            with_credentials.content_flags = SyncContentFlags {
                host_credentials: true,
                ..SyncContentFlags::default()
            }
            .to_json()
            .expect("flags");
            a.db.upsert_sync_dataset(&with_credentials)
                .expect("enable credential sync");
            crate::vault::save_credential(
                "h-1",
                &StoredCredential::Password {
                    password: "host-secret-from-A".into(),
                },
            )
            .expect("A stores a host secret");

            let pushed = push(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A publishes with credentials");
            assert_eq!(pushed.credentials_included, 1);

            let c = machine(&dataset_id, &root, &wrap);
            c.db.upsert_sync_dataset(&with_credentials)
                .expect("C joins with credential sync");
            let pulled = pull(&c.ssh, &c.db, &c.vault, &dataset_id)
                .await
                .expect("C pulls");
            assert_eq!(pulled.credentials_applied, 1);
            let on_c = c.db.get_host("h-1").unwrap().unwrap();
            assert_eq!(on_c.credential_storage, CredentialStorage::Keychain);
            match &crate::vault::get_credential("h-1").expect("keychain secret on C") {
                StoredCredential::Password { password } => {
                    assert_eq!(
                        password, "host-secret-from-A",
                        "the secret survives the trip"
                    )
                }
                other => panic!("unexpected credential: {other:?}"),
            }

            let d = machine(&dataset_id, &root, &wrap);
            d.db.upsert_sync_dataset(&with_credentials)
                .expect("D joins with credential sync");
            d.db.save_setting("default_credential_storage", "localVault")
                .expect("D prefers the App Vault");
            d.vault
                .set_session_key([9; 32])
                .expect("D unlocks its vault");
            let pulled = pull(&d.ssh, &d.db, &d.vault, &dataset_id)
                .await
                .expect("D pulls");
            assert_eq!(pulled.credentials_applied, 1);
            let on_d = d.db.get_host("h-1").unwrap().unwrap();
            assert_eq!(
                on_d.credential_storage,
                CredentialStorage::LocalVault,
                "a vault-preferring machine stores the pulled secret as ciphertext"
            );
            assert!(
                d.db.get_local_vault_credential("h-1").unwrap().is_some(),
                "the vault blob is present"
            );
            match &crate::vault::resolve_host_credential(
                &d.db,
                &d.vault,
                "h-1",
                CredentialStorage::LocalVault,
            )
            .expect("D resolves from its vault")
            {
                StoredCredential::Password { password } => {
                    assert_eq!(password, "host-secret-from-A")
                }
                other => panic!("unexpected credential: {other:?}"),
            }
            /* The direct-to-vault write also purges the keychain copy. The
             * keychain is process-wide in this test, so this is the same entry
             * C read a moment ago — which is exactly the guarantee: no stale
             * plaintext copy is left behind once a secret lives in the vault. */
            assert!(crate::vault::get_credential("h-1").is_err());
        }
        .await;

        cleanup(&a, &root, &dataset_id).await;
        outcome
    }

    #[tokio::test]
    async fn a_wrong_passphrase_and_an_empty_path_fail_distinguishably() {
        if std::env::var("OMNISSH_SYNC_TEST_HOST").is_err() {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live pull check");
            return;
        }

        let dataset_id = format!("live-pull-err-{}", uuid::Uuid::new_v4());
        let root = format!("/config/omnissh-pull-err-{dataset_id}");
        let key = generate_dataset_key().expect("key");
        let wrap = wrap_dataset_key(PASSPHRASE, &key).expect("wrap");
        secrets::save_server_secret(
            &dataset_id,
            &StoredCredential::Password {
                password: env("OMNISSH_SYNC_TEST_PASS", "testpass"),
            },
        )
        .expect("server secret");
        secrets::save_passphrase(&dataset_id, PASSPHRASE).expect("passphrase");

        let a = machine(&dataset_id, &root, &wrap);

        // Nothing published yet: a pull says so instead of failing obscurely.
        match pull(&a.ssh, &a.db, &a.vault, &dataset_id).await {
            Err(SyncError::NotFound(message)) => {
                assert!(
                    message.contains("nothing has been published"),
                    "got {message}"
                )
            }
            other => panic!("expected NotFound, got {other:?}"),
        }

        a.db.save_host(&SavedHost {
            group_id: None,
            ..host("h-1", "nova-db-01", "2026-09-02T00:00:00Z")
        })
        .expect("host");
        push(&a.ssh, &a.db, &a.vault, &dataset_id)
            .await
            .expect("publish");

        /* A machine that joined with the wrong passphrase must fail the AEAD
         * tag check, not half-apply a garbled dataset. */
        secrets::save_passphrase(&dataset_id, "a-different-passphrase").expect("rotate secret");
        match pull(&a.ssh, &a.db, &a.vault, &dataset_id).await {
            Err(SyncError::Decrypt) => {}
            other => panic!("expected Decrypt, got {other:?}"),
        }

        cleanup(&a, &root, &dataset_id).await;
    }

    /* Two machines auto-syncing the SAME dataset at the same time — the
     * question "do we need to warn users, or does it just converge?" answered
     * by experiment rather than by argument. */
    #[tokio::test]
    async fn two_machines_editing_at_once_converge_and_the_older_edit_is_logged() {
        if std::env::var("OMNISSH_SYNC_TEST_HOST").is_err() {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the concurrency check");
            return;
        }

        let dataset_id = format!("live-conc-{}", uuid::Uuid::new_v4());
        let root = format!("/config/omnissh-conc-{dataset_id}");
        let key = generate_dataset_key().expect("key");
        let wrap = wrap_dataset_key(PASSPHRASE, &key).expect("wrap");
        secrets::save_server_secret(
            &dataset_id,
            &StoredCredential::Password {
                password: env("OMNISSH_SYNC_TEST_PASS", "testpass"),
            },
        )
        .expect("server secret");
        secrets::save_passphrase(&dataset_id, PASSPHRASE).expect("passphrase");

        let a = machine(&dataset_id, &root, &wrap);
        let b = machine(&dataset_id, &root, &wrap);

        let outcome = async {
            a.db.save_host(&SavedHost {
                group_id: None,
                ..host("h-1", "shared-01", "2026-09-02T00:00:00Z")
            })
            .expect("seed");
            push(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A publishes");
            pull(&b.ssh, &b.db, &b.vault, &dataset_id)
                .await
                .expect("B joins by pulling");

            /* Both machines edit the same host without seeing each other, then
             * both try to publish — the interleaving a user running two
             * instances against one personal dataset would hit. */
            a.db.save_host(&SavedHost {
                group_id: None,
                ..host("h-1", "renamed-on-A", "2026-09-05T00:00:00Z")
            })
            .expect("A edits");
            b.db.save_host(&SavedHost {
                group_id: None,
                ..host("h-1", "renamed-on-B", "2026-09-06T00:00:00Z")
            })
            .expect("B edits, later");

            push(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A publishes first");
            match push(&b.ssh, &b.db, &b.vault, &dataset_id).await {
                Err(SyncError::Conflict(message)) => assert!(
                    message.contains("pull before pushing"),
                    "B's stale push must be refused, got {message}"
                ),
                other => panic!("expected B's push to be refused, got {other:?}"),
            }

            // B pulls: the merge keeps the newer edit and logs the loser.
            let pulled = pull(&b.ssh, &b.db, &b.vault, &dataset_id)
                .await
                .expect("B pulls after the refusal");
            assert_eq!(pulled.conflicts, 1);
            assert!(
                pulled.published_by_another_machine,
                "B is told the generation came from another machine"
            );
            assert_eq!(
                label_of(&b, "h-1").as_deref(),
                Some("renamed-on-B"),
                "the newer edit wins"
            );
            let logged =
                b.db.list_sync_conflicts(&dataset_id, 10)
                    .expect("conflicts");
            assert_eq!(logged.len(), 1);
            assert_eq!(
                logged[0].loser_updated_at.as_deref(),
                Some("2026-09-05T00:00:00Z"),
                "A's overwritten edit is recorded, not silently dropped"
            );

            // B republishes the merge; A pulls and both sides match.
            push(&b.ssh, &b.db, &b.vault, &dataset_id)
                .await
                .expect("B publishes the merge");
            let pulled = pull(&a.ssh, &a.db, &a.vault, &dataset_id)
                .await
                .expect("A pulls the merge");
            assert!(pulled.published_by_another_machine);
            assert_eq!(
                label_of(&a, "h-1").as_deref(),
                Some("renamed-on-B"),
                "both machines end on the same record"
            );

            /* Convergence: with both sides equal, a further pull applies
             * nothing and neither machine has anything left to publish, so two
             * instances do not ping-pong generations forever. */
            let generation =
                a.db.get_sync_dataset(&dataset_id)
                    .unwrap()
                    .unwrap()
                    .last_generation;
            for machine in [&a, &b] {
                let quiet = pull(&machine.ssh, &machine.db, &machine.vault, &dataset_id)
                    .await
                    .expect("converged pull");
                assert_eq!(quiet.applied.hosts, 0, "nothing left to apply");
                assert_eq!(quiet.conflicts, 0, "and nothing left to resolve");
            }
            assert_eq!(
                a.db.get_sync_dataset(&dataset_id)
                    .unwrap()
                    .unwrap()
                    .last_generation,
                generation,
                "converged machines stop bumping the generation"
            );
        }
        .await;

        cleanup(&a, &root, &dataset_id).await;
        outcome
    }
}
