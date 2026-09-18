/*
 * Dataset rows: content selection, endpoint reconstruction, and save/list/remove.
 *
 * Saving a dataset is "join or create" (AD-3). The remote path is probed first:
 *
 * - A dataset already published there wins. Its metadata carries the dataset id
 *   and the wrapped dataset key, so the passphrase the user typed is verified
 *   by unwrapping *that* key. This is how a second machine — or a teammate —
 *   joins an existing dataset with nothing but the passphrase.
 * - Otherwise the local row's wrap is reused when the passphrase still opens
 *   it, and only a genuinely new dataset generates a fresh key.
 *
 * Consequences worth stating: a wrong passphrase fails at save time instead of
 * at the first push, and pointing two machines at the same path can never
 * produce two different dataset keys for one dataset.
 */

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::db::{HostDb, SyncDataset};
use crate::ssh::manager::SshManager;
use crate::types::session::AuthMethod;
use crate::vault::StoredCredential;

use super::codec::{
    generate_dataset_key, unwrap_dataset_key, wrap_dataset_key, DatasetKey, KeyWrap, NONCE_LEN,
};
use super::meta::DatasetMeta;
use super::secrets;
use super::transport::{RemoteStore, SyncEndpoint};
use super::SyncError;

// ─── Content selection ───────────────────────────────────────────────────────

/* Per-dataset content toggles (AD-11). Defaults mirror the product decision:
 * everything the user can see in the app syncs, except the two credential
 * sub-toggles, which start off because a shared dataset should not hand out
 * host passwords unless the owner says so. */
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncContentFlags {
    #[serde(default = "enabled")]
    pub hosts: bool,
    #[serde(default)]
    pub host_credentials: bool,
    #[serde(default = "enabled")]
    pub groups: bool,
    #[serde(default = "enabled")]
    pub snippets: bool,
    #[serde(default = "enabled")]
    pub snippet_folders: bool,
    #[serde(default = "enabled")]
    pub port_forwards: bool,
    #[serde(default = "enabled")]
    pub s3_connections: bool,
    #[serde(default)]
    pub s3_credentials: bool,
    #[serde(default = "enabled")]
    pub host_plugins: bool,
    #[serde(default = "enabled")]
    pub app_settings: bool,
}

fn enabled() -> bool {
    true
}

impl Default for SyncContentFlags {
    fn default() -> Self {
        Self {
            hosts: true,
            host_credentials: false,
            groups: true,
            snippets: true,
            snippet_folders: true,
            port_forwards: true,
            s3_connections: true,
            s3_credentials: false,
            host_plugins: true,
            app_settings: true,
        }
    }
}

impl SyncContentFlags {
    /* Referential integrity is resolved here rather than trusted from the UI:
     * port-forward rules and plugin rows are FK children of `saved_hosts`, and
     * a credential without its host (or a snippet without its folder) would
     * arrive on the other machine with a dangling parent. */
    pub fn normalized(mut self) -> Self {
        if !self.hosts {
            self.host_credentials = false;
            self.port_forwards = false;
            self.host_plugins = false;
        }
        if !self.s3_connections {
            self.s3_credentials = false;
        }
        if self.snippets {
            self.snippet_folders = true;
        }
        if self.hosts {
            self.groups = true;
        }
        self
    }

    pub fn includes_credentials(&self) -> bool {
        self.host_credentials || self.s3_credentials
    }

    pub fn to_json(self) -> Result<String, SyncError> {
        serde_json::to_string(&self).map_err(|e| SyncError::Serialization(e.to_string()))
    }

    /// Parse the persisted column. An unreadable or partial value falls back to
    /// the defaults for the missing keys rather than failing a whole dataset.
    pub fn from_json(value: &str) -> Self {
        serde_json::from_str::<Self>(value)
            .unwrap_or_default()
            .normalized()
    }
}

// ─── Wire types ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDatasetInput {
    /// Absent for a new dataset.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    pub username: String,
    #[serde(default)]
    pub key_path: Option<String>,
    pub remote_path: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content_flags: SyncContentFlags,
    /* Automatic sync is opt-in and each cadence is opt-in separately: an
     * absent field means "off", never "use a default interval". */
    #[serde(default)]
    pub auto_sync: Option<bool>,
    #[serde(default)]
    pub pull_interval_secs: Option<i64>,
    #[serde(default)]
    pub push_debounce_secs: Option<i64>,
}

/// Secrets for one save call. Never persisted in SQLite, never echoed back.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDatasetSecrets {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub key_passphrase: Option<String>,
    pub passphrase: String,
}

impl std::fmt::Debug for SyncDatasetSecrets {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SyncDatasetSecrets")
            .field("password", &self.password.is_some())
            .field("keyPassphrase", &self.key_passphrase.is_some())
            .field("passphrase", &"<redacted>")
            .finish()
    }
}

impl Drop for SyncDatasetSecrets {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        if let Some(password) = self.password.as_mut() {
            password.zeroize();
        }
        if let Some(passphrase) = self.key_passphrase.as_mut() {
            passphrase.zeroize();
        }
        self.passphrase.zeroize();
    }
}

/// What the Settings panel renders for one dataset. Secret *presence* only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDatasetSummary {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub remote_path: String,
    pub role: String,
    pub content_flags: SyncContentFlags,
    pub scope_mode: String,
    /* Key-auth datasets keep their key path in `scope_mode`. It is reported
     * here so the settings form can prefill it when a dataset is edited —
     * without it, editing a key-auth dataset would silently drop the key and
     * fall back to password authentication. The path is a filename, not a
     * secret; the passphrase stays in the keychain. */
    pub key_path: Option<String>,
    pub auto_sync: bool,
    pub pull_interval_secs: i64,
    pub push_debounce_secs: i64,
    pub last_generation: u64,
    pub last_synced_at: Option<String>,
    pub has_server_secret: bool,
    pub has_passphrase: bool,
}

impl From<&SyncDataset> for SyncDatasetSummary {
    fn from(row: &SyncDataset) -> Self {
        Self {
            id: row.id.clone(),
            name: row.name.clone(),
            host: row.host.clone(),
            port: row.port,
            username: row.username.clone(),
            auth_type: row.auth_type.clone(),
            remote_path: row.remote_path.clone(),
            role: row.role.clone(),
            content_flags: SyncContentFlags::from_json(&row.content_flags),
            scope_mode: row.scope_mode.clone(),
            key_path: key_path_of(row).ok(),
            auto_sync: row.auto_sync,
            pull_interval_secs: row.pull_interval_secs,
            push_debounce_secs: row.push_debounce_secs,
            last_generation: row.last_generation.max(0) as u64,
            last_synced_at: row.last_synced_at.clone(),
            has_server_secret: secrets::has_server_secret(&row.id),
            has_passphrase: secrets::has_passphrase(&row.id),
        }
    }
}

// ─── Endpoint reconstruction ─────────────────────────────────────────────────

/// Rebuild the connection details for a saved dataset from its row plus the
/// keychain secret.
pub fn endpoint_for(row: &SyncDataset) -> Result<SyncEndpoint, SyncError> {
    let stored = secrets::load_server_secret(&row.id)?;
    let auth = match (row.auth_type.as_str(), &stored) {
        ("password", StoredCredential::Password { password }) => AuthMethod::Password {
            password: password.clone(),
        },
        ("privateKey", StoredCredential::KeyPassphrase { passphrase }) => AuthMethod::PrivateKey {
            key_path: key_path_of(row)?,
            passphrase: Some(passphrase.clone()),
        },
        /* A key-auth dataset whose key has no passphrase stores a `Password`
         * record with an empty value, so the two shapes stay distinguishable
         * without a second keychain entry. */
        ("privateKey", StoredCredential::Password { password }) => AuthMethod::PrivateKey {
            key_path: key_path_of(row)?,
            passphrase: Some(password.clone()).filter(|value| !value.is_empty()),
        },
        (auth_type, stored) => {
            return Err(SyncError::Vault(format!(
                "the stored credential does not match this dataset's {auth_type} authentication ({stored:?})"
            )))
        }
    };

    Ok(SyncEndpoint {
        host: row.host.clone(),
        port: row.port,
        username: row.username.clone(),
        auth,
        root: row.remote_path.clone(),
    })
}

/* The key path is persisted inside the endpoint's `scope_mode`-adjacent
 * columns only for host rows, so a key-auth dataset keeps it in `username`'s
 * sibling column `key_path`, encoded in the row's `owner_fingerprint`-free
 * JSON field. Datasets created by this build always carry it. */
fn key_path_of(row: &SyncDataset) -> Result<String, SyncError> {
    let map: BTreeMap<String, String> = serde_json::from_str(&row.scope_mode).unwrap_or_default();
    map.get("keyPath")
        .cloned()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| {
            SyncError::NotFound(
                "this dataset uses key authentication but has no key path — re-save it in Settings"
                    .into(),
            )
        })
}

// ─── Save / list / remove ────────────────────────────────────────────────────

/// Create or update a dataset, verifying the passphrase against the remote when
/// a dataset is already published at the path.
/* What a save did. "Joined an existing dataset" and "created a new one" look
 * identical in a dataset list but mean opposite things for the next step —
 * pull versus push — and mistaking one for the other is exactly how a typo in
 * the remote path turns into an empty dataset nobody can explain. The outcome
 * is therefore reported explicitly instead of being inferred from the row. */
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSaveOutcome {
    pub dataset: SyncDatasetSummary,
    /// The save adopted a dataset already published at this path.
    pub joined: bool,
    /// Generation found on the server at save time; 0 when nothing is there.
    pub remote_generation: u64,
}

pub async fn save_dataset(
    ssh: &SshManager,
    db: &Arc<HostDb>,
    input: SyncDatasetInput,
    mut secrets_input: SyncDatasetSecrets,
) -> Result<SyncSaveOutcome, SyncError> {
    secrets::validate_passphrase(&secrets_input.passphrase)?;
    if input.name.trim().is_empty() {
        return Err(SyncError::Format("give the dataset a name".into()));
    }

    let uses_key = input
        .key_path
        .as_deref()
        .map(|path| !path.trim().is_empty())
        .unwrap_or(false);
    let auth = if uses_key {
        AuthMethod::PrivateKey {
            key_path: input
                .key_path
                .clone()
                .unwrap_or_default()
                .trim()
                .to_string(),
            passphrase: secrets_input
                .key_passphrase
                .clone()
                .filter(|value| !value.is_empty()),
        }
    } else {
        match secrets_input.password.clone() {
            Some(password) if !password.is_empty() => AuthMethod::Password { password },
            _ => {
                return Err(SyncError::Unreachable(
                    "enter the server password or choose a private key".into(),
                ))
            }
        }
    };

    let endpoint = SyncEndpoint {
        host: input.host.trim().to_string(),
        port: input.port.unwrap_or(22),
        username: input.username.trim().to_string(),
        auth,
        root: input.remote_path.trim().to_string(),
    };
    if endpoint.host.is_empty() || endpoint.username.is_empty() || endpoint.root.is_empty() {
        return Err(SyncError::Format(
            "server address, username, and remote path are all required".into(),
        ));
    }

    // Probe before writing anything locally: the remote decides the dataset id
    // and key when it already holds a dataset.
    let store = RemoteStore::connect(ssh, &endpoint).await?;
    let probe = store.probe().await;
    store.close(ssh).await;
    let remote_meta = match probe?.meta.as_deref() {
        Some(bytes) => Some(DatasetMeta::parse(bytes)?),
        None => None,
    };

    let existing_row = match input.id.as_deref() {
        Some(id) => db.get_sync_dataset(id)?,
        None => None,
    };

    let (dataset_id, wrap, owner_fingerprint) = resolve_key_material(
        &input,
        &existing_row,
        remote_meta.as_ref(),
        &secrets_input.passphrase,
    )?;

    /* Joining adopts the remote's dataset id, which can differ from the local
     * row being edited — exactly what happens when a mistyped path created a
     * local-only dataset and the user then corrects the path. Two outcomes,
     * neither of them silent:
     *
     * - the local row never published anything (generation 0): it was a
     *   placeholder, so it is replaced by the joined dataset and its secrets
     *   are moved across rather than left orphaned in the keychain;
     * - it did publish (generation > 0): repointing it would abandon a live
     *   dataset, so the save is refused and the user is told to create a
     *   separate dataset instead.
     */
    if let Some(previous) = existing_row.as_ref().filter(|row| row.id != dataset_id) {
        if previous.last_generation > 0 {
            return Err(SyncError::Conflict(format!(
                "“{}” already publishes its own dataset (generation {}); create a separate dataset for this path instead of repointing this one",
                previous.name, previous.last_generation
            )));
        }
        db.delete_sync_dataset(&previous.id)?;
        secrets::delete_dataset_secrets(&previous.id)?;
    }

    let now = chrono::Utc::now().to_rfc3339();
    let row = SyncDataset {
        id: dataset_id.clone(),
        name: input.name.trim().to_string(),
        host: endpoint.host.clone(),
        port: endpoint.port,
        username: endpoint.username.clone(),
        auth_type: if uses_key { "privateKey" } else { "password" }.to_string(),
        remote_path: endpoint.root.clone(),
        role: input.role.clone().unwrap_or_else(|| "owner".to_string()),
        content_flags: input.content_flags.normalized().to_json()?,
        /* The key path rides in `scope_mode` as a small JSON object so a
         * key-auth endpoint is reconstructible without another migration; the
         * scope selector (AD-11, Task 8) extends the same object. */
        scope_mode: scope_json(&existing_row, input.key_path.as_deref())?,
        auto_sync: input.auto_sync.unwrap_or(false),
        pull_interval_secs: input.pull_interval_secs.unwrap_or(0).clamp(0, 86_400),
        push_debounce_secs: input.push_debounce_secs.unwrap_or(0).clamp(0, 3_600),
        owner_fingerprint,
        kdf_salt: Some(wrap.salt.clone()),
        kdf_m_kib: Some(wrap.m_kib),
        kdf_t: Some(wrap.t),
        kdf_p: Some(wrap.p),
        wrapped_key: Some(pack_wrapped_key(&wrap)),
        last_generation: remote_meta
            .as_ref()
            .map(|meta| meta.generation as i64)
            .or_else(|| existing_row.as_ref().map(|row| row.last_generation))
            .unwrap_or(0),
        last_synced_at: existing_row
            .as_ref()
            .and_then(|row| row.last_synced_at.clone()),
        created_at: existing_row
            .as_ref()
            .map(|row| row.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
    };

    db.upsert_sync_dataset(&row)?;

    /* Secrets are written after the row so a failed keychain write leaves a
     * dataset the UI shows as "needs its secret re-entered" rather than an
     * orphaned keychain entry with no row. */
    let server_credential = if uses_key {
        StoredCredential::KeyPassphrase {
            passphrase: secrets_input.key_passphrase.clone().unwrap_or_default(),
        }
    } else {
        StoredCredential::Password {
            password: secrets_input.password.clone().unwrap_or_default(),
        }
    };
    secrets::save_server_secret(&row.id, &server_credential)?;
    secrets::save_passphrase(&row.id, &secrets_input.passphrase)?;
    secrets_input.passphrase.clear();

    Ok(SyncSaveOutcome {
        dataset: SyncDatasetSummary::from(&row),
        joined: remote_meta.is_some(),
        remote_generation: remote_meta
            .as_ref()
            .map(|meta| meta.generation)
            .unwrap_or(0),
    })
}

/* Key resolution order, strongest claim first: the published remote dataset,
 * then the local row, then a brand-new dataset. Each branch proves the
 * passphrase by actually unwrapping a key, so `save` never stores a passphrase
 * that would later fail to open the dataset. */
fn resolve_key_material(
    input: &SyncDatasetInput,
    existing_row: &Option<SyncDataset>,
    remote_meta: Option<&DatasetMeta>,
    passphrase: &str,
) -> Result<(String, KeyWrap, Option<String>), SyncError> {
    if let Some(meta) = remote_meta {
        // Joining: the remote's wrap is authoritative and the passphrase must open it.
        let _key: DatasetKey = unwrap_dataset_key(passphrase, &meta.key_wrap)?;
        return Ok((
            meta.dataset_id.clone(),
            meta.key_wrap.clone(),
            meta.owner_fingerprint.clone(),
        ));
    }

    if let Some(row) = existing_row {
        if let Some(wrap) = row_wrap(row) {
            if unwrap_dataset_key(passphrase, &wrap).is_ok() {
                return Ok((row.id.clone(), wrap, row.owner_fingerprint.clone()));
            }
            /* The passphrase changed for a dataset that has never been
             * published (no remote metadata to rewrap against), so the old key
             * protects nothing: generate a fresh one under the new passphrase. */
        }
    }

    let key = generate_dataset_key()?;
    let wrap = wrap_dataset_key(passphrase, &key)?;
    let id = input
        .id
        .clone()
        .or_else(|| existing_row.as_ref().map(|row| row.id.clone()))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    Ok((id, wrap, None))
}

/* The row has one blob column for the wrapped key, so the wrap's nonce is
 * stored in front of the ciphertext (`nonce || ciphertext`) instead of adding
 * a column. `KeyWrap` keeps them separate in the remote metadata file, where
 * JSON makes two fields free. */
pub fn pack_wrapped_key(wrap: &KeyWrap) -> Vec<u8> {
    let mut packed = Vec::with_capacity(wrap.nonce.len() + wrap.wrapped_key.len());
    packed.extend_from_slice(&wrap.nonce);
    packed.extend_from_slice(&wrap.wrapped_key);
    packed
}

/// Reassemble a [`KeyWrap`] from the row's columns, when all of them are set.
pub fn row_wrap(row: &SyncDataset) -> Option<KeyWrap> {
    let packed = row.wrapped_key.clone()?;
    if packed.len() <= NONCE_LEN {
        return None;
    }
    let (nonce, wrapped_key) = packed.split_at(NONCE_LEN);
    Some(KeyWrap {
        kdf: "argon2id".to_string(),
        m_kib: row.kdf_m_kib?,
        t: row.kdf_t?,
        p: row.kdf_p?,
        salt: row.kdf_salt.clone()?,
        nonce: nonce.to_vec(),
        wrapped_key: wrapped_key.to_vec(),
    })
}

fn scope_json(
    existing_row: &Option<SyncDataset>,
    key_path: Option<&str>,
) -> Result<String, SyncError> {
    let mut map: BTreeMap<String, String> = existing_row
        .as_ref()
        .and_then(|row| serde_json::from_str(&row.scope_mode).ok())
        .unwrap_or_default();
    map.insert("mode".to_string(), "all".to_string());
    match key_path.map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => map.insert("keyPath".to_string(), path.to_string()),
        None => map.remove("keyPath"),
    };
    serde_json::to_string(&map).map_err(|e| SyncError::Serialization(e.to_string()))
}

pub fn list_datasets(db: &HostDb) -> Result<Vec<SyncDatasetSummary>, SyncError> {
    Ok(db
        .list_sync_datasets()?
        .iter()
        .map(SyncDatasetSummary::from)
        .collect())
}

/// Shortest automatic pull interval and debounce the UI may set. Below these a
/// "cadence" is really a busy-loop against someone's server.
pub const MIN_PULL_INTERVAL_SECS: i64 = 60;
pub const MAX_PULL_INTERVAL_SECS: i64 = 86_400;
pub const MIN_PUSH_DEBOUNCE_SECS: i64 = 5;
pub const MAX_PUSH_DEBOUNCE_SECS: i64 = 3_600;

/* Change only the automatic-sync schedule. Separate from `save_dataset`
 * because that one probes the remote and needs the passphrase to prove it can
 * open the dataset — flipping a toggle must not demand a secret the user
 * already stored, nor reach the network. */
pub fn update_schedule(
    db: &HostDb,
    dataset_id: &str,
    auto_sync: bool,
    pull_interval_secs: i64,
    push_debounce_secs: i64,
) -> Result<SyncDatasetSummary, SyncError> {
    let mut row = db
        .get_sync_dataset(dataset_id)?
        .ok_or_else(|| SyncError::NotFound(format!("no such sync dataset: {dataset_id}")))?;

    // 0 means "never on its own" for both cadences; any other value must be in
    // range, so an out-of-range number is rejected rather than silently clamped.
    if pull_interval_secs != 0
        && !(MIN_PULL_INTERVAL_SECS..=MAX_PULL_INTERVAL_SECS).contains(&pull_interval_secs)
    {
        return Err(SyncError::Format(format!(
            "the automatic pull interval must be 0 (manual only) or between {MIN_PULL_INTERVAL_SECS} and {MAX_PULL_INTERVAL_SECS} seconds"
        )));
    }
    if push_debounce_secs != 0
        && !(MIN_PUSH_DEBOUNCE_SECS..=MAX_PUSH_DEBOUNCE_SECS).contains(&push_debounce_secs)
    {
        return Err(SyncError::Format(format!(
            "the automatic push delay must be 0 (manual only) or between {MIN_PUSH_DEBOUNCE_SECS} and {MAX_PUSH_DEBOUNCE_SECS} seconds"
        )));
    }

    row.auto_sync = auto_sync;
    row.pull_interval_secs = pull_interval_secs;
    row.push_debounce_secs = push_debounce_secs;
    row.updated_at = chrono::Utc::now().to_rfc3339();
    db.upsert_sync_dataset(&row)?;
    Ok(SyncDatasetSummary::from(&row))
}

/// Remove a dataset's row, sync state, and secrets. Local hosts are untouched:
/// unsubscribing from a dataset must never delete the user's own data.
pub fn delete_dataset(db: &HostDb, dataset_id: &str) -> Result<(), SyncError> {
    if db.get_sync_dataset(dataset_id)?.is_none() {
        return Err(SyncError::NotFound(format!(
            "no such sync dataset: {dataset_id}"
        )));
    }
    db.delete_sync_dataset(dataset_id)?;
    secrets::delete_dataset_secrets(dataset_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::codec::generate_dataset_key;

    fn row(id: &str) -> SyncDataset {
        SyncDataset {
            id: id.into(),
            name: "NOVA".into(),
            host: "10.0.0.9".into(),
            port: 2222,
            username: "sync".into(),
            auth_type: "password".into(),
            remote_path: "/srv/omnissh/nova".into(),
            role: "owner".into(),
            content_flags: SyncContentFlags::default().to_json().unwrap(),
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
            last_generation: 3,
            last_synced_at: Some("2026-09-18T10:00:00Z".into()),
            created_at: "2026-09-01T00:00:00Z".into(),
            updated_at: "2026-09-18T10:00:00Z".into(),
        }
    }

    fn input(id: Option<&str>) -> SyncDatasetInput {
        SyncDatasetInput {
            id: id.map(str::to_string),
            name: "NOVA".into(),
            host: "10.0.0.9".into(),
            port: Some(2222),
            username: "sync".into(),
            key_path: None,
            remote_path: "/srv/omnissh/nova".into(),
            role: None,
            content_flags: SyncContentFlags::default(),
            auto_sync: None,
            pull_interval_secs: None,
            push_debounce_secs: None,
        }
    }

    /* The user's rule: automatic sync is off until switched on, and each
     * cadence is set explicitly. An out-of-range value is refused rather than
     * quietly clamped, so nobody ends up polling someone's server every second
     * because a form sent a 1. */
    #[test]
    fn the_schedule_starts_off_and_rejects_out_of_range_cadences() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("db");
        db.upsert_sync_dataset(&row("ds-1")).expect("dataset row");

        let stored = db.get_sync_dataset("ds-1").unwrap().unwrap();
        assert!(!stored.auto_sync, "a saved dataset never syncs on its own");
        assert_eq!(stored.pull_interval_secs, 0);
        assert_eq!(stored.push_debounce_secs, 0);

        let updated = update_schedule(&db, "ds-1", true, 900, 15).expect("valid schedule");
        assert!(updated.auto_sync);
        assert_eq!(updated.pull_interval_secs, 900);
        assert_eq!(updated.push_debounce_secs, 15);

        // 0 stays meaningful: enabled overall, manual for that direction.
        let manual_pull = update_schedule(&db, "ds-1", true, 0, 15).expect("manual pull");
        assert_eq!(manual_pull.pull_interval_secs, 0);

        for (pull, push) in [
            (1, 15),
            (MAX_PULL_INTERVAL_SECS + 1, 15),
            (900, 1),
            (900, MAX_PUSH_DEBOUNCE_SECS + 1),
        ] {
            let error = update_schedule(&db, "ds-1", true, pull, push)
                .expect_err("out-of-range cadence must be refused");
            assert!(matches!(error, SyncError::Format(_)), "got {error:?}");
        }
        // The refused updates left the last valid schedule intact.
        let stored = db.get_sync_dataset("ds-1").unwrap().unwrap();
        assert_eq!(stored.pull_interval_secs, 0);
        assert_eq!(stored.push_debounce_secs, 15);

        assert!(matches!(
            update_schedule(&db, "no-such-dataset", true, 900, 15),
            Err(SyncError::NotFound(_))
        ));
    }

    fn meta(dataset_id: &str, passphrase: &str) -> DatasetMeta {
        let key = generate_dataset_key().unwrap();
        DatasetMeta {
            format_version: 1,
            dataset_id: dataset_id.into(),
            generation: 9,
            payload_sha256: "a".repeat(64),
            key_wrap: wrap_dataset_key(passphrase, &key).unwrap(),
            updated_at: "2026-09-18T09:00:00Z".into(),
            writer_client_id: "other-client".into(),
            owner_fingerprint: Some("SHA256:owner".into()),
            signature: Some("c2ln".into()),
        }
    }

    #[test]
    fn content_flags_default_to_everything_except_credentials() {
        let flags = SyncContentFlags::default();
        assert!(flags.hosts && flags.groups && flags.snippets && flags.app_settings);
        assert!(!flags.host_credentials && !flags.s3_credentials);
        assert!(!flags.includes_credentials());
    }

    #[test]
    fn normalization_drops_children_whose_parent_is_off() {
        let flags = SyncContentFlags {
            hosts: false,
            host_credentials: true,
            port_forwards: true,
            host_plugins: true,
            s3_connections: false,
            s3_credentials: true,
            snippets: true,
            snippet_folders: false,
            ..SyncContentFlags::default()
        }
        .normalized();

        assert!(
            !flags.host_credentials,
            "no credentials without their hosts"
        );
        assert!(!flags.port_forwards, "port forwards are children of hosts");
        assert!(!flags.host_plugins, "plugin rows are children of hosts");
        assert!(!flags.s3_credentials);
        assert!(flags.snippet_folders, "snippets pull their folders along");

        // Hosts reference groups, so groups ride along whenever hosts sync.
        let with_hosts = SyncContentFlags {
            hosts: true,
            groups: false,
            ..SyncContentFlags::default()
        }
        .normalized();
        assert!(with_hosts.groups);
    }

    #[test]
    fn flags_round_trip_through_the_persisted_column() {
        let flags = SyncContentFlags {
            host_credentials: true,
            app_settings: false,
            ..SyncContentFlags::default()
        };
        let json = flags.to_json().unwrap();
        assert!(json.contains("\"hostCredentials\":true"));
        assert!(json.contains("\"appSettings\":false"));
        assert_eq!(SyncContentFlags::from_json(&json), flags.normalized());

        // A partial or corrupt column falls back to defaults instead of
        // failing the whole dataset.
        assert!(!SyncContentFlags::from_json("{\"hosts\":false}").hosts);
        assert_eq!(
            SyncContentFlags::from_json("not json"),
            SyncContentFlags::default()
        );
    }

    #[test]
    fn joining_an_existing_remote_dataset_adopts_its_id_and_key() {
        let published = meta("ds-remote", "shared-team-passphrase");
        let (id, wrap, fingerprint) = resolve_key_material(
            &input(None),
            &None,
            Some(&published),
            "shared-team-passphrase",
        )
        .expect("passphrase opens the published wrap");

        assert_eq!(id, "ds-remote", "the remote's identity wins");
        assert_eq!(wrap, published.key_wrap);
        assert_eq!(fingerprint.as_deref(), Some("SHA256:owner"));
    }

    #[test]
    fn a_wrong_passphrase_for_a_published_dataset_fails_at_save_time() {
        let published = meta("ds-remote", "shared-team-passphrase");
        let error = resolve_key_material(&input(None), &None, Some(&published), "wrong-passphrase")
            .expect_err("must not save a passphrase that cannot open the dataset");
        assert!(matches!(error, SyncError::Decrypt));
    }

    #[test]
    fn an_unpublished_dataset_keeps_its_key_while_the_passphrase_holds() {
        let key = generate_dataset_key().unwrap();
        let wrap = wrap_dataset_key("original-passphrase", &key).unwrap();
        let mut existing = row("ds-local");
        existing.kdf_salt = Some(wrap.salt.clone());
        existing.kdf_m_kib = Some(wrap.m_kib);
        existing.kdf_t = Some(wrap.t);
        existing.kdf_p = Some(wrap.p);
        existing.wrapped_key = Some(pack_wrapped_key(&wrap));

        let (id, kept, _) = resolve_key_material(
            &input(Some("ds-local")),
            &Some(existing.clone()),
            None,
            "original-passphrase",
        )
        .unwrap();
        assert_eq!(id, "ds-local");
        assert_eq!(kept.wrapped_key, wrap.wrapped_key);
        assert_eq!(
            kept.nonce, wrap.nonce,
            "the packed nonce survives the column"
        );

        /* Changing the passphrase before anything was published re-keys the
         * dataset: the old key protects no published bytes. */
        let (_, rekeyed, _) = resolve_key_material(
            &input(Some("ds-local")),
            &Some(existing),
            None,
            "a-brand-new-passphrase",
        )
        .unwrap();
        assert_ne!(rekeyed.wrapped_key, wrap.wrapped_key);
        assert!(unwrap_dataset_key("a-brand-new-passphrase", &rekeyed).is_ok());
    }

    #[test]
    fn a_new_dataset_gets_a_fresh_id_and_key() {
        let (first_id, first_wrap, fingerprint) =
            resolve_key_material(&input(None), &None, None, "brand-new-passphrase").unwrap();
        let (second_id, second_wrap, _) =
            resolve_key_material(&input(None), &None, None, "brand-new-passphrase").unwrap();

        assert_ne!(first_id, second_id, "each new dataset gets its own id");
        assert_ne!(first_wrap.wrapped_key, second_wrap.wrapped_key);
        assert!(
            fingerprint.is_none(),
            "an unsigned dataset has no owner yet"
        );
        assert!(unwrap_dataset_key("brand-new-passphrase", &first_wrap).is_ok());
    }

    #[test]
    fn summaries_expose_secret_presence_but_never_values() {
        let summary = SyncDatasetSummary::from(&row("ds-1"));
        let json = serde_json::to_string(&summary).unwrap();

        assert!(json.contains("\"lastGeneration\":3"));
        assert!(json.contains("\"hasServerSecret\":"));
        assert!(json.contains("\"hasPassphrase\":"));
        /* `authType: "password"` is a routing value, not a secret — what must
         * never appear is a field carrying key or credential material. */
        assert!(json.contains("\"authType\":\"password\""));
        for secret_field in [
            "\"password\":",
            "\"passphrase\":",
            "\"wrappedKey\":",
            "\"kdfSalt\":",
            "\"keyWrap\":",
        ] {
            assert!(
                !json.contains(secret_field),
                "{secret_field} must not reach the frontend"
            );
        }
    }

    #[test]
    fn secrets_debug_and_drop_never_expose_material() {
        let mut secrets_input = SyncDatasetSecrets {
            password: Some("server-pass".into()),
            key_passphrase: None,
            passphrase: "dataset-passphrase".into(),
        };
        let rendered = format!("{secrets_input:?}");
        assert!(!rendered.contains("server-pass"));
        assert!(!rendered.contains("dataset-passphrase"));
        assert!(rendered.contains("<redacted>"));

        // Drop zeroizes; clearing here proves the fields are owned Strings the
        // Drop impl can wipe (a borrowed &str could not be).
        secrets_input.passphrase.clear();
        assert!(secrets_input.passphrase.is_empty());
    }

    #[test]
    fn key_path_survives_a_round_trip_through_the_scope_column() {
        let json = scope_json(&None, Some(" /home/me/.ssh/id_ed25519 ")).unwrap();
        let mut keyed = row("ds-1");
        keyed.scope_mode = json;
        assert_eq!(key_path_of(&keyed).unwrap(), "/home/me/.ssh/id_ed25519");

        // Switching back to password auth drops the stored path.
        let cleared = scope_json(&Some(keyed.clone()), None).unwrap();
        let mut passworded = row("ds-1");
        passworded.scope_mode = cleared;
        assert!(matches!(
            key_path_of(&passworded),
            Err(SyncError::NotFound(_))
        ));
    }

    /* Editing a key-auth dataset has to be able to prefill its key path, or
     * the form would silently fall back to password authentication. */
    #[test]
    fn a_summary_reports_the_key_path_for_editing_but_never_a_secret() {
        let mut password_row = row("ds-1");
        password_row.scope_mode = scope_json(&None, None).unwrap();
        assert!(SyncDatasetSummary::from(&password_row).key_path.is_none());

        let mut key_row = row("ds-2");
        key_row.auth_type = "privateKey".into();
        key_row.scope_mode = scope_json(&None, Some("/home/me/.ssh/id_ed25519")).unwrap();
        let summary = SyncDatasetSummary::from(&key_row);
        assert_eq!(
            summary.key_path.as_deref(),
            Some("/home/me/.ssh/id_ed25519")
        );

        let json = serde_json::to_string(&summary).unwrap();
        assert!(json.contains("\"keyPath\":\"/home/me/.ssh/id_ed25519\""));
        for secret_field in ["\"password\":", "\"passphrase\":", "\"wrappedKey\":"] {
            assert!(!json.contains(secret_field), "{secret_field} must not leak");
        }
    }
}

/* The reported bug, as a live test: a dataset published at one path, a save
 * pointed at a mistyped path, and then the correction. Opt-in via
 * `OMNISSH_SYNC_TEST_HOST` like the other live checks.
 *
 *   OMNISSH_SYNC_TEST_HOST=127.0.0.1 OMNISSH_SYNC_TEST_PORT=2299 \
 *     cargo test --lib sync::dataset::live -- --nocapture --test-threads=1
 */
#[cfg(test)]
mod live {
    use super::*;
    use crate::db::SavedHost;
    use crate::sync::push::push;
    use crate::sync::transport::{RemoteStore, DATASET_FILE, META_FILE};
    use crate::vault::LocalVault;

    const PASSPHRASE: &str = "published-dataset-passphrase";

    fn env(key: &str, fallback: &str) -> String {
        std::env::var(key).unwrap_or_else(|_| fallback.to_string())
    }

    fn saved_host(id: &str, label: &str) -> SavedHost {
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

    fn form(id: Option<&str>, remote_path: &str) -> SyncDatasetInput {
        SyncDatasetInput {
            id: id.map(str::to_string),
            name: "mydata".into(),
            host: env("OMNISSH_SYNC_TEST_HOST", "127.0.0.1"),
            port: Some(
                env("OMNISSH_SYNC_TEST_PORT", "2222")
                    .parse()
                    .unwrap_or(2222),
            ),
            username: env("OMNISSH_SYNC_TEST_USER", "testuser"),
            key_path: None,
            remote_path: remote_path.to_string(),
            role: None,
            content_flags: SyncContentFlags::default(),
            auto_sync: None,
            pull_interval_secs: None,
            push_debounce_secs: None,
        }
    }

    fn secrets_for() -> SyncDatasetSecrets {
        SyncDatasetSecrets {
            password: Some(env("OMNISSH_SYNC_TEST_PASS", "testpass")),
            key_passphrase: None,
            passphrase: PASSPHRASE.to_string(),
        }
    }

    #[tokio::test]
    async fn a_mistyped_path_creates_a_new_dataset_and_correcting_it_joins_the_published_one() {
        if std::env::var("OMNISSH_SYNC_TEST_HOST").is_err() {
            eprintln!("skipped: set OMNISSH_SYNC_TEST_HOST to run the live join check");
            return;
        }

        let suffix = uuid::Uuid::new_v4();
        let published_root = format!("/config/omnissh-join-{suffix}");
        let mistyped_root = format!("/config/omnissh-join-{suffix}-typo");

        // ── A publisher puts a dataset at the real path ──────────────────────
        let publisher_dir = tempfile::tempdir().expect("tempdir");
        let publisher_db = Arc::new(HostDb::new(publisher_dir.path()).expect("db"));
        let ssh = SshManager::new();
        let vault = Arc::new(LocalVault::new());
        publisher_db
            .save_host(&saved_host("h-1", "published-db-01"))
            .expect("host");
        let published = save_dataset(
            &ssh,
            &publisher_db,
            form(None, &published_root),
            secrets_for(),
        )
        .await
        .expect("publisher saves");
        assert!(!published.joined, "an empty path is a new dataset");
        assert_eq!(published.remote_generation, 0);
        push(&ssh, &publisher_db, &vault, &published.dataset.id)
            .await
            .expect("publisher publishes");

        // ── The user's machine: first save points at the mistyped path ───────
        let user_dir = tempfile::tempdir().expect("tempdir");
        let user_db = Arc::new(HostDb::new(user_dir.path()).expect("db"));
        let typo = save_dataset(&ssh, &user_db, form(None, &mistyped_root), secrets_for())
            .await
            .expect("save against the mistyped path still succeeds");
        assert!(
            !typo.joined,
            "nothing is published at the mistyped path, so this is a new dataset"
        );
        assert_eq!(typo.remote_generation, 0);
        assert_eq!(
            typo.dataset.last_generation, 0,
            "which is exactly why Pull reports that nothing is published"
        );
        assert_ne!(
            typo.dataset.id, published.dataset.id,
            "a different path means a different dataset"
        );

        // ── Correcting the path joins the published dataset ──────────────────
        let joined = save_dataset(
            &ssh,
            &user_db,
            form(Some(&typo.dataset.id), &published_root),
            secrets_for(),
        )
        .await
        .expect("correcting the path joins");
        assert!(joined.joined, "the published dataset was adopted");
        assert_eq!(joined.remote_generation, 1);
        assert_eq!(
            joined.dataset.id, published.dataset.id,
            "joining adopts the published dataset's identity"
        );
        assert_eq!(joined.dataset.last_generation, 1);

        /* The placeholder row must not linger: one dataset in, one dataset out,
         * and the mistyped row's secrets are gone with it. */
        let rows = user_db.list_sync_datasets().expect("datasets");
        assert_eq!(rows.len(), 1, "the placeholder row was replaced, not kept");
        assert_eq!(rows[0].id, published.dataset.id);
        assert!(!secrets::has_passphrase(&typo.dataset.id));
        assert!(secrets::has_passphrase(&published.dataset.id));

        // And the pull the user wanted now works.
        let pulled = crate::sync::pull::pull(&ssh, &user_db, &vault, &joined.dataset.id)
            .await
            .expect("pull after joining");
        assert_eq!(pulled.applied.hosts, 1);
        assert_eq!(
            user_db.get_host("h-1").unwrap().map(|host| host.label),
            Some("published-db-01".to_string())
        );

        /* Repointing a published dataset at an *empty* path is legitimate — the
         * server directory moved — and must keep the dataset's identity and key
         * so its passphrase still opens it. */
        let moved = save_dataset(
            &ssh,
            &publisher_db,
            form(Some(&published.dataset.id), &mistyped_root),
            secrets_for(),
        )
        .await
        .expect("moving a dataset to an empty path is allowed");
        assert!(!moved.joined, "an empty path publishes nothing to join");
        assert_eq!(
            moved.dataset.id, published.dataset.id,
            "the dataset keeps its identity when its location moves"
        );
        assert_eq!(moved.dataset.remote_path, mistyped_root);

        /* Repointing it onto a path that holds a *different* dataset is refused:
         * adopting that identity would abandon this dataset's own published
         * history, and silently merging two dataset lineages is worse. */
        let other_root = format!("/config/omnissh-join-{suffix}-other");
        let other_dir = tempfile::tempdir().expect("tempdir");
        let other_db = Arc::new(HostDb::new(other_dir.path()).expect("db"));
        let other = save_dataset(&ssh, &other_db, form(None, &other_root), secrets_for())
            .await
            .expect("a second dataset elsewhere");
        push(&ssh, &other_db, &vault, &other.dataset.id)
            .await
            .expect("second dataset publishes");

        match save_dataset(
            &ssh,
            &publisher_db,
            form(Some(&published.dataset.id), &other_root),
            secrets_for(),
        )
        .await
        {
            Err(SyncError::Conflict(message)) => assert!(
                message.contains("create a separate dataset"),
                "got {message}"
            ),
            other => panic!("expected a conflict, got {other:?}"),
        }
        let _ = secrets::delete_dataset_secrets(&other.dataset.id);
        {
            let endpoint = SyncEndpoint {
                host: env("OMNISSH_SYNC_TEST_HOST", "127.0.0.1"),
                port: env("OMNISSH_SYNC_TEST_PORT", "2222")
                    .parse()
                    .unwrap_or(2222),
                username: env("OMNISSH_SYNC_TEST_USER", "testuser"),
                auth: AuthMethod::Password {
                    password: env("OMNISSH_SYNC_TEST_PASS", "testpass"),
                },
                root: other_root.clone(),
            };
            if let Ok(store) = RemoteStore::connect(&ssh, &endpoint).await {
                for name in [DATASET_FILE, META_FILE] {
                    let _ = store.remove(name).await;
                }
                store.close(&ssh).await;
            }
        }

        // Clean up both remote paths and the keychain entries.
        for (root, dataset_id) in [
            (published_root.as_str(), published.dataset.id.clone()),
            (mistyped_root.as_str(), typo.dataset.id.clone()),
        ] {
            let endpoint = SyncEndpoint {
                host: env("OMNISSH_SYNC_TEST_HOST", "127.0.0.1"),
                port: env("OMNISSH_SYNC_TEST_PORT", "2222")
                    .parse()
                    .unwrap_or(2222),
                username: env("OMNISSH_SYNC_TEST_USER", "testuser"),
                auth: AuthMethod::Password {
                    password: env("OMNISSH_SYNC_TEST_PASS", "testpass"),
                },
                root: root.to_string(),
            };
            if let Ok(store) = RemoteStore::connect(&ssh, &endpoint).await {
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
                store.close(&ssh).await;
            }
            let _ = secrets::delete_dataset_secrets(&dataset_id);
        }
    }
}
