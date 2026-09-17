/*
 * Tauri commands for server-to-server (relay) transfers.
 *
 * Thin wrappers over [`RelayManager`] following the SFTP/SCP transfer command
 * surface so the frontend's transfers UI can drive relay jobs identically.
 */

use std::sync::Arc;

use tauri::State;
use tracing::instrument;

use super::{RelayManager, RelayTransferEvent};
use crate::sftp::SftpError;

/// Queue a copy of `paths` from one SFTP session into `dst_dir` on another.
#[tauri::command]
#[instrument(skip(state, paths), fields(count = paths.len()))]
pub async fn relay_transfer_entries(
    src_session_id: String,
    src_transport: String,
    dst_session_id: String,
    dst_transport: String,
    paths: Vec<String>,
    dst_dir: String,
    state: State<'_, Arc<RelayManager>>,
) -> Result<Vec<String>, SftpError> {
    state
        .enqueue(
            src_session_id,
            src_transport,
            dst_session_id,
            dst_transport,
            paths,
            dst_dir,
        )
        .await
}

/// Snapshot of every known relay job (active and finished).
#[tauri::command]
#[instrument(skip(state))]
pub async fn relay_list_transfers(
    state: State<'_, Arc<RelayManager>>,
) -> Result<Vec<RelayTransferEvent>, SftpError> {
    Ok(state.list_all())
}

#[tauri::command]
#[instrument(skip(state), fields(transfer_id = %transfer_id))]
pub async fn relay_cancel_transfer(
    transfer_id: String,
    state: State<'_, Arc<RelayManager>>,
) -> Result<(), SftpError> {
    state.cancel(&transfer_id)
}

#[tauri::command]
#[instrument(skip(state), fields(transfer_id = %transfer_id))]
pub async fn relay_retry_transfer(
    transfer_id: String,
    state: State<'_, Arc<RelayManager>>,
) -> Result<(), SftpError> {
    state.retry(&transfer_id)
}

#[tauri::command]
#[instrument(skip(state))]
pub async fn relay_clear_finished_transfers(
    state: State<'_, Arc<RelayManager>>,
) -> Result<(), SftpError> {
    state.clear_finished();
    Ok(())
}
