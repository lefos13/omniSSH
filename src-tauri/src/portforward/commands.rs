use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use crate::db::{DbError, HostDb};
use crate::ssh::manager::SshManager;

use super::{manager::PortForwardManager, ForwardType, PortForwardRule, TunnelStatus};

// ─── CRUD ────────────────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(db))]
#[allow(clippy::too_many_arguments)]
pub async fn pf_create_rule(
    host_id: Option<String>,
    label: Option<String>,
    description: Option<String>,
    forward_type: String,
    bind_address: String,
    local_port: u32,
    remote_host: String,
    remote_port: u32,
    auto_start: bool,
    db: State<'_, Arc<HostDb>>,
) -> Result<PortForwardRule, DbError> {
    let id = uuid::Uuid::new_v4().to_string();
    let db = Arc::clone(&db);

    let c_id = id.clone();
    let c_host_id = host_id.clone();
    let c_label = label.clone();
    let c_desc = description.clone();
    let c_ft = forward_type.clone();
    let c_bind = bind_address.clone();
    let c_rhost = remote_host.clone();

    task::spawn_blocking(move || {
        db.create_pf_rule(
            &c_id,
            c_host_id.as_deref(),
            c_label.as_deref(),
            c_desc.as_deref(),
            &c_ft,
            &c_bind,
            local_port,
            &c_rhost,
            remote_port,
            auto_start,
        )
    })
    .await
    .map_err(|e| DbError::InitError(format!("task panicked: {e}")))??;

    crate::telemetry::capture(
        "tunnel_rule_created",
        serde_json::json!({ "auto_start": auto_start }),
    );
    Ok(PortForwardRule {
        id,
        host_id,
        label,
        description,
        forward_type: ForwardType::from_str(&forward_type),
        bind_address,
        local_port,
        remote_host,
        remote_port,
        auto_start,
        enabled: true,
        last_used_at: None,
        total_bytes: 0,
        created_at: String::new(),
    })
}

#[tauri::command]
#[instrument(skip(db))]
#[allow(clippy::too_many_arguments)]
pub async fn pf_update_rule(
    id: String,
    label: Option<String>,
    description: Option<String>,
    bind_address: String,
    local_port: u32,
    remote_host: String,
    remote_port: u32,
    auto_start: bool,
    db: State<'_, Arc<HostDb>>,
) -> Result<(), DbError> {
    let db = Arc::clone(&db);
    task::spawn_blocking(move || {
        db.update_pf_rule(
            &id,
            label.as_deref(),
            description.as_deref(),
            &bind_address,
            local_port,
            &remote_host,
            remote_port,
            auto_start,
        )
    })
    .await
    .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

#[tauri::command]
#[instrument(skip(db))]
pub async fn pf_delete_rule(id: String, db: State<'_, Arc<HostDb>>) -> Result<(), DbError> {
    let db = Arc::clone(&db);
    let result = task::spawn_blocking(move || db.delete_pf_rule(&id))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?;
    if result.is_ok() {
        crate::telemetry::capture("tunnel_rule_deleted", serde_json::json!({}));
    }
    result
}

#[tauri::command]
#[instrument(skip(db))]
pub async fn pf_list_rules(
    host_id: Option<String>,
    db: State<'_, Arc<HostDb>>,
) -> Result<Vec<PortForwardRule>, DbError> {
    let db = Arc::clone(&db);
    task::spawn_blocking(move || db.list_pf_rules(host_id.as_deref()))
        .await
        .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?
}

// ─── Tunnel control ──────────────────────────────────────────────────────────

#[tauri::command]
#[instrument(skip(pf_manager, ssh_manager, db, local_vault))]
#[allow(clippy::too_many_arguments)]
pub async fn pf_start_tunnel(
    rule_id: String,
    host_id: String,
    bind_address: String,
    local_port: u32,
    remote_host: String,
    remote_port: u32,
    pf_manager: State<'_, Arc<PortForwardManager>>,
    ssh_manager: State<'_, SshManager>,
    db: State<'_, Arc<HostDb>>,
    local_vault: State<'_, Arc<crate::vault::LocalVault>>,
) -> Result<TunnelStatus, crate::types::SshError> {
    /* Resolve the tunnel host through the same backend-only path as terminal
     * and SFTP connections. This keeps local-vault hosts fail-closed while
     * retaining keychain fallback for legacy/keychain hosts. */
    let db_clone = Arc::clone(&db);
    let local_vault_clone = Arc::clone(&local_vault);
    let host_id_for_config = host_id.clone();
    let config = task::spawn_blocking(move || {
        crate::ssh::commands::build_host_config_blocking(
            &host_id_for_config,
            &db_clone,
            &local_vault_clone,
            &mut Vec::new(),
        )
    })
    .await
    .map_err(|e| crate::types::SshError::IoError(format!("task panicked: {e}")))??;

    let session_id = ssh_manager.connect_no_pty(config, None).await?;
    let handle = ssh_manager.get_handle(&session_id.0)?;

    // Record last_used_at
    let db_clone = Arc::clone(&db);
    let rid = rule_id.clone();
    let _ = task::spawn_blocking(move || db_clone.touch_pf_rule(&rid)).await;

    let status = pf_manager
        .start_tunnel(
            rule_id,
            handle,
            bind_address,
            local_port,
            remote_host,
            remote_port,
        )
        .await?;

    crate::telemetry::capture("tunnel_started", serde_json::json!({}));

    Ok(status)
}

#[tauri::command]
#[instrument(skip(pf_manager))]
pub async fn pf_stop_tunnel(
    rule_id: String,
    pf_manager: State<'_, Arc<PortForwardManager>>,
) -> Result<(), crate::types::SshError> {
    let result = pf_manager.stop_tunnel(&rule_id);
    if result.is_ok() {
        crate::telemetry::capture("tunnel_stopped", serde_json::json!({}));
    }
    result
}

#[tauri::command]
#[instrument(skip(pf_manager))]
pub async fn pf_list_active_tunnels(
    pf_manager: State<'_, Arc<PortForwardManager>>,
) -> Result<Vec<TunnelStatus>, crate::types::SshError> {
    Ok(pf_manager.list_active())
}
