/*
 * Per-dataset state across a *list* of datasets (Task 7).
 *
 * Two rows may point at one server and one account, differing only in
 * `remote_path`, so every piece of state a sync produces has to stay keyed by
 * dataset id rather than by endpoint. These checks cover that independence and
 * what removing one row leaves behind: the other dataset's state survives, and
 * the local hosts are never touched.
 */

use crate::db::{
    CredentialStorage, HostDb, SavedHost, SyncConflict, SyncDataset, SyncEntityType,
    SyncRecordState,
};

use super::dataset::delete_dataset;
use super::SyncError;

fn dataset_row(id: &str, remote_path: &str) -> SyncDataset {
    SyncDataset {
        id: id.into(),
        name: id.to_uppercase(),
        host: "10.0.0.9".into(),
        port: 2299,
        username: "testuser".into(),
        auth_type: "password".into(),
        remote_path: remote_path.into(),
        role: "owner".into(),
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
        last_generation: 1,
        last_synced_at: Some("2026-09-18T10:00:00Z".into()),
        created_at: "2026-09-01T00:00:00Z".into(),
        updated_at: "2026-09-18T10:00:00Z".into(),
    }
}

fn saved_host(id: &str, label: &str) -> SavedHost {
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

fn state(dataset_id: &str, entity_id: &str, revision: i64, hash: &str) -> SyncRecordState {
    SyncRecordState {
        dataset_id: dataset_id.into(),
        entity_type: SyncEntityType::Host,
        entity_id: entity_id.into(),
        remote_revision: revision,
        base_hash: hash.into(),
        managed: false,
        synced_at: "2026-09-18T10:00:00Z".into(),
    }
}

fn conflict(dataset_id: &str, entity_id: &str) -> SyncConflict {
    SyncConflict {
        id: 0,
        dataset_id: dataset_id.into(),
        entity_type: SyncEntityType::Host,
        entity_id: entity_id.into(),
        resolution: "kept the newer copy".into(),
        winner_updated_at: Some("2026-09-18T12:00:00Z".into()),
        loser_updated_at: Some("2026-09-17T09:00:00Z".into()),
        detected_at: "2026-09-18T12:00:05Z".into(),
    }
}

#[test]
fn two_datasets_at_one_endpoint_keep_their_own_record_state_and_remote_paths() {
    let directory = tempfile::tempdir().expect("tempdir");
    let db = HostDb::new(directory.path()).expect("db");

    /* The acceptance case: one server, one account, two directories. The rows
     * look alike everywhere except `remote_path`, so state keyed by endpoint
     * instead of dataset id would collide exactly here. */
    db.upsert_sync_dataset(&dataset_row("ds-a", "/config/ds-a"))
        .expect("row a");
    db.upsert_sync_dataset(&dataset_row("ds-b", "/config/ds-b"))
        .expect("row b");

    db.upsert_sync_record_state(&[
        state("ds-a", "h-1", 3, "hash-a"),
        state("ds-b", "h-1", 7, "hash-b"),
    ])
    .expect("record state");

    let a = db.list_sync_record_state("ds-a").expect("state a");
    let b = db.list_sync_record_state("ds-b").expect("state b");
    assert_eq!((a.len(), b.len()), (1, 1));
    assert_eq!(
        (a[0].remote_revision, a[0].base_hash.as_str()),
        (3, "hash-a")
    );
    assert_eq!(
        (b[0].remote_revision, b[0].base_hash.as_str()),
        (7, "hash-b"),
        "one dataset's base must not move the other's"
    );

    // Each row rebuilds its own remote path, which is what keeps the writes apart.
    assert_eq!(
        db.get_sync_dataset("ds-a").unwrap().unwrap().remote_path,
        "/config/ds-a"
    );
    assert_eq!(
        db.get_sync_dataset("ds-b").unwrap().unwrap().remote_path,
        "/config/ds-b"
    );

    // Clearing one dataset's state leaves the other's alone.
    db.clear_sync_record_state("ds-a", None).expect("clear a");
    assert!(db.list_sync_record_state("ds-a").unwrap().is_empty());
    assert_eq!(db.list_sync_record_state("ds-b").unwrap().len(), 1);
}

#[test]
fn removing_a_dataset_purges_its_state_and_leaves_the_other_dataset_and_hosts_alone() {
    let directory = tempfile::tempdir().expect("tempdir");
    let db = HostDb::new(directory.path()).expect("db");

    db.save_host(&saved_host("h-1", "host-1")).expect("host 1");
    db.save_host(&saved_host("h-2", "host-2")).expect("host 2");
    db.upsert_sync_dataset(&dataset_row("ds-a", "/config/ds-a"))
        .expect("row a");
    db.upsert_sync_dataset(&dataset_row("ds-b", "/config/ds-b"))
        .expect("row b");
    db.set_sync_dataset_members("ds-a", &[(SyncEntityType::Host, "h-1".into())])
        .expect("members a");
    db.set_sync_dataset_members("ds-b", &[(SyncEntityType::Host, "h-2".into())])
        .expect("members b");
    db.upsert_sync_record_state(&[
        state("ds-a", "h-1", 3, "hash-a"),
        state("ds-b", "h-2", 4, "hash-b"),
    ])
    .expect("record state");
    db.record_sync_conflicts(&[conflict("ds-a", "h-1"), conflict("ds-b", "h-2")])
        .expect("conflicts");

    delete_dataset(&db, "ds-a").expect("remove a");

    // Everything the removed dataset owned goes with it.
    assert!(db.get_sync_dataset("ds-a").unwrap().is_none());
    assert!(db.list_sync_record_state("ds-a").unwrap().is_empty());
    assert!(db.list_sync_conflicts("ds-a", 10).unwrap().is_empty());
    assert!(db.list_sync_dataset_members("ds-a").unwrap().is_empty());

    // The dataset beside it keeps all of its own state.
    assert!(db.get_sync_dataset("ds-b").unwrap().is_some());
    assert_eq!(db.list_sync_record_state("ds-b").unwrap().len(), 1);
    assert_eq!(db.list_sync_conflicts("ds-b", 10).unwrap().len(), 1);
    assert_eq!(db.list_sync_dataset_members("ds-b").unwrap().len(), 1);

    /* Unsubscribing from a dataset never deletes the user's own data: both
     * hosts are still here, including the one the removed dataset synced. */
    assert_eq!(db.list_hosts().expect("hosts").len(), 2);
    assert_eq!(
        db.get_host("h-1").unwrap().map(|host| host.label),
        Some("host-1".to_string())
    );
}

#[test]
fn removing_an_unknown_dataset_reports_not_found_instead_of_succeeding_silently() {
    let directory = tempfile::tempdir().expect("tempdir");
    let db = HostDb::new(directory.path()).expect("db");
    db.upsert_sync_dataset(&dataset_row("ds-a", "/config/ds-a"))
        .expect("row a");

    assert!(matches!(
        delete_dataset(&db, "ds-missing"),
        Err(SyncError::NotFound(_))
    ));

    delete_dataset(&db, "ds-a").expect("remove a");
    assert!(
        matches!(delete_dataset(&db, "ds-a"), Err(SyncError::NotFound(_))),
        "a second removal is reported, not silently accepted"
    );
}
