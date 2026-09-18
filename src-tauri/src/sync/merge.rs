/*
 * Record-level merge (AD-5).
 *
 * Three inputs per content kind: what is local now, what the remote published,
 * and the *base* — the state the last sync agreed on. The base is what makes
 * "edited locally" distinguishable from "edited remotely"; without it a pull can
 * only overwrite.
 *
 * Resolution rules, in order:
 *
 *   local == remote                          → nothing to do
 *   local == base, remote differs            → apply remote (only the remote moved)
 *   remote == base, local differs            → keep local (it will be pushed)
 *   both differ from base                    → conflict: newest `updated_at` wins,
 *                                              ties broken by revision then id
 *   remote tombstone, local untouched        → delete locally
 *   remote tombstone, local edited after base → conflict: deletion vs edit by time
 *   remote record, local tombstone            → conflict: deletion vs edit by time
 *   remote silent about a known record        → keep local (out of scope, not deleted)
 *
 * Every conflict is recorded with both timestamps, so the losing copy is never
 * discarded silently. The module is pure: no database, no network, no clock —
 * all timestamps come from the records themselves, which is what makes the
 * whole table of cases testable.
 */

use std::collections::{BTreeMap, BTreeSet};

use crate::db::SyncEntityType;

/// A record as it exists locally right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalItem {
    pub id: String,
    /// Digest of the record's data, comparable with the base hash.
    pub hash: String,
    pub updated_at: String,
}

/// A record as published by the remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteItem {
    pub id: String,
    pub hash: String,
    pub updated_at: String,
    pub revision: u64,
}

/// The state the previous sync agreed on: `(revision, hash)` per id.
pub type Base = BTreeMap<String, (i64, String)>;

/// What the pull must do with one record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Write the remote record locally and record the new base.
    Apply { id: String, revision: u64 },
    /// Leave the local row alone; the next push carries it.
    KeepLocal { id: String },
    /// Delete the local row (a remote tombstone won).
    Delete { id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeConflict {
    pub entity_type: SyncEntityType,
    pub entity_id: String,
    pub resolution: String,
    pub winner_updated_at: Option<String>,
    pub loser_updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergePlan {
    pub decisions: Vec<Decision>,
    pub conflicts: Vec<MergeConflict>,
}

impl MergePlan {
    pub fn applies(&self) -> impl Iterator<Item = (&str, u64)> {
        self.decisions.iter().filter_map(|decision| match decision {
            Decision::Apply { id, revision } => Some((id.as_str(), *revision)),
            _ => None,
        })
    }

    pub fn deletes(&self) -> impl Iterator<Item = &str> {
        self.decisions.iter().filter_map(|decision| match decision {
            Decision::Delete { id } => Some(id.as_str()),
            _ => None,
        })
    }

    pub fn kept_local(&self) -> usize {
        self.decisions
            .iter()
            .filter(|decision| matches!(decision, Decision::KeepLocal { .. }))
            .count()
    }
}

/* Wall-clock comparison of two ISO-8601 timestamps. Compared as strings on
 * purpose: both sides are written by `chrono::Utc::now().to_rfc3339()` or
 * SQLite's `datetime('now')`, and lexical order matches chronological order for
 * UTC ISO-8601. A malformed or empty timestamp sorts oldest, which makes an
 * unstamped row lose to a stamped one rather than winning by accident. */
fn newer(a: &str, b: &str) -> bool {
    normalize_ts(a) > normalize_ts(b)
}

fn normalize_ts(value: &str) -> String {
    // SQLite writes "2026-09-18 10:00:00"; RFC3339 writes "2026-09-18T10:00:00Z".
    value
        .trim()
        .replace(' ', "T")
        .trim_end_matches('Z')
        .to_string()
}

/// Merge one content kind.
///
/// `remote_tombstones` and `local_tombstones` are the ids deleted on each side
/// *for this kind*, with the deletion timestamp.
pub fn merge_kind(
    entity_type: SyncEntityType,
    locals: &[LocalItem],
    remotes: &[RemoteItem],
    base: &Base,
    remote_tombstones: &BTreeMap<String, String>,
    local_tombstones: &BTreeMap<String, String>,
) -> MergePlan {
    let local_by_id: BTreeMap<&str, &LocalItem> =
        locals.iter().map(|item| (item.id.as_str(), item)).collect();
    let remote_by_id: BTreeMap<&str, &RemoteItem> = remotes
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();

    let mut plan = MergePlan::default();
    let mut seen: BTreeSet<&str> = BTreeSet::new();

    for remote in remotes {
        seen.insert(remote.id.as_str());
        let local = local_by_id.get(remote.id.as_str()).copied();
        let base_entry = base.get(&remote.id);

        match local {
            Some(local) => {
                if local.hash == remote.hash {
                    continue;
                }
                let local_matches_base = base_entry.map(|(_, hash)| *hash == local.hash);
                let remote_matches_base = base_entry.map(|(_, hash)| *hash == remote.hash);
                match (local_matches_base, remote_matches_base) {
                    (Some(true), _) => plan.decisions.push(Decision::Apply {
                        id: remote.id.clone(),
                        revision: remote.revision,
                    }),
                    (_, Some(true)) => plan.decisions.push(Decision::KeepLocal {
                        id: remote.id.clone(),
                    }),
                    _ => {
                        /* Both sides moved (or there is no base at all, which
                         * means both created the same id independently): the
                         * newest copy wins and the loser is logged. */
                        let remote_wins = newer(&remote.updated_at, &local.updated_at)
                            || (normalize_ts(&remote.updated_at)
                                == normalize_ts(&local.updated_at)
                                && remote.revision as i64
                                    > base_entry.map(|(revision, _)| *revision).unwrap_or(0));
                        if remote_wins {
                            plan.conflicts.push(MergeConflict {
                                entity_type,
                                entity_id: remote.id.clone(),
                                resolution: "kept the newer remote copy".into(),
                                winner_updated_at: Some(remote.updated_at.clone()),
                                loser_updated_at: Some(local.updated_at.clone()),
                            });
                            plan.decisions.push(Decision::Apply {
                                id: remote.id.clone(),
                                revision: remote.revision,
                            });
                        } else {
                            plan.conflicts.push(MergeConflict {
                                entity_type,
                                entity_id: remote.id.clone(),
                                resolution: "kept the newer local copy".into(),
                                winner_updated_at: Some(local.updated_at.clone()),
                                loser_updated_at: Some(remote.updated_at.clone()),
                            });
                            plan.decisions.push(Decision::KeepLocal {
                                id: remote.id.clone(),
                            });
                        }
                    }
                }
            }
            None => match local_tombstones.get(&remote.id) {
                /* Deleted here, still present there. Whichever happened later
                 * wins: an old remote copy must not resurrect a fresh delete,
                 * and a stale delete must not erase a fresh remote edit. */
                Some(deleted_at) if newer(deleted_at, &remote.updated_at) => {
                    plan.conflicts.push(MergeConflict {
                        entity_type,
                        entity_id: remote.id.clone(),
                        resolution: "kept the local deletion (newer than the remote copy)".into(),
                        winner_updated_at: Some(deleted_at.clone()),
                        loser_updated_at: Some(remote.updated_at.clone()),
                    });
                    plan.decisions.push(Decision::KeepLocal {
                        id: remote.id.clone(),
                    });
                }
                Some(deleted_at) => {
                    plan.conflicts.push(MergeConflict {
                        entity_type,
                        entity_id: remote.id.clone(),
                        resolution: "restored the record (edited remotely after the local delete)"
                            .into(),
                        winner_updated_at: Some(remote.updated_at.clone()),
                        loser_updated_at: Some(deleted_at.clone()),
                    });
                    plan.decisions.push(Decision::Apply {
                        id: remote.id.clone(),
                        revision: remote.revision,
                    });
                }
                None => plan.decisions.push(Decision::Apply {
                    id: remote.id.clone(),
                    revision: remote.revision,
                }),
            },
        }
    }

    for (id, deleted_at) in remote_tombstones {
        if seen.contains(id.as_str()) {
            // The remote published both a record and a tombstone for this id;
            // the live record is the newer statement, so the tombstone is stale.
            continue;
        }
        let Some(local) = local_by_id.get(id.as_str()).copied() else {
            continue;
        };
        let local_edited_since_base = base
            .get(id)
            .map(|(_, hash)| *hash != local.hash)
            .unwrap_or(true);

        if local_edited_since_base && newer(&local.updated_at, deleted_at) {
            plan.conflicts.push(MergeConflict {
                entity_type,
                entity_id: id.clone(),
                resolution: "kept the local copy (edited after the remote delete)".into(),
                winner_updated_at: Some(local.updated_at.clone()),
                loser_updated_at: Some(deleted_at.clone()),
            });
            plan.decisions.push(Decision::KeepLocal { id: id.clone() });
            continue;
        }
        if local_edited_since_base {
            plan.conflicts.push(MergeConflict {
                entity_type,
                entity_id: id.clone(),
                resolution: "applied the remote delete (newer than the local edit)".into(),
                winner_updated_at: Some(deleted_at.clone()),
                loser_updated_at: Some(local.updated_at.clone()),
            });
        }
        plan.decisions.push(Decision::Delete { id: id.clone() });
    }

    /* A record the remote did not mention at all is left alone: silence means
     * "not in this dataset's scope", never "deleted". Only a tombstone deletes. */
    for local in locals {
        if !remote_by_id.contains_key(local.id.as_str())
            && !remote_tombstones.contains_key(&local.id)
        {
            plan.decisions.push(Decision::KeepLocal {
                id: local.id.clone(),
            });
        }
    }

    plan
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(id: &str, hash: &str, updated_at: &str) -> LocalItem {
        LocalItem {
            id: id.into(),
            hash: hash.into(),
            updated_at: updated_at.into(),
        }
    }

    fn remote(id: &str, hash: &str, updated_at: &str, revision: u64) -> RemoteItem {
        RemoteItem {
            id: id.into(),
            hash: hash.into(),
            updated_at: updated_at.into(),
            revision,
        }
    }

    fn base(entries: &[(&str, i64, &str)]) -> Base {
        entries
            .iter()
            .map(|(id, revision, hash)| (id.to_string(), (*revision, hash.to_string())))
            .collect()
    }

    fn tombstones(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(id, at)| (id.to_string(), at.to_string()))
            .collect()
    }

    fn plan_for(
        locals: &[LocalItem],
        remotes: &[RemoteItem],
        base: &Base,
        remote_tombstones: &BTreeMap<String, String>,
        local_tombstones: &BTreeMap<String, String>,
    ) -> MergePlan {
        merge_kind(
            SyncEntityType::Host,
            locals,
            remotes,
            base,
            remote_tombstones,
            local_tombstones,
        )
    }

    #[test]
    fn identical_records_produce_no_work() {
        let plan = plan_for(
            &[local("h1", "hash-a", "2026-09-01T00:00:00Z")],
            &[remote("h1", "hash-a", "2026-09-01T00:00:00Z", 3)],
            &base(&[("h1", 3, "hash-a")]),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert!(plan.decisions.is_empty());
        assert!(plan.conflicts.is_empty());
    }

    #[test]
    fn a_remote_only_change_is_applied() {
        let plan = plan_for(
            &[local("h1", "hash-a", "2026-09-01T00:00:00Z")],
            &[remote("h1", "hash-b", "2026-09-02T00:00:00Z", 4)],
            &base(&[("h1", 3, "hash-a")]),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            plan.decisions,
            vec![Decision::Apply {
                id: "h1".into(),
                revision: 4
            }]
        );
        assert!(plan.conflicts.is_empty(), "one-sided change is no conflict");
    }

    #[test]
    fn a_local_only_change_is_kept_without_a_conflict() {
        let plan = plan_for(
            &[local("h1", "hash-local", "2026-09-03T00:00:00Z")],
            &[remote("h1", "hash-a", "2026-09-01T00:00:00Z", 3)],
            &base(&[("h1", 3, "hash-a")]),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            plan.decisions,
            vec![Decision::KeepLocal { id: "h1".into() }]
        );
        assert!(plan.conflicts.is_empty());
    }

    #[test]
    fn both_changed_resolves_to_the_newer_copy_and_is_logged() {
        let remote_newer = plan_for(
            &[local("h1", "hash-local", "2026-09-02T00:00:00Z")],
            &[remote("h1", "hash-remote", "2026-09-05T00:00:00Z", 5)],
            &base(&[("h1", 3, "hash-base")]),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            remote_newer.decisions,
            vec![Decision::Apply {
                id: "h1".into(),
                revision: 5
            }]
        );
        assert_eq!(remote_newer.conflicts.len(), 1);
        assert_eq!(
            remote_newer.conflicts[0].resolution,
            "kept the newer remote copy"
        );
        assert_eq!(
            remote_newer.conflicts[0].winner_updated_at.as_deref(),
            Some("2026-09-05T00:00:00Z")
        );
        assert_eq!(
            remote_newer.conflicts[0].loser_updated_at.as_deref(),
            Some("2026-09-02T00:00:00Z")
        );

        let local_newer = plan_for(
            &[local("h1", "hash-local", "2026-09-06T00:00:00Z")],
            &[remote("h1", "hash-remote", "2026-09-05T00:00:00Z", 5)],
            &base(&[("h1", 3, "hash-base")]),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            local_newer.decisions,
            vec![Decision::KeepLocal { id: "h1".into() }]
        );
        assert_eq!(
            local_newer.conflicts[0].resolution,
            "kept the newer local copy"
        );
    }

    #[test]
    fn equal_timestamps_break_the_tie_by_revision() {
        /* Two machines editing within the same clock tick must still resolve
         * deterministically, or the two sides would flip-flop on every sync. */
        let plan = plan_for(
            &[local("h1", "hash-local", "2026-09-05T00:00:00Z")],
            &[remote("h1", "hash-remote", "2026-09-05T00:00:00Z", 9)],
            &base(&[("h1", 3, "hash-base")]),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            plan.decisions,
            vec![Decision::Apply {
                id: "h1".into(),
                revision: 9
            }],
            "a higher remote revision wins a timestamp tie"
        );

        let stale_revision = plan_for(
            &[local("h1", "hash-local", "2026-09-05T00:00:00Z")],
            &[remote("h1", "hash-remote", "2026-09-05T00:00:00Z", 3)],
            &base(&[("h1", 3, "hash-base")]),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            stale_revision.decisions,
            vec![Decision::KeepLocal { id: "h1".into() }]
        );
    }

    #[test]
    fn sqlite_and_rfc3339_timestamps_compare_correctly() {
        // SQLite's `datetime('now')` format must not lose to RFC3339 formatting
        // of an older instant just because of the separator or the Z suffix.
        assert!(newer("2026-09-05T00:00:01Z", "2026-09-05 00:00:00"));
        assert!(!newer("2026-09-05 00:00:00", "2026-09-05T00:00:01Z"));
        assert!(!newer("", "2026-09-05T00:00:00Z"));
        assert!(newer("2026-09-05T00:00:00Z", ""));
    }

    #[test]
    fn a_new_remote_record_is_created_locally() {
        let plan = plan_for(
            &[],
            &[remote("h9", "hash-new", "2026-09-05T00:00:00Z", 1)],
            &Base::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert_eq!(
            plan.decisions,
            vec![Decision::Apply {
                id: "h9".into(),
                revision: 1
            }]
        );
        assert!(plan.conflicts.is_empty());
    }

    #[test]
    fn a_remote_tombstone_deletes_an_untouched_local_record() {
        let plan = plan_for(
            &[local("h1", "hash-a", "2026-09-01T00:00:00Z")],
            &[],
            &base(&[("h1", 3, "hash-a")]),
            &tombstones(&[("h1", "2026-09-04T00:00:00Z")]),
            &BTreeMap::new(),
        );
        assert_eq!(plan.decisions, vec![Decision::Delete { id: "h1".into() }]);
        assert!(plan.conflicts.is_empty());
    }

    #[test]
    fn a_remote_tombstone_loses_to_a_newer_local_edit() {
        let plan = plan_for(
            &[local("h1", "hash-edited", "2026-09-09T00:00:00Z")],
            &[],
            &base(&[("h1", 3, "hash-a")]),
            &tombstones(&[("h1", "2026-09-04T00:00:00Z")]),
            &BTreeMap::new(),
        );
        assert_eq!(
            plan.decisions,
            vec![Decision::KeepLocal { id: "h1".into() }]
        );
        assert_eq!(
            plan.conflicts[0].resolution,
            "kept the local copy (edited after the remote delete)"
        );

        // The reverse order deletes, but still logs what was lost.
        let delete_wins = plan_for(
            &[local("h1", "hash-edited", "2026-09-02T00:00:00Z")],
            &[],
            &base(&[("h1", 3, "hash-a")]),
            &tombstones(&[("h1", "2026-09-04T00:00:00Z")]),
            &BTreeMap::new(),
        );
        assert_eq!(
            delete_wins.decisions,
            vec![Decision::Delete { id: "h1".into() }]
        );
        assert_eq!(
            delete_wins.conflicts[0].resolution,
            "applied the remote delete (newer than the local edit)"
        );
    }

    #[test]
    fn a_local_delete_and_a_remote_edit_resolve_by_time() {
        let delete_wins = plan_for(
            &[],
            &[remote("h1", "hash-remote", "2026-09-02T00:00:00Z", 4)],
            &base(&[("h1", 3, "hash-a")]),
            &BTreeMap::new(),
            &tombstones(&[("h1", "2026-09-06T00:00:00Z")]),
        );
        assert_eq!(
            delete_wins.decisions,
            vec![Decision::KeepLocal { id: "h1".into() }],
            "a fresh local delete is not resurrected by an older remote copy"
        );
        assert!(delete_wins.conflicts[0]
            .resolution
            .contains("kept the local deletion"));

        let edit_wins = plan_for(
            &[],
            &[remote("h1", "hash-remote", "2026-09-09T00:00:00Z", 4)],
            &base(&[("h1", 3, "hash-a")]),
            &BTreeMap::new(),
            &tombstones(&[("h1", "2026-09-06T00:00:00Z")]),
        );
        assert_eq!(
            edit_wins.decisions,
            vec![Decision::Apply {
                id: "h1".into(),
                revision: 4
            }]
        );
        assert!(edit_wins.conflicts[0].resolution.contains("restored"));
    }

    #[test]
    fn a_record_the_remote_never_mentions_is_kept_not_deleted() {
        /* Silence is scope, not a delete: a dataset carrying only the NOVA
         * group must not wipe every other host on the machine. */
        let plan = plan_for(
            &[local("local-only", "hash-x", "2026-09-01T00:00:00Z")],
            &[remote("h1", "hash-a", "2026-09-01T00:00:00Z", 1)],
            &Base::new(),
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        assert!(plan.decisions.contains(&Decision::KeepLocal {
            id: "local-only".into()
        }));
        assert!(!plan
            .decisions
            .iter()
            .any(|decision| matches!(decision, Decision::Delete { .. })));
        assert_eq!(plan.kept_local(), 1);
    }

    #[test]
    fn a_live_remote_record_overrides_a_stale_remote_tombstone() {
        let plan = plan_for(
            &[local("h1", "hash-a", "2026-09-01T00:00:00Z")],
            &[remote("h1", "hash-b", "2026-09-07T00:00:00Z", 5)],
            &base(&[("h1", 3, "hash-a")]),
            &tombstones(&[("h1", "2026-09-02T00:00:00Z")]),
            &BTreeMap::new(),
        );
        assert_eq!(
            plan.decisions,
            vec![Decision::Apply {
                id: "h1".into(),
                revision: 5
            }]
        );
        assert!(plan.deletes().collect::<Vec<_>>().is_empty());
    }

    #[test]
    fn plan_accessors_summarize_the_outcome() {
        let plan = plan_for(
            &[
                local("keep", "hash-k", "2026-09-09T00:00:00Z"),
                local("gone", "hash-g", "2026-09-01T00:00:00Z"),
            ],
            &[remote("new", "hash-n", "2026-09-05T00:00:00Z", 1)],
            &base(&[("gone", 2, "hash-g")]),
            &tombstones(&[("gone", "2026-09-06T00:00:00Z")]),
            &BTreeMap::new(),
        );

        assert_eq!(plan.applies().collect::<Vec<_>>(), vec![("new", 1)]);
        assert_eq!(plan.deletes().collect::<Vec<_>>(), vec!["gone"]);
        assert_eq!(plan.kept_local(), 1);
    }
}
