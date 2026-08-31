use crate::types::{
    AuthMethod, ConnectionStatus, HostConfig, SessionId, SshError, SshStatusPayload,
};
use dashmap::DashMap;
use russh::client;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;
use tracing::info;

use super::handler::SshClientHandler;
use super::session::SshSession;

/// The target handle plus the chain of jump-host handles that must outlive it
/// (deepest hop first, empty for a direct connection).
type EstablishedConn = (
    client::Handle<SshClientHandler>,
    Vec<client::Handle<SshClientHandler>>,
);

/// Boxed, `Send` future for the recursive [`SshManager::establish`]. Boxing is
/// required because the recursion makes the future type self-referential.
type EstablishFuture<'a> =
    Pin<Box<dyn Future<Output = Result<EstablishedConn, SshError>> + Send + 'a>>;

/// A bare (PTY-less) SSH connection used by the SFTP layer.
struct BareConn {
    /// The authenticated target handle, shared with the SFTP layer.
    handle: Arc<tokio::sync::Mutex<client::Handle<SshClientHandler>>>,
    /// When the target is reached through a ProxyJump chain, the jump-host
    /// handles (one per hop) are stored here so the tunnel underneath stays
    /// open. They are never locked — merely keeping them alive prevents russh
    /// from tearing down the tunnel.
    _jump_handles: Vec<client::Handle<SshClientHandler>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ProtocolSessionKind {
    Sftp,
    Scp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SessionOwnership {
    ssh_session_id: String,
    owns_ssh: bool,
}

#[derive(Debug, Default)]
struct ConnectionOwnership {
    explorer_owned: bool,
}

/*
 * Keep one registry for every protocol session riding an SSH connection.
 * Per-transport inheritance remains intact, while final-reference decisions
 * retain explorer ownership even when the owning channel closes first.
 */
#[derive(Debug, Default)]
struct SessionOwnershipBook {
    sessions: HashMap<(ProtocolSessionKind, String), SessionOwnership>,
    connections: HashMap<String, ConnectionOwnership>,
    disconnecting: HashMap<String, DisconnectLifecycle>,
    in_flight_opens: HashMap<String, usize>,
}

#[derive(Debug, Default)]
struct DisconnectLifecycle {
    teardown_complete: bool,
}

impl SessionOwnershipBook {
    fn record(
        &mut self,
        protocol: ProtocolSessionKind,
        protocol_session_id: String,
        ssh_session_id: String,
        requested: Option<bool>,
    ) -> Option<SessionOwnership> {
        if self.disconnecting.contains_key(&ssh_session_id) {
            return None;
        }
        let owns_ssh = requested == Some(true)
            || self.sessions.iter().any(|((kind, _), record)| {
                *kind == protocol && record.ssh_session_id == ssh_session_id && record.owns_ssh
            });
        let record = SessionOwnership {
            ssh_session_id: ssh_session_id.clone(),
            owns_ssh,
        };
        self.sessions
            .insert((protocol, protocol_session_id), record.clone());
        self.connections
            .entry(ssh_session_id)
            .or_default()
            .explorer_owned |= owns_ssh;
        Some(record)
    }

    fn has_ssh_session(&self, ssh_session_id: &str) -> bool {
        self.sessions
            .values()
            .any(|record| record.ssh_session_id == ssh_session_id)
    }

    fn remove(
        &mut self,
        protocol: ProtocolSessionKind,
        protocol_session_id: &str,
    ) -> Option<(SessionOwnership, bool)> {
        let record = self
            .sessions
            .remove(&(protocol, protocol_session_id.to_string()))?;
        let ssh_session_id = record.ssh_session_id.clone();
        let has_references = self.has_ssh_session(&ssh_session_id);
        let explorer_owned = self
            .connections
            .get(&ssh_session_id)
            .map(|connection| connection.explorer_owned)
            .unwrap_or(record.owns_ssh);
        let should_disconnect =
            !self.disconnecting.contains_key(&ssh_session_id) && explorer_owned && !has_references;
        if should_disconnect {
            self.mark_disconnecting(ssh_session_id.clone());
        }
        if !has_references {
            self.connections.remove(&ssh_session_id);
        }
        Some((record, should_disconnect))
    }

    fn begin_open(&mut self, ssh_session_id: &str) -> bool {
        if self.disconnecting.contains_key(ssh_session_id) {
            return false;
        }
        *self
            .in_flight_opens
            .entry(ssh_session_id.to_string())
            .or_default() += 1;
        true
    }

    fn finish_open(&mut self, ssh_session_id: &str) {
        let Some(count) = self.in_flight_opens.get_mut(ssh_session_id) else {
            return;
        };
        *count -= 1;
        if *count > 0 {
            return;
        }
        self.in_flight_opens.remove(ssh_session_id);
        self.prune_disconnecting(ssh_session_id);
    }

    fn mark_disconnecting(&mut self, ssh_session_id: String) {
        self.disconnecting.entry(ssh_session_id).or_default();
    }

    fn complete_disconnect(&mut self, ssh_session_id: &str) {
        if let Some(lifecycle) = self.disconnecting.get_mut(ssh_session_id) {
            lifecycle.teardown_complete = true;
        }
        self.prune_disconnecting(ssh_session_id);
    }

    fn prune_disconnecting(&mut self, ssh_session_id: &str) {
        let no_in_flight_opens = !self.in_flight_opens.contains_key(ssh_session_id);
        let teardown_complete = self
            .disconnecting
            .get(ssh_session_id)
            .is_some_and(|lifecycle| lifecycle.teardown_complete);
        if no_in_flight_opens && teardown_complete {
            self.disconnecting.remove(ssh_session_id);
        }
    }

    fn remove_sessions_for_ssh(&mut self, ssh_session_id: &str) {
        self.sessions
            .retain(|_, record| record.ssh_session_id != ssh_session_id);
        self.connections.remove(ssh_session_id);
    }
}

/// Manages all active SSH sessions. Stored as Tauri managed state.
pub struct SshManager {
    sessions: DashMap<String, SshSession>,
    /// Bare SSH handles for SFTP-only connections (no PTY).
    bare_handles: DashMap<String, BareConn>,
    /// In-flight connection attempts, keyed by the frontend-supplied attempt ID.
    /// A handle exists here only while a `connect`/`connect_no_pty` call is
    /// running; cancelling its token aborts the attempt before any session is
    /// registered, so no ghost session or lingering handle is left behind.
    pending_connects: DashMap<String, CancellationToken>,
    /// Ownership and reference tracking shared by SFTP and SCP sessions.
    protocol_ownership: StdMutex<SessionOwnershipBook>,
}

/*
 * Count an async protocol handshake from handle lookup through manager
 * registration. A disconnect may finish the SSH teardown before that
 * handshake resumes, so the tombstone cannot be pruned until this guard drops.
 */
pub(crate) struct ProtocolOpenGuard<'a> {
    manager: &'a SshManager,
    ssh_session_id: String,
}

pub(crate) enum ProtocolOpenError<E, T> {
    Disconnecting,
    Prepare(E),
    Rejected(Option<T>),
}

/*
 * Bundle the lifecycle identity so the async coordinator stays explicit
 * without making every transport command pass a long positional argument
 * list.
 */
pub(crate) struct ProtocolOpenRequest {
    pub protocol: ProtocolSessionKind,
    pub protocol_session_id: String,
    pub ssh_session_id: String,
    pub requested: Option<bool>,
}

impl Drop for ProtocolOpenGuard<'_> {
    fn drop(&mut self) {
        self.manager.finish_protocol_open(&self.ssh_session_id);
    }
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: DashMap::new(),
            bare_handles: DashMap::new(),
            pending_connects: DashMap::new(),
            protocol_ownership: StdMutex::new(SessionOwnershipBook::default()),
        }
    }

    fn register_protocol_session(
        &self,
        protocol: ProtocolSessionKind,
        protocol_session_id: String,
        ssh_session_id: String,
        requested: Option<bool>,
    ) -> bool {
        let mut ownership = self
            .protocol_ownership
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ownership
            .record(protocol, protocol_session_id, ssh_session_id, requested)
            .is_some()
    }

    /*
     * Publish the protocol wrapper before taking the lifecycle decision. The
     * rollback callback is allowed to return None because an SSH disconnect
     * collector may have claimed the wrapper between publication and this
     * check; in that case the collector remains the sole cleanup owner.
     */
    fn publish_protocol_session<T, R, Publish, Rollback>(
        &self,
        protocol: ProtocolSessionKind,
        protocol_session_id: String,
        ssh_session_id: String,
        requested: Option<bool>,
        publish: Publish,
        rollback: Rollback,
    ) -> Result<R, Option<T>>
    where
        Publish: FnOnce() -> R,
        Rollback: FnOnce() -> Option<T>,
    {
        let result = publish();
        if self.register_protocol_session(protocol, protocol_session_id, ssh_session_id, requested)
        {
            Ok(result)
        } else {
            Err(rollback())
        }
    }

    pub(crate) fn mark_protocol_disconnecting(&self, ssh_session_id: &str) {
        let mut ownership = self
            .protocol_ownership
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ownership.mark_disconnecting(ssh_session_id.to_string());
    }

    pub(crate) fn complete_protocol_disconnect(&self, ssh_session_id: &str) {
        let mut ownership = self
            .protocol_ownership
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ownership.complete_disconnect(ssh_session_id);
    }

    fn begin_protocol_open(&self, ssh_session_id: &str) -> Option<ProtocolOpenGuard<'_>> {
        let mut ownership = self
            .protocol_ownership
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ownership
            .begin_open(ssh_session_id)
            .then_some(ProtocolOpenGuard {
                manager: self,
                ssh_session_id: ssh_session_id.to_string(),
            })
    }

    /*
     * Keep the lifecycle guard around the real asynchronous protocol setup.
     * Commands supply their transport-specific handshake and wrapper manager
     * callbacks, while this helper fixes the publish-before-register order.
     */
    pub(crate) async fn open_protocol_session<Prepare, T, E, R, Publish, Rollback>(
        &self,
        request: ProtocolOpenRequest,
        prepare: Prepare,
        publish: Publish,
        rollback: Rollback,
    ) -> Result<R, ProtocolOpenError<E, T>>
    where
        Prepare: Future<Output = Result<T, E>>,
        Publish: FnOnce(T) -> R,
        Rollback: FnOnce() -> Option<T>,
    {
        let Some(_protocol_open) = self.begin_protocol_open(&request.ssh_session_id) else {
            return Err(ProtocolOpenError::Disconnecting);
        };
        let wrapper = prepare.await.map_err(ProtocolOpenError::Prepare)?;
        self.publish_protocol_session(
            request.protocol,
            request.protocol_session_id,
            request.ssh_session_id,
            request.requested,
            || publish(wrapper),
            rollback,
        )
        .map_err(ProtocolOpenError::Rejected)
    }

    fn finish_protocol_open(&self, ssh_session_id: &str) {
        let mut ownership = self
            .protocol_ownership
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ownership.finish_open(ssh_session_id);
    }

    pub(crate) fn remove_protocol_session(
        &self,
        protocol: ProtocolSessionKind,
        protocol_session_id: &str,
    ) -> Option<bool> {
        let mut ownership = self
            .protocol_ownership
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ownership
            .remove(protocol, protocol_session_id)
            .map(|(_, should_disconnect)| should_disconnect)
    }

    pub(crate) fn remove_protocol_sessions_for_ssh(&self, ssh_session_id: &str) {
        let mut ownership = self
            .protocol_ownership
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        ownership.remove_sessions_for_ssh(ssh_session_id);
    }

    /// Register a cancellation token for an in-flight connection attempt and
    /// return a clone the connect path can await on. Re-registering the same
    /// attempt ID replaces (and orphans) the previous token.
    fn register_pending(&self, attempt_id: String) -> CancellationToken {
        let token = CancellationToken::new();
        self.pending_connects.insert(attempt_id, token.clone());
        token
    }

    /// Drop the pending registration for `attempt_id` once the attempt settles
    /// (succeeded, failed, or was cancelled).
    fn clear_pending(&self, attempt_id: &str) {
        self.pending_connects.remove(attempt_id);
    }

    /// Abort an in-flight connection attempt by its attempt ID. Returns `true`
    /// if a matching attempt was found and signalled. The connect path observes
    /// the cancellation, unwinds its partial state, and removes the registration.
    pub fn cancel_connect(&self, attempt_id: &str) -> bool {
        if let Some(entry) = self.pending_connects.get(attempt_id) {
            entry.cancel();
            true
        } else {
            false
        }
    }

    /// Establish a new SSH connection and return its SessionId.
    pub async fn connect(
        &self,
        config: HostConfig,
        app_handle: AppHandle,
        attempt_id: Option<String>,
    ) -> Result<SessionId, SshError> {
        let session_id = SessionId::new();
        let sid = session_id.0.clone();

        // Arm cancellation for this attempt (if the frontend supplied an ID) so
        // `cancel_connect` can abort it mid-handshake.
        let cancel_token = attempt_id
            .as_ref()
            .map(|id| self.register_pending(id.clone()));

        let _ = app_handle.emit(
            "ssh:status",
            &SshStatusPayload {
                session_id: sid.clone(),
                status: ConnectionStatus::Connecting,
            },
        );

        let keepalive_secs = config.keep_alive_interval.unwrap_or(0) as u64;
        let russh_config = Arc::new(client::Config {
            // Send SSH keepalive probes rather than arming an inactivity GC timer.
            // `inactivity_timeout` only tears the session down after a quiet
            // window (and sends nothing to prevent it), which would also collapse
            // any ProxyJump tunnel beneath an idle session. `keepalive_interval`
            // proactively keeps the connection — and the tunnel — alive, while
            // `keepalive_max` unanswered probes still detect a genuinely dead peer.
            keepalive_interval: if keepalive_secs > 0 {
                Some(std::time::Duration::from_secs(keepalive_secs))
            } else {
                None // No keepalive — connection stays alive until explicitly closed
            },
            keepalive_max: 3,
            ..Default::default()
        });

        // Establish the connection — directly or tunnelled through a ProxyJump
        // chain. The jump handles must outlive the target session, so they are
        // handed (shared) to the SshSession to keep alive; sharing via Arc lets
        // split panes on the same connection hold the tunnel open too.
        //
        // The whole establish + PTY-open is raced against the cancellation token:
        // if the user cancels, the future is dropped mid-await, which drops any
        // partially-established handles and lets russh tear the connection down.
        // Nothing is inserted into `sessions` until this succeeds, so a cancel
        // leaves no ghost session behind.
        let connect_fut = async {
            let (handle, jump_handles) = Self::establish(&config, russh_config).await?;

            info!(session_id = %sid, host = %config.host, "SSH authenticated");

            SshSession::open_pty(
                handle,
                Arc::new(jump_handles),
                sid.clone(),
                80,
                24,
                app_handle,
                config.default_shell.clone(),
                config.startup_command.clone(),
            )
            .await
        };

        let outcome = match &cancel_token {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => Err(SshError::Cancelled),
                r = connect_fut => r,
            },
            None => connect_fut.await,
        };

        if let Some(id) = &attempt_id {
            self.clear_pending(id);
        }

        let session = outcome?;
        self.sessions.insert(sid.clone(), session);

        Ok(session_id)
    }

    /// Establish an SSH connection without opening a PTY.
    /// Used for SFTP-only sessions where no terminal is needed.
    /// Returns a session ID that can be used with `get_handle`.
    pub async fn connect_no_pty(
        &self,
        config: HostConfig,
        attempt_id: Option<String>,
    ) -> Result<SessionId, SshError> {
        let session_id = SessionId::new();
        let sid = session_id.0.clone();

        let cancel_token = attempt_id
            .as_ref()
            .map(|id| self.register_pending(id.clone()));

        let russh_config = Arc::new(client::Config {
            inactivity_timeout: None, // SFTP connections stay alive indefinitely
            ..Default::default()
        });

        // Establish the connection — directly or tunnelled through a ProxyJump —
        // racing against the cancellation token so the user can abort mid-handshake.
        let establish_fut = Self::establish(&config, russh_config);
        let established = match &cancel_token {
            Some(token) => tokio::select! {
                biased;
                _ = token.cancelled() => Err(SshError::Cancelled),
                r = establish_fut => r,
            },
            None => establish_fut.await,
        };

        if let Some(id) = &attempt_id {
            self.clear_pending(id);
        }

        let (handle, jump_handles) = established?;

        info!(session_id = %sid, host = %config.host, "SSH authenticated (no PTY, for SFTP)");

        self.bare_handles.insert(
            sid.clone(),
            BareConn {
                handle: Arc::new(tokio::sync::Mutex::new(handle)),
                _jump_handles: jump_handles,
            },
        );

        Ok(session_id)
    }

    /// Establish a connected + authenticated russh handle for `config`, returning
    /// the target handle plus the chain of jump-host handles that must be kept
    /// alive beneath it (empty for a direct connection).
    ///
    /// When `config.jump_host` is set the connection is tunnelled, and because a
    /// jump host may itself be reached through its own ProxyJump this recurses to
    /// build the *entire* chain (`ssh -J a,b,c target`): each hop opens a
    /// `direct-tcpip` channel to the next over the already-authenticated handle
    /// below it. Every returned jump handle MUST outlive the target session —
    /// dropping one tears down the tunnel above it. Recursion depth is bounded by
    /// the cyclic-reference guard in `build_host_config_blocking`, which resolves
    /// the chain before this runs.
    ///
    /// Returns a boxed future because the recursion makes the future type
    /// self-referential (an `async fn` calling itself cannot size its own future).
    pub(crate) fn establish(
        config: &HostConfig,
        russh_config: Arc<client::Config>,
    ) -> EstablishFuture<'_> {
        Box::pin(async move {
            let Some(jump) = config.jump_host.as_deref() else {
                // Direct connection — no tunnel.
                let addr = format!("{}:{}", config.host, config.port);
                let mut handle = client::connect(russh_config, &addr, SshClientHandler)
                    .await
                    .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
                Self::authenticate_handle(&mut handle, config).await?;
                return Ok((handle, Vec::new()));
            };

            // 1. Recursively establish the jump connection (it may itself be
            //    tunnelled through its own ProxyJump). Reaching/auth errors are
            //    re-labelled so the failing hop is identifiable.
            let (jump_handle, mut chain) = Self::establish(jump, russh_config.clone())
                .await
                .map_err(|e| match e {
                    SshError::ConnectionFailed(m) => {
                        SshError::ConnectionFailed(format!("tunnel host {}: {m}", jump.host))
                    }
                    SshError::AuthenticationFailed(m) => {
                        SshError::AuthenticationFailed(format!("tunnel host {}: {m}", jump.host))
                    }
                    other => other,
                })?;

            // 2. Open a direct-tcpip channel through the jump host to the target.
            let channel = jump_handle
                .channel_open_direct_tcpip(
                    config.host.clone(),
                    config.port as u32,
                    "127.0.0.1".to_string(),
                    0,
                )
                .await
                .map_err(|e| {
                    SshError::ConnectionFailed(format!(
                        "failed to open tunnel to {}:{}: {e}",
                        config.host, config.port
                    ))
                })?;

            // 3. Run the target SSH session over the tunnelled channel.
            let mut handle =
                client::connect_stream(russh_config, channel.into_stream(), SshClientHandler)
                    .await
                    .map_err(|e| SshError::ConnectionFailed(e.to_string()))?;
            Self::authenticate_handle(&mut handle, config).await?;

            // Keep this hop's handle and everything beneath it alive under the
            // target session.
            chain.push(jump_handle);
            Ok((handle, chain))
        })
    }

    /// Authenticate an already-connected handle using the config's auth method.
    /// Shared by direct and tunnelled connection paths (and the health-check
    /// probe, which authenticates the jump host before tunnelling to the target).
    pub(crate) async fn authenticate_handle(
        handle: &mut client::Handle<SshClientHandler>,
        config: &HostConfig,
    ) -> Result<(), SshError> {
        let authenticated = match &config.auth_method {
            AuthMethod::Password { password } => handle
                .authenticate_password(&config.username, password)
                .await
                .map_err(|e| SshError::AuthenticationFailed(e.to_string()))?,
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            } => {
                let key_data = tokio::fs::read_to_string(key_path)
                    .await
                    .map_err(|e| SshError::IoError(e.to_string()))?;

                // Auto-convert PPK to OpenSSH if detected
                let key_data = if super::keys::is_ppk_format(&key_data) {
                    let kp = key_path.clone();
                    let pp = passphrase.clone();
                    tokio::task::spawn_blocking(move || {
                        super::keys::convert_ppk_to_openssh(&kp, pp.as_deref())
                    })
                    .await
                    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))??
                } else {
                    key_data
                };

                Self::auth_with_key_data(handle, &config.username, &key_data, passphrase.as_deref())
                    .await?
            }
            AuthMethod::PrivateKeyData {
                key_data,
                passphrase,
            } => {
                Self::auth_with_key_data(handle, &config.username, key_data, passphrase.as_deref())
                    .await?
            }
        };

        if !authenticated {
            return Err(SshError::AuthenticationFailed(
                "server rejected credentials".to_string(),
            ));
        }
        Ok(())
    }

    async fn auth_with_key_data(
        handle: &mut client::Handle<SshClientHandler>,
        username: &str,
        key_data: &str,
        passphrase: Option<&str>,
    ) -> Result<bool, SshError> {
        let key_pair = russh_keys::decode_secret_key(key_data, passphrase)
            .map_err(|e| SshError::KeyParseError(e.to_string()))?;
        let key = Arc::new(key_pair);
        handle
            .authenticate_publickey(username, key)
            .await
            .map_err(|e| SshError::AuthenticationFailed(e.to_string()))
    }

    /// Return the shared Handle for an active session.  Used by the SFTP layer
    /// to open an independent SFTP channel on the same connection.
    ///
    /// The caller must lock the handle only long enough to call
    /// `channel_open_session()`, then drop the guard.
    pub fn get_handle(
        &self,
        session_id: &str,
    ) -> Result<std::sync::Arc<tokio::sync::Mutex<russh::client::Handle<SshClientHandler>>>, SshError>
    {
        // Check PTY sessions first, then bare handles (SFTP-only)
        if let Some(entry) = self.sessions.get(session_id) {
            return Ok(entry.value().ssh_handle());
        }
        if let Some(entry) = self.bare_handles.get(session_id) {
            return Ok(entry.value().handle.clone());
        }
        Err(SshError::SessionNotFound(session_id.to_string()))
    }

    /// Open a new PTY channel on the same connection as an existing session.
    /// Returns the new session ID.
    pub async fn split_session(
        &self,
        source_session_id: &str,
        app_handle: AppHandle,
    ) -> Result<SessionId, SshError> {
        // Get the shared handle, host config, and the ProxyJump tunnel chain from
        // the source session. The jump handles are shared (Arc) so the tunnel
        // stays open as long as the parent OR any split pane is alive — closing
        // the parent tab no longer tears the tunnel out from under its children.
        let (handle, host_config, jump_handles) = {
            let entry = self
                .sessions
                .get(source_session_id)
                .ok_or_else(|| SshError::SessionNotFound(source_session_id.to_string()))?;
            (
                entry.value().ssh_handle(),
                entry.value().host_config(),
                entry.value().jump_handles(),
            )
        };

        let new_id = SessionId::new();
        let sid = new_id.0.clone();

        let session = SshSession::open_split_pty(
            handle,
            jump_handles,
            sid.clone(),
            80,
            24,
            app_handle,
            host_config.default_shell,
        )
        .await?;

        self.sessions.insert(sid, session);
        Ok(new_id)
    }

    /// Send bytes to a session's PTY channel.
    pub async fn send_input(&self, session_id: &str, data: &[u8]) -> Result<(), SshError> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        entry.value().send_input(data).await
    }

    /// Resize a session's PTY.
    pub async fn resize_pty(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), SshError> {
        let entry = self
            .sessions
            .get(session_id)
            .ok_or_else(|| SshError::SessionNotFound(session_id.to_string()))?;
        entry.value().resize_pty(cols, rows).await
    }

    /// Disconnect and remove a session.
    pub async fn disconnect(
        &self,
        session_id: &str,
        app_handle: AppHandle,
    ) -> Result<(), SshError> {
        self.mark_protocol_disconnecting(session_id);
        let _ = app_handle.emit(
            "ssh:status",
            &SshStatusPayload {
                session_id: session_id.to_string(),
                status: ConnectionStatus::Disconnecting,
            },
        );

        // PTY sessions and bare (SFTP-only) handles live in separate maps —
        // check both so a no-PTY connection (e.g. an explorer connect whose
        // cancel landed after the handshake settled) can be torn down through
        // this same command instead of lingering in `bare_handles` forever.
        let disconnect_result = if let Some((_, session)) = self.sessions.remove(session_id) {
            session.disconnect().await
        } else if let Some((_, bare)) = self.bare_handles.remove(session_id) {
            // Best-effort goodbye — dropping the handles closes the connection
            // (and any ProxyJump tunnel beneath it) even if the server is gone.
            let _ = bare
                .handle
                .lock()
                .await
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            Ok(())
        } else {
            Err(SshError::SessionNotFound(session_id.to_string()))
        };

        /* A disconnect tombstone is retained until every open that obtained
         * this SSH handle before the mark has settled, then pruned after the
         * handle is gone. This bounds registry memory without permitting a
         * late protocol open to reuse a removed connection ID. */
        self.complete_protocol_disconnect(session_id);
        disconnect_result?;

        let _ = app_handle.emit(
            "ssh:status",
            &SshStatusPayload {
                session_id: session_id.to_string(),
                status: ConnectionStatus::Disconnected,
            },
        );

        info!(session_id = %session_id, "SSH disconnected");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cancelling an attempt ID that was never registered (or whose attempt
    /// already settled) must report that nothing was found.
    #[test]
    fn cancel_connect_returns_false_for_unknown_attempt() {
        let manager = SshManager::new();
        assert!(!manager.cancel_connect("no-such-attempt"));
    }

    /// The token handed to the connect path observes a cancel issued through
    /// the manager by attempt ID.
    #[test]
    fn cancel_connect_signals_the_registered_token() {
        let manager = SshManager::new();
        let token = manager.register_pending("attempt-1".to_string());
        assert!(!token.is_cancelled());

        assert!(manager.cancel_connect("attempt-1"));
        assert!(token.is_cancelled());
    }

    /// Once an attempt settles and clears its registration, a late cancel is a
    /// no-op: the settled attempt's token must not be signalled.
    #[test]
    fn clear_pending_makes_a_late_cancel_a_no_op() {
        let manager = SshManager::new();
        let token = manager.register_pending("attempt-1".to_string());
        manager.clear_pending("attempt-1");

        assert!(!manager.cancel_connect("attempt-1"));
        assert!(!token.is_cancelled());
    }

    /// Re-registering an attempt ID replaces the token: a cancel reaches the
    /// new attempt, never the orphaned one.
    #[test]
    fn reregistering_an_attempt_id_replaces_the_token() {
        let manager = SshManager::new();
        let orphaned = manager.register_pending("attempt-1".to_string());
        let active = manager.register_pending("attempt-1".to_string());

        assert!(manager.cancel_connect("attempt-1"));
        assert!(active.is_cancelled());
        assert!(!orphaned.is_cancelled());
    }
}

/*
 * Exercise the shared registry directly so mixed SFTP/SCP ownership decisions
 * remain independent of live russh handles and Tauri command state.
 */
#[cfg(test)]
mod ownership_tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ownership_records_requested_value() {
        let mut book = SessionOwnershipBook::default();

        assert_eq!(
            book.record(
                ProtocolSessionKind::Sftp,
                "sftp-1".into(),
                "ssh-1".into(),
                Some(true),
            )
            .expect("SFTP registration"),
            SessionOwnership {
                ssh_session_id: "ssh-1".into(),
                owns_ssh: true,
            }
        );
    }

    #[test]
    fn ownership_inherits_within_the_same_transport() {
        let mut book = SessionOwnershipBook::default();
        book.record(
            ProtocolSessionKind::Sftp,
            "sftp-1".into(),
            "ssh-1".into(),
            Some(true),
        );

        let inherited = book
            .record(
                ProtocolSessionKind::Sftp,
                "sftp-2".into(),
                "ssh-1".into(),
                Some(false),
            )
            .expect("inherited SFTP registration");
        assert!(inherited.owns_ssh);
    }

    #[test]
    fn reference_registered_before_owner_release_prevents_disconnect() {
        let mut book = SessionOwnershipBook::default();
        book.record(
            ProtocolSessionKind::Sftp,
            "sftp-1".into(),
            "ssh-1".into(),
            Some(true),
        );
        book.record(
            ProtocolSessionKind::Scp,
            "scp-1".into(),
            "ssh-1".into(),
            Some(false),
        );

        let (removed, should_disconnect) = book
            .remove(ProtocolSessionKind::Sftp, "sftp-1")
            .expect("owned SFTP record");
        assert!(removed.owns_ssh);
        assert!(!should_disconnect);
        assert!(book.has_ssh_session("ssh-1"));
        assert!(book
            .sessions
            .contains_key(&(ProtocolSessionKind::Scp, "scp-1".into())));
    }

    #[test]
    fn last_cross_transport_reference_disconnects_after_owner_closes_first() {
        let mut book = SessionOwnershipBook::default();
        book.record(
            ProtocolSessionKind::Sftp,
            "sftp-1".into(),
            "ssh-1".into(),
            Some(true),
        );
        book.record(
            ProtocolSessionKind::Scp,
            "scp-1".into(),
            "ssh-1".into(),
            Some(false),
        );

        assert!(
            !book
                .remove(ProtocolSessionKind::Sftp, "sftp-1")
                .expect("SFTP record")
                .1
        );
        assert!(
            book.remove(ProtocolSessionKind::Scp, "scp-1")
                .expect("SCP record")
                .1
        );
    }

    #[test]
    fn last_cross_transport_reference_disconnects_after_non_owner_closes_first() {
        let mut book = SessionOwnershipBook::default();
        book.record(
            ProtocolSessionKind::Sftp,
            "sftp-1".into(),
            "ssh-1".into(),
            Some(true),
        );
        book.record(
            ProtocolSessionKind::Scp,
            "scp-1".into(),
            "ssh-1".into(),
            Some(false),
        );

        assert!(
            !book
                .remove(ProtocolSessionKind::Scp, "scp-1")
                .expect("SCP record")
                .1
        );
        assert!(
            book.remove(ProtocolSessionKind::Sftp, "sftp-1")
                .expect("SFTP record")
                .1
        );
    }

    #[test]
    fn terminal_owned_references_never_disconnect_ssh() {
        let mut book = SessionOwnershipBook::default();
        book.record(
            ProtocolSessionKind::Sftp,
            "sftp-1".into(),
            "ssh-1".into(),
            Some(false),
        );
        book.record(
            ProtocolSessionKind::Scp,
            "scp-1".into(),
            "ssh-1".into(),
            None,
        );

        assert!(
            !book
                .remove(ProtocolSessionKind::Scp, "scp-1")
                .expect("SCP record")
                .1
        );
        assert!(
            !book
                .remove(ProtocolSessionKind::Sftp, "sftp-1")
                .expect("SFTP record")
                .1
        );
    }

    #[test]
    fn explicit_disconnect_rejects_a_late_sftp_registration() {
        let manager = SshManager::new();
        let open = manager
            .begin_protocol_open("ssh-1")
            .expect("open should begin before disconnect");
        manager.mark_protocol_disconnecting("ssh-1");
        manager.complete_protocol_disconnect("ssh-1");

        let result = manager.publish_protocol_session(
            ProtocolSessionKind::Sftp,
            "sftp-late".into(),
            "ssh-1".into(),
            Some(false),
            || {},
            || Some(()),
        );

        assert_eq!(result, Err(Some(())));
        assert!(manager
            .remove_protocol_session(ProtocolSessionKind::Sftp, "sftp-late")
            .is_none());
        drop(open);
    }

    #[test]
    fn explicit_disconnect_rejects_a_late_scp_registration() {
        let manager = SshManager::new();
        let open = manager
            .begin_protocol_open("ssh-1")
            .expect("open should begin before disconnect");
        manager.mark_protocol_disconnecting("ssh-1");
        manager.complete_protocol_disconnect("ssh-1");

        let result = manager.publish_protocol_session(
            ProtocolSessionKind::Scp,
            "scp-late".into(),
            "ssh-1".into(),
            Some(false),
            || {},
            || Some(()),
        );

        assert_eq!(result, Err(Some(())));
        assert!(manager
            .remove_protocol_session(ProtocolSessionKind::Scp, "scp-late")
            .is_none());
        drop(open);
    }

    #[test]
    fn registered_cross_transport_reference_survives_owner_close() {
        let manager = SshManager::new();
        assert!(manager.register_protocol_session(
            ProtocolSessionKind::Sftp,
            "sftp-old".into(),
            "ssh-1".into(),
            Some(true),
        ));
        assert!(manager.register_protocol_session(
            ProtocolSessionKind::Scp,
            "scp-live".into(),
            "ssh-1".into(),
            Some(false),
        ));

        assert_eq!(
            manager.remove_protocol_session(ProtocolSessionKind::Sftp, "sftp-old"),
            Some(false)
        );
        assert!(manager
            .remove_protocol_session(ProtocolSessionKind::Scp, "scp-live")
            .is_some());

        assert!(!manager.register_protocol_session(
            ProtocolSessionKind::Scp,
            "scp-late".into(),
            "ssh-1".into(),
            Some(false),
        ));
    }

    /* The close linearization point must win over an open that already holds
     * the SSH handle. Once the final owner marks disconnecting, publication is
     * rejected and its rollback path remains responsible for the wrapper. */
    #[test]
    fn final_owner_close_blocks_an_in_flight_cross_transport_open() {
        let manager = SshManager::new();
        assert!(manager.register_protocol_session(
            ProtocolSessionKind::Sftp,
            "sftp-owner".into(),
            "ssh-1".into(),
            Some(true),
        ));
        let open = manager
            .begin_protocol_open("ssh-1")
            .expect("open should begin before final close");

        assert_eq!(
            manager.remove_protocol_session(ProtocolSessionKind::Sftp, "sftp-owner"),
            Some(true)
        );
        let result = manager.publish_protocol_session(
            ProtocolSessionKind::Scp,
            "scp-late".into(),
            "ssh-1".into(),
            Some(false),
            || {},
            || Some(()),
        );

        assert_eq!(result, Err(Some(())));
        assert!(manager
            .remove_protocol_session(ProtocolSessionKind::Scp, "scp-late")
            .is_none());
        drop(open);
    }

    #[test]
    fn final_owned_scp_release_marks_the_bare_connection_for_disconnect() {
        let manager = SshManager::new();
        assert!(manager.register_protocol_session(
            ProtocolSessionKind::Scp,
            "scp-only".into(),
            "ssh-1".into(),
            Some(true),
        ));

        assert_eq!(
            manager.remove_protocol_session(ProtocolSessionKind::Scp, "scp-only"),
            Some(true)
        );
    }

    /* These command-adjacent harnesses pause the same production helper that
     * sftp_open and scp_open call after handle acquisition. They let explicit
     * disconnect win at the awaited-handshake boundary without a live server,
     * then verify the publish callback's wrapper is rolled back. */
    #[tokio::test]
    async fn sftp_open_helper_rolls_back_after_disconnect_during_handshake() {
        let manager = SshManager::new();
        let published = std::sync::Arc::new(StdMutex::new(HashSet::new()));
        let published_for_publish = published.clone();
        let published_for_rollback = published.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();

        let open = manager.open_protocol_session(
            ProtocolOpenRequest {
                protocol: ProtocolSessionKind::Sftp,
                protocol_session_id: "sftp-late".to_string(),
                ssh_session_id: "ssh-1".to_string(),
                requested: Some(true),
            },
            async move {
                let _ = ready_tx.send(());
                let _ = resume_rx.await;
                Ok::<_, ()>("sftp-late".to_string())
            },
            move |session_id| {
                published_for_publish.lock().unwrap().insert(session_id);
            },
            move || {
                published_for_rollback
                    .lock()
                    .unwrap()
                    .remove("sftp-late")
                    .then(|| "sftp-late".to_string())
            },
        );
        tokio::pin!(open);

        let result = tokio::select! {
            _ = ready_rx => {
                manager.mark_protocol_disconnecting("ssh-1");
                manager.remove_protocol_sessions_for_ssh("ssh-1");
                manager.complete_protocol_disconnect("ssh-1");
                let _ = resume_tx.send(());
                open.await
            }
            _ = &mut open => panic!("handshake completed before disconnect interleaving"),
        };

        assert!(matches!(result, Err(ProtocolOpenError::Rejected(Some(_)))));
        assert!(published.lock().unwrap().is_empty());
        assert!(manager
            .remove_protocol_session(ProtocolSessionKind::Sftp, "sftp-late")
            .is_none());
    }

    #[tokio::test]
    async fn scp_open_helper_rolls_back_after_disconnect_during_probe() {
        let manager = SshManager::new();
        let published = std::sync::Arc::new(StdMutex::new(HashSet::new()));
        let published_for_publish = published.clone();
        let published_for_rollback = published.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();

        let open = manager.open_protocol_session(
            ProtocolOpenRequest {
                protocol: ProtocolSessionKind::Scp,
                protocol_session_id: "scp-late".to_string(),
                ssh_session_id: "ssh-1".to_string(),
                requested: Some(true),
            },
            async move {
                let _ = ready_tx.send(());
                let _ = resume_rx.await;
                Ok::<_, ()>("scp-late".to_string())
            },
            move |session_id| {
                published_for_publish.lock().unwrap().insert(session_id);
            },
            move || {
                published_for_rollback
                    .lock()
                    .unwrap()
                    .remove("scp-late")
                    .then(|| "scp-late".to_string())
            },
        );
        tokio::pin!(open);

        let result = tokio::select! {
            _ = ready_rx => {
                manager.mark_protocol_disconnecting("ssh-1");
                manager.remove_protocol_sessions_for_ssh("ssh-1");
                manager.complete_protocol_disconnect("ssh-1");
                let _ = resume_tx.send(());
                open.await
            }
            _ = &mut open => panic!("probe completed before disconnect interleaving"),
        };

        assert!(matches!(result, Err(ProtocolOpenError::Rejected(Some(_)))));
        assert!(published.lock().unwrap().is_empty());
        assert!(manager
            .remove_protocol_session(ProtocolSessionKind::Scp, "scp-late")
            .is_none());
    }

    #[tokio::test]
    async fn final_sftp_owner_close_deterministically_rejects_late_scp_open() {
        let manager = SshManager::new();
        assert!(manager.register_protocol_session(
            ProtocolSessionKind::Sftp,
            "sftp-owner".to_string(),
            "ssh-1".to_string(),
            Some(true),
        ));

        let published = std::sync::Arc::new(StdMutex::new(HashSet::new()));
        let published_for_publish = published.clone();
        let published_for_rollback = published.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = tokio::sync::oneshot::channel();
        let open = manager.open_protocol_session(
            ProtocolOpenRequest {
                protocol: ProtocolSessionKind::Scp,
                protocol_session_id: "scp-late".to_string(),
                ssh_session_id: "ssh-1".to_string(),
                requested: Some(false),
            },
            async move {
                let _ = ready_tx.send(());
                let _ = resume_rx.await;
                Ok::<_, ()>("scp-late".to_string())
            },
            move |session_id| {
                published_for_publish.lock().unwrap().insert(session_id);
            },
            move || {
                published_for_rollback
                    .lock()
                    .unwrap()
                    .remove("scp-late")
                    .then(|| "scp-late".to_string())
            },
        );
        tokio::pin!(open);

        let result = tokio::select! {
            _ = ready_rx => {
                assert_eq!(
                    manager.remove_protocol_session(ProtocolSessionKind::Sftp, "sftp-owner"),
                    Some(true)
                );
                let _ = resume_tx.send(());
                open.await
            }
            _ = &mut open => panic!("open completed before owner-close interleaving"),
        };

        assert!(matches!(result, Err(ProtocolOpenError::Rejected(Some(_)))));
        assert!(published.lock().unwrap().is_empty());
        assert!(manager
            .remove_protocol_session(ProtocolSessionKind::Scp, "scp-late")
            .is_none());
    }

    /* The publish hook marks the connection at the exact point an SSH
     * disconnect can win between wrapper insertion and lifecycle registration.
     * A correct coordinator then rejects registration and invokes rollback. */
    #[test]
    fn late_sftp_publication_is_rolled_back_after_disconnect_wins() {
        let manager = SshManager::new();
        let rollback_called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rollback_called_for_test = rollback_called.clone();

        let result = manager.publish_protocol_session(
            ProtocolSessionKind::Sftp,
            "sftp-late".to_string(),
            "ssh-1".to_string(),
            Some(true),
            || {
                manager.mark_protocol_disconnecting("ssh-1");
            },
            move || {
                rollback_called_for_test.store(true, std::sync::atomic::Ordering::SeqCst);
                Some(())
            },
        );

        assert_eq!(result, Err(Some(())));
        assert!(rollback_called.load(std::sync::atomic::Ordering::SeqCst));
        assert!(manager
            .remove_protocol_session(ProtocolSessionKind::Sftp, "sftp-late")
            .is_none());
    }

    #[test]
    fn late_scp_publication_is_rolled_back_after_disconnect_wins() {
        let manager = SshManager::new();
        let rollback_called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let rollback_called_for_test = rollback_called.clone();

        let result = manager.publish_protocol_session(
            ProtocolSessionKind::Scp,
            "scp-late".to_string(),
            "ssh-1".to_string(),
            Some(true),
            || {
                manager.mark_protocol_disconnecting("ssh-1");
            },
            move || {
                rollback_called_for_test.store(true, std::sync::atomic::Ordering::SeqCst);
                Some(())
            },
        );

        assert_eq!(result, Err(Some(())));
        assert!(rollback_called.load(std::sync::atomic::Ordering::SeqCst));
        assert!(manager
            .remove_protocol_session(ProtocolSessionKind::Scp, "scp-late")
            .is_none());
    }

    #[test]
    fn disconnect_tombstone_waits_for_late_open_before_pruning() {
        let manager = SshManager::new();
        let guard = manager
            .begin_protocol_open("ssh-1")
            .expect("open should begin before disconnect");

        manager.mark_protocol_disconnecting("ssh-1");
        manager.complete_protocol_disconnect("ssh-1");
        assert!(manager
            .protocol_ownership
            .lock()
            .unwrap()
            .disconnecting
            .contains_key("ssh-1"));

        drop(guard);
        assert!(!manager
            .protocol_ownership
            .lock()
            .unwrap()
            .disconnecting
            .contains_key("ssh-1"));
    }
}
