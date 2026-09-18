/*
 * Background auto-sync.
 *
 * Off by default and per dataset: a dataset runs on its own only when the user
 * sets `auto_sync`, and each cadence is separately configurable —
 * `pull_interval_secs` (0 = never) and `push_debounce_secs` (0 = never). With
 * both at zero the dataset is manual-only even with the master switch on.
 *
 * Local changes are detected by *fingerprinting the database* rather than by
 * having every store call a "something changed" command. The fingerprint is the
 * max `updated_at` across the syncable tables plus their row and tombstone
 * counts, so any mutation path counts — the dashboard, an importer, a restored
 * backup, a pull — and no future feature can forget to notify the scheduler.
 * The push debounce is "the fingerprint has been stable for N seconds and
 * differs from what we last published".
 *
 * Volatile columns are excluded from the fingerprint for the same reason they
 * are excluded from a record's content hash (`codec::content_digest`): opening
 * a terminal bumps `last_connected_at`, and that must not trigger a sync.
 *
 * One run per dataset at a time, and a failure never retries in a tight loop:
 * the phase becomes `Error`, and the next natural trigger tries again.
 */

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{HostDb, SyncDataset};
use crate::ssh::manager::SshManager;
use crate::vault::LocalVault;

use super::dataset::SyncContentFlags;
use super::{pull, push, SyncError};

/// How often the scheduler wakes up. The cadences are user-facing seconds, so
/// a one-second tick keeps the debounce honest without polling the network.
const TICK: Duration = Duration::from_secs(1);
const EVENT_NAME: &str = "sync:status";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncPhase {
    Idle,
    Pulling,
    Pushing,
    Error,
}

/// One dataset's live state, mirrored to the frontend on every change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusSnapshot {
    pub dataset_id: String,
    pub name: String,
    pub phase: SyncPhase,
    pub auto_sync: bool,
    pub pull_interval_secs: i64,
    pub push_debounce_secs: i64,
    pub generation: u64,
    pub last_synced_at: Option<String>,
    /// Local edits are waiting for the debounce window to elapse.
    pub pending_local_changes: bool,
    pub message: Option<String>,
    /// `SyncError::kind` of the last failure, for actionable frontend wording.
    pub kind: Option<String>,
}

/// Per-dataset bookkeeping the scheduler keeps in memory.
#[derive(Debug, Clone)]
struct Tracked {
    phase: SyncPhase,
    message: Option<String>,
    kind: Option<String>,
    /// Fingerprint at the last successful publish.
    published_fingerprint: Option<String>,
    /// Current fingerprint and when it was first seen.
    current_fingerprint: Option<String>,
    fingerprint_since: Option<Instant>,
    last_pull: Option<Instant>,
    running: bool,
}

impl Default for Tracked {
    fn default() -> Self {
        Self {
            phase: SyncPhase::Idle,
            message: None,
            kind: None,
            published_fingerprint: None,
            current_fingerprint: None,
            fingerprint_since: None,
            last_pull: None,
            running: false,
        }
    }
}

pub struct SyncScheduler {
    state: Mutex<HashMap<String, Tracked>>,
}

impl SyncScheduler {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(HashMap::new()),
        }
    }

    /// Snapshot every dataset for `sync_status`.
    pub fn snapshot(&self, db: &HostDb) -> Result<Vec<SyncStatusSnapshot>, SyncError> {
        let datasets = db.list_sync_datasets()?;
        let state = self
            .state
            .lock()
            .map_err(|e| SyncError::Database(format!("sync scheduler state lock poisoned: {e}")))?;
        Ok(datasets
            .iter()
            .map(|dataset| {
                let tracked = state.get(&dataset.id).cloned().unwrap_or_default();
                snapshot_of(dataset, &tracked)
            })
            .collect())
    }

    fn with_tracked<T>(
        &self,
        dataset_id: &str,
        apply: impl FnOnce(&mut Tracked) -> T,
    ) -> Result<T, SyncError> {
        let mut state = self
            .state
            .lock()
            .map_err(|e| SyncError::Database(format!("sync scheduler state lock poisoned: {e}")))?;
        Ok(apply(state.entry(dataset_id.to_string()).or_default()))
    }

    /// Note that a manual run finished, so the debounce does not immediately
    /// re-publish what the user just published by hand.
    pub fn note_manual_push(&self, dataset_id: &str, fingerprint: Option<String>) {
        let _ = self.with_tracked(dataset_id, |tracked| {
            tracked.published_fingerprint = fingerprint;
            tracked.phase = SyncPhase::Idle;
            tracked.message = None;
            tracked.kind = None;
        });
    }

    pub fn note_manual_pull(&self, dataset_id: &str) {
        let _ = self.with_tracked(dataset_id, |tracked| {
            tracked.last_pull = Some(Instant::now());
            tracked.phase = SyncPhase::Idle;
            tracked.message = None;
            tracked.kind = None;
        });
    }
}

impl Default for SyncScheduler {
    fn default() -> Self {
        Self::new()
    }
}

fn snapshot_of(dataset: &SyncDataset, tracked: &Tracked) -> SyncStatusSnapshot {
    /* "Pending" means the fingerprint differs from what was published *and*
     * automatic pushing is configured — otherwise the UI would nag about
     * changes it is never going to publish on its own. */
    let pending = dataset.auto_sync
        && dataset.push_debounce_secs > 0
        && tracked.current_fingerprint.is_some()
        && tracked.current_fingerprint != tracked.published_fingerprint;

    SyncStatusSnapshot {
        dataset_id: dataset.id.clone(),
        name: dataset.name.clone(),
        phase: tracked.phase,
        auto_sync: dataset.auto_sync,
        pull_interval_secs: dataset.pull_interval_secs,
        push_debounce_secs: dataset.push_debounce_secs,
        generation: dataset.last_generation.max(0) as u64,
        last_synced_at: dataset.last_synced_at.clone(),
        pending_local_changes: pending,
        message: tracked.message.clone(),
        kind: tracked.kind.clone(),
    }
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────

/* One cheap query per syncable table: the newest edit plus the row count. The
 * count matters because a delete lowers no `MAX(updated_at)`; the tombstone
 * count catches deletes whose row is already gone. */
pub fn local_fingerprint(db: &HostDb, flags: SyncContentFlags) -> Result<String, SyncError> {
    let flags = flags.normalized();
    let mut parts: Vec<String> = Vec::new();
    let mut push_part = |name: &str, value: String| parts.push(format!("{name}={value}"));

    if flags.hosts {
        let hosts = db.list_hosts()?;
        push_part(
            "hosts",
            format!(
                "{}:{}",
                hosts.len(),
                newest(hosts.iter().map(|h| &h.updated_at))
            ),
        );
    }
    if flags.groups {
        let groups = db.list_groups()?;
        push_part(
            "groups",
            format!(
                "{}:{}",
                groups.len(),
                newest(groups.iter().map(|g| &g.updated_at))
            ),
        );
    }
    if flags.snippets {
        let snippets = db.list_snippets(None)?;
        push_part(
            "snippets",
            format!(
                "{}:{}",
                snippets.len(),
                newest(snippets.iter().map(|s| &s.updated_at))
            ),
        );
    }
    if flags.snippet_folders {
        let folders = db.list_snippet_folders()?;
        push_part(
            "folders",
            format!(
                "{}:{}",
                folders.len(),
                newest(folders.iter().map(|f| &f.updated_at))
            ),
        );
    }
    if flags.port_forwards {
        let rules = db.list_pf_rules(None)?;
        push_part(
            "forwards",
            format!(
                "{}:{}",
                rules.len(),
                newest(rules.iter().map(|r| &r.updated_at))
            ),
        );
    }
    if flags.s3_connections {
        let connections = db.list_s3_connections()?;
        push_part(
            "s3",
            format!(
                "{}:{}",
                connections.len(),
                newest(connections.iter().map(|c| &c.updated_at))
            ),
        );
    }
    if flags.app_settings {
        /* Settings have no timestamps, so the fingerprint is over the values
         * themselves — with the machine-local deny-list applied, or switching
         * theme on one machine would publish a dataset. */
        let mut settings: Vec<String> = db
            .load_all_settings()?
            .into_iter()
            .filter(|(key, _)| !super::codec::APP_SETTINGS_DENY_LIST.contains(&key.as_str()))
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        settings.sort();
        push_part(
            "settings",
            super::codec::payload_digest(settings.join("\u{1}").as_bytes()),
        );
    }
    let tombstones = db.list_sync_tombstones(None)?;
    push_part(
        "tombstones",
        format!(
            "{}:{}",
            tombstones.len(),
            newest(tombstones.iter().map(|t| &t.deleted_at))
        ),
    );

    Ok(super::codec::payload_digest(parts.join("|").as_bytes()))
}

fn newest<'a>(values: impl Iterator<Item = &'a String>) -> String {
    values.max().cloned().unwrap_or_default()
}

// ─── Loop ────────────────────────────────────────────────────────────────────

/* Everything a tick needs. Passing the SSH manager and an emitter explicitly —
 * rather than reaching into an `AppHandle` — is what makes the loop's
 * integration (fingerprint → decision → run → status) testable against a real
 * server without a running Tauri app. */
pub struct SchedulerDeps<'a> {
    pub ssh: &'a SshManager,
    pub db: &'a Arc<HostDb>,
    pub local_vault: &'a Arc<LocalVault>,
    pub scheduler: &'a Arc<SyncScheduler>,
    pub emit: &'a (dyn Fn(SyncStatusSnapshot) + Sync),
}

/// Start the background loop. Called once from `setup`.
pub fn spawn(
    app: AppHandle,
    db: Arc<HostDb>,
    local_vault: Arc<LocalVault>,
    scheduler: Arc<SyncScheduler>,
) {
    tauri::async_runtime::spawn(async move {
        /* A pull on start is the point of auto-sync, but it must not race the
         * window's first paint or the vault's unlock dialog. A few seconds of
         * grace is enough; the loop then treats "never pulled" as due. */
        tokio::time::sleep(Duration::from_secs(3)).await;
        loop {
            let emit_app = app.clone();
            let emit = move |snapshot: SyncStatusSnapshot| {
                let _ = emit_app.emit(EVENT_NAME, snapshot);
            };
            let ssh = app.state::<SshManager>();
            let deps = SchedulerDeps {
                ssh: &ssh,
                db: &db,
                local_vault: &local_vault,
                scheduler: &scheduler,
                emit: &emit,
            };
            if let Err(error) = tick(&deps).await {
                // A scheduler-level failure (a poisoned lock, a DB read) is
                // logged once per tick and never aborts the loop.
                tracing::warn!(error = %error, "auto-sync tick failed");
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

pub async fn tick(deps: &SchedulerDeps<'_>) -> Result<(), SyncError> {
    let db = deps.db;
    let scheduler = deps.scheduler;
    let datasets = db.list_sync_datasets()?;
    for dataset in datasets {
        if !dataset.auto_sync {
            continue;
        }
        if scheduler.with_tracked(&dataset.id, |tracked| tracked.running)? {
            continue;
        }

        let flags = SyncContentFlags::from_json(&dataset.content_flags);
        let fingerprint = {
            let db = Arc::clone(db);
            tokio::task::spawn_blocking(move || local_fingerprint(&db, flags))
                .await
                .map_err(|e| SyncError::Database(format!("fingerprint task panicked: {e}")))??
        };

        let action = scheduler.with_tracked(&dataset.id, |tracked| {
            if tracked.current_fingerprint.as_deref() != Some(fingerprint.as_str()) {
                tracked.current_fingerprint = Some(fingerprint.clone());
                tracked.fingerprint_since = Some(Instant::now());
            }
            decide(&dataset, tracked)
        })?;

        if let Some(action) = action {
            run(deps, &dataset, action, fingerprint).await;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Pull,
    Push,
}

/* Pull wins over push when both are due: publishing first would hit the
 * generation guard (`SyncError::Conflict`) whenever the remote has moved, so
 * fetching first is both cheaper and what the user means by "keep me in sync". */
fn decide(dataset: &SyncDataset, tracked: &Tracked) -> Option<Action> {
    let pull_due = dataset.pull_interval_secs > 0
        && tracked
            .last_pull
            .map(|at| at.elapsed() >= Duration::from_secs(dataset.pull_interval_secs as u64))
            .unwrap_or(true);
    if pull_due {
        return Some(Action::Pull);
    }

    if dataset.push_debounce_secs <= 0 {
        return None;
    }
    let changed = tracked.current_fingerprint.is_some()
        && tracked.current_fingerprint != tracked.published_fingerprint;
    let settled = tracked
        .fingerprint_since
        .map(|at| at.elapsed() >= Duration::from_secs(dataset.push_debounce_secs as u64))
        .unwrap_or(false);
    /* A dataset with no published fingerprint yet (first run after start) is
     * still allowed to publish once the local state has settled: that is the
     * "I enabled auto-sync and then edited something" case. */
    if changed && settled {
        return Some(Action::Push);
    }
    None
}

async fn run(deps: &SchedulerDeps<'_>, dataset: &SyncDataset, action: Action, fingerprint: String) {
    let scheduler = deps.scheduler;
    let phase = match action {
        Action::Pull => SyncPhase::Pulling,
        Action::Push => SyncPhase::Pushing,
    };
    let _ = scheduler.with_tracked(&dataset.id, |tracked| {
        tracked.running = true;
        tracked.phase = phase;
        tracked.message = None;
        tracked.kind = None;
    });
    emit(deps, &dataset.id);

    let outcome = match action {
        Action::Pull => pull::pull(deps.ssh, deps.db, deps.local_vault, &dataset.id)
            .await
            .map(|_| ()),
        Action::Push => push::push(deps.ssh, deps.db, deps.local_vault, &dataset.id)
            .await
            .map(|_| ()),
    };

    let _ = scheduler.with_tracked(&dataset.id, |tracked| {
        tracked.running = false;
        match &outcome {
            Ok(()) => {
                tracked.phase = SyncPhase::Idle;
                tracked.message = None;
                tracked.kind = None;
                match action {
                    Action::Pull => tracked.last_pull = Some(Instant::now()),
                    /* The published fingerprint is the one measured *before*
                     * the run: a pull that applied records changes the
                     * fingerprint, and treating that as "already published"
                     * would swallow the follow-up push. */
                    Action::Push => tracked.published_fingerprint = Some(fingerprint.clone()),
                }
            }
            Err(error) => {
                tracked.phase = SyncPhase::Error;
                tracked.message = Some(error.to_string());
                tracked.kind = Some(error_kind(error).to_string());
                if action == Action::Pull {
                    // Back off a full interval instead of retrying every tick.
                    tracked.last_pull = Some(Instant::now());
                }
            }
        }
    });
    if let Err(error) = &outcome {
        tracing::warn!(dataset_id = %dataset.id, error = %error, "auto-sync run failed");
    }
    emit(deps, &dataset.id);
}

fn emit(deps: &SchedulerDeps<'_>, dataset_id: &str) {
    let Ok(Some(dataset)) = deps.db.get_sync_dataset(dataset_id) else {
        return;
    };
    let Ok(tracked) = deps
        .scheduler
        .with_tracked(dataset_id, |tracked| tracked.clone())
    else {
        return;
    };
    (deps.emit)(snapshot_of(&dataset, &tracked));
}

/* The frontend branches on the error kind, and `SyncError::kind` is private to
 * the serialization impl, so the discriminant is recovered here. Keeping it in
 * one place means the status event and the command errors agree. */
fn error_kind(error: &SyncError) -> &'static str {
    match error {
        SyncError::Format(_) => "format",
        SyncError::Crypto(_) => "crypto",
        SyncError::Decrypt => "decrypt",
        SyncError::Version(_) => "version",
        SyncError::Serialization(_) => "serialization",
        SyncError::Unreachable(_) => "unreachable",
        SyncError::Transport(_) => "transport",
        SyncError::SftpUnavailable(_) => "sftpUnavailable",
        SyncError::Locked(_) => "locked",
        SyncError::Conflict(_) => "conflict",
        SyncError::Vault(_) => "vault",
        SyncError::NotFound(_) => "notFound",
        SyncError::Database(_) => "database",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{HostGroup, SavedHost, SyncDataset};

    fn dataset(auto_sync: bool, pull_interval_secs: i64, push_debounce_secs: i64) -> SyncDataset {
        SyncDataset {
            id: "ds-1".into(),
            name: "NOVA".into(),
            host: "10.0.0.9".into(),
            port: 22,
            username: "sync".into(),
            auth_type: "password".into(),
            remote_path: "/srv/nova".into(),
            role: "owner".into(),
            content_flags: SyncContentFlags::default().to_json().unwrap(),
            scope_mode: "{\"mode\":\"all\"}".into(),
            auto_sync,
            pull_interval_secs,
            push_debounce_secs,
            owner_fingerprint: None,
            kdf_salt: None,
            kdf_m_kib: None,
            kdf_t: None,
            kdf_p: None,
            wrapped_key: None,
            last_generation: 3,
            last_synced_at: Some("2026-09-18T10:00:00Z".into()),
            created_at: String::new(),
            updated_at: String::new(),
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
            credential_storage: crate::db::CredentialStorage::Keychain,
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
    fn nothing_runs_while_the_cadences_are_zero() {
        /* The user's requirement: automatic sync is opt-in, and each cadence is
         * separately opt-in. A dataset with the master switch on but both
         * cadences at zero stays manual-only. */
        let tracked = Tracked {
            current_fingerprint: Some("fp-new".into()),
            published_fingerprint: Some("fp-old".into()),
            fingerprint_since: Some(Instant::now() - Duration::from_secs(600)),
            ..Tracked::default()
        };
        assert_eq!(decide(&dataset(true, 0, 0), &tracked), None);
    }

    #[test]
    fn a_pull_is_due_when_it_has_never_run_and_then_on_its_interval() {
        let due = Tracked::default();
        assert_eq!(decide(&dataset(true, 900, 0), &due), Some(Action::Pull));

        let just_pulled = Tracked {
            last_pull: Some(Instant::now()),
            ..Tracked::default()
        };
        assert_eq!(decide(&dataset(true, 900, 0), &just_pulled), None);

        let overdue = Tracked {
            last_pull: Some(Instant::now() - Duration::from_secs(901)),
            ..Tracked::default()
        };
        assert_eq!(decide(&dataset(true, 900, 0), &overdue), Some(Action::Pull));
    }

    #[test]
    fn a_push_waits_for_the_debounce_window_to_settle() {
        let changed_just_now = Tracked {
            current_fingerprint: Some("fp-new".into()),
            published_fingerprint: Some("fp-old".into()),
            fingerprint_since: Some(Instant::now()),
            last_pull: Some(Instant::now()),
            ..Tracked::default()
        };
        assert_eq!(decide(&dataset(true, 900, 10), &changed_just_now), None);

        let settled = Tracked {
            fingerprint_since: Some(Instant::now() - Duration::from_secs(11)),
            ..changed_just_now.clone()
        };
        assert_eq!(
            decide(&dataset(true, 900, 10), &settled),
            Some(Action::Push)
        );

        // Nothing changed → nothing to publish, however long it has been quiet.
        let unchanged = Tracked {
            published_fingerprint: Some("fp-new".into()),
            ..settled
        };
        assert_eq!(decide(&dataset(true, 900, 10), &unchanged), None);
    }

    #[test]
    fn a_due_pull_takes_precedence_over_a_due_push() {
        /* Pushing first would hit the generation guard whenever the remote has
         * moved on, so the scheduler fetches first. */
        let both = Tracked {
            current_fingerprint: Some("fp-new".into()),
            published_fingerprint: Some("fp-old".into()),
            fingerprint_since: Some(Instant::now() - Duration::from_secs(60)),
            last_pull: Some(Instant::now() - Duration::from_secs(9000)),
            ..Tracked::default()
        };
        assert_eq!(decide(&dataset(true, 900, 10), &both), Some(Action::Pull));
    }

    #[test]
    fn the_fingerprint_reacts_to_edits_and_deletes_but_not_to_usage() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("db");
        let flags = SyncContentFlags::default();

        let empty = local_fingerprint(&db, flags).unwrap();

        db.create_group(&HostGroup {
            id: "g1".into(),
            name: "NOVA".into(),
            color: "#6366f1".into(),
            icon: None,
            sort_order: 0,
            default_username: None,
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: "2026-09-01T00:00:00Z".into(),
        })
        .unwrap();
        db.save_host(&host("h1", "db-01", "2026-09-02T00:00:00Z"))
            .unwrap();
        let with_host = local_fingerprint(&db, flags).unwrap();
        assert_ne!(with_host, empty, "a new host changes the fingerprint");

        db.save_host(&host("h1", "db-01-renamed", "2026-09-03T00:00:00Z"))
            .unwrap();
        let renamed = local_fingerprint(&db, flags).unwrap();
        assert_ne!(renamed, with_host, "an edit changes the fingerprint");

        /* Connecting to a host bumps `last_connected_at` and
         * `connection_count`. That is usage, not content: it must not trigger a
         * push, exactly as it does not change a record's content hash. */
        db.record_connection("h1").unwrap();
        assert_eq!(
            local_fingerprint(&db, flags).unwrap(),
            renamed,
            "opening a connection must not look like an edit"
        );

        db.delete_host("h1").unwrap();
        let deleted = local_fingerprint(&db, flags).unwrap();
        assert_ne!(deleted, renamed, "a delete changes the fingerprint");
        assert_ne!(deleted, empty, "the tombstone keeps it distinct from empty");
    }

    #[test]
    fn a_machine_local_setting_does_not_change_the_fingerprint() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("db");
        let flags = SyncContentFlags::default();
        let before = local_fingerprint(&db, flags).unwrap();

        db.save_setting("app_skipped_update", "1.4.2").unwrap();
        db.save_setting("editors_config", "{\"editors\":[]}")
            .unwrap();
        assert_eq!(
            local_fingerprint(&db, flags).unwrap(),
            before,
            "deny-listed settings are not dataset content"
        );

        db.save_setting("app_theme", "light").unwrap();
        assert_ne!(
            local_fingerprint(&db, flags).unwrap(),
            before,
            "a synced setting does change it"
        );
    }

    #[test]
    fn the_fingerprint_only_covers_enabled_content_kinds() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("db");
        let hosts_only = SyncContentFlags {
            snippets: false,
            snippet_folders: false,
            s3_connections: false,
            app_settings: false,
            ..SyncContentFlags::default()
        };
        let before = local_fingerprint(&db, hosts_only).unwrap();

        db.save_setting("app_theme", "light").unwrap();
        assert_eq!(
            local_fingerprint(&db, hosts_only).unwrap(),
            before,
            "a dataset that does not carry settings ignores them"
        );
    }

    #[test]
    fn a_snapshot_reports_pending_changes_only_when_auto_push_is_configured() {
        let tracked = Tracked {
            current_fingerprint: Some("fp-new".into()),
            published_fingerprint: Some("fp-old".into()),
            ..Tracked::default()
        };

        assert!(snapshot_of(&dataset(true, 900, 10), &tracked).pending_local_changes);
        assert!(
            !snapshot_of(&dataset(true, 900, 0), &tracked).pending_local_changes,
            "manual pushing must not nag about pending changes"
        );
        assert!(!snapshot_of(&dataset(false, 900, 10), &tracked).pending_local_changes);
    }

    #[test]
    fn a_snapshot_serializes_with_the_frontend_field_names() {
        let tracked = Tracked {
            phase: SyncPhase::Error,
            message: Some("another machine is syncing this dataset".into()),
            kind: Some("locked".into()),
            ..Tracked::default()
        };
        let json = serde_json::to_string(&snapshot_of(&dataset(true, 900, 10), &tracked)).unwrap();

        assert!(json.contains("\"datasetId\":\"ds-1\""));
        assert!(json.contains("\"phase\":\"error\""));
        assert!(json.contains("\"autoSync\":true"));
        assert!(json.contains("\"pullIntervalSecs\":900"));
        assert!(json.contains("\"pushDebounceSecs\":10"));
        assert!(json.contains("\"pendingLocalChanges\":false"));
        assert!(json.contains("\"kind\":\"locked\""));
    }

    #[test]
    fn every_error_kind_has_a_stable_discriminant() {
        /* The frontend maps these strings onto actionable wording, so they must
         * match `SyncError`'s serialized `kind` exactly. */
        for (error, expected) in [
            (SyncError::Decrypt, "decrypt"),
            (SyncError::Locked("busy".into()), "locked"),
            (SyncError::Conflict("stale".into()), "conflict"),
            (SyncError::Vault("locked".into()), "vault"),
            (SyncError::NotFound("gone".into()), "notFound"),
            (SyncError::Unreachable("down".into()), "unreachable"),
        ] {
            assert_eq!(error_kind(&error), expected);
            let json = serde_json::to_value(&error).unwrap();
            assert_eq!(json["kind"], expected, "kind must match the command error");
        }
    }
}

/* The scheduler driven against a real server, opt-in via
 * `OMNISSH_SYNC_TEST_HOST`. `tick` takes its dependencies explicitly, so the
 * whole chain — fingerprint, decision, run, emitted status — runs here without
 * a Tauri app, against the same Docker openssh target the other live checks
 * use.
 *
 *   OMNISSH_SYNC_TEST_HOST=127.0.0.1 OMNISSH_SYNC_TEST_PORT=2299 \
 *     cargo test --lib sync::scheduler::live -- --nocapture --test-threads=1
 */
#[cfg(test)]
mod live {
    use super::*;
    use crate::db::SavedHost;
    use crate::sync::codec::{generate_dataset_key, wrap_dataset_key};
    use crate::sync::dataset::pack_wrapped_key;
    use crate::sync::secrets;
    use crate::sync::transport::{RemoteStore, SyncEndpoint, DATASET_FILE, META_FILE};
    use crate::types::session::AuthMethod;
    use crate::vault::StoredCredential;

    const PASSPHRASE: &str = "scheduler-live-passphrase";

    fn env(key: &str, fallback: &str) -> String {
        std::env::var(key).unwrap_or_else(|_| fallback.to_string())
    }

    fn host(id: &str, label: &str, updated_at: &str) -> SavedHost {
        SavedHost {
            id: id.into(),
            label: label.into(),
            host: "10.0.0.5".into(),
            port: 22,
            username: "deployer".into(),
            auth_type: "password".into(),
            credential_storage: crate::db::CredentialStorage::Keychain,
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

    #[tokio::test]
    async fn auto_sync_pulls_on_first_tick_and_pushes_after_the_debounce() {
        if std::env::var("OMNISSH_SYNC_TEST_HOST").is_err() {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live scheduler check");
            return;
        }

        let dataset_id = format!("live-sched-{}", uuid::Uuid::new_v4());
        let root = format!("/config/omnissh-sched-{dataset_id}");
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

        let make = |auto_sync: bool, pull: i64, push_debounce: i64| {
            let dir = tempfile::tempdir().expect("tempdir");
            let db = Arc::new(HostDb::new(dir.path()).expect("db"));
            db.upsert_sync_dataset(&SyncDataset {
                id: dataset_id.clone(),
                name: "Scheduled NOVA".into(),
                host: env("OMNISSH_SYNC_TEST_HOST", "127.0.0.1"),
                port: env("OMNISSH_SYNC_TEST_PORT", "2222")
                    .parse()
                    .unwrap_or(2222),
                username: env("OMNISSH_SYNC_TEST_USER", "testuser"),
                auth_type: "password".into(),
                remote_path: root.clone(),
                role: "owner".into(),
                content_flags: SyncContentFlags::default().to_json().expect("flags"),
                scope_mode: "{\"mode\":\"all\"}".into(),
                auto_sync,
                pull_interval_secs: pull,
                push_debounce_secs: push_debounce,
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
            (dir, db)
        };

        // Publisher: manual only (auto_sync off), so it never runs by itself.
        let (_publisher_dir, publisher_db) = make(false, 0, 0);
        publisher_db
            .save_host(&host("h-1", "scheduled-db-01", "2026-09-02T00:00:00Z"))
            .expect("host");
        let publisher_ssh = SshManager::new();
        let publisher_vault = Arc::new(LocalVault::new());
        push::push(&publisher_ssh, &publisher_db, &publisher_vault, &dataset_id)
            .await
            .expect("publisher publishes generation 1");

        // Subscriber: auto-sync on, pull every 60 s, push 5 s after the last edit.
        let (_subscriber_dir, subscriber_db) = make(true, 60, 5);
        let subscriber_ssh = SshManager::new();
        let subscriber_vault = Arc::new(LocalVault::new());
        let scheduler = Arc::new(SyncScheduler::new());
        /* Emitted snapshots are collected through a channel rather than a
         * shared Vec behind a lock: the emitter must be `Sync`, and a channel
         * keeps the test free of lock handling. */
        let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
        let sink = move |snapshot: SyncStatusSnapshot| {
            let _ = events_tx.send(snapshot);
        };
        let drain = |rx: &mut tokio::sync::mpsc::UnboundedReceiver<SyncStatusSnapshot>| {
            let mut seen = Vec::new();
            while let Ok(snapshot) = rx.try_recv() {
                seen.push(snapshot);
            }
            seen
        };
        let deps = SchedulerDeps {
            ssh: &subscriber_ssh,
            db: &subscriber_db,
            local_vault: &subscriber_vault,
            scheduler: &scheduler,
            emit: &sink,
        };

        // First tick: never pulled → a pull is due and the dataset arrives.
        tick(&deps).await.expect("first tick");
        assert_eq!(
            subscriber_db.list_hosts().unwrap().len(),
            1,
            "auto-pull brought the dataset in"
        );
        let seen = drain(&mut events_rx);
        assert!(
            seen.iter().any(|s| s.phase == SyncPhase::Pulling),
            "a pulling phase was emitted"
        );
        assert!(
            matches!(seen.last().map(|s| s.phase), Some(SyncPhase::Idle)),
            "and it settled back to idle: {:?}",
            seen.last()
        );

        // Second tick right after: the interval has not elapsed, nothing runs.
        tick(&deps).await.expect("second tick");
        assert!(
            drain(&mut events_rx).is_empty(),
            "no work is due one second into a 60 s interval"
        );

        // A local edit is not published until the debounce window has passed.
        subscriber_db
            .save_host(&host("h-2", "added-on-subscriber", "2026-09-06T00:00:00Z"))
            .expect("local edit");
        tick(&deps).await.expect("tick right after the edit");
        assert!(
            drain(&mut events_rx).is_empty(),
            "the push waits for the debounce window"
        );
        let status = scheduler.snapshot(&subscriber_db).expect("status");
        assert!(
            status[0].pending_local_changes,
            "the UI is told changes are waiting"
        );

        tokio::time::sleep(Duration::from_secs(6)).await;
        tick(&deps).await.expect("tick after the debounce");
        let seen = drain(&mut events_rx);
        assert!(
            seen.iter().any(|s| s.phase == SyncPhase::Pushing),
            "the settled change was published: {seen:?}"
        );
        let row = subscriber_db
            .get_sync_dataset(&dataset_id)
            .unwrap()
            .unwrap();
        assert_eq!(row.last_generation, 2, "the publish bumped the generation");
        assert!(
            !scheduler.snapshot(&subscriber_db).unwrap()[0].pending_local_changes,
            "nothing is pending once it has been published"
        );

        // Nothing further is due: no change, interval not elapsed.
        tick(&deps).await.expect("quiet tick");
        assert!(drain(&mut events_rx).is_empty(), "a quiet dataset is quiet");

        /* A dataset with the master switch off is skipped entirely, even with
         * pending changes and an elapsed interval — the user's opt-in rule. */
        let (_manual_dir, manual_db) = make(false, 60, 5);
        manual_db
            .save_host(&host("h-3", "manual-only", "2026-09-07T00:00:00Z"))
            .expect("edit on the manual dataset");
        let manual_scheduler = Arc::new(SyncScheduler::new());
        let (manual_tx, mut manual_rx) = tokio::sync::mpsc::unbounded_channel();
        let manual_sink = move |snapshot: SyncStatusSnapshot| {
            let _ = manual_tx.send(snapshot);
        };
        let manual_deps = SchedulerDeps {
            ssh: &subscriber_ssh,
            db: &manual_db,
            local_vault: &subscriber_vault,
            scheduler: &manual_scheduler,
            emit: &manual_sink,
        };
        tokio::time::sleep(Duration::from_secs(6)).await;
        tick(&manual_deps).await.expect("manual tick");
        tick(&manual_deps).await.expect("manual tick again");
        assert!(
            drain(&mut manual_rx).is_empty(),
            "automatic sync must never run for a dataset the user did not enable"
        );
        assert_eq!(
            manual_db
                .get_sync_dataset(&dataset_id)
                .unwrap()
                .unwrap()
                .last_generation,
            0,
            "and it published nothing"
        );

        // Clean up the remote objects and the keychain secrets.
        let endpoint = SyncEndpoint {
            host: env("OMNISSH_SYNC_TEST_HOST", "127.0.0.1"),
            port: env("OMNISSH_SYNC_TEST_PORT", "2222")
                .parse()
                .unwrap_or(2222),
            username: env("OMNISSH_SYNC_TEST_USER", "testuser"),
            auth: AuthMethod::Password {
                password: env("OMNISSH_SYNC_TEST_PASS", "testpass"),
            },
            root: root.clone(),
        };
        if let Ok(store) = RemoteStore::connect(&subscriber_ssh, &endpoint).await {
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
            store.close(&subscriber_ssh).await;
        }
        let _ = secrets::delete_dataset_secrets(&dataset_id);
    }
}
