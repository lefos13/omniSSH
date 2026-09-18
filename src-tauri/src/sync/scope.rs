/*
 * Dataset scope: which local hosts one dataset carries (Task 8).
 *
 * A dataset is either the whole host list (`all`), a set of whole groups
 * (`groups`), or an explicit host selection (`hosts`). The mode lives in the
 * `scope_mode` column as a small JSON object that also holds a key-auth
 * dataset's key path; the selection itself lives in `sync_dataset_members`, one
 * row per group or host id, so a dataset's membership is queryable instead of
 * buried in a blob.
 *
 * Two rules are deliberate:
 *
 * - Saving validates the selection strictly (an id that does not exist, or that
 *   is a host where a group is expected, is refused), while *resolving* it is
 *   tolerant: a group deleted locally since it was selected simply contributes
 *   no hosts, so a stale membership row can never break a push or the dataset
 *   list.
 * - A host leaving the scope is not a delete. Pushing the new scope emits a
 *   `scopeRemovals` record so other clients stop claiming that host for this
 *   dataset, and applying one clears only what this dataset agreed about the
 *   host and its children. The host row and its credential stay on the machine
 *   that has them.
 */

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::db::{HostDb, SyncDataset, SyncEntityType};

use super::codec::ScopeRemoval;
use super::SyncError;

/// Keys of the `scope_mode` JSON object. `mode` is the selector; `keyPath` is a
/// key-auth endpoint's private key, kept beside it rather than in a column of
/// its own.
const SCOPE_MODE_KEY: &str = "mode";
const KEY_PATH_KEY: &str = "keyPath";

/// How a dataset selects the hosts it carries.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncScopeMode {
    /// Every host on this machine. The default, and what a row written before
    /// scopes existed means.
    #[default]
    All,
    /// Every host whose `group_id` is one of the selected groups.
    Groups,
    /// Exactly the selected hosts.
    Hosts,
}

impl SyncScopeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Groups => "groups",
            Self::Hosts => "hosts",
        }
    }

    /// The kind `sync_dataset_members` rows carry for this mode; `None` for
    /// `all`, which selects everything and therefore stores no membership.
    fn member_kind(self) -> Option<SyncEntityType> {
        match self {
            Self::All => None,
            Self::Groups => Some(SyncEntityType::Group),
            Self::Hosts => Some(SyncEntityType::Host),
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "all" => Some(Self::All),
            "groups" => Some(Self::Groups),
            "hosts" => Some(Self::Hosts),
            _ => None,
        }
    }
}

// ─── The `scope_mode` column ─────────────────────────────────────────────────

/* The column is read by three callers (endpoint reconstruction, the dataset
 * summary, and scope resolution) and written by one, so the JSON shape is
 * decoded here once. Anything unreadable — an empty string, a legacy bare
 * `"all"`, a hand-edited value — falls back to `All`, which is the behaviour
 * every dataset saved before scopes existed had. */
fn scope_object(row: &SyncDataset) -> std::collections::BTreeMap<String, String> {
    serde_json::from_str(&row.scope_mode).unwrap_or_default()
}

pub fn scope_mode_of(row: &SyncDataset) -> SyncScopeMode {
    scope_object(row)
        .get(SCOPE_MODE_KEY)
        .and_then(|mode| SyncScopeMode::parse(mode))
        .or_else(|| SyncScopeMode::parse(row.scope_mode.trim()))
        .unwrap_or_default()
}

/// The key path stored beside the scope mode, when this dataset uses key auth.
pub fn key_path_of(row: &SyncDataset) -> Result<String, SyncError> {
    scope_object(row)
        .get(KEY_PATH_KEY)
        .cloned()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            SyncError::NotFound(
                "this dataset uses key authentication but has no key path — re-save it in Settings"
                    .into(),
            )
        })
}

/// Serialize the column, keeping every key the row already carried so an
/// unrelated field cannot be dropped by a save that only meant to change the
/// scope.
pub fn scope_json(
    existing_row: &Option<SyncDataset>,
    mode: SyncScopeMode,
    key_path: Option<&str>,
) -> Result<String, SyncError> {
    let mut map = existing_row.as_ref().map(scope_object).unwrap_or_default();
    map.insert(SCOPE_MODE_KEY.to_string(), mode.as_str().to_string());
    match key_path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => map.insert(KEY_PATH_KEY.to_string(), path.to_string()),
        None => map.remove(KEY_PATH_KEY),
    };
    serde_json::to_string(&map).map_err(|e| SyncError::Serialization(e.to_string()))
}

// ─── Membership rows ─────────────────────────────────────────────────────────

/// Turn the selection a save was given into `sync_dataset_members` rows.
///
/// Strict on purpose: a save is the one moment the user is looking at the
/// selection, so an id that no longer exists, or one of the wrong kind, is
/// refused with a message naming it instead of being stored as a member that
/// silently resolves to nothing.
pub fn validate_selection(
    db: &HostDb,
    mode: SyncScopeMode,
    ids: &[String],
) -> Result<Vec<(SyncEntityType, String)>, SyncError> {
    let selected: BTreeSet<String> = ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();

    /* `all` selects everything, so any list left over from another mode is
     * dropped rather than stored: switching groups → all must not leave
     * membership rows that would come back if the mode were switched again. */
    let Some(kind) = mode.member_kind() else {
        return Ok(Vec::new());
    };
    if selected.is_empty() {
        return Err(SyncError::Format(match mode {
            SyncScopeMode::Groups => {
                "choose at least one group, or switch the scope back to all hosts".into()
            }
            _ => "choose at least one host, or switch the scope back to all hosts".into(),
        }));
    }

    let (expected, other, expected_label, other_label) = match kind {
        SyncEntityType::Group => (
            db.list_groups()?
                .into_iter()
                .map(|g| g.id)
                .collect::<BTreeSet<_>>(),
            db.list_hosts()?
                .into_iter()
                .map(|h| h.id)
                .collect::<BTreeSet<_>>(),
            "group",
            "a host, not a group",
        ),
        _ => (
            db.list_hosts()?
                .into_iter()
                .map(|h| h.id)
                .collect::<BTreeSet<_>>(),
            db.list_groups()?
                .into_iter()
                .map(|g| g.id)
                .collect::<BTreeSet<_>>(),
            "host",
            "a group, not a host",
        ),
    };

    let mut rows = Vec::with_capacity(selected.len());
    for id in selected {
        if expected.contains(&id) {
            rows.push((kind, id));
        } else if other.contains(&id) {
            return Err(SyncError::Format(format!(
                "“{id}” is {other_label} — this dataset's scope selects {}s",
                expected_label
            )));
        } else {
            return Err(SyncError::NotFound(format!(
                "no {expected_label} with id {id} on this computer"
            )));
        }
    }
    Ok(rows)
}

/// The membership ids of one dataset, restricted to the kind its mode selects.
pub fn member_ids(
    db: &HostDb,
    dataset_id: &str,
    mode: SyncScopeMode,
) -> Result<Vec<String>, SyncError> {
    let Some(kind) = mode.member_kind() else {
        return Ok(Vec::new());
    };
    Ok(db
        .list_sync_dataset_members(dataset_id)?
        .into_iter()
        .filter(|(entity_type, _)| *entity_type == kind)
        .map(|(_, id)| id)
        .collect())
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/// The hosts and groups one dataset carries, after the mode and its membership
/// have been applied to the current local database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedScope {
    pub mode: SyncScopeMode,
    pub host_ids: BTreeSet<String>,
    /// Groups to publish: the selected ones, plus every group a selected host
    /// references, so a pulled host never arrives with a dangling `group_id`.
    pub group_ids: BTreeSet<String>,
}

impl ResolvedScope {
    pub fn includes_host(&self, id: &str) -> bool {
        self.host_ids.contains(id)
    }

    pub fn includes_group(&self, id: &str) -> bool {
        self.group_ids.contains(id)
    }
}

/// Resolve a saved dataset's scope against the local database.
///
/// Membership ids that no longer resolve are skipped rather than reported: the
/// group they named was deleted locally, and refusing to resolve would break
/// every push and hide the dataset from the list until the user edited it.
pub fn resolve(db: &HostDb, dataset_id: &str) -> Result<ResolvedScope, SyncError> {
    let row = db
        .get_sync_dataset(dataset_id)?
        .ok_or_else(|| SyncError::NotFound(format!("no such sync dataset: {dataset_id}")))?;
    resolve_row(db, &row)
}

/// Resolve a row that is already in hand — a save, or the dataset list building
/// a summary — so the caller does not pay for a second lookup.
pub fn resolve_row(db: &HostDb, row: &SyncDataset) -> Result<ResolvedScope, SyncError> {
    let mode = scope_mode_of(row);
    resolve_selection(db, mode, &member_ids(db, &row.id, mode)?)
}

fn resolve_selection(
    db: &HostDb,
    mode: SyncScopeMode,
    ids: &[String],
) -> Result<ResolvedScope, SyncError> {
    let hosts = db.list_hosts()?;
    let all_groups: BTreeSet<String> = db.list_groups()?.into_iter().map(|g| g.id).collect();
    let all_hosts: BTreeSet<String> = hosts.iter().map(|h| h.id.clone()).collect();
    let selected: BTreeSet<String> = ids.iter().cloned().collect();

    match mode {
        SyncScopeMode::All => Ok(ResolvedScope {
            mode,
            host_ids: all_hosts,
            group_ids: all_groups,
        }),
        SyncScopeMode::Groups => {
            let group_ids: BTreeSet<String> = selected.intersection(&all_groups).cloned().collect();
            Ok(ResolvedScope {
                mode,
                host_ids: hosts
                    .iter()
                    .filter(|host| {
                        matches!(
                            host.group_id.as_ref(),
                            Some(group_id) if group_ids.contains(group_id)
                        )
                    })
                    .map(|host| host.id.clone())
                    .collect(),
                group_ids,
            })
        }
        SyncScopeMode::Hosts => {
            let host_ids: BTreeSet<String> = selected.intersection(&all_hosts).cloned().collect();
            Ok(ResolvedScope {
                mode,
                group_ids: hosts
                    .iter()
                    .filter(|host| host_ids.contains(&host.id))
                    .filter_map(|host| host.group_id.clone())
                    .filter(|group_id| all_groups.contains(group_id))
                    .collect(),
                host_ids,
            })
        }
    }
}

// ─── Scope removals ──────────────────────────────────────────────────────────

/// Forget what `dataset_id` agreed about `host_id` and its children.
///
/// Only record state is cleared. The host row, its credential, and its saved
/// port-forward rules and plugin configs all stay: they are the user's own data
/// and may well be carried by another dataset. Returns how many base rows were
/// dropped.
pub fn forget_host(db: &HostDb, dataset_id: &str, host_id: &str) -> Result<usize, SyncError> {
    let mut cleared =
        db.clear_sync_record_state(dataset_id, Some((SyncEntityType::Host, host_id)))?;

    /* Port-forward rules are children by `host_id`, which the rule itself
     * carries; a rule that only ever existed on the other machine has no local
     * row and nothing to clear. */
    for rule in db.list_pf_rules(None)? {
        if rule.host_id.as_deref() == Some(host_id) {
            cleared += db.clear_sync_record_state(
                dataset_id,
                Some((SyncEntityType::PortForward, rule.id.as_str())),
            )?;
        }
    }

    /* Plugin records are keyed `"{host_id}:{plugin_id}"`, so the base state
     * itself identifies the host's children even after the config row is gone. */
    let prefix = format!("{host_id}:");
    for state in db.list_sync_record_state(dataset_id)? {
        if state.entity_type == SyncEntityType::HostPlugin && state.entity_id.starts_with(&prefix) {
            cleared += db.clear_sync_record_state(
                dataset_id,
                Some((SyncEntityType::HostPlugin, state.entity_id.as_str())),
            )?;
        }
    }
    Ok(cleared)
}

/// Apply a pulled payload's scope removals. A removal is not a delete: nothing
/// is removed from `saved_hosts` and no credential is touched.
pub fn apply_scope_removals(
    db: &HostDb,
    dataset_id: &str,
    removals: &[ScopeRemoval],
) -> Result<usize, SyncError> {
    let mut cleared = 0;
    for removal in removals {
        if SyncEntityType::from_db(removal.entity_type.clone()).ok() != Some(SyncEntityType::Host) {
            continue;
        }
        cleared += forget_host(db, dataset_id, &removal.entity_id)?;
    }
    Ok(cleared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{CredentialStorage, HostGroup, SavedHost, SyncDataset, SyncRecordState};
    use crate::sync::codec::SyncPayload;
    use crate::sync::collect::collect;
    use crate::sync::dataset::SyncContentFlags;

    const DATASET: &str = "ds-nova";

    fn host(id: &str, label: &str, group_id: Option<&str>) -> SavedHost {
        SavedHost {
            id: id.into(),
            label: label.into(),
            host: "10.0.0.5".into(),
            port: 22,
            username: "deployer".into(),
            auth_type: "password".into(),
            credential_storage: CredentialStorage::Keychain,
            group_id: group_id.map(str::to_string),
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: "2026-09-02T00:00:00Z".into(),
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

    fn group(id: &str, name: &str) -> HostGroup {
        HostGroup {
            id: id.into(),
            name: name.into(),
            color: "#6366f1".into(),
            icon: None,
            sort_order: 0,
            default_username: None,
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: "2026-09-01T00:00:00Z".into(),
        }
    }

    fn dataset_row(id: &str, scope_mode: &str) -> SyncDataset {
        SyncDataset {
            id: id.into(),
            name: "NOVA".into(),
            host: "10.0.0.9".into(),
            port: 2222,
            username: "sync".into(),
            auth_type: "password".into(),
            remote_path: format!("/srv/omnissh/{id}"),
            role: "owner".into(),
            content_flags: SyncContentFlags::default().to_json().unwrap(),
            scope_mode: scope_mode.into(),
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
        }
    }

    fn state(dataset_id: &str, kind: SyncEntityType, id: &str) -> SyncRecordState {
        SyncRecordState {
            dataset_id: dataset_id.into(),
            entity_type: kind,
            entity_id: id.into(),
            remote_revision: 1,
            base_hash: "hash".into(),
            managed: false,
            synced_at: String::new(),
        }
    }

    /// Two groups, three hosts: g-nova holds h-1 and h-2, g-bank holds h-3.
    fn seeded_db(directory: &tempfile::TempDir) -> HostDb {
        let db = HostDb::new(directory.path()).expect("db");
        db.create_group(&group("g-nova", "NOVA")).expect("group");
        db.create_group(&group("g-bank", "Bank")).expect("group");
        db.save_host(&host("h-1", "nova-web", Some("g-nova")))
            .expect("host");
        db.save_host(&host("h-2", "nova-db", Some("g-nova")))
            .expect("host");
        db.save_host(&host("h-3", "bank-core", Some("g-bank")))
            .expect("host");
        db
    }

    fn member_ids_of(db: &HostDb, dataset_id: &str) -> Vec<String> {
        let row = db.get_sync_dataset(dataset_id).unwrap().unwrap();
        member_ids(db, dataset_id, scope_mode_of(&row)).expect("members")
    }

    #[test]
    fn an_all_scope_resolves_every_host_and_group() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.upsert_sync_dataset(&dataset_row(DATASET, "{\"mode\":\"all\"}"))
            .expect("row");

        let scope = resolve(&db, DATASET).expect("scope");
        assert_eq!(scope.mode, SyncScopeMode::All);
        assert_eq!(
            scope.host_ids,
            BTreeSet::from(["h-1".to_string(), "h-2".into(), "h-3".into()])
        );
        assert_eq!(
            scope.group_ids,
            BTreeSet::from(["g-nova".to_string(), "g-bank".into()])
        );
    }

    /* A row written before scopes existed carries no `mode` key at all, and one
     * legacy test row carries the bare string `all`. Both mean "everything". */
    #[test]
    fn a_row_without_a_mode_key_or_a_bare_mode_string_defaults_to_all() {
        let directory = tempfile::tempdir().unwrap();
        let _db = seeded_db(&directory);
        let mut row = dataset_row(DATASET, "{}");
        assert_eq!(scope_mode_of(&row), SyncScopeMode::All);
        row.scope_mode = "all".into();
        assert_eq!(scope_mode_of(&row), SyncScopeMode::All);
        row.scope_mode = String::new();
        assert_eq!(scope_mode_of(&row), SyncScopeMode::All);
        row.scope_mode = "{\"mode\":\"groups\"}".into();
        assert_eq!(scope_mode_of(&row), SyncScopeMode::Groups);
    }

    #[test]
    fn a_groups_scope_resolves_only_that_groups_hosts() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.upsert_sync_dataset(&dataset_row(DATASET, "{\"mode\":\"groups\"}"))
            .expect("row");
        db.set_sync_dataset_members(DATASET, &[(SyncEntityType::Group, "g-nova".into())])
            .expect("members");

        let scope = resolve(&db, DATASET).expect("scope");
        assert_eq!(scope.group_ids, BTreeSet::from(["g-nova".to_string()]));
        assert_eq!(
            scope.host_ids,
            BTreeSet::from(["h-1".to_string(), "h-2".into()]),
            "a host outside the selected group must not travel"
        );
    }

    #[test]
    fn a_hosts_scope_carries_the_selected_hosts_and_the_groups_they_reference() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.upsert_sync_dataset(&dataset_row(DATASET, "{\"mode\":\"hosts\"}"))
            .expect("row");
        db.set_sync_dataset_members(DATASET, &[(SyncEntityType::Host, "h-3".into())])
            .expect("members");

        let scope = resolve(&db, DATASET).expect("scope");
        assert_eq!(scope.host_ids, BTreeSet::from(["h-3".to_string()]));
        assert_eq!(
            scope.group_ids,
            BTreeSet::from(["g-bank".to_string()]),
            "the referenced group travels so the host's group_id never dangles"
        );
    }

    /* A group deleted locally leaves its membership row behind; resolving has
     * to keep working rather than erroring the push and the dataset list. */
    #[test]
    fn a_membership_id_that_no_longer_resolves_contributes_nothing_instead_of_failing() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.upsert_sync_dataset(&dataset_row(DATASET, "{\"mode\":\"groups\"}"))
            .expect("row");
        db.set_sync_dataset_members(DATASET, &[(SyncEntityType::Group, "g-gone".into())])
            .expect("members");

        let scope = resolve(&db, DATASET).expect("scope");
        assert!(scope.host_ids.is_empty());
        assert!(scope.group_ids.is_empty());
    }

    #[test]
    fn saving_a_selection_rejects_ids_that_are_missing_or_of_the_wrong_kind() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);

        let rows = validate_selection(&db, SyncScopeMode::Groups, &["g-nova".into()])
            .expect("valid selection");
        assert_eq!(rows, vec![(SyncEntityType::Group, "g-nova".to_string())]);

        // A host id where a group is expected, and vice versa.
        let wrong_kind = validate_selection(&db, SyncScopeMode::Groups, &["h-1".into()])
            .expect_err("a host id is not a group");
        assert!(
            matches!(wrong_kind, SyncError::Format(_)),
            "got {wrong_kind:?}"
        );
        let wrong_kind = validate_selection(&db, SyncScopeMode::Hosts, &["g-nova".into()])
            .expect_err("a group id is not a host");
        assert!(
            matches!(wrong_kind, SyncError::Format(_)),
            "got {wrong_kind:?}"
        );

        let missing = validate_selection(&db, SyncScopeMode::Hosts, &["h-nope".into()])
            .expect_err("an unknown id must be refused");
        assert!(matches!(missing, SyncError::NotFound(_)), "got {missing:?}");

        let empty = validate_selection(&db, SyncScopeMode::Groups, &[])
            .expect_err("an empty selection is not a scope");
        assert!(matches!(empty, SyncError::Format(_)), "got {empty:?}");

        // `all` selects everything, so a leftover list is dropped, not stored.
        assert!(validate_selection(&db, SyncScopeMode::All, &["h-1".into()])
            .expect("all ignores a stale list")
            .is_empty());
    }

    #[test]
    fn a_scoped_push_collects_only_the_hosts_in_scope_and_their_children() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.create_pf_rule(
            "pf-nova",
            Some("h-1"),
            Some("web"),
            None,
            "local",
            "127.0.0.1",
            8080,
            "127.0.0.1",
            80,
            false,
        )
        .expect("rule");
        db.create_pf_rule(
            "pf-bank",
            Some("h-3"),
            Some("core"),
            None,
            "local",
            "127.0.0.1",
            8081,
            "127.0.0.1",
            81,
            false,
        )
        .expect("rule");
        db.set_plugin_config("h-1", "docker", true, "{}")
            .expect("plugin");
        db.set_plugin_config("h-3", "docker", true, "{}")
            .expect("plugin");

        db.upsert_sync_dataset(&dataset_row(DATASET, "{\"mode\":\"groups\"}"))
            .expect("row");
        db.set_sync_dataset_members(DATASET, &[(SyncEntityType::Group, "g-nova".into())])
            .expect("members");

        let scope = resolve(&db, DATASET).expect("scope");
        let vault = crate::vault::LocalVault::new();
        let collected =
            collect(&db, &vault, DATASET, 1, SyncContentFlags::default(), &scope).expect("collect");

        let hosts = collected.payload.sections.hosts.expect("host section");
        let labels: BTreeSet<&str> = hosts
            .iter()
            .map(|record| record.data.label.as_str())
            .collect();
        assert_eq!(labels, BTreeSet::from(["nova-web", "nova-db"]));
        let groups = collected.payload.sections.groups.expect("group section");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].data.id, "g-nova");

        let forwards = collected
            .payload
            .sections
            .port_forwards
            .expect("forward section");
        assert_eq!(
            forwards
                .iter()
                .map(|rule| rule.id.as_str())
                .collect::<Vec<_>>(),
            vec!["pf-nova"],
            "a rule of an out-of-scope host must not travel"
        );
        let plugins = collected
            .payload
            .sections
            .host_plugins
            .expect("plugin section");
        assert_eq!(
            plugins.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["h-1:docker"]
        );
        assert_eq!(collected.stats.hosts, 2);
    }

    /* Content kinds outside the host scope keep their content-flag behaviour:
     * a dataset scoped to one host still carries the app settings. */
    #[test]
    fn a_scoped_push_still_carries_the_unscoped_content_kinds() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.save_setting("terminal_theme", "dracula")
            .expect("setting");
        db.upsert_sync_dataset(&dataset_row(DATASET, "{\"mode\":\"hosts\"}"))
            .expect("row");
        db.set_sync_dataset_members(DATASET, &[(SyncEntityType::Host, "h-1".into())])
            .expect("members");

        let scope = resolve(&db, DATASET).expect("scope");
        let vault = crate::vault::LocalVault::new();
        let collected =
            collect(&db, &vault, DATASET, 1, SyncContentFlags::default(), &scope).expect("collect");

        assert_eq!(collected.stats.hosts, 1);
        assert!(collected.stats.app_settings);
        let settings = collected
            .payload
            .sections
            .app_settings
            .expect("settings section");
        assert_eq!(
            settings.entries.get("terminal_theme").map(String::as_str),
            Some("dracula")
        );
    }

    /* The acceptance case for the removal record: a host that still exists
     * locally but is no longer selected by this dataset. */
    #[test]
    fn dropping_a_host_from_the_scope_emits_a_removal_and_not_a_delete() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.upsert_sync_dataset(&dataset_row(DATASET, "{\"mode\":\"hosts\"}"))
            .expect("row");
        db.set_sync_dataset_members(
            DATASET,
            &[
                (SyncEntityType::Host, "h-1".into()),
                (SyncEntityType::Host, "h-2".into()),
            ],
        )
        .expect("members");

        // The first push agreed on both hosts.
        let vault = crate::vault::LocalVault::new();
        let before = collect(
            &db,
            &vault,
            DATASET,
            1,
            SyncContentFlags::default(),
            &resolve(&db, DATASET).expect("scope"),
        )
        .expect("collect");
        assert!(before.scope_removals.is_empty());
        db.upsert_sync_record_state(&[
            state(DATASET, SyncEntityType::Host, "h-1"),
            state(DATASET, SyncEntityType::Host, "h-2"),
        ])
        .expect("base state");

        // h-2 is taken out of the scope; it is still a host on this machine.
        db.set_sync_dataset_members(DATASET, &[(SyncEntityType::Host, "h-1".into())])
            .expect("members");
        let after = collect(
            &db,
            &vault,
            DATASET,
            2,
            SyncContentFlags::default(),
            &resolve(&db, DATASET).expect("scope"),
        )
        .expect("collect");

        assert_eq!(
            after
                .payload
                .scope_removals
                .iter()
                .map(|removal| (removal.entity_type.as_str(), removal.entity_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("host", "h-2")]
        );
        assert_eq!(after.scope_removals, vec!["h-2".to_string()]);
        assert!(
            after.payload.tombstones.is_empty(),
            "leaving a scope is not a deletion"
        );
        assert!(db.get_host("h-2").expect("lookup").is_some());
    }

    /* Host tombstones are filtered to the hosts this dataset has agreed on, so
     * deleting a host locally cannot delete it out of someone else's dataset. */
    #[test]
    fn only_hosts_that_belonged_to_the_dataset_publish_a_tombstone() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.upsert_sync_dataset(&dataset_row(DATASET, "{\"mode\":\"hosts\"}"))
            .expect("row");
        db.set_sync_dataset_members(DATASET, &[(SyncEntityType::Host, "h-1".into())])
            .expect("members");
        db.upsert_sync_record_state(&[state(DATASET, SyncEntityType::Host, "h-1")])
            .expect("base state");

        // h-2 was never part of this dataset; h-1 was.
        db.delete_host("h-2").expect("delete h-2");
        db.delete_host("h-1").expect("delete h-1");

        let vault = crate::vault::LocalVault::new();
        let collected = collect(
            &db,
            &vault,
            DATASET,
            1,
            SyncContentFlags::default(),
            &resolve(&db, DATASET).expect("scope"),
        )
        .expect("collect");

        assert_eq!(
            collected
                .payload
                .tombstones
                .iter()
                .map(|tombstone| (tombstone.entity_type.as_str(), tombstone.entity_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("host", "h-1")]
        );
    }

    /* Applying a removal forgets the dataset's claim about the host and its
     * children and nothing else. A tombstone, by contrast, is a real delete. */
    #[test]
    fn a_scope_removal_clears_record_state_while_a_tombstone_deletes_the_host() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.create_pf_rule(
            "pf-1",
            Some("h-1"),
            Some("web"),
            None,
            "local",
            "127.0.0.1",
            8080,
            "127.0.0.1",
            80,
            false,
        )
        .expect("rule");
        db.set_plugin_config("h-1", "docker", true, "{}")
            .expect("plugin");
        db.upsert_sync_dataset(&dataset_row(DATASET, "{\"mode\":\"hosts\"}"))
            .expect("row");
        db.upsert_sync_dataset(&dataset_row("ds-other", "{\"mode\":\"hosts\"}"))
            .expect("other row");
        db.upsert_sync_record_state(&[
            state(DATASET, SyncEntityType::Host, "h-1"),
            state(DATASET, SyncEntityType::PortForward, "pf-1"),
            state(DATASET, SyncEntityType::HostPlugin, "h-1:docker"),
            state("ds-other", SyncEntityType::Host, "h-1"),
        ])
        .expect("base state");

        let removal = ScopeRemoval {
            entity_type: "host".into(),
            entity_id: "h-1".into(),
            removed_at: "2026-09-18T10:00:00Z".into(),
        };
        let cleared =
            apply_scope_removals(&db, DATASET, std::slice::from_ref(&removal)).expect("apply");
        assert_eq!(cleared, 3, "the host and both of its child records");

        assert!(
            db.list_sync_record_state(DATASET)
                .expect("state")
                .is_empty(),
            "this dataset keeps no claim about the host it dropped"
        );
        assert_eq!(
            db.list_sync_record_state("ds-other").expect("other").len(),
            1,
            "the other dataset's state is untouched (Task 7)"
        );
        // The host, its rule, and its plugin config are all still here.
        assert!(db.get_host("h-1").expect("host").is_some());
        assert_eq!(db.list_pf_rules(Some("h-1")).expect("rules").len(), 1);
        assert_eq!(db.list_plugin_configs("h-1").expect("plugins").len(), 1);

        // A tombstone for the same host is the real delete.
        db.delete_host("h-1").expect("delete");
        assert!(db.get_host("h-1").expect("host").is_none());
    }

    /* One host, two datasets: the id stays single and each dataset keeps its
     * own record state, so dropping it from one must not disturb the other. */
    #[test]
    fn one_host_in_two_datasets_keeps_independent_record_state() {
        let directory = tempfile::tempdir().unwrap();
        let db = seeded_db(&directory);
        db.upsert_sync_dataset(&dataset_row("ds-a", "{\"mode\":\"hosts\"}"))
            .expect("row a");
        db.upsert_sync_dataset(&dataset_row("ds-b", "{\"mode\":\"hosts\"}"))
            .expect("row b");
        db.set_sync_dataset_members("ds-a", &[(SyncEntityType::Host, "h-1".into())])
            .expect("members a");
        db.set_sync_dataset_members(
            "ds-b",
            &[
                (SyncEntityType::Host, "h-1".into()),
                (SyncEntityType::Host, "h-2".into()),
            ],
        )
        .expect("members b");
        db.upsert_sync_record_state(&[
            state("ds-a", SyncEntityType::Host, "h-1"),
            state("ds-b", SyncEntityType::Host, "h-1"),
            state("ds-b", SyncEntityType::Host, "h-2"),
        ])
        .expect("base state");

        let vault = crate::vault::LocalVault::new();
        let collected_a = collect(
            &db,
            &vault,
            "ds-a",
            1,
            SyncContentFlags::default(),
            &resolve(&db, "ds-a").expect("scope a"),
        )
        .expect("collect a");
        let collected_b = collect(
            &db,
            &vault,
            "ds-b",
            1,
            SyncContentFlags::default(),
            &resolve(&db, "ds-b").expect("scope b"),
        )
        .expect("collect b");

        assert_eq!(collected_a.stats.hosts, 1);
        assert_eq!(collected_b.stats.hosts, 2);
        assert_eq!(collected_a.payload.sections.hosts.unwrap()[0].id, "h-1");
        assert_eq!(db.get_host("h-1").expect("host").unwrap().id, "h-1");

        // Removing h-1 from ds-a leaves ds-b's claim about the same host alone.
        let removal = ScopeRemoval {
            entity_type: "host".into(),
            entity_id: "h-1".into(),
            removed_at: "2026-09-18T10:00:00Z".into(),
        };
        apply_scope_removals(&db, "ds-a", std::slice::from_ref(&removal)).expect("apply");
        assert!(db.list_sync_record_state("ds-a").expect("a").is_empty());
        assert_eq!(db.list_sync_record_state("ds-b").expect("b").len(), 2);
        assert!(db.get_host("h-1").expect("host").is_some());
        assert_eq!(member_ids_of(&db, "ds-a").len(), 1);
    }

    /* `scopeRemovals` is additive: a document written by this build still
     * parses in a reader that has never heard of the field, and a document from
     * before it carries no removals. */
    #[test]
    fn the_payload_stays_readable_without_scope_removals() {
        let legacy: SyncPayload = serde_json::from_str(
            r#"{"formatVersion":1,"datasetId":"ds-nova","generation":3,"sections":{},"tombstones":[]}"#,
        )
        .expect("legacy payload");
        assert!(legacy.scope_removals.is_empty());

        let mut written = SyncPayload::new("ds-nova", 4);
        written.scope_removals.push(ScopeRemoval {
            entity_type: "host".into(),
            entity_id: "h-1".into(),
            removed_at: "2026-09-18T10:00:00Z".into(),
        });
        let json = serde_json::to_string(&written).expect("serialize");
        assert!(json.contains("\"scopeRemovals\":[{\"entityType\":\"host\""));
    }
}
