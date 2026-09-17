/*
 * Server-to-server (relay) file copies.
 *
 * Copies entries from one explorer session directly into a directory on
 * another, streaming bytes between the two sessions without staging to local
 * disk. Mirrors the SFTP transfer manager's queue/cancel/history machinery and
 * reuses `transfer_common` for progress throttling and finished-history
 * bounding, emitting `relay:transfer` events the frontend folds into the shared
 * transfers popover.
 *
 * Scope: both endpoints must be SFTP. SCP has no random-access file stream (it
 * drives `scp -f`/`scp -t` against a local path), so a relay involving an SCP
 * fallback is rejected with an actionable error rather than half-working.
 */

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use russh_sftp::protocol::{FileType, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::sftp::{validate_remote_name, SftpError, SftpManager};
use crate::transfer_common::{
    eta_secs, record_finished, record_progress, FinishedStatus, ProgressFields,
};

pub mod commands;

// ─── Constants ───────────────────────────────────────────────────────────────

const CHUNK_SIZE: usize = 256 * 1024; // 256 KB
const EVENT_NAME: &str = "relay:transfer";
const MAX_CONCURRENT: u32 = 3;

/// Shared handle to a live SFTP session.
type SftpHandle = Arc<tokio::sync::Mutex<russh_sftp::client::SftpSession>>;

// ─── Wire types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RelayStatus {
    Queued,
    InProgress,
    Completed,
    Failed(String),
    Cancelled,
}

/// Event payload emitted on the `relay:transfer` channel. Shape-matched to the
/// SFTP/SCP/S3 transfer events so the frontend can reuse one store, with the
/// two session ids naming both ends of the copy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayTransferEvent {
    pub transfer_id: String,
    pub src_session_id: String,
    pub src_transport: String,
    pub dst_session_id: String,
    pub dst_transport: String,
    pub name: String,
    /// Always `"Relay"` — distinguishes server-to-server from upload/download.
    pub direction: String,
    pub status: RelayStatus,
    pub error: Option<String>,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub speed_bps: u64,
    pub eta_secs: Option<u64>,
    pub created_at: u64,
}

// ─── Job state ───────────────────────────────────────────────────────────────

pub struct RelayJobState {
    pub transfer_id: String,
    pub src_session_id: String,
    pub src_transport: String,
    pub dst_session_id: String,
    pub dst_transport: String,
    pub name: String,
    pub paths: Vec<String>,
    pub dst_dir: String,
    pub status: RelayStatus,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub speed_bps: u64,
    pub cancel_token: CancellationToken,
    pub error: Option<String>,
    pub created_at: u64,
    pub last_emit: Instant,
    pub speed_window_bytes: u64,
    pub speed_window_start: Instant,
}

/// Owned copy of a job's descriptor, so the DashMap guard is released before
/// the (long) copy runs.
pub struct RelayDesc {
    pub src_session_id: String,
    pub dst_session_id: String,
    pub paths: Vec<String>,
    pub dst_dir: String,
}

impl RelayJobState {
    fn desc(&self) -> RelayDesc {
        RelayDesc {
            src_session_id: self.src_session_id.clone(),
            dst_session_id: self.dst_session_id.clone(),
            paths: self.paths.clone(),
            dst_dir: self.dst_dir.clone(),
        }
    }

    fn to_event(&self) -> RelayTransferEvent {
        RelayTransferEvent {
            transfer_id: self.transfer_id.clone(),
            src_session_id: self.src_session_id.clone(),
            src_transport: self.src_transport.clone(),
            dst_session_id: self.dst_session_id.clone(),
            dst_transport: self.dst_transport.clone(),
            name: self.name.clone(),
            direction: "Relay".to_string(),
            status: self.status.clone(),
            error: self.error.clone(),
            bytes_transferred: self.bytes_transferred,
            total_bytes: self.total_bytes,
            files_done: self.files_done,
            files_total: self.files_total,
            speed_bps: self.speed_bps,
            eta_secs: eta_secs(self.speed_bps, self.total_bytes, self.bytes_transferred),
            created_at: self.created_at,
        }
    }
}

impl ProgressFields for RelayJobState {
    fn bytes_transferred(&mut self) -> &mut u64 {
        &mut self.bytes_transferred
    }
    fn speed_bps(&mut self) -> &mut u64 {
        &mut self.speed_bps
    }
    fn speed_window_bytes(&mut self) -> &mut u64 {
        &mut self.speed_window_bytes
    }
    fn speed_window_start(&mut self) -> &mut Instant {
        &mut self.speed_window_start
    }
    fn last_emit(&mut self) -> &mut Instant {
        &mut self.last_emit
    }
}

impl FinishedStatus for RelayJobState {
    fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            RelayStatus::Completed | RelayStatus::Failed(_) | RelayStatus::Cancelled
        )
    }
}

// ─── Manager ─────────────────────────────────────────────────────────────────

pub struct RelayManager {
    jobs: Arc<DashMap<String, RelayJobState>>,
    finished_order: Arc<Mutex<VecDeque<String>>>,
    queue_tx: mpsc::UnboundedSender<String>,
    semaphore: Arc<Semaphore>,
    sftp_manager: Arc<SftpManager>,
    app_handle: AppHandle,
    worker_rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<String>>>>,
}

impl RelayManager {
    pub fn new(sftp_manager: Arc<SftpManager>, app_handle: AppHandle) -> Self {
        let (queue_tx, queue_rx) = mpsc::unbounded_channel::<String>();
        Self {
            jobs: Arc::new(DashMap::new()),
            finished_order: Arc::new(Mutex::new(VecDeque::new())),
            queue_tx,
            semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT as usize)),
            sftp_manager,
            app_handle,
            worker_rx: Arc::new(Mutex::new(Some(queue_rx))),
        }
    }

    /// Spawn the worker loop lazily — `new()` runs inside Tauri's `.setup()`
    /// where no tokio runtime is active yet.
    fn ensure_worker_spawned(&self) {
        let mut guard = self.worker_rx.lock().expect("relay worker_rx poisoned");
        if let Some(mut queue_rx) = guard.take() {
            let jobs = self.jobs.clone();
            let finished_order = self.finished_order.clone();
            let semaphore = self.semaphore.clone();
            let sftp_manager = self.sftp_manager.clone();
            let app_handle = self.app_handle.clone();

            tokio::spawn(async move {
                while let Some(job_id) = queue_rx.recv().await {
                    let permit = semaphore
                        .clone()
                        .acquire_owned()
                        .await
                        .expect("relay semaphore closed");

                    let jobs = jobs.clone();
                    let finished_order = finished_order.clone();
                    let sftp_manager = sftp_manager.clone();
                    let app_handle = app_handle.clone();

                    tokio::spawn(async move {
                        execute_relay(&jobs, &finished_order, &job_id, &sftp_manager, &app_handle)
                            .await;
                        drop(permit);
                    });
                }
            });
        }
    }

    fn unix_now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Queue a server-to-server copy of `paths` into `dst_dir`. One job per
    /// source path, mirroring the SFTP manager's upload/download enqueue.
    #[instrument(skip(self, paths), fields(count = paths.len()))]
    pub async fn enqueue(
        &self,
        src_session_id: String,
        src_transport: String,
        dst_session_id: String,
        dst_transport: String,
        paths: Vec<String>,
        dst_dir: String,
    ) -> Result<Vec<String>, SftpError> {
        if src_transport != "sftp" || dst_transport != "sftp" {
            return Err(SftpError::ProtocolError(
                "Server-to-server copy requires the SFTP subsystem on both hosts; \
                 the SCP fallback cannot stream between two servers."
                    .to_string(),
            ));
        }
        if paths.is_empty() {
            return Ok(Vec::new());
        }
        self.ensure_worker_spawned();

        // Clone the session handles so no DashMap guard is held across awaits.
        let src: SftpHandle = {
            let session = self.sftp_manager.get_session(&src_session_id)?;
            session.sftp.clone()
        };
        {
            // Fail fast when the destination session is gone.
            let _ = self.sftp_manager.get_session(&dst_session_id)?;
        }

        let mut ids = Vec::with_capacity(paths.len());
        for path in paths {
            let meta = {
                let sftp = src.lock().await;
                sftp.metadata(&path)
                    .await
                    .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
            };
            let name = path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&path)
                .to_string();
            let (total_bytes, files_total) = if meta.file_type() == FileType::Dir {
                walk_remote_stats(&src, &path).await
            } else {
                (meta.size.unwrap_or(0), 1)
            };

            let transfer_id = uuid::Uuid::new_v4().to_string();
            let now = Instant::now();
            let job = RelayJobState {
                transfer_id: transfer_id.clone(),
                src_session_id: src_session_id.clone(),
                src_transport: src_transport.clone(),
                dst_session_id: dst_session_id.clone(),
                dst_transport: dst_transport.clone(),
                name,
                paths: vec![path],
                dst_dir: dst_dir.clone(),
                status: RelayStatus::Queued,
                bytes_transferred: 0,
                total_bytes,
                files_done: 0,
                files_total,
                speed_bps: 0,
                cancel_token: CancellationToken::new(),
                error: None,
                created_at: Self::unix_now_millis(),
                last_emit: now,
                speed_window_bytes: 0,
                speed_window_start: now,
            };
            self.jobs.insert(transfer_id.clone(), job);
            if let Some(job) = self.jobs.get(&transfer_id) {
                let _ = self.app_handle.emit(EVENT_NAME, job.to_event());
            }

            self.queue_tx
                .send(transfer_id.clone())
                .map_err(|e| SftpError::ChannelError(e.to_string()))?;
            ids.push(transfer_id);
        }

        Ok(ids)
    }

    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn cancel(&self, transfer_id: &str) -> Result<(), SftpError> {
        let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
            SftpError::SessionNotFound(format!("relay transfer not found: {transfer_id}"))
        })?;
        job.cancel_token.cancel();
        if job.status == RelayStatus::Queued {
            job.status = RelayStatus::Cancelled;
            let event = job.to_event();
            drop(job);
            let _ = self.app_handle.emit(EVENT_NAME, event);
            record_finished(&self.jobs, &self.finished_order, transfer_id);
        }
        Ok(())
    }

    #[instrument(skip(self), fields(transfer_id = %transfer_id))]
    pub fn retry(&self, transfer_id: &str) -> Result<(), SftpError> {
        self.ensure_worker_spawned();
        {
            let mut job = self.jobs.get_mut(transfer_id).ok_or_else(|| {
                SftpError::SessionNotFound(format!("relay transfer not found: {transfer_id}"))
            })?;
            match &job.status {
                RelayStatus::Failed(_) | RelayStatus::Cancelled => {}
                _ => {
                    return Err(SftpError::ProtocolError(format!(
                        "relay transfer {transfer_id} is not in a failed/cancelled state"
                    )));
                }
            }
            job.status = RelayStatus::Queued;
            job.bytes_transferred = 0;
            job.files_done = 0;
            job.speed_bps = 0;
            job.error = None;
            job.cancel_token = CancellationToken::new();
            job.last_emit = Instant::now();
            job.speed_window_bytes = 0;
            job.speed_window_start = Instant::now();

            let event = job.to_event();
            drop(job);
            let _ = self.app_handle.emit(EVENT_NAME, event);
        }

        self.queue_tx
            .send(transfer_id.to_string())
            .map_err(|e| SftpError::ChannelError(e.to_string()))?;
        Ok(())
    }

    pub fn list_all(&self) -> Vec<RelayTransferEvent> {
        self.jobs.iter().map(|r| r.value().to_event()).collect()
    }

    pub fn clear_finished(&self) {
        self.jobs.retain(|_, job| !job.is_terminal());
    }
}

// ─── Execution ───────────────────────────────────────────────────────────────

async fn execute_relay(
    jobs: &Arc<DashMap<String, RelayJobState>>,
    finished_order: &Arc<Mutex<VecDeque<String>>>,
    job_id: &str,
    sftp_manager: &Arc<SftpManager>,
    app_handle: &AppHandle,
) {
    let (desc, cancel_token) = match jobs.get(job_id) {
        Some(job) => (job.desc(), job.cancel_token.clone()),
        None => return,
    };

    if cancel_token.is_cancelled() {
        set_job_status(
            jobs,
            finished_order,
            job_id,
            RelayStatus::Cancelled,
            None,
            app_handle,
        );
        return;
    }
    set_job_status(
        jobs,
        finished_order,
        job_id,
        RelayStatus::InProgress,
        None,
        app_handle,
    );

    // Resolve both endpoints once; a missing session fails the whole job.
    let src: SftpHandle = match sftp_manager.get_session(&desc.src_session_id) {
        Ok(session) => session.sftp.clone(),
        Err(e) => {
            set_job_status(
                jobs,
                finished_order,
                job_id,
                RelayStatus::Failed(e.to_string()),
                Some(e.to_string()),
                app_handle,
            );
            return;
        }
    };
    let dst: SftpHandle = match sftp_manager.get_session(&desc.dst_session_id) {
        Ok(session) => session.sftp.clone(),
        Err(e) => {
            set_job_status(
                jobs,
                finished_order,
                job_id,
                RelayStatus::Failed(e.to_string()),
                Some(e.to_string()),
                app_handle,
            );
            return;
        }
    };

    let result = run_relay(jobs, job_id, &src, &dst, &desc, &cancel_token, app_handle).await;

    match result {
        Ok(()) => set_job_status(
            jobs,
            finished_order,
            job_id,
            RelayStatus::Completed,
            None,
            app_handle,
        ),
        Err(SftpError::TransferCancelled) => set_job_status(
            jobs,
            finished_order,
            job_id,
            RelayStatus::Cancelled,
            None,
            app_handle,
        ),
        Err(e) => set_job_status(
            jobs,
            finished_order,
            job_id,
            RelayStatus::Failed(e.to_string()),
            Some(e.to_string()),
            app_handle,
        ),
    }
}

async fn run_relay(
    jobs: &Arc<DashMap<String, RelayJobState>>,
    job_id: &str,
    src: &SftpHandle,
    dst: &SftpHandle,
    desc: &RelayDesc,
    cancel_token: &CancellationToken,
    app_handle: &AppHandle,
) -> Result<(), SftpError> {
    let ctx = CopyCtx {
        jobs,
        job_id,
        src,
        dst,
        cancel_token,
        app_handle,
    };
    let dst_dir = desc.dst_dir.trim_end_matches('/').to_string();
    for src_path in &desc.paths {
        if cancel_token.is_cancelled() {
            return Err(SftpError::TransferCancelled);
        }
        let name = src_path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(src_path);
        let safe_name = validate_remote_name(name)?;
        let dst_path = join_path(&dst_dir, safe_name);
        Box::pin(copy_path(&ctx, src_path, &dst_path)).await?;
    }
    Ok(())
}

/// Everything a recursive copy needs, bundled so the recursion doesn't thread
/// seven separate arguments through every level.
struct CopyCtx<'a> {
    jobs: &'a Arc<DashMap<String, RelayJobState>>,
    job_id: &'a str,
    src: &'a SftpHandle,
    dst: &'a SftpHandle,
    cancel_token: &'a CancellationToken,
    app_handle: &'a AppHandle,
}

/// Recursively copy one source entry (file or directory) to `dst_path`.
async fn copy_path(ctx: &CopyCtx<'_>, src_path: &str, dst_path: &str) -> Result<(), SftpError> {
    if ctx.cancel_token.is_cancelled() {
        return Err(SftpError::TransferCancelled);
    }

    let meta = {
        let sftp = ctx.src.lock().await;
        sftp.metadata(src_path)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
    };

    if meta.file_type() == FileType::Dir {
        {
            let sftp = ctx.dst.lock().await;
            remote_mkdir_p(&sftp, dst_path).await?;
        }
        let entries = {
            let sftp = ctx.src.lock().await;
            sftp.read_dir(src_path)
                .await
                .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
        };
        for entry in entries {
            let child_name = entry.file_name();
            if child_name == "." || child_name == ".." {
                continue;
            }
            // Server-supplied names must never be trusted when building paths.
            let safe = validate_remote_name(&child_name)?;
            let child_src = join_path(src_path, safe);
            let child_dst = join_path(dst_path, safe);
            Box::pin(copy_path(ctx, &child_src, &child_dst)).await?;
        }
        return Ok(());
    }

    // Ensure the destination parent exists, then stream the file.
    if let Some(parent) = parent_path(dst_path) {
        let sftp = ctx.dst.lock().await;
        remote_mkdir_p(&sftp, &parent).await?;
    }

    let mut reader = {
        let sftp = ctx.src.lock().await;
        sftp.open(src_path)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
    };
    let mut writer = {
        let sftp = ctx.dst.lock().await;
        sftp.open_with_flags(
            dst_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
    };

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut written: u64 = 0;
    loop {
        if ctx.cancel_token.is_cancelled() {
            let _ = writer.shutdown().await;
            return Err(SftpError::TransferCancelled);
        }
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
        written += n as u64;
        update_progress(ctx.jobs, ctx.job_id, n as u64, ctx.app_handle);
    }

    writer
        .flush()
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;
    // The close is where the server commits the final writes. A failure here
    // means the destination cannot be trusted, so the job must not report
    // success — mirror the upload paths, which propagate close errors too.
    writer
        .shutdown()
        .await
        .map_err(|e| SftpError::RemoteIoError(e.to_string()))?;

    // Confirm the bytes actually landed. Reporting Completed while the
    // destination is empty or short is worse than reporting a failure.
    let landed = {
        let sftp = ctx.dst.lock().await;
        sftp.metadata(dst_path)
            .await
            .map_err(|e| SftpError::RemoteIoError(e.to_string()))?
    };
    if landed.file_type() == FileType::Dir || landed.size.unwrap_or(0) != written {
        return Err(SftpError::RemoteIoError(format!(
            "destination verification failed for {dst_path}: copied {written} bytes but the server reports {}",
            landed.size.unwrap_or(0)
        )));
    }

    mark_file_done(ctx.jobs, ctx.job_id, ctx.app_handle);
    Ok(())
}

// ─── Status helpers ──────────────────────────────────────────────────────────

fn set_job_status(
    jobs: &Arc<DashMap<String, RelayJobState>>,
    finished_order: &Arc<Mutex<VecDeque<String>>>,
    job_id: &str,
    status: RelayStatus,
    error: Option<String>,
    app_handle: &AppHandle,
) {
    let Some(mut job) = jobs.get_mut(job_id) else {
        return;
    };
    // A terminal status is final — never overwrite it (a cancel racing the
    // worker would otherwise double-emit and double-record).
    if job.is_terminal() {
        return;
    }
    job.status = status;
    job.error = error;
    let event = job.to_event();
    let is_terminal = job.is_terminal();
    // Drop the shard guard before record_finished, which re-enters the map.
    drop(job);

    let _ = app_handle.emit(EVENT_NAME, event);
    if is_terminal {
        record_finished(jobs, finished_order, job_id);
    }
}

fn update_progress(
    jobs: &Arc<DashMap<String, RelayJobState>>,
    job_id: &str,
    new_bytes: u64,
    app_handle: &AppHandle,
) {
    if let Some(mut job) = jobs.get_mut(job_id) {
        let should_emit = record_progress(&mut *job, new_bytes);
        if should_emit {
            let event = job.to_event();
            drop(job);
            let _ = app_handle.emit(EVENT_NAME, event);
        }
    }
}

fn mark_file_done(
    jobs: &Arc<DashMap<String, RelayJobState>>,
    job_id: &str,
    app_handle: &AppHandle,
) {
    if let Some(mut job) = jobs.get_mut(job_id) {
        job.files_done += 1;
        let event = job.to_event();
        drop(job);
        let _ = app_handle.emit(EVENT_NAME, event);
    }
}

// ─── Path helpers ────────────────────────────────────────────────────────────

fn join_path(base: &str, name: &str) -> String {
    if base.is_empty() || base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

fn parent_path(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => Some("/".to_string()),
        Some(i) => Some(trimmed[..i].to_string()),
        None => None,
    }
}

async fn remote_mkdir_p(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> Result<(), SftpError> {
    let mut current = String::new();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        current = format!("{current}/{seg}");
        match sftp.create_dir(&current).await {
            Ok(()) => {}
            Err(_) => match sftp.metadata(&current).await {
                Ok(attrs) if attrs.file_type() == FileType::Dir => {}
                _ => {
                    return Err(SftpError::RemoteIoError(format!(
                        "failed to create remote directory: {current}"
                    )));
                }
            },
        }
    }
    Ok(())
}

/// Recursively total (bytes, files) for a source directory, cycle-guarded by
/// visited path so a symlink loop cannot hang the enqueue.
async fn walk_remote_stats(sftp_arc: &SftpHandle, path: &str) -> (u64, u32) {
    let mut visited = HashSet::new();
    Box::pin(walk_remote_stats_inner(sftp_arc, path, &mut visited)).await
}

async fn walk_remote_stats_inner(
    sftp_arc: &SftpHandle,
    path: &str,
    visited: &mut HashSet<String>,
) -> (u64, u32) {
    if !visited.insert(path.to_string()) {
        return (0, 0);
    }
    let entries = {
        let sftp = sftp_arc.lock().await;
        match sftp.read_dir(path).await {
            Ok(entries) => entries,
            Err(e) => {
                tracing::warn!(error = %e, "relay stat walk: read_dir failed; subtree undercounted");
                return (0, 0);
            }
        }
    };

    let mut total_bytes: u64 = 0;
    let mut file_count: u32 = 0;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let full_path = join_path(path, &name);
        if entry.metadata().file_type() == FileType::Dir {
            let (b, c) = Box::pin(walk_remote_stats_inner(sftp_arc, &full_path, visited)).await;
            total_bytes += b;
            file_count += c;
        } else {
            total_bytes += entry.metadata().size.unwrap_or(0);
            file_count += 1;
        }
    }
    (total_bytes, file_count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_path_handles_root_and_trailing_slashes() {
        assert_eq!(join_path("/", "etc"), "/etc");
        assert_eq!(join_path("", "etc"), "/etc");
        assert_eq!(join_path("/var/", "log"), "/var/log");
        assert_eq!(join_path("/var/www", "index.html"), "/var/www/index.html");
    }

    #[test]
    fn parent_path_handles_root_and_top_level() {
        assert_eq!(parent_path("/etc/hosts"), Some("/etc".to_string()));
        assert_eq!(parent_path("/etc"), Some("/".to_string()));
        assert_eq!(parent_path("relative"), None);
    }

    #[test]
    fn relay_job_event_carries_both_sessions() {
        let now = Instant::now();
        let job = RelayJobState {
            transfer_id: "t1".to_string(),
            src_session_id: "src".to_string(),
            src_transport: "sftp".to_string(),
            dst_session_id: "dst".to_string(),
            dst_transport: "sftp".to_string(),
            name: "file.txt".to_string(),
            paths: vec!["/a/file.txt".to_string()],
            dst_dir: "/b".to_string(),
            status: RelayStatus::InProgress,
            bytes_transferred: 10,
            total_bytes: 100,
            files_done: 0,
            files_total: 1,
            speed_bps: 5,
            cancel_token: CancellationToken::new(),
            error: None,
            created_at: 0,
            last_emit: now,
            speed_window_bytes: 0,
            speed_window_start: now,
        };
        let event = job.to_event();
        assert_eq!(event.direction, "Relay");
        assert_eq!(event.src_session_id, "src");
        assert_eq!(event.dst_session_id, "dst");
        assert_eq!(event.eta_secs, Some(18));
        assert!(!job.is_terminal());
    }
}
