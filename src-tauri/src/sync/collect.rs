/*
 * Turning the local database into a dataset payload.
 *
 * One pass per enabled content kind (AD-11), plus the tombstones that tell the
 * other side what was deleted. Two details carry the merge contract:
 *
 * - `base_hash` is the digest of a record's *data* only, never of the wrapper
 *   that holds `revision`. That keeps the hash stable while a revision counter
 *   moves, so "did this record change?" is answerable without circularity.
 * - `revision` only increments when the data hash differs from the last synced
 *   base for this dataset. An unchanged record republishes with the revision it
 *   already had, so a push does not make every record look newly edited to the
 *   other machine.
 *
 * The dataset's scope narrows the host-shaped kinds: `hosts`, `groups`, port
 * forwards, and plugin configs come from the resolved selection only, because a
 * scoped dataset that published every group would hand a peer the groups its
 * hosts were meant to be separated from. Snippets, S3 connections, and app
 * settings are not host-shaped and keep their content-flag behaviour.
 *
 * Credentials are read only when the dataset opts in. A secret that cannot be
 * read without prompting (a locked App Vault) is *reported*, never silently
 * dropped — the push command turns that count into a blocking preflight.
 */

use std::collections::{BTreeSet, HashMap};

use serde::Serialize;

use crate::db::{CredentialStorage, HostDb, SyncEntityType};
use crate::vault::{self, LocalVault, StoredCredential, VaultError};

use super::codec::{
    app_settings_record, content_digest, Record, ScopeRemoval, SyncPayload, Tombstone,
};
use super::dataset::SyncContentFlags;
use super::scope::ResolvedScope;
use super::SyncError;

/// Counts a push reports back to the UI.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectStats {
    pub hosts: usize,
    pub groups: usize,
    pub snippets: usize,
    pub snippet_folders: usize,
    pub port_forwards: usize,
    pub s3_connections: usize,
    pub host_plugins: usize,
    pub app_settings: bool,
    pub tombstones: usize,
    /// Hosts that left this dataset's scope on this push (Task 8).
    pub scope_removals: usize,
    pub credentials_included: usize,
    /// Hosts (or S3 connections) whose secret could not be read.
    pub credentials_blocked: usize,
}

/// The base state a previous sync agreed on: `(entity, id) → (revision, hash)`.
pub type BaseState = HashMap<(SyncEntityType, String), (i64, String)>;

pub fn base_state(db: &HostDb, dataset_id: &str) -> Result<BaseState, SyncError> {
    Ok(db
        .list_sync_record_state(dataset_id)?
        .into_iter()
        .map(|state| {
            (
                (state.entity_type, state.entity_id),
                (state.remote_revision, state.base_hash),
            )
        })
        .collect())
}

/* One record wrapper for every entity kind: hash the data, look up the base,
 * and bump the revision only on a real change. Returns the record plus its
 * hash so the caller can persist the new base without hashing twice. */
fn wrap_record<T: Serialize + Clone>(
    entity: SyncEntityType,
    id: String,
    updated_at: String,
    data: T,
    credential: Option<StoredCredential>,
    base: &BaseState,
) -> Result<(Record<T>, String), SyncError> {
    let hash = content_digest(&data)?;
    let (revision, changed) = match base.get(&(entity, id.clone())) {
        Some((revision, base_hash)) if *base_hash == hash => (*revision, false),
        Some((revision, _)) => (revision.saturating_add(1), true),
        None => (1, true),
    };
    let _ = changed;
    Ok((
        Record {
            id,
            revision: revision.max(1) as u64,
            updated_at,
            deleted: false,
            credential,
            data,
        },
        hash,
    ))
}

/// A record's new base state, to persist after a successful publish.
pub struct CollectedBase {
    pub entity_type: SyncEntityType,
    pub entity_id: String,
    pub revision: i64,
    pub hash: String,
}

pub struct Collected {
    pub payload: SyncPayload,
    pub stats: CollectStats,
    pub bases: Vec<CollectedBase>,
    /* Host ids that were in this dataset's base state but are out of its scope
     * now, and still exist locally. The caller drops this dataset's base rows
     * for them only after the remote accepted the bundle, and their local rows
     * are never touched. */
    pub scope_removals: Vec<String>,
}

/// Build the payload for `dataset_id` at `generation`.
///
/// `scope` is the resolved selection (Task 8): hosts, groups, port forwards,
/// and plugin configs are limited to it, while every other content kind keeps
/// its content-flag behaviour.
///
/// `local_vault` is only touched for hosts stored in the App Vault, and only
/// when credentials are enabled.
pub fn collect(
    db: &HostDb,
    local_vault: &LocalVault,
    dataset_id: &str,
    generation: u64,
    flags: SyncContentFlags,
    scope: &ResolvedScope,
) -> Result<Collected, SyncError> {
    let flags = flags.normalized();
    let base = base_state(db, dataset_id)?;
    let mut payload = SyncPayload::new(dataset_id, generation);
    let mut stats = CollectStats::default();
    let mut bases: Vec<CollectedBase> = Vec::new();
    /* One read of `saved_hosts` feeds the host section, the plugin section, the
     * scope-removal comparison, and the host-tombstone filter. */
    let hosts = db.list_hosts()?;

    if flags.hosts {
        let mut records = Vec::new();
        for host in &hosts {
            if !scope.includes_host(&host.id) {
                continue;
            }
            let credential = if flags.host_credentials {
                match read_host_credential(db, local_vault, &host.id, host.credential_storage) {
                    Ok(Some(credential)) => {
                        stats.credentials_included += 1;
                        Some(credential)
                    }
                    Ok(None) => None,
                    Err(_) => {
                        stats.credentials_blocked += 1;
                        None
                    }
                }
            } else {
                None
            };
            let (record, hash) = wrap_record(
                SyncEntityType::Host,
                host.id.clone(),
                host.updated_at.clone(),
                host.clone(),
                credential,
                &base,
            )?;
            bases.push(CollectedBase {
                entity_type: SyncEntityType::Host,
                entity_id: record.id.clone(),
                revision: record.revision as i64,
                hash,
            });
            records.push(record);
        }
        stats.hosts = records.len();
        payload.sections.hosts = Some(records);
    }

    if flags.groups {
        let groups = db.list_groups()?;
        let mut records = Vec::new();
        for group in &groups {
            if !scope.includes_group(&group.id) {
                continue;
            }
            let (record, hash) = wrap_record(
                SyncEntityType::Group,
                group.id.clone(),
                group.updated_at.clone(),
                group.clone(),
                None,
                &base,
            )?;
            bases.push(CollectedBase {
                entity_type: SyncEntityType::Group,
                entity_id: record.id.clone(),
                revision: record.revision as i64,
                hash,
            });
            records.push(record);
        }
        stats.groups = records.len();
        payload.sections.groups = Some(records);
    }

    if flags.snippet_folders {
        let mut records = Vec::new();
        for folder in db.list_snippet_folders()? {
            let (record, hash) = wrap_record(
                SyncEntityType::SnippetFolder,
                folder.id.clone(),
                folder.updated_at.clone(),
                folder.clone(),
                None,
                &base,
            )?;
            bases.push(CollectedBase {
                entity_type: SyncEntityType::SnippetFolder,
                entity_id: record.id.clone(),
                revision: record.revision as i64,
                hash,
            });
            records.push(record);
        }
        stats.snippet_folders = records.len();
        payload.sections.snippet_folders = Some(records);
    }

    if flags.snippets {
        let mut records = Vec::new();
        for snippet in db.list_snippets(None)? {
            let (record, hash) = wrap_record(
                SyncEntityType::Snippet,
                snippet.id.clone(),
                snippet.updated_at.clone(),
                snippet.clone(),
                None,
                &base,
            )?;
            bases.push(CollectedBase {
                entity_type: SyncEntityType::Snippet,
                entity_id: record.id.clone(),
                revision: record.revision as i64,
                hash,
            });
            records.push(record);
        }
        stats.snippets = records.len();
        payload.sections.snippets = Some(records);
    }

    if flags.port_forwards {
        let mut records = Vec::new();
        for rule in db.list_pf_rules(None)? {
            let in_scope = matches!(rule.host_id.as_deref(), Some(id) if scope.includes_host(id));
            if !in_scope {
                continue;
            }
            let (record, hash) = wrap_record(
                SyncEntityType::PortForward,
                rule.id.clone(),
                rule.updated_at.clone(),
                rule.clone(),
                None,
                &base,
            )?;
            bases.push(CollectedBase {
                entity_type: SyncEntityType::PortForward,
                entity_id: record.id.clone(),
                revision: record.revision as i64,
                hash,
            });
            records.push(record);
        }
        stats.port_forwards = records.len();
        payload.sections.port_forwards = Some(records);
    }

    if flags.s3_connections {
        let mut records = Vec::new();
        for connection in db.list_s3_connections()? {
            let credential = if flags.s3_credentials {
                match vault::get_credential(&format!("s3:{}", connection.id)) {
                    Ok(credential) => {
                        stats.credentials_included += 1;
                        Some(credential)
                    }
                    Err(VaultError::NotFound(_)) => None,
                    Err(_) => {
                        stats.credentials_blocked += 1;
                        None
                    }
                }
            } else {
                None
            };
            let (record, hash) = wrap_record(
                SyncEntityType::S3Connection,
                connection.id.clone(),
                connection.updated_at.clone(),
                connection.clone(),
                credential,
                &base,
            )?;
            bases.push(CollectedBase {
                entity_type: SyncEntityType::S3Connection,
                entity_id: record.id.clone(),
                revision: record.revision as i64,
                hash,
            });
            records.push(record);
        }
        stats.s3_connections = records.len();
        payload.sections.s3_connections = Some(records);
    }

    if flags.host_plugins {
        let mut records = Vec::new();
        for host in &hosts {
            if !scope.includes_host(&host.id) {
                continue;
            }
            for config in db.list_plugin_configs(&host.id)? {
                let id = format!("{}:{}", config.host_id, config.plugin_id);
                let (record, hash) = wrap_record(
                    SyncEntityType::HostPlugin,
                    id,
                    // Plugin rows carry their own `updated_at` in the table but
                    // not in the struct, so the host's timestamp is the clock.
                    host.updated_at.clone(),
                    config.clone(),
                    None,
                    &base,
                )?;
                bases.push(CollectedBase {
                    entity_type: SyncEntityType::HostPlugin,
                    entity_id: record.id.clone(),
                    revision: record.revision as i64,
                    hash,
                });
                records.push(record);
            }
        }
        stats.host_plugins = records.len();
        payload.sections.host_plugins = Some(records);
    }

    if flags.app_settings {
        let entries = db.load_all_settings()?;
        let record = app_settings_record(chrono::Utc::now().to_rfc3339(), entries);
        let hash = content_digest(&record)?;
        let revision = base
            .get(&(SyncEntityType::AppSettings, "appSettings".to_string()))
            .map(|(revision, base_hash)| {
                if *base_hash == hash {
                    *revision
                } else {
                    revision.saturating_add(1)
                }
            })
            .unwrap_or(1);
        bases.push(CollectedBase {
            entity_type: SyncEntityType::AppSettings,
            entity_id: "appSettings".to_string(),
            revision,
            hash,
        });
        stats.app_settings = true;
        payload.sections.app_settings = Some(record);
    }

    let known_hosts = known_host_ids(&base);
    let removed_at = chrono::Utc::now().to_rfc3339();

    /* Tombstones are published in full on every push rather than tracked per
     * dataset: applying a delete twice is a no-op, and a client that has been
     * offline for months still needs the whole delete set. The table only grows
     * with real deletions.
     *
     * A host tombstone is the exception, because the table is global while a
     * dataset is not: publishing every host delete would let one dataset delete
     * a host that belongs to another. Only the hosts this dataset has agreed on
     * before are published. */
    payload.tombstones = db
        .list_sync_tombstones(None)?
        .into_iter()
        .filter(|tombstone| match tombstone.entity_type {
            SyncEntityType::Host => flags.hosts && known_hosts.contains(&tombstone.entity_id),
            entity => tombstone_in_scope(entity, flags),
        })
        .map(|tombstone| Tombstone {
            entity_type: tombstone.entity_type.as_str().to_string(),
            entity_id: tombstone.entity_id,
            deleted_at: tombstone.deleted_at,
        })
        .collect();
    stats.tombstones = payload.tombstones.len();

    /* The other half of the same problem: a host this dataset used to carry and
     * no longer does. It is still a host on this machine, so it is reported as a
     * scope removal rather than a deletion, and the other side keeps its own
     * copy. A host deleted outright is absent from `hosts` and travels as the
     * tombstone above instead. */
    if flags.hosts {
        let live: BTreeSet<&str> = hosts.iter().map(|host| host.id.as_str()).collect();
        payload.scope_removals = known_hosts
            .into_iter()
            .filter(|id| live.contains(id.as_str()) && !scope.host_ids.contains(id))
            .map(|id| ScopeRemoval {
                entity_type: SyncEntityType::Host.as_str().to_string(),
                entity_id: id,
                removed_at: removed_at.clone(),
            })
            .collect();
    }
    stats.scope_removals = payload.scope_removals.len();
    let scope_removals: Vec<String> = payload
        .scope_removals
        .iter()
        .map(|removal| removal.entity_id.clone())
        .collect();

    Ok(Collected {
        payload,
        stats,
        bases,
        scope_removals,
    })
}

/* The hosts this dataset has agreed on before: its base state of `host` rows.
 * That set, not the current host table, is what decides whether a host delete
 * belongs to this dataset — a delete for a host no dataset ever published is
 * nothing this client needs to tell anyone about. */
fn known_host_ids(base: &BaseState) -> BTreeSet<String> {
    base.keys()
        .filter(|(entity_type, _)| *entity_type == SyncEntityType::Host)
        .map(|(_, id)| id.clone())
        .collect()
}

/// A delete is only published for content kinds this dataset actually carries.
fn tombstone_in_scope(entity: SyncEntityType, flags: SyncContentFlags) -> bool {
    match entity {
        SyncEntityType::Host => flags.hosts,
        SyncEntityType::Group => flags.groups,
        SyncEntityType::Snippet => flags.snippets,
        SyncEntityType::SnippetFolder => flags.snippet_folders,
        SyncEntityType::PortForward => flags.port_forwards,
        SyncEntityType::S3Connection => flags.s3_connections,
        SyncEntityType::HostPlugin => flags.host_plugins,
        SyncEntityType::AppSettings => flags.app_settings,
    }
}

/* A host with no stored secret is normal (key-file auth with no passphrase), so
 * a missing record is `None` rather than an error; anything else — above all a
 * locked App Vault — is an error the caller counts as blocked. */
fn read_host_credential(
    db: &HostDb,
    local_vault: &LocalVault,
    host_id: &str,
    storage: CredentialStorage,
) -> Result<Option<StoredCredential>, SyncError> {
    match vault::resolve_host_credential(db, local_vault, host_id, storage) {
        Ok(credential) => Ok(Some(credential)),
        Err(VaultError::NotFound(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Preflight counts for the push dialog: how many in-scope secrets are readable
/// right now, without publishing anything.
pub fn credential_preflight(
    db: &HostDb,
    local_vault: &LocalVault,
    scope: &ResolvedScope,
    flags: SyncContentFlags,
) -> Result<(usize, usize, usize), SyncError> {
    let flags = flags.normalized();
    let hosts = db.list_hosts()?;
    let hosts_in_scope = if flags.hosts {
        hosts
            .iter()
            .filter(|host| scope.includes_host(&host.id))
            .count()
    } else {
        0
    };
    if !flags.includes_credentials() {
        return Ok((hosts_in_scope, 0, 0));
    }

    let mut readable = 0;
    let mut blocked = 0;
    if flags.host_credentials {
        for host in &hosts {
            if !scope.includes_host(&host.id) {
                continue;
            }
            match read_host_credential(db, local_vault, &host.id, host.credential_storage) {
                Ok(Some(_)) => readable += 1,
                Ok(None) => {}
                Err(_) => blocked += 1,
            }
        }
    }
    if flags.s3_credentials {
        for connection in db.list_s3_connections()? {
            match vault::get_credential(&format!("s3:{}", connection.id)) {
                Ok(_) => readable += 1,
                Err(VaultError::NotFound(_)) => {}
                Err(_) => blocked += 1,
            }
        }
    }
    Ok((hosts_in_scope, readable, blocked))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SavedHost;

    fn host(id: &str, label: &str, updated_at: &str) -> SavedHost {
        SavedHost {
            id: id.into(),
            label: label.into(),
            host: "10.0.0.5".into(),
            port: 22,
            username: "deployer".into(),
            auth_type: "password".into(),
            credential_storage: CredentialStorage::Keychain,
            group_id: None,
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

    #[test]
    fn a_new_record_starts_at_revision_one() {
        let base = BaseState::new();
        let (record, hash) = wrap_record(
            SyncEntityType::Host,
            "h1".into(),
            "2026-09-02T00:00:00Z".into(),
            host("h1", "db-01", "2026-09-02T00:00:00Z"),
            None,
            &base,
        )
        .unwrap();
        assert_eq!(record.revision, 1);
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn an_unchanged_record_keeps_its_revision_and_a_changed_one_bumps() {
        let unchanged = host("h1", "db-01", "2026-09-02T00:00:00Z");
        let hash = content_digest(&unchanged).unwrap();
        let mut base = BaseState::new();
        base.insert((SyncEntityType::Host, "h1".to_string()), (7, hash.clone()));

        let (same, same_hash) = wrap_record(
            SyncEntityType::Host,
            "h1".into(),
            "2026-09-02T00:00:00Z".into(),
            unchanged,
            None,
            &base,
        )
        .unwrap();
        assert_eq!(same.revision, 7, "republishing must not look like an edit");
        assert_eq!(same_hash, hash);

        let (edited, edited_hash) = wrap_record(
            SyncEntityType::Host,
            "h1".into(),
            "2026-09-03T00:00:00Z".into(),
            host("h1", "db-01-renamed", "2026-09-03T00:00:00Z"),
            None,
            &base,
        )
        .unwrap();
        assert_eq!(edited.revision, 8);
        assert_ne!(edited_hash, hash);
    }

    #[test]
    fn a_credential_does_not_change_a_records_data_hash() {
        /* The hash covers the row only, so enabling credential sync must not
         * make every host look edited on the other machine. */
        let data = host("h1", "db-01", "2026-09-02T00:00:00Z");
        let base = BaseState::new();
        let (_, without) = wrap_record(
            SyncEntityType::Host,
            "h1".into(),
            "2026-09-02T00:00:00Z".into(),
            data.clone(),
            None,
            &base,
        )
        .unwrap();
        let (with_record, with) = wrap_record(
            SyncEntityType::Host,
            "h1".into(),
            "2026-09-02T00:00:00Z".into(),
            data,
            Some(StoredCredential::Password {
                password: "s3cret".into(),
            }),
            &base,
        )
        .unwrap();
        assert_eq!(without, with);
        assert!(with_record.credential.is_some());
    }

    #[test]
    fn tombstones_are_filtered_to_the_datasets_content_kinds() {
        let hosts_only = SyncContentFlags {
            hosts: true,
            snippets: false,
            snippet_folders: false,
            s3_connections: false,
            app_settings: false,
            ..SyncContentFlags::default()
        }
        .normalized();

        assert!(tombstone_in_scope(SyncEntityType::Host, hosts_only));
        assert!(tombstone_in_scope(SyncEntityType::Group, hosts_only));
        assert!(!tombstone_in_scope(SyncEntityType::Snippet, hosts_only));
        assert!(!tombstone_in_scope(
            SyncEntityType::S3Connection,
            hosts_only
        ));
        assert!(!tombstone_in_scope(SyncEntityType::AppSettings, hosts_only));
    }
}
