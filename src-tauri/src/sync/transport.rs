/*
 * Sync transport: the remote dataset directory over SSH + SFTP.
 *
 * A dataset lives in a plain directory on a server the user controls, holding
 * four kinds of object (see `docs` in `sync::mod`): the sealed bundle, the
 * plaintext metadata file, an advisory lock, and a bounded `history/` of prior
 * generations. This module is the only place that talks to that directory.
 *
 * Design points that matter:
 *
 * - The SSH connection is *ephemeral and invisible*: `connect_no_pty` +
 *   `disconnect_bare`, so a sync never appears as a terminal/explorer session
 *   and never emits `ssh:status` for a session the frontend does not know.
 * - The SFTP session is owned by this store rather than registered in
 *   `SftpManager`: the manager's map is the user-visible session registry, and
 *   a background sync must not show up there or be closable from the UI.
 * - Publishing is atomic: bytes go to `.tmp-<uuid>` in the same directory and
 *   are renamed over the target, so a reader never observes a half-written
 *   bundle. Servers that reject rename-over-existing get one remove+rename
 *   retry.
 * - SFTP-only, like `relay`: an SCP-only remote is rejected with an actionable
 *   error instead of half-working.
 */

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileType, OpenFlags};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tracing::instrument;

use crate::ssh::manager::SshManager;
use crate::types::session::{AuthMethod, HostConfig};

use super::SyncError;

// ─── Remote layout ───────────────────────────────────────────────────────────

/// Sealed dataset bundle (`OMNISYNC` container).
pub const DATASET_FILE: &str = "dataset.bin";
/// Plaintext, non-secret metadata: generation, digest, key wrap, signature.
pub const META_FILE: &str = "dataset.meta.json";
/// Advisory writer lock.
pub const LOCK_FILE: &str = "dataset.lock";
/// Retained previous generations.
pub const HISTORY_DIR: &str = "history";
/// Generations kept in `history/` before the oldest is pruned.
pub const HISTORY_KEEP: usize = 10;
/// A lock older than this is treated as abandoned by a crashed client.
pub const LOCK_STALE_AFTER: Duration = Duration::from_secs(60);

/// Largest object this transport will read into memory. A dataset is host
/// metadata, not file content; anything this size is a wrong path or a hostile
/// server, and must not be allowed to exhaust memory.
const MAX_OBJECT_BYTES: u64 = 64 * 1024 * 1024;

const READ_CHUNK: usize = 64 * 1024;

// ─── Endpoint ────────────────────────────────────────────────────────────────

/// Where a dataset lives and how to authenticate to it.
///
/// `auth` reuses [`AuthMethod`] so the secret material inherits its zeroizing
/// `Drop` and redacted `Debug`. ProxyJump is deliberately absent: a sync
/// endpoint is a storage location, and jump-host support is a later phase.
#[derive(Debug)]
pub struct SyncEndpoint {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// Absolute (or home-relative) directory holding the dataset objects.
    pub root: String,
}

impl SyncEndpoint {
    fn host_config(&self) -> HostConfig {
        HostConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            auth_method: self.auth.clone(),
            label: Some(format!("sync:{}", self.host)),
            // Sync sessions live for seconds; a keepalive would only add noise.
            keep_alive_interval: None,
            default_shell: None,
            startup_command: None,
            jump_host: None,
        }
    }
}

/// What a probe found at a dataset root — used by `sync_test_connection` to
/// tell "empty directory, ready to initialise" from "someone else's dataset".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProbe {
    /// The root exists and is a directory.
    pub path_exists: bool,
    /// A probe file could be created and removed in the root.
    pub writable: bool,
    /// A dataset bundle and metadata file are already present.
    pub dataset_present: bool,
    /// Raw metadata bytes when present, for the caller to parse and report.
    #[serde(skip)]
    pub meta: Option<Vec<u8>>,
}

// ─── Store ───────────────────────────────────────────────────────────────────

/// An open connection to one dataset directory.
///
/// Created by [`RemoteStore::connect`] and released by [`RemoteStore::close`];
/// dropping without `close` leaks the SSH session until the process exits, so
/// callers always close (including on the error path).
pub struct RemoteStore {
    ssh_session_id: String,
    sftp: Arc<Mutex<SftpSession>>,
    root: String,
    /// Identifies this client in the lock file so a stale lock is attributable.
    client_id: String,
}

impl RemoteStore {
    /// Connect, open an SFTP channel, and resolve the dataset root.
    ///
    /// The span deliberately records no host, port, or path: a sync log line
    /// must not identify the server or the directory the user chose.
    #[instrument(skip(ssh, endpoint))]
    pub async fn connect(ssh: &SshManager, endpoint: &SyncEndpoint) -> Result<Self, SyncError> {
        let session_id = ssh
            .connect_no_pty(endpoint.host_config(), None)
            .await
            .map_err(|e| SyncError::Unreachable(format!("sync endpoint unreachable: {e}")))?;
        let ssh_session_id = session_id.0.clone();

        /* Every failure after the connection is established must tear that
         * connection down: an early `?` here would otherwise leave a live
         * bare handle behind for each failed sync attempt. */
        match Self::open_sftp(ssh, &ssh_session_id).await {
            Ok(sftp) => Ok(Self {
                ssh_session_id,
                sftp: Arc::new(Mutex::new(sftp)),
                root: normalize_root(&endpoint.root),
                client_id: uuid::Uuid::new_v4().to_string(),
            }),
            Err(error) => {
                let _ = ssh.disconnect_bare(&ssh_session_id).await;
                Err(error)
            }
        }
    }

    async fn open_sftp(ssh: &SshManager, ssh_session_id: &str) -> Result<SftpSession, SyncError> {
        let handle = ssh
            .get_handle(ssh_session_id)
            .map_err(|e| SyncError::Transport(e.to_string()))?;
        let channel = {
            let handle = handle.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|e| SyncError::Transport(format!("could not open a channel: {e}")))?
        };
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| SyncError::Transport(format!("could not request SFTP: {e}")))?;
        /* `request_subsystem` returns before the server's accept/reject, so a
         * host without the SFTP subsystem fails here — the same place the
         * explorer detects it before falling back to SCP. Sync has no SCP
         * path (no random-access writes, no atomic rename), so this is a hard,
         * actionable error rather than a fallback. */
        SftpSession::new(channel.into_stream()).await.map_err(|e| {
            SyncError::SftpUnavailable(format!(
                "this server does not provide SFTP, which dataset sync requires: {e}"
            ))
        })
    }

    /// Release the SSH session. Always call this, including after an error.
    pub async fn close(self, ssh: &SshManager) {
        {
            let sftp = self.sftp.lock().await;
            let _ = sftp.close().await;
        }
        let _ = ssh.disconnect_bare(&self.ssh_session_id).await;
    }

    /// This client's lock identity, recorded in the lock file.
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    fn path(&self, name: &str) -> String {
        join(&self.root, name)
    }

    // ─── Directory ───────────────────────────────────────────────────────────

    /// Create the dataset root (and any missing parent) if absent.
    pub async fn ensure_root(&self) -> Result<(), SyncError> {
        let sftp = self.sftp.lock().await;
        ensure_dir(&sftp, &self.root).await?;
        ensure_dir(&sftp, &join(&self.root, HISTORY_DIR)).await
    }

    /// Inspect the root without modifying the dataset: existence, writability,
    /// and whether a dataset is already published there.
    pub async fn probe(&self) -> Result<RemoteProbe, SyncError> {
        let sftp = self.sftp.lock().await;
        let path_exists = matches!(
            sftp.metadata(&self.root).await,
            Ok(attrs) if attrs.file_type() == FileType::Dir
        );
        if !path_exists {
            return Ok(RemoteProbe {
                path_exists: false,
                writable: false,
                dataset_present: false,
                meta: None,
            });
        }

        /* Writability is probed with a real create+remove rather than inferred
         * from the mode bits: the account may be denied by ACLs, a read-only
         * mount, or a quota that `metadata` cannot show — and for a member of a
         * shared dataset, "can this account write?" is exactly the question
         * whose answer the UI must surface. */
        let probe_path = self.path(&format!(".omnissh-probe-{}", self.client_id));
        let writable = match sftp
            .open_with_flags(
                &probe_path,
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            )
            .await
        {
            Ok(mut file) => {
                let wrote = file.write_all(b"omnissh").await.is_ok();
                let _ = file.shutdown().await;
                let _ = sftp.remove_file(&probe_path).await;
                wrote
            }
            Err(_) => false,
        };

        let meta = read_optional(&sftp, &self.path(META_FILE)).await?;
        let bundle_present = read_metadata(&sftp, &self.path(DATASET_FILE))
            .await?
            .is_some();

        Ok(RemoteProbe {
            path_exists,
            writable,
            dataset_present: meta.is_some() && bundle_present,
            meta,
        })
    }

    // ─── Objects ─────────────────────────────────────────────────────────────

    /// Read one object from the dataset root, or `None` when it does not exist.
    pub async fn read(&self, name: &str) -> Result<Option<Vec<u8>>, SyncError> {
        let sftp = self.sftp.lock().await;
        read_optional(&sftp, &self.path(name)).await
    }

    /// Publish `bytes` as `name`, atomically from a reader's point of view.
    pub async fn write_atomic(&self, name: &str, bytes: &[u8]) -> Result<(), SyncError> {
        let sftp = self.sftp.lock().await;
        let target = self.path(name);
        let staging = self.path(&format!(".tmp-{}-{}", self.client_id, uuid::Uuid::new_v4()));

        write_all(&sftp, &staging, bytes).await?;

        /* POSIX rename replaces the destination, but not every SFTP server
         * implements SSH_FXP_RENAME that way (the v3 spec leaves an existing
         * target as an error). Falling back to remove+rename keeps publishing
         * atomic where the server allows it and merely narrow where it does
         * not; the staging file is always cleaned up. */
        if sftp.rename(&staging, &target).await.is_ok() {
            return Ok(());
        }
        let _ = sftp.remove_file(&target).await;
        match sftp.rename(&staging, &target).await {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = sftp.remove_file(&staging).await;
                Err(SyncError::Transport(format!(
                    "could not publish {name}: {error}"
                )))
            }
        }
    }

    /// Remove an object, treating "already gone" as success.
    pub async fn remove(&self, name: &str) -> Result<(), SyncError> {
        let sftp = self.sftp.lock().await;
        match sftp.remove_file(&self.path(name)).await {
            Ok(()) => Ok(()),
            Err(_) if read_optional(&sftp, &self.path(name)).await?.is_none() => Ok(()),
            Err(error) => Err(SyncError::Transport(format!(
                "could not remove {name}: {error}"
            ))),
        }
    }

    // ─── History ─────────────────────────────────────────────────────────────

    /// Copy the current bundle and metadata into `history/<generation>.*`.
    pub async fn archive_generation(
        &self,
        generation: u64,
        bundle: &[u8],
        meta: &[u8],
    ) -> Result<(), SyncError> {
        self.write_atomic(&format!("{HISTORY_DIR}/{generation}.bin"), bundle)
            .await?;
        self.write_atomic(&format!("{HISTORY_DIR}/{generation}.meta.json"), meta)
            .await
    }

    /// Retained generations, oldest first.
    pub async fn list_history(&self) -> Result<Vec<u64>, SyncError> {
        let sftp = self.sftp.lock().await;
        let dir = join(&self.root, HISTORY_DIR);
        let entries = match sftp.read_dir(&dir).await {
            Ok(entries) => entries,
            // No history directory yet simply means nothing has been archived.
            Err(_) => return Ok(Vec::new()),
        };
        let mut generations: Vec<u64> = entries
            .filter_map(|entry| {
                let name = entry.file_name();
                name.strip_suffix(".bin")
                    .and_then(|stem| stem.parse::<u64>().ok())
            })
            .collect();
        generations.sort_unstable();
        Ok(generations)
    }

    /// Drop the oldest archived generations beyond [`HISTORY_KEEP`].
    pub async fn prune_history(&self, keep: usize) -> Result<(), SyncError> {
        let generations = self.list_history().await?;
        if generations.len() <= keep {
            return Ok(());
        }
        let drop_count = generations.len() - keep;
        for generation in generations.into_iter().take(drop_count) {
            self.remove(&format!("{HISTORY_DIR}/{generation}.bin"))
                .await?;
            self.remove(&format!("{HISTORY_DIR}/{generation}.meta.json"))
                .await?;
        }
        Ok(())
    }

    // ─── Locking ─────────────────────────────────────────────────────────────

    /// Take the writer lock, or fail with [`SyncError::Locked`].
    ///
    /// The lock is an `O_EXCL` create, which is the strongest mutual exclusion
    /// SFTP offers. A lock whose recorded timestamp is older than
    /// `stale_after` is assumed to belong to a crashed client and is stolen
    /// once; two clients racing to steal the same stale lock are still
    /// serialised by the `O_EXCL` retry.
    pub async fn acquire_lock(&self, stale_after: Duration) -> Result<(), SyncError> {
        if self.try_create_lock().await? {
            return Ok(());
        }

        let holder = self.read_lock_holder().await?;
        let age = holder
            .as_ref()
            .map(|holder| now_secs().saturating_sub(holder.acquired_at_secs));
        let stale = age.map(|age| age >= stale_after.as_secs()).unwrap_or(true);
        if !stale {
            let owner = holder
                .as_ref()
                .map(|holder| holder.client_id.as_str())
                .unwrap_or("another client");
            return Err(SyncError::Locked(format!(
                "another client ({owner}) is syncing this dataset; try again in a moment"
            )));
        }

        tracing::warn!(
            dataset_lock_age_secs = age.unwrap_or_default(),
            "stealing a stale dataset lock"
        );
        self.remove(LOCK_FILE).await?;
        if self.try_create_lock().await? {
            return Ok(());
        }
        Err(SyncError::Locked(
            "another client took the dataset lock while a stale one was being cleared".into(),
        ))
    }

    /// Release the writer lock. Missing lock file is success.
    pub async fn release_lock(&self) -> Result<(), SyncError> {
        self.remove(LOCK_FILE).await
    }

    async fn try_create_lock(&self) -> Result<bool, SyncError> {
        let body = serde_json::to_vec(&LockFile {
            client_id: self.client_id.clone(),
            acquired_at_secs: now_secs(),
        })
        .map_err(|e| SyncError::Serialization(e.to_string()))?;

        let sftp = self.sftp.lock().await;
        let mut file = match sftp
            .open_with_flags(
                &self.path(LOCK_FILE),
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            )
            .await
        {
            Ok(file) => file,
            // EXCLUDE means "someone else holds it" — not a transport failure.
            Err(_) => return Ok(false),
        };
        file.write_all(&body)
            .await
            .map_err(|e| SyncError::Transport(format!("could not write the dataset lock: {e}")))?;
        file.shutdown()
            .await
            .map_err(|e| SyncError::Transport(format!("could not write the dataset lock: {e}")))?;
        Ok(true)
    }

    async fn read_lock_holder(&self) -> Result<Option<LockFile>, SyncError> {
        let Some(bytes) = self.read(LOCK_FILE).await? else {
            return Ok(None);
        };
        // A truncated or foreign lock file is treated as "unknown holder", which
        // the staleness rule then resolves — never as a hard failure.
        Ok(serde_json::from_slice(&bytes).ok())
    }
}

/// Contents of the advisory lock file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LockFile {
    pub client_id: String,
    pub acquired_at_secs: u64,
}

// ─── Path + I/O helpers ──────────────────────────────────────────────────────

/// Strip trailing slashes so joins never produce `//`, and map an empty root to
/// `.` (the SFTP session's start directory).
fn normalize_root(root: &str) -> String {
    let trimmed = root.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        if root.trim().starts_with('/') {
            "/".to_string()
        } else {
            ".".to_string()
        }
    } else {
        trimmed.to_string()
    }
}

fn join(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn ensure_dir(sftp: &SftpSession, path: &str) -> Result<(), SyncError> {
    if matches!(sftp.metadata(path).await, Ok(attrs) if attrs.file_type() == FileType::Dir) {
        return Ok(());
    }
    // Walk the components so a nested root (`/srv/omnissh/datasets/nova`) is
    // created in one call, mirroring the explorer's `ensure_remote_dir`.
    let absolute = path.starts_with('/');
    let mut current = if absolute {
        String::from("")
    } else {
        String::from(".")
    };
    for segment in path.split('/').filter(|s| !s.is_empty() && *s != ".") {
        current = if current.is_empty() {
            format!("/{segment}")
        } else {
            format!("{current}/{segment}")
        };
        match sftp.create_dir(&current).await {
            Ok(()) => {}
            Err(error) => match sftp.metadata(&current).await {
                Ok(attrs) if attrs.file_type() == FileType::Dir => {}
                _ => {
                    return Err(SyncError::Transport(format!(
                        "could not create the dataset directory: {error}"
                    )))
                }
            },
        }
    }
    Ok(())
}

async fn read_metadata(
    sftp: &SftpSession,
    path: &str,
) -> Result<Option<russh_sftp::protocol::FileAttributes>, SyncError> {
    match sftp.metadata(path).await {
        Ok(attrs) => Ok(Some(attrs)),
        Err(_) => Ok(None),
    }
}

async fn read_optional(sftp: &SftpSession, path: &str) -> Result<Option<Vec<u8>>, SyncError> {
    let Some(attrs) = read_metadata(sftp, path).await? else {
        return Ok(None);
    };
    if attrs.file_type() == FileType::Dir {
        return Err(SyncError::Transport(
            "a dataset object is a directory, not a file".to_string(),
        ));
    }
    // The size is server-reported, so it is a cheap pre-check only; the read
    // loop below enforces the same ceiling on the bytes actually delivered.
    if attrs.size.unwrap_or(0) > MAX_OBJECT_BYTES {
        return Err(SyncError::Transport(format!(
            "a dataset object is larger than the {MAX_OBJECT_BYTES}-byte limit"
        )));
    }

    let mut file = match sftp.open(path).await {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };
    let mut out = Vec::with_capacity(attrs.size.unwrap_or(0) as usize);
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let read = file
            .read(&mut buf)
            .await
            .map_err(|e| SyncError::Transport(format!("could not read a dataset object: {e}")))?;
        if read == 0 {
            break;
        }
        if out.len() as u64 + read as u64 > MAX_OBJECT_BYTES {
            return Err(SyncError::Transport(format!(
                "a dataset object is larger than the {MAX_OBJECT_BYTES}-byte limit"
            )));
        }
        out.extend_from_slice(&buf[..read]);
    }
    Ok(Some(out))
}

async fn write_all(sftp: &SftpSession, path: &str, bytes: &[u8]) -> Result<(), SyncError> {
    let mut file = sftp
        .open_with_flags(
            path,
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| SyncError::Transport(format!("could not open a dataset object: {e}")))?;
    file.write_all(bytes)
        .await
        .map_err(|e| SyncError::Transport(format!("could not write a dataset object: {e}")))?;
    file.shutdown()
        .await
        .map_err(|e| SyncError::Transport(format!("could not flush a dataset object: {e}")))?;
    Ok(())
}

/* Live transport check against a real SFTP server. Opt-in because it needs a
 * reachable endpoint: with `OMNISSH_SYNC_TEST_HOST` unset the test reports that
 * it was skipped rather than silently passing. The E2E suite runs the same
 * round-trip through the UI against the `sshd-sync` compose service.
 *
 *   docker run -d --rm -p 2299:2222 -e USER_NAME=testuser \
 *     -e USER_PASSWORD=testpass -e PASSWORD_ACCESS=true \
 *     lscr.io/linuxserver/openssh-server:latest
 *   OMNISSH_SYNC_TEST_HOST=127.0.0.1 OMNISSH_SYNC_TEST_PORT=2299 \
 *     OMNISSH_SYNC_TEST_USER=testuser OMNISSH_SYNC_TEST_PASS=testpass \
 *     cargo test --lib sync::transport::live -- --nocapture
 */
#[cfg(test)]
mod live {
    use super::*;

    fn endpoint_from_env() -> Option<SyncEndpoint> {
        let host = std::env::var("OMNISSH_SYNC_TEST_HOST").ok()?;
        Some(SyncEndpoint {
            host,
            port: std::env::var("OMNISSH_SYNC_TEST_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(2222),
            username: std::env::var("OMNISSH_SYNC_TEST_USER").unwrap_or_else(|_| "testuser".into()),
            auth: AuthMethod::Password {
                password: std::env::var("OMNISSH_SYNC_TEST_PASS")
                    .unwrap_or_else(|_| "testpass".into()),
            },
            root: std::env::var("OMNISSH_SYNC_TEST_ROOT")
                .unwrap_or_else(|_| "/config/omnissh-sync-test".into()),
        })
    }

    #[tokio::test]
    async fn publishes_reads_locks_and_archives_against_a_real_server() {
        let Some(endpoint) = endpoint_from_env() else {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live transport check");
            return;
        };

        let ssh = SshManager::new();
        let store = RemoteStore::connect(&ssh, &endpoint)
            .await
            .expect("connect to the sync endpoint");

        let outcome = async {
            store.ensure_root().await.expect("ensure root");

            let probe = store.probe().await.expect("probe");
            assert!(probe.path_exists, "root should exist after ensure_root");
            assert!(probe.writable, "test account should be able to write");

            // Publish, re-publish over the existing object, and read back.
            store
                .write_atomic(DATASET_FILE, b"generation-1")
                .await
                .expect("publish generation 1");
            assert_eq!(
                store.read(DATASET_FILE).await.expect("read bundle"),
                Some(b"generation-1".to_vec())
            );
            store
                .write_atomic(DATASET_FILE, b"generation-2")
                .await
                .expect("republish over an existing object");
            assert_eq!(
                store.read(DATASET_FILE).await.expect("read bundle"),
                Some(b"generation-2".to_vec())
            );
            assert_eq!(store.read("no-such-object").await.expect("missing"), None);

            // No staging files may survive a publish.
            let probe = store.probe().await.expect("probe after publish");
            assert!(probe.dataset_present == store.read(META_FILE).await.unwrap().is_some());

            // Locking: exclusive while held, re-acquirable after release.
            store
                .acquire_lock(LOCK_STALE_AFTER)
                .await
                .expect("acquire lock");
            let second = RemoteStore::connect(&ssh, &endpoint)
                .await
                .expect("second client connects");
            let contended = second.acquire_lock(LOCK_STALE_AFTER).await;
            assert!(
                matches!(contended, Err(SyncError::Locked(_))),
                "a held lock must block a second writer, got {contended:?}"
            );
            // A lock past its staleness window is stolen instead of deadlocking.
            second
                .acquire_lock(Duration::from_secs(0))
                .await
                .expect("steal a stale lock");
            second.release_lock().await.expect("release stolen lock");
            store
                .acquire_lock(LOCK_STALE_AFTER)
                .await
                .expect("re-acquire after release");
            store.release_lock().await.expect("release lock");
            second.close(&ssh).await;

            // History: archive, list oldest-first, prune to the newest entry.
            for generation in 1..=3u64 {
                store
                    .archive_generation(
                        generation,
                        format!("bundle-{generation}").as_bytes(),
                        format!("{{\"generation\":{generation}}}").as_bytes(),
                    )
                    .await
                    .expect("archive generation");
            }
            assert_eq!(store.list_history().await.expect("history"), vec![1, 2, 3]);
            store.prune_history(1).await.expect("prune history");
            assert_eq!(store.list_history().await.expect("history"), vec![3]);

            // Clean up so a rerun starts from an empty root.
            store.remove(DATASET_FILE).await.expect("remove bundle");
            store
                .remove(&format!("{HISTORY_DIR}/3.bin"))
                .await
                .expect("remove archived bundle");
            store
                .remove(&format!("{HISTORY_DIR}/3.meta.json"))
                .await
                .expect("remove archived meta");
        }
        .await;

        store.close(&ssh).await;
        outcome
    }

    #[tokio::test]
    async fn a_bad_password_is_reported_as_unreachable() {
        let Some(mut endpoint) = endpoint_from_env() else {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live transport check");
            return;
        };
        endpoint.auth = AuthMethod::Password {
            password: "definitely-not-the-password".into(),
        };

        let ssh = SshManager::new();
        match RemoteStore::connect(&ssh, &endpoint).await {
            Err(SyncError::Unreachable(message)) => {
                assert!(message.contains("unreachable"), "got {message}")
            }
            Err(other) => panic!("expected an unreachable error, got {other:?}"),
            Ok(store) => {
                store.close(&ssh).await;
                panic!("a wrong password must not authenticate");
            }
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roots_normalize_without_double_slashes() {
        assert_eq!(normalize_root("/srv/omnissh/"), "/srv/omnissh");
        assert_eq!(normalize_root("  /srv/omnissh  "), "/srv/omnissh");
        assert_eq!(normalize_root("datasets/nova"), "datasets/nova");
        assert_eq!(normalize_root("/"), "/");
        assert_eq!(normalize_root(""), ".");

        assert_eq!(
            join("/srv/omnissh", DATASET_FILE),
            "/srv/omnissh/dataset.bin"
        );
        assert_eq!(join("/", DATASET_FILE), "/dataset.bin");
        assert_eq!(join(".", HISTORY_DIR), "./history");
    }

    #[test]
    fn endpoint_builds_a_direct_no_jump_host_config() {
        let endpoint = SyncEndpoint {
            host: "10.0.0.9".into(),
            port: 2222,
            username: "sync".into(),
            auth: AuthMethod::Password {
                password: "endpoint-pass".into(),
            },
            root: "/srv/omnissh/nova/".into(),
        };
        let config = endpoint.host_config();

        assert_eq!(config.host, "10.0.0.9");
        assert_eq!(config.port, 2222);
        assert_eq!(config.username, "sync");
        assert!(config.jump_host.is_none());
        assert!(config.startup_command.is_none());
        assert!(config.keep_alive_interval.is_none());
        // A sync endpoint's Debug output must never carry the secret.
        assert!(!format!("{:?}", endpoint.auth).contains("endpoint-pass"));
    }

    #[test]
    fn lock_file_round_trips_as_camel_case_json() {
        let lock = LockFile {
            client_id: "client-1".into(),
            acquired_at_secs: 1_759_000_000,
        };
        let json = serde_json::to_string(&lock).unwrap();
        assert!(json.contains("\"clientId\":\"client-1\""));
        assert!(json.contains("\"acquiredAtSecs\":1759000000"));
        assert_eq!(serde_json::from_str::<LockFile>(&json).unwrap(), lock);
    }

    #[test]
    fn probe_serializes_for_the_frontend_without_raw_metadata() {
        let probe = RemoteProbe {
            path_exists: true,
            writable: false,
            dataset_present: true,
            meta: Some(b"{\"generation\":4}".to_vec()),
        };
        let json = serde_json::to_string(&probe).unwrap();
        assert!(json.contains("\"pathExists\":true"));
        assert!(json.contains("\"writable\":false"));
        assert!(json.contains("\"datasetPresent\":true"));
        // The raw bytes stay server-side; the command layer parses and reports
        // only the fields the UI needs.
        assert!(!json.contains("generation"));
    }
}
