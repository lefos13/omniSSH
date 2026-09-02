/*
 * Termius import policy stays separate from the low-level reader: normalized
 * records are retained only behind an opaque, expiring Rust-side preview and
 * credentials are materialized solely inside the blocking commit path.
 */

use super::envelope;
use super::source::{decode_record_value, IdbKey, Row, SourceRows};
use super::v8::{self, Value};
use super::{crypto, datadir, localkey, source};
use crate::db::{CredentialStorage, HostDb, HostGroup, SavedHost};
use crate::vault::{self, LocalVault, StoredCredential, VaultError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::task;
use zeroize::Zeroize;

pub const MAX_PREVIEW_STATES: usize = 32;
pub const MAX_PREVIEW_HOSTS: usize = 10_000;
pub const MAX_PREVIEW_GROUPS: usize = 10_000;
pub const PREVIEW_TTL_SECONDS: u64 = 10 * 60;
pub const MAX_RETAINED_PREVIEW_BYTES: usize = 128 * 1024 * 1024;
const MAX_FIELD_LENGTH: usize = 16 * 1024;
const MAX_REFERENCE_COUNT: usize = 8;
const MAX_WARNING_COUNT: usize = 64;
const MAX_PREVIEW_ROWS: usize = MAX_PREVIEW_HOSTS * 4 + MAX_PREVIEW_GROUPS * 2;
const HOST_DATABASES: &[&str] = &["hosts"];
const CONFIG_DATABASES: &[&str] = &["ssh_configs"];
const GROUP_DATABASES: &[&str] = &["groups"];
const CREDENTIAL_DATABASES: &[&str] = &["keys", "ssh_identities"];
const PROXY_DATABASES: &[&str] = &["proxies"];
const WARN_UNSUPPORTED_RECORD: &str = "Some Termius records could not be read";
const WARN_PROXY_NOT_LINKED: &str = "Proxy settings were preserved but not linked automatically";
const WARN_PROXY_RELATIONSHIP: &str = "Some Termius proxy relationships were not imported";
const WARN_PROXY_UNSAFE: &str = "A free-form Termius proxy value was not imported";
const WARN_CREDENTIAL_RELATIONSHIP: &str =
    "Some Termius credential relationships could not be resolved";
const WARN_MISSING_GROUP: &str = "Some host group references could not be resolved";
const WARN_INCOMPARABLE_UPDATE: &str = "Some Termius update markers could not be compared";
const WARN_CLEANUP_PENDING: &str = "Some unused credential entries are pending cleanup";

const SOURCE_ID_ALIASES: &[&str] = &["id", "_id", "uuid"];
const HOST_ENTITY_ID_ALIASES: &[&str] = &["id", "_id", "uuid", "hostId", "host_id"];
const CONFIG_ENTITY_ID_ALIASES: &[&str] = &[
    "id",
    "_id",
    "uuid",
    "sshConfigId",
    "ssh_config_id",
    "configId",
    "config_id",
];
const IDENTITY_ENTITY_ID_ALIASES: &[&str] = &[
    "id",
    "_id",
    "uuid",
    "identityId",
    "identity_id",
    "sshIdentityId",
    "ssh_identity_id",
];
const KEY_ENTITY_ID_ALIASES: &[&str] = &[
    "id",
    "_id",
    "uuid",
    "keyId",
    "key_id",
    "sshKeyId",
    "ssh_key_id",
];
const GROUP_ENTITY_ID_ALIASES: &[&str] = &[
    "id",
    "_id",
    "uuid",
    "groupId",
    "group_id",
    "folderId",
    "folder_id",
];
const PROXY_ENTITY_ID_ALIASES: &[&str] = &["id", "_id", "uuid", "proxyId", "proxy_id"];
const LOCAL_ID_ALIASES: &[&str] = &["localId", "local_id", "localID", "local"];
const LABEL_ALIASES: &[&str] = &["label", "name", "title", "displayName", "display_name"];
const ADDRESS_ALIASES: &[&str] = &[
    "address",
    "host",
    "hostname",
    "hostName",
    "hostnameOrIp",
    "hostname_or_ip",
    "server",
    "ip",
];
const USERNAME_ALIASES: &[&str] = &["username", "userName", "user_name", "user", "login"];
const PORT_ALIASES: &[&str] = &["port", "serverPort", "server_port", "sshPort", "ssh_port"];
const GROUP_ALIASES: &[&str] = &[
    "groupId",
    "group_id",
    "folderId",
    "folder_id",
    "group",
    "folder",
    "parentGroupId",
    "parent_group_id",
];
const GROUP_NAME_ALIASES: &[&str] = &["name", "label", "title", "displayName", "display_name"];
const PARENT_GROUP_ALIASES: &[&str] = &[
    "parentId",
    "parent_id",
    "parentGroupId",
    "parent_group_id",
    "parent",
];
const PASSWORD_ALIASES: &[&str] = &[
    "password",
    "pass",
    "secret",
    "loginPassword",
    "login_password",
    "sshPassword",
    "ssh_password",
];
const PRIVATE_KEY_ALIASES: &[&str] = &[
    "privateKey",
    "private_key",
    "privateKeyData",
    "private_key_data",
    "keyData",
    "key_data",
];
const PASSPHRASE_ALIASES: &[&str] = &[
    "passphrase",
    "keyPassphrase",
    "key_passphrase",
    "privateKeyPassphrase",
    "private_key_passphrase",
];
const KEY_PATH_ALIASES: &[&str] = &[
    "keyPath",
    "key_path",
    "privateKeyPath",
    "private_key_path",
    "identityFile",
    "identity_file",
];
const NOTES_ALIASES: &[&str] = &["notes", "note", "description", "comment"];
const STARTUP_ALIASES: &[&str] = &[
    "startupCommand",
    "startup_command",
    "startup",
    "initialCommand",
    "initial_command",
];
const START_DIRECTORY_ALIASES: &[&str] = &[
    "startDirectory",
    "start_directory",
    "initialDirectory",
    "initial_directory",
    "remotePath",
    "remote_path",
];
const PROXY_ALIASES: &[&str] = &[
    "proxy",
    "proxyId",
    "proxy_id",
    "proxyHost",
    "proxy_host",
    "jumpHost",
    "jump_host",
    "bastion",
];
const HOST_CONFIG_REFERENCE_ALIASES: &[&str] = &[
    "ssh_config",
    "sshConfig",
    "ssh_config_id",
    "sshConfigId",
    "config",
    "config_id",
    "configId",
];
const IDENTITY_REFERENCE_ALIASES: &[&str] = &[
    "identity",
    "ssh_identity",
    "sshIdentity",
    "identity_id",
    "identityId",
    "ssh_identity_id",
    "sshIdentityId",
];
const SSH_KEY_REFERENCE_ALIASES: &[&str] = &[
    "ssh_key",
    "sshKey",
    "ssh_key_id",
    "sshKeyId",
    "key",
    "key_id",
    "keyId",
];
const PROXY_REFERENCE_ALIASES: &[&str] = &[
    "proxycommand",
    "proxyCommand",
    "proxy_command",
    "proxy",
    "proxyId",
    "proxy_id",
    "proxyHostId",
    "proxy_host_id",
    "jumpHostId",
    "jump_host_id",
    "bastionId",
    "bastion_id",
];
const PROXY_TARGET_ALIASES: &[&str] = &[
    "targetId",
    "target_id",
    "targetIds",
    "target_ids",
    "hostId",
    "host_id",
    "hostIds",
    "host_ids",
    "proxyHostId",
    "proxy_host_id",
    "jumpHostId",
    "jump_host_id",
    "targets",
    "targetHosts",
    "target_hosts",
    "target",
    "targetHost",
    "target_host",
    "proxyHost",
    "proxy_host",
    "jumpHost",
    "jump_host",
];
const UPDATED_AT_ALIASES: &[&str] = &[
    "updated_at",
    "updatedAt",
    "modified_at",
    "modifiedAt",
    "lastUpdated",
    "last_updated",
    "timestamp",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermiusPreviewRequest {
    #[serde(default, alias = "sourcePath")]
    pub source_path: Option<String>,
    #[serde(default = "default_metadata_only", alias = "metadataOnly")]
    pub metadata_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermiusCommitRequest {
    #[serde(alias = "previewToken")]
    pub preview_token: String,
    #[serde(alias = "selectedIds", alias = "selected_host_ids")]
    pub selected_ids: Vec<String>,
    #[serde(alias = "includeCredentials")]
    pub include_credentials: bool,
    #[serde(
        alias = "credentialsConfirmed",
        alias = "credentialConfirmation",
        alias = "confirmCredentials"
    )]
    pub credentials_confirmed: bool,
    #[serde(alias = "credentialStorage", default)]
    pub credential_storage: CredentialStorage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermiusPreviewResponse {
    pub preview_token: String,
    pub metadata_only: bool,
    pub hosts: Vec<TermiusHostPreview>,
    pub groups: Vec<TermiusGroupPreview>,
    pub counts: TermiusPreviewCounts,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermiusHostPreview {
    pub id: String,
    pub label: String,
    pub address: String,
    pub username: String,
    pub port: u16,
    pub group_id: Option<String>,
    pub notes: Option<String>,
    pub startup_command: Option<String>,
    pub start_directory: Option<String>,
    pub key_path: Option<String>,
    pub proxy: Option<String>,
    pub credential_available: bool,
    pub has_password: bool,
    pub has_private_key: bool,
    pub already_exists: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermiusGroupPreview {
    pub id: String,
    pub name: String,
    pub host_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermiusPreviewCounts {
    pub hosts: usize,
    pub groups: usize,
    pub credential_available: usize,
    pub already_exists: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermiusCommitResponse {
    pub imported_hosts: usize,
    pub imported_groups: usize,
    pub skipped_hosts: usize,
    pub credentials_stored: usize,
    pub credentials_in_vault: usize,
    pub credentials_in_keychain: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TermiusImportError {
    #[error("Termius data was not found")]
    SourceUnavailable,
    #[error("Termius data could not be read")]
    SourceRead,
    #[error("Termius must be closed before importing")]
    SourceRunning,
    #[error("Termius import preview is too large")]
    PreviewLimit,
    #[error("too many Termius import previews are active")]
    TooManyPreviews,
    #[error("Termius import preview expired")]
    PreviewExpired,
    #[error("selected Termius import entries are invalid")]
    InvalidSelection,
    #[error("credential import requires explicit confirmation")]
    CredentialsConfirmationRequired,
    #[error("selected Termius credentials are unavailable")]
    CredentialsUnavailable,
    #[error("Termius encrypted metadata could not be decrypted")]
    MetadataUnavailable,
    #[error("Termius import could not be completed")]
    CommitFailed,
    #[error("Termius credential cleanup is pending")]
    CleanupPending,
}
impl Serialize for TermiusImportError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        let mut state = serializer.serialize_struct("TermiusImportError", 2)?;
        let kind = match self {
            Self::SourceUnavailable => "source_unavailable",
            Self::SourceRead => "source_read",
            Self::SourceRunning => "source_running",
            Self::PreviewLimit => "preview_limit",
            Self::TooManyPreviews => "too_many_previews",
            Self::PreviewExpired => "preview_expired",
            Self::InvalidSelection => "invalid_selection",
            Self::CredentialsConfirmationRequired => "credentials_confirmation_required",
            Self::CredentialsUnavailable => "credentials_unavailable",
            Self::MetadataUnavailable => "metadata_unavailable",
            Self::CommitFailed => "commit_failed",
            Self::CleanupPending => "cleanup_pending",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

#[derive(Clone, PartialEq, Eq)]
struct SecretText {
    value: String,
}

impl Drop for SecretText {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

#[derive(Clone)]
struct NormalizedHost {
    source_id: String,
    public_id: String,
    label: String,
    address: String,
    username: String,
    port: u16,
    group_source_id: Option<String>,
    notes: Option<String>,
    startup_command: Option<String>,
    start_directory: Option<String>,
    key_path: Option<String>,
    proxy: Option<String>,
    password: Option<SecretText>,
    private_key: Option<SecretText>,
    passphrase: Option<SecretText>,
    warnings: Vec<String>,
}

#[derive(Clone)]
struct NormalizedGroup {
    source_id: String,
    public_id: String,
    name: String,
    parent_source_id: Option<String>,
}

#[derive(Clone)]
struct NormalizedImport {
    hosts: Vec<NormalizedHost>,
    groups: Vec<NormalizedGroup>,
    warnings: Vec<String>,
}

/* LevelDB can retain several live historical rows for one IndexedDB entity.
 * This index keeps only the greatest bounded update marker, aliases both
 * persisted identifiers, and owns decoded values behind a zeroizing drop. */
#[derive(Clone, Default)]
struct SourceRef {
    id: Option<String>,
    local_id: Option<String>,
}

impl SourceRef {
    fn is_empty(&self) -> bool {
        self.id.is_none() && self.local_id.is_none()
    }

    fn aliases(&self) -> impl Iterator<Item = String> + '_ {
        self.id
            .iter()
            .map(|value| format!("id:{value}"))
            .chain(self.local_id.iter().map(|value| format!("local:{value}")))
    }

    fn first_value(&self) -> Option<String> {
        self.id.clone().or_else(|| self.local_id.clone())
    }
}

fn merge_source_refs(destination: &mut SourceRef, incoming: &SourceRef) {
    if destination.id.is_none() {
        destination.id = incoming.id.clone();
    }
    if destination.local_id.is_none() {
        destination.local_id = incoming.local_id.clone();
    }
}

#[derive(Clone, PartialEq, Eq)]
enum UpdatedAt {
    Missing,
    Chronological(i128),
    Incomparable,
}

fn compare_updated_at(left: &UpdatedAt, right: &UpdatedAt) -> std::cmp::Ordering {
    match (left, right) {
        (UpdatedAt::Chronological(left), UpdatedAt::Chronological(right)) => left.cmp(right),
        (UpdatedAt::Chronological(_), _) => std::cmp::Ordering::Greater,
        (_, UpdatedAt::Chronological(_)) => std::cmp::Ordering::Less,
        _ => std::cmp::Ordering::Equal,
    }
}

struct SecretValue(Value);

impl Drop for SecretValue {
    fn drop(&mut self) {
        zeroize_value(&mut self.0);
    }
}

struct VersionedValue {
    ids: SourceRef,
    aliases: BTreeSet<String>,
    updated_at: UpdatedAt,
    row_index: usize,
    value: SecretValue,
}

fn version_is_newer(incoming: &VersionedValue, current: &VersionedValue) -> bool {
    compare_updated_at(&incoming.updated_at, &current.updated_at)
        .then_with(|| incoming.row_index.cmp(&current.row_index))
        == std::cmp::Ordering::Greater
}

struct VersionedValueIndex {
    records: BTreeMap<String, VersionedValue>,
    aliases: HashMap<String, String>,
    namespace: &'static str,
    incomparable_update: bool,
}

impl VersionedValueIndex {
    fn new(namespace: &'static str) -> Self {
        Self {
            records: BTreeMap::new(),
            aliases: HashMap::new(),
            namespace,
            incomparable_update: false,
        }
    }

    fn insert_value(
        &mut self,
        value: Value,
        key: &IdbKey,
        row_index: usize,
        entity_id_aliases: &[&str],
    ) -> bool {
        let Some(object) = object_value(&value) else {
            let mut value = value;
            zeroize_value(&mut value);
            return false;
        };
        let mut ids = SourceRef {
            id: field_identifier(object, entity_id_aliases),
            local_id: field_identifier(object, LOCAL_ID_ALIASES),
        };
        let storage_key = idb_key_identifier(key);
        if ids.is_empty() {
            ids.id = storage_key.clone();
        }
        let updated_at = field_updated_at(object);
        if updated_at == UpdatedAt::Incomparable {
            self.incomparable_update = true;
        }
        let mut incoming = VersionedValue {
            ids,
            aliases: BTreeSet::new(),
            updated_at,
            row_index,
            value: SecretValue(value),
        };
        incoming.aliases.extend(incoming.ids.aliases());
        if let Some(storage_key) = storage_key {
            /* IndexedDB's primary key is stable across historical writes;
             * retain it as a join-only alias when an old/new row exposes only
             * one side of the id/local_id pair. */
            incoming.aliases.insert(format!("storage:{storage_key}"));
        }
        let matches = incoming
            .aliases
            .iter()
            .filter_map(|alias| self.aliases.get(alias).cloned())
            .collect::<HashSet<_>>();
        let canonical = matches
            .iter()
            .filter_map(|candidate| {
                self.records
                    .get(candidate)
                    .map(|record| (candidate, record))
            })
            .max_by(|(left_key, left), (right_key, right)| {
                compare_updated_at(&left.updated_at, &right.updated_at)
                    .then_with(|| left.row_index.cmp(&right.row_index))
                    .then_with(|| left_key.cmp(right_key))
            })
            .map(|(candidate, _)| candidate.clone())
            .unwrap_or_else(|| {
                incoming.ids.first_value().map_or_else(
                    || format!("{}:{row_index}", self.namespace),
                    |id| format!("{}:{id}", self.namespace),
                )
            });

        for candidate in &matches {
            if let Some(record) = self.records.get(candidate) {
                merge_source_refs(&mut incoming.ids, &record.ids);
                incoming.aliases.extend(record.aliases.iter().cloned());
            }
        }

        for candidate in matches {
            if candidate != canonical {
                self.records.remove(&candidate);
            }
        }
        let should_replace = self
            .records
            .get(&canonical)
            .is_none_or(|current| version_is_newer(&incoming, current));
        if should_replace {
            self.records.insert(canonical, incoming);
        } else if let Some(current) = self.records.get_mut(&canonical) {
            merge_source_refs(&mut current.ids, &incoming.ids);
            current.aliases.extend(incoming.aliases);
        }
        self.rebuild_aliases();
        true
    }

    fn rebuild_aliases(&mut self) {
        self.aliases.clear();
        for (canonical, record) in &self.records {
            for alias in &record.aliases {
                self.aliases.insert(alias.clone(), canonical.clone());
            }
        }
    }

    fn resolve_record(&self, reference: &SourceRef) -> Option<&VersionedValue> {
        reference
            .id
            .as_ref()
            .and_then(|id| self.aliases.get(&format!("id:{id}")))
            .or_else(|| {
                reference
                    .local_id
                    .as_ref()
                    .and_then(|id| self.aliases.get(&format!("local:{id}")))
            })
            .and_then(|canonical| self.records.get(canonical))
    }

    fn resolve_value(&self, reference: &SourceRef) -> Option<&Value> {
        self.resolve_record(reference).map(|record| &record.value.0)
    }

    fn values_in_source_order(&self) -> Vec<&VersionedValue> {
        let mut values = self.records.values().collect::<Vec<_>>();
        values.sort_by(|left, right| {
            left.row_index
                .cmp(&right.row_index)
                .then_with(|| compare_updated_at(&left.updated_at, &right.updated_at))
        });
        values
    }
}

struct SourceIndexes {
    hosts: VersionedValueIndex,
    configs: VersionedValueIndex,
    identities: VersionedValueIndex,
    keys: VersionedValueIndex,
    groups: VersionedValueIndex,
    proxies: VersionedValueIndex,
}

impl SourceIndexes {
    fn new() -> Self {
        Self {
            hosts: VersionedValueIndex::new("host"),
            configs: VersionedValueIndex::new("config"),
            identities: VersionedValueIndex::new("identity"),
            keys: VersionedValueIndex::new("key"),
            groups: VersionedValueIndex::new("group"),
            proxies: VersionedValueIndex::new("proxy"),
        }
    }
}

struct PendingPreview {
    normalized: NormalizedImport,
    created_at: Instant,
    retained_bytes: usize,
    #[cfg(test)]
    drop_probe: Option<std::sync::Arc<PendingDropProbe>>,
}

#[derive(Default)]
struct PreviewStore {
    previews: HashMap<String, PendingPreview>,
    retained_bytes: usize,
}

#[cfg(test)]
struct PendingDropProbe {
    dropped: std::sync::atomic::AtomicUsize,
    wake: std::sync::Condvar,
    wait_lock: Mutex<()>,
}

#[cfg(test)]
impl PendingDropProbe {
    fn new() -> Self {
        Self {
            dropped: std::sync::atomic::AtomicUsize::new(0),
            wake: std::sync::Condvar::new(),
            wait_lock: Mutex::new(()),
        }
    }

    fn wait_for_drop(&self, timeout: Duration) -> bool {
        let guard = self.wait_lock.lock().unwrap();
        let (guard, _) = self
            .wake
            .wait_timeout_while(guard, timeout, |_| {
                self.dropped.load(std::sync::atomic::Ordering::SeqCst) == 0
            })
            .unwrap();
        drop(guard);
        self.dropped.load(std::sync::atomic::Ordering::SeqCst) > 0
    }
}

pub struct TermiusImportState {
    previews: Arc<Mutex<PreviewStore>>,
    ttl: Duration,
    byte_limit: usize,
    commit_lock: Mutex<()>,
}

impl Default for TermiusImportState {
    fn default() -> Self {
        Self::new()
    }
}

impl TermiusImportState {
    pub fn new() -> Self {
        Self::with_ttl(Duration::from_secs(PREVIEW_TTL_SECONDS))
    }

    fn with_ttl(ttl: Duration) -> Self {
        Self::with_limits(ttl, MAX_RETAINED_PREVIEW_BYTES)
    }

    fn with_limits(ttl: Duration, byte_limit: usize) -> Self {
        let ttl = std::cmp::max(ttl, Duration::from_millis(1));
        let previews = Arc::new(Mutex::new(PreviewStore::default()));
        Self {
            previews,
            ttl,
            byte_limit,
            commit_lock: Mutex::new(()),
        }
    }

    fn insert(&self, normalized: NormalizedImport) -> Result<String, TermiusImportError> {
        self.insert_at(normalized, Instant::now())
    }

    fn insert_at(
        &self,
        normalized: NormalizedImport,
        created_at: Instant,
    ) -> Result<String, TermiusImportError> {
        let token = uuid::Uuid::new_v4().to_string();
        self.insert_with_token(token, normalized, created_at)
    }

    fn insert_with_token(
        &self,
        token: String,
        normalized: NormalizedImport,
        created_at: Instant,
    ) -> Result<String, TermiusImportError> {
        self.insert_pending(
            token,
            PendingPreview {
                retained_bytes: normalized_retained_bytes(&normalized)?,
                normalized,
                created_at,
                #[cfg(test)]
                drop_probe: None,
            },
        )
    }

    fn insert_pending(
        &self,
        token: String,
        pending: PendingPreview,
    ) -> Result<String, TermiusImportError> {
        let mut store = self
            .previews
            .lock()
            .map_err(|_| TermiusImportError::CommitFailed)?;
        purge_expired(&mut store, self.ttl, Instant::now());
        if store.previews.len() >= MAX_PREVIEW_STATES {
            return Err(TermiusImportError::TooManyPreviews);
        }
        let next_bytes = store
            .retained_bytes
            .checked_add(pending.retained_bytes)
            .ok_or(TermiusImportError::PreviewLimit)?;
        if next_bytes > self.byte_limit {
            return Err(TermiusImportError::PreviewLimit);
        }
        store.retained_bytes = next_bytes;
        store.previews.insert(token.clone(), pending);
        drop(store);

        /* A per-token weak timer removes expired normalized records without
         * retaining the state or its secrets. Thread creation is fail-closed:
         * if the eviction mechanism cannot be installed, the just-inserted
         * preview is removed before returning an error. */
        let weak_previews = Arc::downgrade(&self.previews);
        let timer_token = token.clone();
        let ttl = self.ttl;
        if std::thread::Builder::new()
            .name("termius-preview-expiry".to_string())
            .spawn(move || {
                std::thread::sleep(ttl);
                if let Some(previews) = weak_previews.upgrade() {
                    evict_token(&previews, &timer_token, ttl, Instant::now());
                }
            })
            .is_err()
        {
            if let Ok(mut store) = self.previews.lock() {
                remove_preview(&mut store, &token);
            }
            return Err(TermiusImportError::CommitFailed);
        }
        Ok(token)
    }

    fn take(&self, token: &str) -> Result<PendingPreview, TermiusImportError> {
        let mut store = self
            .previews
            .lock()
            .map_err(|_| TermiusImportError::CommitFailed)?;
        purge_expired(&mut store, self.ttl, Instant::now());
        remove_preview(&mut store, token).ok_or(TermiusImportError::PreviewExpired)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.previews.lock().unwrap().previews.len()
    }

    #[cfg(test)]
    fn retained_bytes(&self) -> usize {
        self.previews.lock().unwrap().retained_bytes
    }

    #[cfg(test)]
    fn insert_pending_for_test(
        &self,
        token: String,
        pending: PendingPreview,
    ) -> Result<String, TermiusImportError> {
        self.insert_pending(token, pending)
    }
}

struct SourceRowsGuard(SourceRows);

impl Drop for SourceRowsGuard {
    fn drop(&mut self) {
        for row in &mut self.0.rows {
            row.value_bytes.zeroize();
            zeroize_idb_key(&mut row.idb_key);
        }
    }
}

fn is_expired(created_at: Instant, now: Instant, ttl: Duration) -> bool {
    now.checked_duration_since(created_at)
        .is_some_and(|elapsed| elapsed >= ttl)
}

fn remove_preview(store: &mut PreviewStore, token: &str) -> Option<PendingPreview> {
    let preview = store.previews.remove(token)?;
    store.retained_bytes = store.retained_bytes.saturating_sub(preview.retained_bytes);
    Some(preview)
}

fn purge_expired(store: &mut PreviewStore, ttl: Duration, now: Instant) {
    let expired = store
        .previews
        .iter()
        .filter(|(_, preview)| is_expired(preview.created_at, now, ttl))
        .map(|(token, _)| token.clone())
        .collect::<Vec<_>>();
    for token in expired {
        remove_preview(store, &token);
    }
}

fn evict_token(previews: &Mutex<PreviewStore>, token: &str, ttl: Duration, now: Instant) {
    if let Ok(mut store) = previews.lock() {
        if store
            .previews
            .get(token)
            .is_some_and(|preview| is_expired(preview.created_at, now, ttl))
        {
            remove_preview(&mut store, token);
        }
    }
}

fn normalized_retained_bytes(normalized: &NormalizedImport) -> Result<usize, TermiusImportError> {
    /* Count every retained source-derived string before insertion. The budget
     * deliberately ignores allocator slack, so it is conservative enough to
     * cap payload growth while remaining deterministic across platforms. */
    let mut total = 0usize;
    let mut add = |value: &str| -> Result<(), TermiusImportError> {
        total = total
            .checked_add(value.len())
            .ok_or(TermiusImportError::PreviewLimit)?;
        Ok(())
    };
    for host in &normalized.hosts {
        for value in [
            Some(host.source_id.as_str()),
            Some(host.public_id.as_str()),
            Some(host.label.as_str()),
            Some(host.address.as_str()),
            Some(host.username.as_str()),
            host.group_source_id.as_deref(),
            host.notes.as_deref(),
            host.startup_command.as_deref(),
            host.start_directory.as_deref(),
            host.key_path.as_deref(),
            host.proxy.as_deref(),
            host.password.as_ref().map(|value| value.value.as_str()),
            host.private_key.as_ref().map(|value| value.value.as_str()),
            host.passphrase.as_ref().map(|value| value.value.as_str()),
        ]
        .into_iter()
        .flatten()
        {
            add(value)?;
        }
        for warning in &host.warnings {
            add(warning)?;
        }
    }
    for group in &normalized.groups {
        add(&group.source_id)?;
        add(&group.public_id)?;
        add(&group.name)?;
        if let Some(parent) = group.parent_source_id.as_deref() {
            add(parent)?;
        }
    }
    for warning in &normalized.warnings {
        add(warning)?;
    }
    Ok(total)
}

#[cfg(test)]
impl Drop for PendingPreview {
    fn drop(&mut self) {
        if let Some(probe) = self.drop_probe.as_ref() {
            probe
                .dropped
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            probe.wake.notify_all();
        }
    }
}

impl Default for TermiusPreviewRequest {
    fn default() -> Self {
        Self {
            source_path: None,
            metadata_only: true,
        }
    }
}

fn default_metadata_only() -> bool {
    true
}

/* Termius records may contain encrypted metadata fields (e.g. host label/address,
 * username, notes, group names, startup commands, and relationship IDs) alongside
 * credential secrets. Decryption keys are discovered against authenticated envelope
 * samples before building the index. Metadata fields are decrypted for preview,
 * while credential fields remain retained as ciphertext until explicit commit. */
fn is_metadata_field_name(name: &str) -> bool {
    [
        SOURCE_ID_ALIASES,
        HOST_ENTITY_ID_ALIASES,
        CONFIG_ENTITY_ID_ALIASES,
        IDENTITY_ENTITY_ID_ALIASES,
        KEY_ENTITY_ID_ALIASES,
        GROUP_ENTITY_ID_ALIASES,
        PROXY_ENTITY_ID_ALIASES,
        LOCAL_ID_ALIASES,
        LABEL_ALIASES,
        ADDRESS_ALIASES,
        USERNAME_ALIASES,
        PORT_ALIASES,
        GROUP_ALIASES,
        GROUP_NAME_ALIASES,
        PARENT_GROUP_ALIASES,
        KEY_PATH_ALIASES,
        NOTES_ALIASES,
        STARTUP_ALIASES,
        START_DIRECTORY_ALIASES,
        PROXY_ALIASES,
        HOST_CONFIG_REFERENCE_ALIASES,
        IDENTITY_REFERENCE_ALIASES,
        SSH_KEY_REFERENCE_ALIASES,
        PROXY_REFERENCE_ALIASES,
        PROXY_TARGET_ALIASES,
        UPDATED_AT_ALIASES,
    ]
    .into_iter()
    .flatten()
    .any(|alias| name.eq_ignore_ascii_case(alias))
}

fn collect_encrypted_samples(
    value: &Value,
    samples: &mut Vec<SecretText>,
    limit: usize,
    approved: bool,
) {
    if samples.len() >= limit {
        return;
    }
    match value {
        Value::String(s) if approved => {
            if envelope::parse(s).is_ok_and(|parsed| parsed.is_some())
                && !samples.iter().any(|sample| sample.value == *s)
            {
                samples.push(SecretText { value: s.clone() });
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_encrypted_samples(item, samples, limit, approved);
                if samples.len() >= limit {
                    break;
                }
            }
        }
        Value::Object(map) => {
            for (field_name, field_value) in map {
                collect_encrypted_samples(
                    field_value,
                    samples,
                    limit,
                    is_metadata_field_name(field_name) && !is_secret_field_name(field_name),
                );
                if samples.len() >= limit {
                    break;
                }
            }
        }
        _ => {}
    }
}

fn collect_encrypted_idb_key_samples(key: &IdbKey, samples: &mut Vec<SecretText>, limit: usize) {
    if samples.len() >= limit {
        return;
    }
    match key {
        IdbKey::String(value) if envelope::parse(value).is_ok_and(|parsed| parsed.is_some()) => {
            if !samples.iter().any(|sample| sample.value == *value) {
                samples.push(SecretText {
                    value: value.clone(),
                });
            }
        }
        IdbKey::Array(values) => {
            for value in values {
                collect_encrypted_idb_key_samples(value, samples, limit);
                if samples.len() >= limit {
                    break;
                }
            }
        }
        _ => {}
    }
}

fn is_secret_field_name(name: &str) -> bool {
    PASSWORD_ALIASES
        .iter()
        .chain(PRIVATE_KEY_ALIASES)
        .chain(PASSPHRASE_ALIASES)
        .any(|alias| name.eq_ignore_ascii_case(alias))
}

fn decrypt_metadata_string(
    s: &mut String,
    key: Option<&[u8; 32]>,
) -> Result<(), TermiusImportError> {
    match envelope::parse(s) {
        Ok(Some(_)) => {
            let Some(key) = key else {
                return Err(TermiusImportError::MetadataUnavailable);
            };
            let mut plaintext =
                crypto::decrypt(key, s).map_err(|_| TermiusImportError::MetadataUnavailable)?;
            let text = std::str::from_utf8(&plaintext)
                .map(str::to_string)
                .map_err(|_| TermiusImportError::MetadataUnavailable);
            plaintext.zeroize();
            let text = text?;
            let mut encrypted = std::mem::replace(s, text);
            encrypted.zeroize();
            Ok(())
        }
        Err(_) => Err(TermiusImportError::MetadataUnavailable),
        Ok(None) => Ok(()),
    }
}

fn decrypt_metadata_value(
    value: &mut Value,
    key: Option<&[u8; 32]>,
    approved: bool,
) -> Result<(), TermiusImportError> {
    match value {
        Value::Object(map) => {
            for (field_name, field_val) in map.iter_mut() {
                decrypt_metadata_value(
                    field_val,
                    key,
                    is_metadata_field_name(field_name) && !is_secret_field_name(field_name),
                )?;
            }
        }
        Value::Array(items) => {
            for item in items {
                decrypt_metadata_value(item, key, approved)?;
            }
        }
        Value::String(s) if approved => {
            decrypt_metadata_string(s, key)?;
        }
        _ => {}
    }
    Ok(())
}

fn decrypt_idb_key(
    key: &mut IdbKey,
    decrypt_key: Option<&[u8; 32]>,
) -> Result<(), TermiusImportError> {
    if let IdbKey::String(s) = key {
        decrypt_metadata_string(s, decrypt_key)?;
    }
    Ok(())
}

fn find_source_decryption_key(
    source: &SourceRows,
) -> Result<Option<SecretKey>, TermiusImportError> {
    let mut samples = Vec::new();
    for row in &source.rows {
        collect_encrypted_idb_key_samples(&row.idb_key, &mut samples, 16);
        if let Some(mut value) = decode_row_value(row) {
            collect_encrypted_samples(&value, &mut samples, 16, false);
            zeroize_value(&mut value);
            if samples.len() >= 16 {
                break;
            }
        }
    }
    if samples.is_empty() {
        return Ok(None);
    }
    match localkey::find_local_key(|candidate| {
        samples.iter().any(|sample| {
            let Ok(mut plaintext) = crypto::decrypt(candidate, &sample.value) else {
                return false;
            };
            plaintext.zeroize();
            true
        })
    }) {
        Ok(key) => Ok(Some(SecretKey(key))),
        Err(localkey::LocalKeyError::NotFound) => Ok(None),
    }
}

fn normalize_source_rows(source: SourceRows) -> Result<NormalizedImport, TermiusImportError> {
    if source.rows.len() > MAX_PREVIEW_ROWS {
        return Err(TermiusImportError::PreviewLimit);
    }
    let key = find_source_decryption_key(&source)?;
    normalize_source_rows_with_key(source, key.as_ref().map(|k| &k.0))
}

fn normalize_source_rows_with_key(
    source: SourceRows,
    key: Option<&[u8; 32]>,
) -> Result<NormalizedImport, TermiusImportError> {
    let mut source = SourceRowsGuard(source);
    if source.0.rows.len() > MAX_PREVIEW_ROWS {
        return Err(TermiusImportError::PreviewLimit);
    }

    let mut indexes = SourceIndexes::new();
    let mut groups = Vec::new();
    let mut warnings = Vec::new();
    let mut skipped_records = false;

    for (index, row) in source.0.rows.iter_mut().enumerate() {
        let Some(mut value) = decode_row_value(row) else {
            row.value_bytes.zeroize();
            skipped_records = true;
            continue;
        };

        if let Err(error) = decrypt_idb_key(&mut row.idb_key, key)
            .and_then(|()| decrypt_metadata_value(&mut value, key, false))
        {
            zeroize_value(&mut value);
            return Err(error);
        }

        let accepted = if HOST_DATABASES.contains(&row.database_name.as_str()) {
            indexes
                .hosts
                .insert_value(value, &row.idb_key, index, HOST_ENTITY_ID_ALIASES)
        } else if CONFIG_DATABASES.contains(&row.database_name.as_str()) {
            indexes
                .configs
                .insert_value(value, &row.idb_key, index, CONFIG_ENTITY_ID_ALIASES)
        } else if GROUP_DATABASES.contains(&row.database_name.as_str()) {
            indexes
                .groups
                .insert_value(value, &row.idb_key, index, GROUP_ENTITY_ID_ALIASES)
        } else if CREDENTIAL_DATABASES.contains(&row.database_name.as_str()) {
            if row.database_name.eq_ignore_ascii_case("keys") {
                indexes
                    .keys
                    .insert_value(value, &row.idb_key, index, KEY_ENTITY_ID_ALIASES)
            } else {
                indexes.identities.insert_value(
                    value,
                    &row.idb_key,
                    index,
                    IDENTITY_ENTITY_ID_ALIASES,
                )
            }
        } else if PROXY_DATABASES.contains(&row.database_name.as_str()) {
            indexes
                .proxies
                .insert_value(value, &row.idb_key, index, PROXY_ENTITY_ID_ALIASES)
        } else {
            zeroize_value(&mut value);
            true
        };
        if !accepted {
            skipped_records = true;
        }
        row.value_bytes.zeroize();
    }

    if skipped_records {
        push_warning(&mut warnings, WARN_UNSUPPORTED_RECORD);
    }
    if [
        &indexes.hosts,
        &indexes.configs,
        &indexes.identities,
        &indexes.keys,
        &indexes.groups,
        &indexes.proxies,
    ]
    .iter()
    .any(|index| index.incomparable_update)
    {
        push_warning(&mut warnings, WARN_INCOMPARABLE_UPDATE);
    }

    for record in indexes.groups.values_in_source_order() {
        if let Some(group) = normalize_group_record(record, &indexes.groups) {
            insert_group(&mut groups, group, &mut warnings);
        } else {
            skipped_records = true;
        }
    }
    if groups.len() > MAX_PREVIEW_GROUPS {
        return Err(TermiusImportError::PreviewLimit);
    }

    let mut hosts = Vec::new();
    for record in indexes.hosts.values_in_source_order() {
        if let Some(host) = normalize_host_record(record, &indexes, &mut groups, &mut warnings) {
            if hosts.len() >= MAX_PREVIEW_HOSTS {
                return Err(TermiusImportError::PreviewLimit);
            }
            hosts.push(host);
        } else {
            skipped_records = true;
        }
    }
    if skipped_records {
        push_warning(&mut warnings, WARN_UNSUPPORTED_RECORD);
    }

    resolve_group_references(&mut hosts, &mut groups, &mut warnings);
    order_groups(&mut groups, &mut warnings);
    flatten_group_paths(&mut groups, &mut warnings);

    Ok(NormalizedImport {
        hosts,
        groups,
        warnings,
    })
}

fn preview_for_test(
    normalized: &NormalizedImport,
    existing: &[SavedHost],
) -> TermiusPreviewResponse {
    let token = uuid::Uuid::new_v4().to_string();
    build_preview(normalized, existing, &token, true)
}

fn build_preview(
    normalized: &NormalizedImport,
    existing: &[SavedHost],
    preview_token: &str,
    metadata_only: bool,
) -> TermiusPreviewResponse {
    let existing_keys = existing
        .iter()
        .map(saved_host_dedup_key)
        .collect::<HashSet<_>>();
    let group_ids = normalized
        .groups
        .iter()
        .map(|group| (group.source_id.as_str(), group.public_id.clone()))
        .collect::<HashMap<_, _>>();
    let mut already_exists = 0;
    let mut credential_available = 0;
    let hosts = normalized
        .hosts
        .iter()
        .map(|host| {
            let is_existing = existing_keys.contains(&normalized_host_dedup_key(host));
            if is_existing {
                already_exists += 1;
            }
            let has_password = host.password.is_some();
            let has_private_key = host.private_key.is_some() || host.key_path.is_some();
            if has_password || has_private_key {
                credential_available += 1;
            }
            TermiusHostPreview {
                id: host.public_id.clone(),
                label: host.label.clone(),
                address: host.address.clone(),
                username: host.username.clone(),
                port: host.port,
                group_id: host
                    .group_source_id
                    .as_deref()
                    .and_then(|id| group_ids.get(id).cloned()),
                notes: host.notes.clone(),
                startup_command: host.startup_command.clone(),
                start_directory: host.start_directory.clone(),
                key_path: host.key_path.clone(),
                proxy: host.proxy.clone(),
                credential_available: has_password || has_private_key,
                has_password,
                has_private_key,
                already_exists: is_existing,
                warnings: host.warnings.clone(),
            }
        })
        .collect::<Vec<_>>();
    let group_host_counts = normalized
        .hosts
        .iter()
        .filter_map(|host| host.group_source_id.as_deref())
        .fold(HashMap::<&str, usize>::new(), |mut counts, id| {
            *counts.entry(id).or_default() += 1;
            counts
        });
    let groups = normalized
        .groups
        .iter()
        .map(|group| TermiusGroupPreview {
            id: group.public_id.clone(),
            name: group.name.clone(),
            host_count: group_host_counts
                .get(group.source_id.as_str())
                .copied()
                .unwrap_or_default(),
        })
        .collect::<Vec<_>>();

    TermiusPreviewResponse {
        preview_token: preview_token.to_string(),
        metadata_only,
        counts: TermiusPreviewCounts {
            hosts: hosts.len(),
            groups: groups.len(),
            credential_available,
            already_exists,
        },
        hosts,
        groups,
        warnings: normalized.warnings.clone(),
    }
}

fn decode_row_value(row: &Row) -> Option<Value> {
    let mut bytes = row.value_bytes.clone();
    let result = match v8::decode(&bytes) {
        Ok(value) => Some(value),
        Err(_) => decode_record_value(&bytes)
            .ok()
            .and_then(|record| v8::decode(record).ok()),
    };
    bytes.zeroize();
    result
}

fn source_ids(object: &BTreeMap<String, Value>) -> SourceRef {
    SourceRef {
        id: field_identifier(object, SOURCE_ID_ALIASES),
        local_id: field_identifier(object, LOCAL_ID_ALIASES),
    }
}

fn field_updated_at(object: &BTreeMap<String, Value>) -> UpdatedAt {
    match field_value(object, UPDATED_AT_ALIASES) {
        Some(Value::Int32(value)) => epoch_marker(i128::from(*value)),
        Some(Value::Uint32(value)) => epoch_marker(i128::from(*value)),
        Some(Value::Float64(value)) if value.is_finite() && value.fract() == 0.0 => {
            epoch_marker(*value as i128)
        }
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() || value.len() > MAX_FIELD_LENGTH {
                UpdatedAt::Missing
            } else if let Ok(value) = value.parse::<i128>() {
                epoch_marker(value)
            } else if let Ok(value) = chrono::DateTime::parse_from_rfc3339(value) {
                UpdatedAt::Chronological(
                    i128::from(value.timestamp()) * 1_000_000_000
                        + i128::from(value.timestamp_subsec_nanos()),
                )
            } else {
                UpdatedAt::Incomparable
            }
        }
        _ => UpdatedAt::Missing,
    }
}

fn epoch_marker(value: i128) -> UpdatedAt {
    /* Termius releases have used seconds, milliseconds, microseconds, and
     * nanoseconds. Magnitude normalization puts all epoch forms on one axis. */
    let absolute = value.saturating_abs();
    let multiplier = if absolute < 100_000_000_000 {
        1_000_000_000
    } else if absolute < 100_000_000_000_000 {
        1_000_000
    } else if absolute < 100_000_000_000_000_000 {
        1_000
    } else {
        1
    };
    value
        .checked_mul(multiplier)
        .map(UpdatedAt::Chronological)
        .unwrap_or(UpdatedAt::Incomparable)
}

fn resolve_source_id(index: &VersionedValueIndex, reference: &SourceRef) -> Option<String> {
    index
        .resolve_record(reference)
        .and_then(|record| record.ids.first_value())
}

fn source_ref_from_value(value: &Value) -> Option<SourceRef> {
    match value {
        Value::Object(object) => {
            let reference = source_ids(object);
            (!reference.is_empty()).then_some(reference)
        }
        _ => identifier_value(value).map(|id| SourceRef {
            id: Some(id),
            local_id: None,
        }),
    }
}

fn reference_from_field_value(value: &Value) -> Option<SourceRef> {
    let mut references = Vec::new();
    collect_source_refs(value, &mut references);
    (references.len() == 1).then(|| references.remove(0))
}

fn inline_object_value(value: &Value) -> Option<&BTreeMap<String, Value>> {
    if source_ref_from_value(value).is_some() {
        None
    } else {
        object_value(value)
    }
}

fn field_reference(object: &BTreeMap<String, Value>, aliases: &[&str]) -> Option<SourceRef> {
    field_value(object, aliases).and_then(reference_from_field_value)
}

fn field_reference_list(object: &BTreeMap<String, Value>, aliases: &[&str]) -> Vec<SourceRef> {
    let Some(value) = field_value(object, aliases) else {
        return Vec::new();
    };
    let mut references = Vec::new();
    collect_source_refs(value, &mut references);
    references
}

fn collect_source_refs(value: &Value, references: &mut Vec<SourceRef>) {
    if references.len() >= MAX_REFERENCE_COUNT {
        return;
    }
    match value {
        Value::Array(values) => {
            for value in values {
                collect_source_refs(value, references);
                if references.len() >= MAX_REFERENCE_COUNT {
                    break;
                }
            }
        }
        _ => {
            let Some(reference) = source_ref_from_value(value) else {
                return;
            };
            let duplicate = references.iter().any(|existing| {
                existing.id.is_some() && existing.id == reference.id
                    || existing.local_id.is_some() && existing.local_id == reference.local_id
            });
            if !duplicate {
                references.push(reference);
            }
        }
    }
}

fn handle_proxy_relationship(
    object: &BTreeMap<String, Value>,
    proxies: &VersionedValueIndex,
    host_warnings: &mut Vec<String>,
    warnings: &mut Vec<String>,
) {
    let references = field_reference_list(object, PROXY_REFERENCE_ALIASES);
    if references.len() != 1 {
        push_warning(host_warnings, WARN_PROXY_RELATIONSHIP);
        push_warning(warnings, WARN_PROXY_RELATIONSHIP);
        return;
    }
    let Some(proxy) = proxies.resolve_value(&references[0]) else {
        push_warning(host_warnings, WARN_PROXY_RELATIONSHIP);
        push_warning(warnings, WARN_PROXY_RELATIONSHIP);
        return;
    };
    let Some(proxy_object) = object_value(proxy) else {
        push_warning(host_warnings, WARN_PROXY_RELATIONSHIP);
        push_warning(warnings, WARN_PROXY_RELATIONSHIP);
        return;
    };
    if proxy_target_count(proxy_object) != 1 {
        push_warning(host_warnings, WARN_PROXY_RELATIONSHIP);
        push_warning(warnings, WARN_PROXY_RELATIONSHIP);
        return;
    }
    push_warning(host_warnings, WARN_PROXY_NOT_LINKED);
    push_warning(warnings, WARN_PROXY_NOT_LINKED);
}

fn proxy_target_count(object: &BTreeMap<String, Value>) -> usize {
    let references = field_reference_list(object, PROXY_TARGET_ALIASES);
    if references.is_empty()
        && field_text(object, &["hostname", "host", "address", "server"]).is_some()
    {
        1
    } else {
        references.len()
    }
}

fn normalize_group_record(
    record: &VersionedValue,
    group_index: &VersionedValueIndex,
) -> Option<NormalizedGroup> {
    let object = object_value(&record.value.0)?;
    let source_id = record.ids.first_value()?;
    let name = field_text(object, GROUP_NAME_ALIASES)?;
    let parent_reference = field_reference(object, PARENT_GROUP_ALIASES);
    let parent_source_id = parent_reference
        .as_ref()
        .and_then(|reference| resolve_source_id(group_index, reference))
        .or_else(|| parent_reference.and_then(|reference| reference.first_value()));
    Some(NormalizedGroup {
        source_id,
        public_id: uuid::Uuid::new_v4().to_string(),
        name,
        parent_source_id,
    })
}

/* Resolve the measured Termius v1 chain. Direct host fields are retained as
 * fallbacks for older exports, while current records take their port from the
 * ssh config, username/password from the identity, and key material from the
 * referenced key record. */
fn normalize_host_record(
    record: &VersionedValue,
    indexes: &SourceIndexes,
    groups: &mut Vec<NormalizedGroup>,
    warnings: &mut Vec<String>,
) -> Option<NormalizedHost> {
    let object = object_value(&record.value.0)?;
    let address = field_text(object, ADDRESS_ALIASES)?;
    if address.is_empty() {
        return None;
    }
    let source_id = record.ids.first_value()?;
    let label = field_text(object, LABEL_ALIASES).unwrap_or_else(|| address.clone());
    let mut host_warnings = Vec::new();

    let group_reference = field_reference(object, GROUP_ALIASES);
    let group_source_id = group_reference
        .as_ref()
        .and_then(|reference| resolve_source_id(&indexes.groups, reference))
        .or_else(|| group_reference.and_then(|reference| reference.first_value()));
    if let Some(group_value) = field_value(object, GROUP_ALIASES) {
        if let Some(group_object) = object_value(group_value) {
            if let Some(group) = embedded_group(group_object) {
                insert_group(groups, group, warnings);
            }
        }
    }

    let config_reference = field_reference(object, HOST_CONFIG_REFERENCE_ALIASES);
    let config_object = config_reference
        .as_ref()
        .and_then(|reference| indexes.configs.resolve_value(reference))
        .and_then(object_value);
    let config_identity_value =
        config_object.and_then(|config| field_value(config, IDENTITY_REFERENCE_ALIASES));
    let identity_value =
        config_identity_value.or_else(|| field_value(object, IDENTITY_REFERENCE_ALIASES));
    let identity_reference = identity_value.and_then(reference_from_field_value);
    let inline_identity_object = identity_value.and_then(inline_object_value);
    let identity_object = identity_reference
        .as_ref()
        .and_then(|reference| indexes.identities.resolve_value(reference))
        .and_then(object_value)
        .or(inline_identity_object);
    if identity_value.is_some() && identity_object.is_none() {
        push_warning(&mut host_warnings, WARN_CREDENTIAL_RELATIONSHIP);
        push_warning(warnings, WARN_CREDENTIAL_RELATIONSHIP);
    }
    let identity_key_value =
        identity_object.and_then(|identity| field_value(identity, SSH_KEY_REFERENCE_ALIASES));
    let key_value = identity_key_value.or_else(|| field_value(object, SSH_KEY_REFERENCE_ALIASES));
    let key_reference = key_value.and_then(reference_from_field_value);
    let inline_key_object = key_value.and_then(inline_object_value);
    let key_object = key_reference
        .as_ref()
        .and_then(|reference| indexes.keys.resolve_value(reference))
        .and_then(object_value)
        .or(inline_key_object);
    if key_value.is_some() && key_object.is_none() {
        push_warning(&mut host_warnings, WARN_CREDENTIAL_RELATIONSHIP);
        push_warning(warnings, WARN_CREDENTIAL_RELATIONSHIP);
    }

    let username = identity_object
        .and_then(|identity| field_text(identity, USERNAME_ALIASES))
        .or_else(|| config_object.and_then(|config| field_text(config, USERNAME_ALIASES)))
        .or_else(|| field_text(object, USERNAME_ALIASES))
        .unwrap_or_default();
    let port = config_object
        .and_then(|config| field_port(config, PORT_ALIASES))
        .or_else(|| field_port(object, PORT_ALIASES))
        .unwrap_or(22);
    let password = identity_object
        .and_then(|identity| field_secret(identity, PASSWORD_ALIASES))
        .or_else(|| config_object.and_then(|config| field_secret(config, PASSWORD_ALIASES)))
        .or_else(|| field_secret(object, PASSWORD_ALIASES));
    let private_key = key_object
        .and_then(|key| field_secret(key, PRIVATE_KEY_ALIASES))
        .or_else(|| {
            identity_object.and_then(|identity| field_secret(identity, PRIVATE_KEY_ALIASES))
        })
        .or_else(|| config_object.and_then(|config| field_secret(config, PRIVATE_KEY_ALIASES)))
        .or_else(|| field_secret(object, PRIVATE_KEY_ALIASES));
    let passphrase = key_object
        .and_then(|key| field_secret(key, PASSPHRASE_ALIASES))
        .or_else(|| identity_object.and_then(|identity| field_secret(identity, PASSPHRASE_ALIASES)))
        .or_else(|| config_object.and_then(|config| field_secret(config, PASSPHRASE_ALIASES)))
        .or_else(|| field_secret(object, PASSPHRASE_ALIASES));
    let key_path = key_object
        .and_then(|key| field_text(key, KEY_PATH_ALIASES))
        .or_else(|| identity_object.and_then(|identity| field_text(identity, KEY_PATH_ALIASES)))
        .or_else(|| config_object.and_then(|config| field_text(config, KEY_PATH_ALIASES)))
        .or_else(|| field_text(object, KEY_PATH_ALIASES));

    let mut proxy = None;
    if let Some(config) = config_object {
        if field_value(config, PROXY_REFERENCE_ALIASES).is_some() {
            handle_proxy_relationship(config, &indexes.proxies, &mut host_warnings, warnings);
        }
    } else if field_value(object, PROXY_ALIASES).is_some() {
        let direct_proxy = field_value(
            object,
            &[
                "proxy",
                "proxyHost",
                "proxy_host",
                "jumpHost",
                "jump_host",
                "bastion",
            ],
        );
        if let Some(Value::String(value)) = direct_proxy {
            proxy = safe_proxy_value(value);
            if proxy.is_none() {
                push_warning(&mut host_warnings, WARN_PROXY_UNSAFE);
                push_warning(warnings, WARN_PROXY_UNSAFE);
            }
            push_warning(&mut host_warnings, WARN_PROXY_NOT_LINKED);
            push_warning(warnings, WARN_PROXY_NOT_LINKED);
        } else {
            handle_proxy_relationship(object, &indexes.proxies, &mut host_warnings, warnings);
        }
    }

    Some(NormalizedHost {
        source_id,
        public_id: uuid::Uuid::new_v4().to_string(),
        label,
        address,
        username,
        port,
        group_source_id,
        notes: field_text(object, NOTES_ALIASES),
        startup_command: field_text(object, STARTUP_ALIASES),
        start_directory: field_text(object, START_DIRECTORY_ALIASES),
        key_path,
        proxy,
        password,
        private_key,
        passphrase,
        warnings: host_warnings,
    })
}

fn embedded_group(object: &BTreeMap<String, Value>) -> Option<NormalizedGroup> {
    let source_id = source_ids(object).first_value()?;
    let name = field_text(object, GROUP_NAME_ALIASES)?;
    let parent_reference = field_reference(object, PARENT_GROUP_ALIASES);
    Some(NormalizedGroup {
        source_id,
        public_id: uuid::Uuid::new_v4().to_string(),
        name,
        parent_source_id: parent_reference.and_then(|reference| reference.first_value()),
    })
}
fn insert_group(
    groups: &mut Vec<NormalizedGroup>,
    group: NormalizedGroup,
    warnings: &mut Vec<String>,
) {
    if let Some(existing) = groups
        .iter_mut()
        .find(|existing| existing.source_id == group.source_id)
    {
        if existing.name != group.name || existing.parent_source_id != group.parent_source_id {
            push_warning(warnings, WARN_UNSUPPORTED_RECORD);
        }
        return;
    }
    if groups.len() < MAX_PREVIEW_GROUPS {
        groups.push(group);
    }
}

fn resolve_group_references(
    hosts: &mut [NormalizedHost],
    groups: &mut [NormalizedGroup],
    warnings: &mut Vec<String>,
) {
    let by_name = groups.iter().fold(
        HashMap::<String, Option<String>>::new(),
        |mut map, group| {
            let entry = map
                .entry(group.name.to_ascii_lowercase())
                .or_insert_with(|| Some(group.source_id.clone()));
            if entry.as_deref() != Some(group.source_id.as_str()) {
                *entry = None;
            }
            map
        },
    );
    let known_ids = groups
        .iter()
        .map(|group| group.source_id.clone())
        .collect::<HashSet<_>>();
    for host in hosts {
        let Some(reference) = host.group_source_id.clone() else {
            continue;
        };
        if known_ids.contains(reference.as_str()) {
            continue;
        }
        let resolved = by_name
            .get(&reference.to_ascii_lowercase())
            .and_then(|value| value.clone());
        if resolved.is_some() {
            host.group_source_id = resolved;
        } else {
            push_warning(warnings, WARN_MISSING_GROUP);
            host.group_source_id = None;
        }
    }
    for group in groups {
        if let Some(parent) = group.parent_source_id.clone() {
            if !known_ids.contains(&parent) {
                group.parent_source_id = by_name
                    .get(&parent.to_ascii_lowercase())
                    .and_then(|value| value.clone());
                if group.parent_source_id.is_none() {
                    push_warning(warnings, WARN_MISSING_GROUP);
                }
            }
        }
    }
}

fn order_groups(groups: &mut Vec<NormalizedGroup>, warnings: &mut Vec<String>) {
    let original = std::mem::take(groups);
    let known_ids = original
        .iter()
        .map(|group| group.source_id.clone())
        .collect::<HashSet<_>>();
    let mut remaining = original;
    let mut ordered = Vec::with_capacity(remaining.len());
    while !remaining.is_empty() {
        let mut progress = false;
        let mut index = 0;
        while index < remaining.len() {
            let ready = remaining[index]
                .parent_source_id
                .as_deref()
                .is_none_or(|parent| {
                    !known_ids.contains(parent)
                        || ordered
                            .iter()
                            .any(|group: &NormalizedGroup| group.source_id == parent)
                });
            if ready {
                ordered.push(remaining.remove(index));
                progress = true;
            } else {
                index += 1;
            }
        }
        if !progress {
            push_warning(warnings, WARN_UNSUPPORTED_RECORD);
            for mut group in remaining.drain(..) {
                group.parent_source_id = None;
                ordered.push(group);
            }
        }
    }
    *groups = ordered;
}

fn flatten_group_paths(groups: &mut [NormalizedGroup], warnings: &mut Vec<String>) {
    /* The persisted group schema is intentionally flat. Resolve ancestry once
     * into deterministic display names, then discard the source-only parent
     * links before any preview or database model can observe them. */
    let mut paths = groups
        .iter()
        .map(|group| (group.source_id.clone(), group.name.clone()))
        .collect::<HashMap<_, _>>();
    for group in groups {
        let Some(parent_id) = group.parent_source_id.take() else {
            paths.insert(group.source_id.clone(), group.name.clone());
            continue;
        };
        let Some(parent_path) = paths.get(&parent_id).cloned() else {
            push_warning(warnings, WARN_MISSING_GROUP);
            paths.insert(group.source_id.clone(), group.name.clone());
            continue;
        };
        let display_path = format!("{parent_path} / {}", group.name);
        group.name = bounded_path(&display_path, warnings);
        paths.insert(group.source_id.clone(), group.name.clone());
    }
}

fn bounded_path(value: &str, warnings: &mut Vec<String>) -> String {
    if value.len() <= MAX_FIELD_LENGTH {
        return value.to_string();
    }
    push_warning(warnings, WARN_UNSUPPORTED_RECORD);
    let mut end = MAX_FIELD_LENGTH;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn object_value(value: &Value) -> Option<&BTreeMap<String, Value>> {
    match value {
        Value::Object(object) => Some(object),
        _ => None,
    }
}

fn field_value<'a>(object: &'a BTreeMap<String, Value>, aliases: &[&str]) -> Option<&'a Value> {
    aliases.iter().find_map(|alias| {
        object
            .iter()
            .find_map(|(name, value)| name.eq_ignore_ascii_case(alias).then_some(value))
    })
}

fn field_identifier(object: &BTreeMap<String, Value>, aliases: &[&str]) -> Option<String> {
    field_value(object, aliases).and_then(identifier_value)
}

fn identifier_value(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => bounded_text(value),
        Value::Int32(value) => Some(value.to_string()),
        Value::Uint32(value) => Some(value.to_string()),
        Value::Float64(value) if value.is_finite() => Some(value.to_string()),
        _ => None,
    }
}

fn field_text(object: &BTreeMap<String, Value>, aliases: &[&str]) -> Option<String> {
    field_value(object, aliases).and_then(|value| match value {
        Value::String(value) => bounded_text(value),
        _ => None,
    })
}

fn field_secret(object: &BTreeMap<String, Value>, aliases: &[&str]) -> Option<SecretText> {
    field_value(object, aliases).and_then(|value| match value {
        Value::String(value) if !value.is_empty() && value.len() <= MAX_FIELD_LENGTH => {
            Some(SecretText {
                value: value.clone(),
            })
        }
        _ => None,
    })
}

fn field_port(object: &BTreeMap<String, Value>, aliases: &[&str]) -> Option<u16> {
    let value = field_value(object, aliases)?;
    let port = match value {
        Value::Int32(value) if *value > 0 => u32::try_from(*value).ok()?,
        Value::Uint32(value) => *value,
        Value::Float64(value) if value.is_finite() && value.fract() == 0.0 && *value > 0.0 => {
            *value as u32
        }
        Value::String(value) => value.parse::<u32>().ok()?,
        _ => return None,
    };
    u16::try_from(port).ok().filter(|port| *port > 0)
}

fn bounded_text(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= MAX_FIELD_LENGTH).then(|| value.to_string())
}

fn safe_proxy_value(value: &str) -> Option<String> {
    /* Accept only the narrow ProxyJump metadata shape understood by anySCP.
     * Commands, URLs, query strings, whitespace, and password-bearing userinfo
     * are rejected instead of relying on an incomplete secret detector. */
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_FIELD_LENGTH
        || value.chars().any(char::is_whitespace)
        || value.chars().any(|character| {
            character.is_control() || matches!(character, '/' | '\\' | '?' | '#' | '%' | '=' | ';')
        })
    {
        return None;
    }
    let mut parts = value.rsplitn(2, '@');
    let host_port = parts.next()?;
    if let Some(user) = parts.next() {
        if user.is_empty()
            || user.contains(':')
            || !user
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        {
            return None;
        }
    }
    let valid = if let Some(bracketed) = host_port.strip_prefix('[') {
        let (address, suffix) = bracketed.split_once(']')?;
        !address.is_empty()
            && address
                .chars()
                .all(|character| character.is_ascii_hexdigit() || character == ':')
            && (suffix.is_empty() || valid_proxy_port(suffix.strip_prefix(':')?))
    } else {
        let (host, port) = host_port
            .rsplit_once(':')
            .map_or((host_port, None), |(host, port)| (host, Some(port)));
        !host.is_empty()
            && host
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
            && port.is_none_or(valid_proxy_port)
    };
    valid.then(|| value.to_string())
}

fn valid_proxy_port(value: &str) -> bool {
    value.parse::<u16>().ok().is_some_and(|port| port > 0)
}

fn idb_key_identifier(key: &IdbKey) -> Option<String> {
    match key {
        IdbKey::String(value) => bounded_text(value),
        IdbKey::Number(value) | IdbKey::Date(value) if value.is_finite() => Some(value.to_string()),
        _ => None,
    }
}

fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(values) => values.values_mut().for_each(zeroize_value),
        _ => {}
    }
}

fn zeroize_idb_key(key: &mut IdbKey) {
    match key {
        IdbKey::String(value) => value.zeroize(),
        IdbKey::Array(values) => values.iter_mut().for_each(zeroize_idb_key),
        IdbKey::Binary(value) => value.zeroize(),
        _ => {}
    }
}

fn push_warning(warnings: &mut Vec<String>, warning: &str) {
    if warnings.len() < MAX_WARNING_COUNT && !warnings.iter().any(|entry| entry == warning) {
        warnings.push(warning.to_string());
    }
}

fn normalized_host_dedup_key(host: &NormalizedHost) -> (String, String, u16) {
    (
        host.address.to_ascii_lowercase(),
        host.username.clone(),
        host.port,
    )
}

fn saved_host_dedup_key(host: &SavedHost) -> (String, String, u16) {
    (
        host.host.trim().to_ascii_lowercase(),
        host.username.trim().to_string(),
        host.port,
    )
}

trait CredentialWriter {
    fn save(&self, host_id: &str, credential: &StoredCredential) -> Result<(), VaultError>;
    fn delete(&self, host_id: &str) -> Result<(), VaultError>;
    fn exists(&self, host_id: &str) -> Result<bool, VaultError>;
}

struct OsVaultWriter;

impl CredentialWriter for OsVaultWriter {
    fn save(&self, host_id: &str, credential: &StoredCredential) -> Result<(), VaultError> {
        vault::save_credential(host_id, credential)
    }

    fn delete(&self, host_id: &str) -> Result<(), VaultError> {
        vault::delete_credential(host_id)
    }

    fn exists(&self, host_id: &str) -> Result<bool, VaultError> {
        vault::credential_exists(host_id)
    }
}

struct SecretKey([u8; 32]);

impl Drop for SecretKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct PreparedImport {
    groups: Vec<HostGroup>,
    hosts: Vec<SavedHost>,
    credentials: Vec<(String, StoredCredential)>,
    skipped_hosts: usize,
}

/* This is the only persistence path for a Termius preview. It builds metadata
 * first, stages vault entries with generated host IDs, then commits groups and
 * hosts transactionally; every failure removes all entries touched so far. */
fn commit_pending(
    db: &HostDb,
    writer: &dyn CredentialWriter,
    pending: PendingPreview,
    request: &TermiusCommitRequest,
) -> Result<(TermiusCommitResponse, Vec<(String, StoredCredential)>), TermiusImportError> {
    if request.include_credentials && !request.credentials_confirmed {
        return Err(TermiusImportError::CredentialsConfirmationRequired);
    }
    if request.selected_ids.is_empty() || request.selected_ids.len() > MAX_PREVIEW_HOSTS {
        return Err(TermiusImportError::InvalidSelection);
    }

    let hosts_by_id = pending
        .normalized
        .hosts
        .iter()
        .map(|host| (host.public_id.as_str(), host))
        .collect::<HashMap<_, _>>();
    if request
        .selected_ids
        .iter()
        .any(|id| !hosts_by_id.contains_key(id.as_str()))
    {
        return Err(TermiusImportError::InvalidSelection);
    }

    let existing_keys = db
        .list_hosts()
        .map_err(|_| TermiusImportError::CommitFailed)?
        .iter()
        .map(saved_host_dedup_key)
        .collect::<HashSet<_>>();
    let mut seen_keys = existing_keys;
    let mut selected_hosts = Vec::new();
    let mut skipped_hosts = 0;
    for id in &request.selected_ids {
        let host = hosts_by_id
            .get(id.as_str())
            .copied()
            .ok_or(TermiusImportError::InvalidSelection)?;
        if !seen_keys.insert(normalized_host_dedup_key(host)) {
            skipped_hosts += 1;
        } else {
            selected_hosts.push(host);
        }
    }
    if selected_hosts.is_empty() {
        return Ok((
            TermiusCommitResponse {
                imported_hosts: 0,
                imported_groups: 0,
                skipped_hosts,
                credentials_stored: 0,
                credentials_in_vault: 0,
                credentials_in_keychain: 0,
                warnings: duplicate_warnings(skipped_hosts, &pending.normalized.warnings),
            },
            vec![],
        ));
    }

    let key = if request.include_credentials {
        find_decryption_key(&selected_hosts)?
    } else {
        None
    };
    let timestamp = crate::import::commands::timestamp_now();
    let (groups, group_ids) =
        stage_groups(db, &pending.normalized.groups, &selected_hosts, &timestamp)?;
    let mut hosts = Vec::with_capacity(selected_hosts.len());
    let mut credentials = Vec::new();
    for source_host in selected_hosts {
        let host_id = uuid::Uuid::new_v4().to_string();
        let credential = if request.include_credentials {
            credential_for_host(source_host, key.as_ref())?
        } else {
            None
        };
        let saved_host = SavedHost {
            id: host_id.clone(),
            label: source_host.label.clone(),
            host: source_host.address.clone(),
            port: source_host.port,
            username: source_host.username.clone(),
            auth_type: source_auth_type(
                source_host,
                request.include_credentials,
                credential.as_ref(),
            )
            .to_string(),
            credential_storage: Default::default(),
            group_id: source_host
                .group_source_id
                .as_deref()
                .and_then(|source_id| group_ids.get(source_id).cloned()),
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
            key_path: source_host.key_path.clone(),
            color: None,
            notes: source_host.notes.clone(),
            environment: None,
            os_type: None,
            startup_command: source_host.startup_command.clone(),
            proxy_jump: source_host.proxy.clone(),
            proxy_jump_host_id: None,
            start_directory: source_host.start_directory.clone(),
            keep_alive_interval: None,
            default_shell: None,
            font_size: None,
            last_connected_at: None,
            connection_count: Some(0),
        };
        if let Some(credential) = credential {
            credentials.push((host_id.clone(), credential));
        }
        hosts.push(saved_host);
    }

    let prepared = PreparedImport {
        groups,
        hosts,
        credentials,
        skipped_hosts,
    };
    persist_prepared(db, writer, prepared, &pending.normalized.warnings)
}

fn duplicate_warnings(skipped_hosts: usize, source_warnings: &[String]) -> Vec<String> {
    let mut warnings = source_warnings.to_vec();
    if skipped_hosts > 0 {
        push_warning(&mut warnings, "Duplicate hosts were skipped");
    }
    warnings
}

fn source_auth_type(
    host: &NormalizedHost,
    include_credentials: bool,
    credential: Option<&StoredCredential>,
) -> &'static str {
    if include_credentials && matches!(credential, Some(StoredCredential::PrivateKeyData { .. })) {
        "privateKeyData"
    } else if host.key_path.is_some() {
        "privateKey"
    } else {
        "password"
    }
}

fn stage_groups(
    db: &HostDb,
    source_groups: &[NormalizedGroup],
    hosts: &[&NormalizedHost],
    timestamp: &str,
) -> Result<(Vec<HostGroup>, HashMap<String, String>), TermiusImportError> {
    let by_source = source_groups
        .iter()
        .map(|group| (group.source_id.as_str(), group))
        .collect::<HashMap<_, _>>();
    let mut needed = HashSet::new();
    for host in hosts {
        let mut current = host.group_source_id.clone();
        for _ in 0..MAX_PREVIEW_GROUPS {
            let Some(source_id) = current else { break };
            if !needed.insert(source_id.clone()) {
                break;
            }
            current = by_source
                .get(source_id.as_str())
                .and_then(|group| group.parent_source_id.clone());
        }
    }

    let existing_groups = db
        .list_groups()
        .map_err(|_| TermiusImportError::CommitFailed)?;
    let mut group_ids_by_name = existing_groups
        .iter()
        .map(|group| (group.name.clone(), group.id.clone()))
        .collect::<HashMap<_, _>>();
    let mut next_sort_order = existing_groups
        .iter()
        .map(|group| group.sort_order)
        .max()
        .map_or(0, |value| value + 1);
    let mut source_to_db = HashMap::new();
    let mut staged = Vec::new();
    for source_group in source_groups {
        if !needed.contains(&source_group.source_id) {
            continue;
        }
        if let Some(existing_id) = group_ids_by_name.get(&source_group.name) {
            source_to_db.insert(source_group.source_id.clone(), existing_id.clone());
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        staged.push(HostGroup {
            id: id.clone(),
            name: source_group.name.clone(),
            color: "#6366f1".to_string(),
            icon: Some("Folder".to_string()),
            sort_order: next_sort_order,
            default_username: None,
            created_at: timestamp.to_string(),
            updated_at: timestamp.to_string(),
        });
        next_sort_order += 1;
        group_ids_by_name.insert(source_group.name.clone(), id.clone());
        source_to_db.insert(source_group.source_id.clone(), id);
    }
    Ok((staged, source_to_db))
}

fn find_decryption_key(hosts: &[&NormalizedHost]) -> Result<Option<SecretKey>, TermiusImportError> {
    let encrypted_values = hosts
        .iter()
        .flat_map(|host| {
            [
                host.password.as_ref(),
                host.private_key.as_ref(),
                host.passphrase.as_ref(),
            ]
        })
        .flatten()
        .filter(|value| match envelope::parse(&value.value) {
            Ok(parsed) => parsed.is_some(),
            Err(_) => true,
        })
        .map(|value| value.value.as_str())
        .collect::<Vec<_>>();
    if encrypted_values.is_empty() {
        return Ok(None);
    }
    let key = localkey::find_local_key(|candidate| {
        encrypted_values.iter().any(|value| {
            let Ok(mut plaintext) = crypto::decrypt(candidate, value) else {
                return false;
            };
            plaintext.zeroize();
            true
        })
    })
    .map_err(|_| TermiusImportError::CredentialsUnavailable)?;
    Ok(Some(SecretKey(key)))
}

fn credential_for_host(
    host: &NormalizedHost,
    key: Option<&SecretKey>,
) -> Result<Option<StoredCredential>, TermiusImportError> {
    if let Some(private_key) = host.private_key.as_ref() {
        let key_data = materialize_secret(private_key, key)?;
        let passphrase = host
            .passphrase
            .as_ref()
            .map(|value| materialize_secret(value, key))
            .transpose()?;
        return Ok(Some(StoredCredential::PrivateKeyData {
            key_data: key_data.into_inner(),
            passphrase: passphrase.map(SecretText::into_inner),
        }));
    }
    if host.key_path.is_some() {
        return host
            .passphrase
            .as_ref()
            .map(|value| {
                materialize_secret(value, key).map(|passphrase| StoredCredential::KeyPassphrase {
                    passphrase: passphrase.into_inner(),
                })
            })
            .transpose();
    }
    if let Some(password) = host.password.as_ref() {
        return Ok(Some(StoredCredential::Password {
            password: materialize_secret(password, key)?.into_inner(),
        }));
    }
    Ok(None)
}

fn materialize_secret(
    source: &SecretText,
    key: Option<&SecretKey>,
) -> Result<SecretText, TermiusImportError> {
    match envelope::parse(&source.value) {
        Ok(Some(_)) => {
            let Some(key) = key else {
                return Err(TermiusImportError::CredentialsUnavailable);
            };
            let mut plaintext = crypto::decrypt(&key.0, &source.value)
                .map_err(|_| TermiusImportError::CredentialsUnavailable)?;
            let result = std::str::from_utf8(&plaintext)
                .map(|value| SecretText {
                    value: value.to_string(),
                })
                .map_err(|_| TermiusImportError::CredentialsUnavailable);
            plaintext.zeroize();
            result
        }
        Ok(None) => Ok(source.clone()),
        Err(_) => Err(TermiusImportError::CredentialsUnavailable),
    }
}

impl SecretText {
    fn into_inner(mut self) -> String {
        std::mem::take(&mut self.value)
    }
}

fn delete_vault_entry(writer: &dyn CredentialWriter, host_id: &str) -> bool {
    for _ in 0..2 {
        let _ = writer.delete(host_id);
        if matches!(writer.exists(host_id), Ok(false)) {
            return true;
        }
    }
    false
}

#[derive(PartialEq, Eq)]
enum CleanupOutcome {
    Clean,
    Journaled,
    Failed,
}

fn cleanup_or_journal(
    db: &HostDb,
    writer: &dyn CredentialWriter,
    host_ids: &[String],
) -> CleanupOutcome {
    let mut outcome = CleanupOutcome::Clean;
    for host_id in host_ids.iter().rev() {
        if delete_vault_entry(writer, host_id) {
            if db.remove_vault_cleanup(host_id).is_err() {
                outcome = CleanupOutcome::Failed;
            }
        } else if db
            .enqueue_vault_cleanup(std::slice::from_ref(host_id))
            .is_ok()
        {
            if outcome == CleanupOutcome::Clean {
                outcome = CleanupOutcome::Journaled;
            }
        } else {
            outcome = CleanupOutcome::Failed;
        }
    }
    outcome
}

fn recover_vault_cleanup(db: &HostDb, writer: &dyn CredentialWriter) -> bool {
    let Ok(host_ids) = db.list_vault_cleanup() else {
        return false;
    };
    let mut recovered = true;
    for host_id in host_ids {
        if delete_vault_entry(writer, &host_id) {
            recovered &= db.remove_vault_cleanup(&host_id).is_ok();
        } else {
            recovered = false;
        }
    }
    recovered
}

pub(crate) fn recover_pending_vault_cleanup(db: &HostDb) -> bool {
    recover_vault_cleanup(db, &OsVaultWriter)
}

fn persist_prepared(
    db: &HostDb,
    writer: &dyn CredentialWriter,
    prepared: PreparedImport,
    source_warnings: &[String],
) -> Result<(TermiusCommitResponse, Vec<(String, StoredCredential)>), TermiusImportError> {
    if !recover_vault_cleanup(db, writer) {
        return Err(TermiusImportError::CleanupPending);
    }
    /* Persist non-secret cleanup intent before the first keychain write. The
     * host transaction clears committed IDs atomically; all other exits delete
     * or retain the journal entries for startup recovery. */
    let staged_vault_ids = prepared
        .credentials
        .iter()
        .map(|(host_id, _)| host_id.clone())
        .collect::<Vec<_>>();
    if db.enqueue_vault_cleanup(&staged_vault_ids).is_err() {
        return Err(TermiusImportError::CommitFailed);
    }
    for (host_id, credential) in &prepared.credentials {
        if writer.save(host_id, credential).is_err() {
            return Err(
                if cleanup_or_journal(db, writer, &staged_vault_ids) == CleanupOutcome::Clean {
                    TermiusImportError::CommitFailed
                } else {
                    TermiusImportError::CleanupPending
                },
            );
        }
    }
    let transaction = match db.save_groups_and_hosts_transaction(&prepared.groups, &prepared.hosts)
    {
        Ok(transaction) => transaction,
        Err(_) => {
            return Err(
                if cleanup_or_journal(db, writer, &staged_vault_ids) == CleanupOutcome::Clean {
                    TermiusImportError::CommitFailed
                } else {
                    TermiusImportError::CleanupPending
                },
            );
        }
    };
    let skipped_vault_ids = transaction
        .skipped_host_ids
        .iter()
        .filter(|host_id| staged_vault_ids.contains(host_id))
        .cloned()
        .collect::<Vec<_>>();
    let cleanup_pending = !skipped_vault_ids.is_empty()
        && cleanup_or_journal(db, writer, &skipped_vault_ids) != CleanupOutcome::Clean;
    let skipped_hosts = prepared.skipped_hosts + transaction.skipped_host_ids.len();
    let mut warnings = duplicate_warnings(skipped_hosts, source_warnings);
    if cleanup_pending {
        push_warning(&mut warnings, WARN_CLEANUP_PENDING);
    }

    let mut successfully_stored_credentials = Vec::new();
    for (host_id, credential) in prepared.credentials {
        if !skipped_vault_ids.contains(&host_id) {
            successfully_stored_credentials.push((host_id, credential));
        }
    }

    let credentials_stored = successfully_stored_credentials.len();

    Ok((
        TermiusCommitResponse {
            imported_hosts: transaction.imported_hosts,
            imported_groups: transaction.imported_groups,
            skipped_hosts,
            credentials_stored,
            credentials_in_vault: 0,
            credentials_in_keychain: credentials_stored,
            warnings,
        },
        successfully_stored_credentials,
    ))
}

fn map_source_error(error: source::SourceError) -> TermiusImportError {
    match error {
        source::SourceError::Running(_) => TermiusImportError::SourceRunning,
        source::SourceError::Open => TermiusImportError::SourceUnavailable,
        source::SourceError::Limit { .. } => TermiusImportError::PreviewLimit,
        source::SourceError::LevelDb
        | source::SourceError::Malformed { .. }
        | source::SourceError::Unsupported { .. }
        | source::SourceError::MissingMetadata { .. } => TermiusImportError::SourceRead,
    }
}

/* Both IPC commands keep all source, database, vault, and cryptographic work
 * on Tokio's blocking pool. Their serialized values contain only bounded
 * metadata, opaque IDs, counts, and fixed diagnostic categories. */
#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn import_preview_termius(
    request: TermiusPreviewRequest,
    db: State<'_, Arc<HostDb>>,
    previews: State<'_, Arc<TermiusImportState>>,
) -> Result<TermiusPreviewResponse, TermiusImportError> {
    let source_path = request.source_path;
    let metadata_only = request.metadata_only;
    let db = Arc::clone(&*db);
    let previews = Arc::clone(&*previews);

    task::spawn_blocking(move || {
        let leveldb_path = source_path
            .map(PathBuf::from)
            .or_else(datadir::resolve)
            .ok_or(TermiusImportError::SourceUnavailable)?;
        let source_rows = source::read_source(&leveldb_path).map_err(map_source_error)?;
        let normalized = normalize_source_rows(source_rows)?;
        let existing = db
            .list_hosts()
            .map_err(|_| TermiusImportError::CommitFailed)?;
        let token = uuid::Uuid::new_v4().to_string();
        let response = build_preview(&normalized, &existing, &token, metadata_only);
        previews.insert_with_token(token, normalized, Instant::now())?;
        Ok(response)
    })
    .await
    .map_err(|_| TermiusImportError::CommitFailed)?
}

#[tauri::command]
#[tracing::instrument(skip_all)]
pub async fn import_commit_termius(
    request: TermiusCommitRequest,
    db: State<'_, Arc<HostDb>>,
    previews: State<'_, Arc<TermiusImportState>>,
    local_vault: State<'_, Arc<LocalVault>>,
) -> Result<TermiusCommitResponse, TermiusImportError> {
    import_commit_termius_inner(
        request,
        Arc::clone(&*db),
        Arc::clone(&*previews),
        Arc::clone(&*local_vault),
    )
    .await
}

pub(crate) async fn import_commit_termius_inner(
    request: TermiusCommitRequest,
    db: Arc<HostDb>,
    previews: Arc<TermiusImportState>,
    local_vault: Arc<LocalVault>,
) -> Result<TermiusCommitResponse, TermiusImportError> {
    if request.include_credentials && !request.credentials_confirmed {
        return Err(TermiusImportError::CredentialsConfirmationRequired);
    }
    task::spawn_blocking(move || {
        let _commit_guard = previews
            .commit_lock
            .lock()
            .map_err(|_| TermiusImportError::CommitFailed)?;
        let pending = previews.take(&request.preview_token)?;
        let writer = OsVaultWriter;
        let (mut response, credentials) = commit_pending(&db, &writer, pending, &request)?;

        if request.credential_storage == CredentialStorage::LocalVault && request.include_credentials {
            let password_host_ids: Vec<String> = credentials
                .into_iter()
                .filter(|(_, cred)| matches!(cred, StoredCredential::Password { password: _ }))
                .map(|(id, _)| id)
                .collect();

            if !password_host_ids.is_empty() {
                match vault::migrate_hosts_to_vault(&db, &local_vault, &password_host_ids) {
                    Ok(result) => {
                        response.credentials_in_vault += result.migrated;
                        // Skips (e.g. NotFound) and failures stay in the keychain, so we only
                        // subtract the successfully migrated count from the keychain total.
                        response.credentials_in_keychain = response.credentials_in_keychain.saturating_sub(result.migrated);
                        if !result.failed.is_empty() {
                            push_warning(
                                &mut response.warnings,
                                &format!(
                                    "Failed to move {} passwords to the App Vault. They remain in the System Keychain.",
                                    result.failed.len()
                                ),
                            );
                        }
                    }
                    Err(VaultError::LocalVaultLocked) | Err(VaultError::Crypto(_)) | Err(_) => {
                        push_warning(
                            &mut response.warnings,
                            "Credentials were saved to the System Keychain because the App Vault was locked.",
                        );
                    }
                }
            }
        }
        Ok(response)
    })
    .await
    .map_err(|_| TermiusImportError::CommitFailed)?
}

#[cfg(test)]
mod tests {

    #[tokio::test]
    async fn local_vault_commit_sweeps_passwords_and_leaves_keys() {
        let (db_unarc, path) = temp_db();
        let db = Arc::new(db_unarc);
        let previews = Arc::new(TermiusImportState::new());
        let vault = Arc::new(crate::vault::LocalVault::new());
        vault.set_session_key([0; 32]).unwrap();

        let h1 = pending_host("h1", "pw.invalid", Some("pw"));
        let mut h2 = pending_host("h2", "key.invalid", None);
        h2.private_key = Some(SecretText {
            value: "key".to_string(),
        });

        let pending = pending_import(vec![h1, h2]);
        let mut request = commit_request(
            vec!["opaque-h1".to_string(), "opaque-h2".to_string()],
            true,
            true,
        );
        request.credential_storage = crate::db::CredentialStorage::LocalVault;

        previews
            .insert_pending_for_test(request.preview_token.clone(), pending)
            .unwrap();

        let result = import_commit_termius_inner(
            request,
            Arc::clone(&db),
            Arc::clone(&previews),
            Arc::clone(&vault),
        )
        .await
        .unwrap();

        assert_eq!(result.imported_hosts, 2);
        assert_eq!(result.credentials_stored, 2);
        assert_eq!(result.credentials_in_vault, 1);
        assert_eq!(result.credentials_in_keychain, 1);

        let hosts = db.list_hosts().unwrap();
        let h1_saved = hosts.iter().find(|h| h.label == "h1").unwrap();
        assert_eq!(
            h1_saved.credential_storage,
            crate::db::CredentialStorage::LocalVault
        );

        let h2_saved = hosts.iter().find(|h| h.label == "h2").unwrap();
        assert_eq!(
            h2_saved.credential_storage,
            crate::db::CredentialStorage::Keychain
        );

        assert!(crate::vault::get_credential(&h1_saved.id).is_err());
        assert!(crate::vault::get_credential(&h2_saved.id).is_ok());
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn local_vault_commit_when_locked_leaves_credentials_in_keychain_with_warning() {
        let (db_unarc, path) = temp_db();
        let db = Arc::new(db_unarc);
        let previews = Arc::new(TermiusImportState::new());
        let vault = Arc::new(crate::vault::LocalVault::new());
        // Vault remains locked!

        let h1 = pending_host("h1", "pw.invalid", Some("pw"));
        let pending = pending_import(vec![h1]);
        let mut request = commit_request(vec!["opaque-h1".to_string()], true, true);
        request.credential_storage = crate::db::CredentialStorage::LocalVault;

        previews
            .insert_pending_for_test(request.preview_token.clone(), pending)
            .unwrap();

        let result = import_commit_termius_inner(
            request,
            Arc::clone(&db),
            Arc::clone(&previews),
            Arc::clone(&vault),
        )
        .await
        .unwrap();

        assert_eq!(result.imported_hosts, 1);
        assert_eq!(result.credentials_stored, 1);
        assert_eq!(result.credentials_in_vault, 0);
        assert_eq!(result.credentials_in_keychain, 1);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("App Vault was locked"));

        let hosts = db.list_hosts().unwrap();
        let h1_saved = hosts.iter().find(|h| h.label == "h1").unwrap();
        // Since it's a sweep failure, the marker hasn't been changed to LocalVault by the persistence logic?
        // Wait! The marker is saved by db.save_groups_and_hosts_transaction based on `request.credential_storage`!
        // No, `build_prepared` sets `credential_storage: request.credential_storage`.
        // So the host in the DB *has* the LocalVault marker, but the credential was left in the keychain!
        // But the sweep didn't change it. Wait, `migrate_host_to_vault` handles the credential.
        assert_eq!(
            h1_saved.credential_storage,
            crate::db::CredentialStorage::Keychain
        );
        assert!(crate::vault::get_credential(&h1_saved.id).is_ok()); // Stays in keychain
        let _ = std::fs::remove_dir_all(path);
    }

    use super::*;
    use crate::db::HostDb;
    use crate::vault::StoredCredential;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use xsalsa20poly1305::{
        aead::{Aead, KeyInit},
        Key, Nonce, XSalsa20Poly1305,
    };

    const KEY: [u8; 32] = [0x42; 32];

    fn v8_string(value: &str) -> Vec<u8> {
        let mut bytes = vec![b'"', value.len() as u8];
        bytes.extend(value.as_bytes());
        bytes
    }

    fn v8_object(fields: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut bytes = vec![b'o'];
        for (name, value) in fields {
            bytes.extend(v8_string(name));
            bytes.extend(value);
        }
        bytes.extend([b'{', fields.len() as u8]);
        bytes
    }

    fn v8_array(values: &[Vec<u8>]) -> Vec<u8> {
        let mut bytes = vec![b'A', values.len() as u8];
        for value in values {
            bytes.extend(value);
        }
        bytes.extend([b'$', 0, values.len() as u8]);
        bytes
    }

    fn encrypted(value: &[u8]) -> String {
        let nonce = [0x24; 24];
        let body = XSalsa20Poly1305::new(Key::from_slice(&KEY))
            .encrypt(Nonce::from_slice(&nonce), value)
            .expect("seal fixture");
        let mut raw = vec![0x04, 0x01];
        raw.extend(nonce);
        raw.extend(body);
        STANDARD.encode(raw)
    }

    fn row(database_name: &str, id: &str, value: Vec<u8>) -> Row {
        Row {
            database_name: database_name.to_string(),
            object_store_name: "default".to_string(),
            idb_key: IdbKey::String(id.to_string()),
            value_bytes: value,
        }
    }

    fn source(rows: Vec<Row>) -> SourceRows {
        SourceRows {
            rows,
            counts: BTreeMap::new(),
        }
    }

    struct FakeVault {
        saved: std::sync::Mutex<Vec<(String, StoredCredential)>>,
        deleted: std::sync::Mutex<Vec<String>>,
        calls: std::sync::Mutex<usize>,
        delete_failures: std::sync::Mutex<usize>,
        fail_at: Option<usize>,
    }

    impl FakeVault {
        fn new(fail_at: Option<usize>) -> Self {
            Self {
                saved: std::sync::Mutex::new(Vec::new()),
                deleted: std::sync::Mutex::new(Vec::new()),
                calls: std::sync::Mutex::new(0),
                delete_failures: std::sync::Mutex::new(0),
                fail_at,
            }
        }

        fn fail_next_deletes(&self, count: usize) {
            *self.delete_failures.lock().unwrap() = count;
        }

        fn saved_len(&self) -> usize {
            self.saved.lock().unwrap().len()
        }

        fn deleted_len(&self) -> usize {
            self.deleted.lock().unwrap().len()
        }
    }

    impl CredentialWriter for FakeVault {
        fn save(
            &self,
            host_id: &str,
            credential: &StoredCredential,
        ) -> Result<(), crate::vault::VaultError> {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            self.saved
                .lock()
                .unwrap()
                .push((host_id.to_string(), credential.clone()));
            if self.fail_at == Some(*calls) {
                Err(crate::vault::VaultError::Keychain(
                    "synthetic failure".to_string(),
                ))
            } else {
                Ok(())
            }
        }

        fn delete(&self, host_id: &str) -> Result<(), crate::vault::VaultError> {
            self.deleted.lock().unwrap().push(host_id.to_string());
            let mut failures = self.delete_failures.lock().unwrap();
            if *failures > 0 {
                *failures -= 1;
                return Err(crate::vault::VaultError::Keychain(
                    "synthetic delete failure".to_string(),
                ));
            }
            self.saved.lock().unwrap().retain(|(id, _)| id != host_id);
            Ok(())
        }

        fn exists(&self, host_id: &str) -> Result<bool, crate::vault::VaultError> {
            Ok(self
                .saved
                .lock()
                .unwrap()
                .iter()
                .any(|(id, _)| id == host_id))
        }
    }

    fn temp_db() -> (HostDb, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("anyscp-termius-test-{}", uuid::Uuid::new_v4()));
        let db = HostDb::new(&path).expect("HostDb::new");
        (db, path)
    }

    fn pending_host(id: &str, address: &str, password: Option<&str>) -> NormalizedHost {
        NormalizedHost {
            source_id: id.to_string(),
            public_id: format!("opaque-{id}"),
            label: id.to_string(),
            address: address.to_string(),
            username: "alice".to_string(),
            port: 22,
            group_source_id: None,
            notes: None,
            startup_command: None,
            start_directory: None,
            key_path: None,
            proxy: None,
            password: password.map(|value| SecretText {
                value: value.to_string(),
            }),
            private_key: None,
            passphrase: None,
            warnings: Vec::new(),
        }
    }

    fn saved_host_for_test(id: &str, group_id: Option<&str>) -> SavedHost {
        SavedHost {
            id: id.to_string(),
            label: id.to_string(),
            host: format!("{id}.example"),
            port: 22,
            username: "alice".to_string(),
            auth_type: "password".to_string(),
            credential_storage: Default::default(),
            group_id: group_id.map(str::to_string),
            created_at: "2026-01-01T00:00:00.000Z".to_string(),
            updated_at: "2026-01-01T00:00:00.000Z".to_string(),
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
            last_connected_at: None,
            connection_count: Some(0),
        }
    }

    fn pending_import(hosts: Vec<NormalizedHost>) -> PendingPreview {
        pending_import_with_groups(hosts, Vec::new())
    }

    fn pending_import_with_groups(
        hosts: Vec<NormalizedHost>,
        groups: Vec<NormalizedGroup>,
    ) -> PendingPreview {
        let normalized = NormalizedImport {
            hosts,
            groups,
            warnings: Vec::new(),
        };
        PendingPreview {
            retained_bytes: normalized_retained_bytes(&normalized).unwrap(),
            normalized,
            created_at: Instant::now(),
            drop_probe: None,
        }
    }

    fn commit_request(
        ids: Vec<String>,
        include_credentials: bool,
        credentials_confirmed: bool,
    ) -> TermiusCommitRequest {
        TermiusCommitRequest {
            preview_token: "opaque-token".to_string(),
            selected_ids: ids,
            include_credentials,
            credentials_confirmed,
            credential_storage: CredentialStorage::Keychain,
        }
    }

    #[test]
    fn v1_aliases_normalize_encrypted_password_and_private_key_without_preview_secrets() {
        let password = encrypted(b"fixture-password");
        let private_key = encrypted(b"-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key");
        let passphrase = encrypted(b"fixture-passphrase");
        let rows = source(vec![row(
            "hosts",
            "source-host-1",
            v8_object(&[
                ("name", v8_string("Production")),
                ("host", v8_string("server.example")),
                ("userName", v8_string("alice")),
                ("sshPort", vec![b'U', 0x9a, 0x11]),
                ("password", v8_string(&password)),
                ("private_key", v8_string(&private_key)),
                ("keyPassphrase", v8_string(&passphrase)),
                (
                    "proxy",
                    v8_string("ssh://alice:fixture-proxy-secret@jump.example"),
                ),
                ("note", v8_string("kept in metadata")),
            ]),
        )]);

        let normalized = normalize_source_rows(rows).expect("normalize fixture");
        assert_eq!(normalized.hosts.len(), 1);
        let host = &normalized.hosts[0];
        assert_eq!(host.label, "Production");
        assert_eq!(host.address, "server.example");
        assert_eq!(host.username, "alice");
        assert_eq!(host.port, 2202);
        assert_eq!(
            host.password.as_ref().map(|s| s.value.as_str()),
            Some(password.as_str())
        );
        assert_eq!(
            host.private_key.as_ref().map(|s| s.value.as_str()),
            Some(private_key.as_str())
        );

        let preview = preview_for_test(&normalized, &[]);
        let serialized = serde_json::to_string(&preview).expect("serialize preview");
        assert!(!serialized.contains("fixture-password"));
        assert!(!serialized.contains("fixture-key"));
        assert!(!serialized.contains("fixture-passphrase"));
        assert!(!serialized.contains(&password));
        assert!(!serialized.contains(&private_key));
        assert!(!serialized.contains(&passphrase));
        assert!(!serialized.contains("\"password\":"));
        assert!(!serialized.contains("\"private_key\":"));
        assert!(!serialized.contains("\"privateKey\":"));
        assert!(!serialized.contains("\"key_data\":"));
        assert!(!serialized.contains("\"passphrase\":"));
        assert!(!serialized.contains("\"ciphertext\":"));
        assert!(!serialized.contains("\"nonce\":"));
        assert!(!serialized.contains("keyPassphrase"));
        assert!(!serialized.contains("fixture-proxy-secret"));
        assert!(preview.hosts[0].proxy.is_none());
        assert!(!preview.hosts[0].warnings.is_empty());
        assert!(preview.hosts[0].credential_available);
        assert!(preview.hosts[0].has_password);
        assert!(preview.hosts[0].has_private_key);
    }

    #[test]
    fn preview_decrypts_encrypted_metadata_without_exposing_credentials_in_preview() {
        let label = encrypted(b"Production Server");
        let address = encrypted(b"server.example");
        let username = encrypted(b"alice");
        let group_name = encrypted(b"Production Group");
        let notes = encrypted(b"production bastion notes");
        let start_dir = encrypted(b"/opt/app");
        let startup_cmd = encrypted(b"tmux attach");
        let key_path = encrypted(b"/home/alice/.ssh/id_ed25519");
        let password = encrypted(b"fixture-password");
        let private_key = encrypted(b"-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key");
        let passphrase = encrypted(b"fixture-passphrase");

        let rows = source(vec![
            row(
                "groups",
                "group-1",
                v8_object(&[
                    ("id", v8_string("group-1")),
                    ("name", v8_string(&group_name)),
                ]),
            ),
            row(
                "hosts",
                "source-host-1",
                v8_object(&[
                    ("id", v8_string("source-host-1")),
                    ("name", v8_string(&label)),
                    ("host", v8_string(&address)),
                    ("userName", v8_string(&username)),
                    ("groupId", v8_string("group-1")),
                    ("sshPort", vec![b'U', 0x9a, 0x11]),
                    ("password", v8_string(&password)),
                    ("private_key", v8_string(&private_key)),
                    ("keyPassphrase", v8_string(&passphrase)),
                    ("note", v8_string(&notes)),
                    ("start_directory", v8_string(&start_dir)),
                    ("startup_command", v8_string(&startup_cmd)),
                    ("key_path", v8_string(&key_path)),
                ]),
            ),
        ]);

        let normalized =
            normalize_source_rows_with_key(rows, Some(&KEY)).expect("normalize fixture with key");
        assert_eq!(normalized.hosts.len(), 1);
        let host = &normalized.hosts[0];
        assert_eq!(host.label, "Production Server");
        assert_eq!(host.address, "server.example");
        assert_eq!(host.username, "alice");
        assert_eq!(host.notes.as_deref(), Some("production bastion notes"));
        assert_eq!(host.start_directory.as_deref(), Some("/opt/app"));
        assert_eq!(host.startup_command.as_deref(), Some("tmux attach"));
        assert_eq!(
            host.key_path.as_deref(),
            Some("/home/alice/.ssh/id_ed25519")
        );
        assert_eq!(normalized.groups.len(), 1);
        assert_eq!(normalized.groups[0].name, "Production Group");

        // Credentials must remain ciphertext envelopes in normalized host
        assert_eq!(
            host.password.as_ref().map(|s| s.value.as_str()),
            Some(password.as_str())
        );
        assert_eq!(
            host.private_key.as_ref().map(|s| s.value.as_str()),
            Some(private_key.as_str())
        );
        assert_eq!(
            host.passphrase.as_ref().map(|s| s.value.as_str()),
            Some(passphrase.as_str())
        );

        let preview = preview_for_test(&normalized, &[]);
        assert_eq!(preview.hosts[0].label, "Production Server");
        assert_eq!(preview.hosts[0].address, "server.example");
        assert_eq!(preview.hosts[0].username, "alice");
        assert_eq!(
            preview.hosts[0].notes.as_deref(),
            Some("production bastion notes")
        );
        assert_eq!(
            preview.hosts[0].start_directory.as_deref(),
            Some("/opt/app")
        );
        assert_eq!(
            preview.hosts[0].startup_command.as_deref(),
            Some("tmux attach")
        );
        assert_eq!(
            preview.hosts[0].key_path.as_deref(),
            Some("/home/alice/.ssh/id_ed25519")
        );
        assert_eq!(preview.groups[0].name, "Production Group");

        let serialized = serde_json::to_string(&preview).expect("serialize preview");
        assert!(serialized.contains("Production Server"));
        assert!(serialized.contains("server.example"));
        assert!(serialized.contains("alice"));
        assert!(serialized.contains("Production Group"));

        // No ciphertext envelope strings in preview
        assert!(!serialized.contains(&label));
        assert!(!serialized.contains(&address));
        assert!(!serialized.contains(&username));
        assert!(!serialized.contains(&group_name));
        assert!(!serialized.contains(&password));
        assert!(!serialized.contains(&private_key));
        assert!(!serialized.contains(&passphrase));

        // No raw secrets in preview
        assert!(!serialized.contains("fixture-password"));
        assert!(!serialized.contains("fixture-key"));
        assert!(!serialized.contains("fixture-passphrase"));
    }

    #[test]
    fn preview_fails_closed_when_encrypted_metadata_cannot_be_decrypted() {
        let label = encrypted(b"Secret Production");
        let address = encrypted(b"secret.example");
        let rows = source(vec![row(
            "hosts",
            "source-host-1",
            v8_object(&[("name", v8_string(&label)), ("host", v8_string(&address))]),
        )]);

        // With no key provided, it must fail closed and never return host with ciphertext address
        let result = normalize_source_rows_with_key(rows, None);
        assert!(matches!(
            result,
            Err(TermiusImportError::MetadataUnavailable)
        ));
    }

    #[test]
    fn v1_chain_resolves_encrypted_structural_ids_and_timestamps() {
        let host_id = encrypted(b"host-uuid-1");
        let cfg_id = encrypted(b"cfg-uuid-1");
        let identity_id = encrypted(b"identity-uuid-1");
        let key_id = encrypted(b"key-uuid-1");
        let group_id = encrypted(b"group-uuid-1");
        let timestamp = encrypted(b"2025-06-01T12:00:00Z");
        let port_str = encrypted(b"2222");

        let rows = source(vec![
            row(
                "groups",
                "group-storage",
                v8_object(&[
                    ("id", v8_string(&group_id)),
                    ("name", v8_string(&encrypted(b"Infrastructure"))),
                    ("updated_at", v8_string(&timestamp)),
                ]),
            ),
            row(
                "hosts",
                "host-storage",
                v8_object(&[
                    ("id", v8_string(&host_id)),
                    ("name", v8_string(&encrypted(b"Encrypted Chain Host"))),
                    ("address", v8_string(&encrypted(b"chain.example"))),
                    ("groupId", v8_string(&group_id)),
                    ("ssh_config", v8_string(&cfg_id)),
                    ("updated_at", v8_string(&timestamp)),
                ]),
            ),
            row(
                "ssh_configs",
                "cfg-storage",
                v8_object(&[
                    ("id", v8_string(&cfg_id)),
                    ("port", v8_string(&port_str)),
                    ("identity", v8_string(&identity_id)),
                    ("updated_at", v8_string(&timestamp)),
                ]),
            ),
            row(
                "ssh_identities",
                "identity-storage",
                v8_object(&[
                    ("id", v8_string(&identity_id)),
                    ("username", v8_string(&encrypted(b"chain-user"))),
                    ("password", v8_string(&encrypted(b"chain-pass"))),
                    ("ssh_key", v8_string(&key_id)),
                    ("updated_at", v8_string(&timestamp)),
                ]),
            ),
            row(
                "keys",
                "key-storage",
                v8_object(&[
                    ("id", v8_string(&key_id)),
                    (
                        "private_key",
                        v8_string(&encrypted(
                            b"-----BEGIN OPENSSH PRIVATE KEY-----\nchain-key",
                        )),
                    ),
                    ("updated_at", v8_string(&timestamp)),
                ]),
            ),
        ]);

        let normalized =
            normalize_source_rows_with_key(rows, Some(&KEY)).expect("normalize encrypted chain");
        assert_eq!(normalized.hosts.len(), 1);
        let host = &normalized.hosts[0];
        assert_eq!(host.label, "Encrypted Chain Host");
        assert_eq!(host.address, "chain.example");
        assert_eq!(host.username, "chain-user");
        assert_eq!(host.port, 2222);
        assert!(
            host.warnings.is_empty(),
            "unexpected host warnings: {:?}",
            host.warnings
        );
        assert!(
            normalized.warnings.is_empty(),
            "unexpected import warnings: {:?}",
            normalized.warnings
        );
    }

    #[test]
    fn corrupted_metadata_ciphertexts_are_not_emitted_as_plaintext() {
        // An envelope with unknown header version
        let mut raw = vec![0x04, 0x99]; // unknown version
        raw.extend([0x24; 24]);
        raw.extend([0x42; 32]);
        let corrupted = STANDARD.encode(raw);

        let rows = source(vec![row(
            "hosts",
            "source-host-bad",
            v8_object(&[
                ("name", v8_string(&corrupted)),
                ("host", v8_string(&corrupted)),
            ]),
        )]);

        let result = normalize_source_rows_with_key(rows, Some(&KEY));
        assert!(matches!(
            result,
            Err(TermiusImportError::MetadataUnavailable)
        ));
    }

    #[test]
    fn encrypted_proxy_metadata_decrypted_and_validated() {
        let valid_proxy = encrypted(b"jumpuser@jumphost.example:2222");
        let unsafe_proxy = encrypted(b"alice:secretpass@jumphost.example:2222");

        let rows = source(vec![
            row(
                "hosts",
                "host-safe-proxy",
                v8_object(&[
                    ("id", v8_string("host-safe-proxy")),
                    ("name", v8_string("Safe Proxy Host")),
                    ("host", v8_string("safe.example")),
                    ("proxy", v8_string(&valid_proxy)),
                ]),
            ),
            row(
                "hosts",
                "host-unsafe-proxy",
                v8_object(&[
                    ("id", v8_string("host-unsafe-proxy")),
                    ("name", v8_string("Unsafe Proxy Host")),
                    ("host", v8_string("unsafe.example")),
                    ("proxy", v8_string(&unsafe_proxy)),
                ]),
            ),
        ]);

        let normalized =
            normalize_source_rows_with_key(rows, Some(&KEY)).expect("normalize proxies");
        assert_eq!(normalized.hosts.len(), 2);
        let safe_host = normalized
            .hosts
            .iter()
            .find(|h| h.label == "Safe Proxy Host")
            .unwrap();
        assert_eq!(
            safe_host.proxy.as_deref(),
            Some("jumpuser@jumphost.example:2222")
        );

        let unsafe_host = normalized
            .hosts
            .iter()
            .find(|h| h.label == "Unsafe Proxy Host")
            .unwrap();
        assert!(unsafe_host.proxy.is_none());
        assert!(unsafe_host.warnings.iter().any(|w| w == WARN_PROXY_UNSAFE));
    }

    #[test]
    fn encrypted_group_relationships_hierarchy_resolved() {
        let parent_id = encrypted(b"parent-group-id");
        let parent_name = encrypted(b"Parent Infrastructure");
        let child_id = encrypted(b"child-group-id");
        let child_name = encrypted(b"Child Production");

        let rows = source(vec![
            row(
                "groups",
                "grp-parent",
                v8_object(&[
                    ("id", v8_string(&parent_id)),
                    ("name", v8_string(&parent_name)),
                ]),
            ),
            row(
                "groups",
                "grp-child",
                v8_object(&[
                    ("id", v8_string(&child_id)),
                    ("name", v8_string(&child_name)),
                    ("parentId", v8_string(&parent_id)),
                ]),
            ),
            row(
                "hosts",
                "host-in-child",
                v8_object(&[
                    ("id", v8_string("host-1")),
                    ("name", v8_string("Grouped Host")),
                    ("host", v8_string("grouped.example")),
                    ("groupId", v8_string(&child_id)),
                ]),
            ),
        ]);

        let normalized =
            normalize_source_rows_with_key(rows, Some(&KEY)).expect("normalize groups");
        assert_eq!(normalized.groups.len(), 2);
        let parent = normalized
            .groups
            .iter()
            .find(|g| g.source_id == "parent-group-id")
            .unwrap();
        assert_eq!(parent.name, "Parent Infrastructure");
        let child = normalized
            .groups
            .iter()
            .find(|g| g.source_id == "child-group-id")
            .unwrap();
        assert_eq!(child.name, "Parent Infrastructure / Child Production");
        assert_eq!(child.parent_source_id, None);

        let host = &normalized.hosts[0];
        assert_eq!(host.group_source_id.as_deref(), Some("child-group-id"));
        assert!(
            normalized.warnings.is_empty(),
            "warnings: {:?}",
            normalized.warnings
        );
    }

    #[test]
    fn v1_chain_deduplicates_latest_rows_and_retains_alternate_aliases() {
        let private_key = "-----BEGIN OPENSSH PRIVATE KEY-----\ncurrent-key";
        let rows = source(vec![
            row(
                "hosts",
                "host-storage",
                v8_object(&[
                    ("local_id", v8_string("host-local")),
                    ("updated_at", v8_string("2024-01-01T00:00:00Z")),
                    ("label", v8_string("stale host")),
                    ("address", v8_string("referenced.example")),
                    (
                        "ssh_config",
                        v8_object(&[("local_id", v8_string("cfg-local"))]),
                    ),
                ]),
            ),
            row(
                "hosts",
                "host-storage",
                v8_object(&[
                    ("id", v8_string("host-id")),
                    ("updated_at", v8_string("2025-01-01T00:00:00Z")),
                    ("label", v8_string("current host")),
                    ("address", v8_string("referenced.example")),
                    ("notes", v8_string("source notes")),
                    (
                        "ssh_config",
                        v8_object(&[("local_id", v8_string("cfg-local"))]),
                    ),
                ]),
            ),
            row(
                "ssh_configs",
                "config-storage",
                v8_object(&[
                    ("local_id", v8_string("cfg-local")),
                    ("updated_at", v8_string("2024-01-01T00:00:00Z")),
                    ("port", vec![b'U', 0x98, 0x11]),
                    (
                        "identity",
                        v8_object(&[("local_id", v8_string("identity-local"))]),
                    ),
                ]),
            ),
            row(
                "ssh_configs",
                "config-storage",
                v8_object(&[
                    ("id", v8_string("cfg-id")),
                    ("updated_at", v8_string("2025-01-01T00:00:00Z")),
                    ("port", vec![b'U', 0xc4, 0x11]),
                    (
                        "identity",
                        v8_object(&[("local_id", v8_string("identity-local"))]),
                    ),
                    (
                        "proxycommand",
                        v8_object(&[("local_id", v8_string("proxy-local"))]),
                    ),
                ]),
            ),
            row(
                "ssh_identities",
                "identity-storage",
                v8_object(&[
                    ("local_id", v8_string("identity-local")),
                    ("updated_at", v8_string("2024-01-01T00:00:00Z")),
                    ("username", v8_string("stale-user")),
                    ("password", v8_string("stale-password")),
                    (
                        "ssh_key",
                        v8_object(&[("local_id", v8_string("key-local"))]),
                    ),
                ]),
            ),
            row(
                "ssh_identities",
                "identity-storage",
                v8_object(&[
                    ("id", v8_string("identity-id")),
                    ("updated_at", v8_string("2025-01-01T00:00:00Z")),
                    ("username", v8_string("joined-user")),
                    ("password", v8_string("identity-password")),
                    (
                        "ssh_key",
                        v8_object(&[("local_id", v8_string("key-local"))]),
                    ),
                ]),
            ),
            row(
                "keys",
                "key-storage",
                v8_object(&[
                    ("local_id", v8_string("key-local")),
                    ("updated_at", v8_string("2024-01-01T00:00:00Z")),
                    ("private_key", v8_string("stale-key")),
                    ("passphrase", v8_string("stale-passphrase")),
                ]),
            ),
            row(
                "keys",
                "key-storage",
                v8_object(&[
                    ("id", v8_string("key-id")),
                    ("updated_at", v8_string("2025-01-01T00:00:00Z")),
                    ("private_key", v8_string(private_key)),
                    ("passphrase", v8_string("current-passphrase")),
                ]),
            ),
            row(
                "proxies",
                "proxy-storage",
                v8_object(&[
                    ("local_id", v8_string("proxy-local")),
                    ("updated_at", v8_string("2024-01-01T00:00:00Z")),
                    ("hostname", v8_string("stale-jump.example")),
                ]),
            ),
            row(
                "proxies",
                "proxy-storage",
                v8_object(&[
                    ("id", v8_string("proxy-id")),
                    ("updated_at", v8_string("2025-01-01T00:00:00Z")),
                    ("hostname", v8_string("jump.example")),
                ]),
            ),
        ]);

        let normalized = normalize_source_rows(rows).expect("normalize referenced records");
        assert_eq!(normalized.hosts.len(), 1);
        let host = &normalized.hosts[0];
        assert_eq!(host.label, "current host");
        assert_eq!(host.port, 2244);
        assert_eq!(host.username, "joined-user");
        assert_eq!(host.notes.as_deref(), Some("source notes"));
        assert_eq!(
            host.password.as_ref().map(|secret| secret.value.as_str()),
            Some("identity-password")
        );
        assert_eq!(
            host.private_key
                .as_ref()
                .map(|secret| secret.value.as_str()),
            Some(private_key)
        );
        assert_eq!(
            host.passphrase.as_ref().map(|secret| secret.value.as_str()),
            Some("current-passphrase")
        );
        assert!(host.proxy.is_none());
        assert!(host
            .warnings
            .iter()
            .any(|warning| warning == WARN_PROXY_NOT_LINKED));

        let preview = preview_for_test(&normalized, &[]);
        let serialized_preview = serde_json::to_string(&preview).expect("serialize preview");
        assert!(!serialized_preview.contains(private_key));
        assert!(!serialized_preview.contains("current-passphrase"));
        assert!(!serialized_preview.contains("identity-password"));
        assert!(!serialized_preview.contains("stale-key"));
        assert!(!serialized_preview.contains("\"password\":"));
        assert!(!serialized_preview.contains("\"privateKey\":"));
        assert!(!serialized_preview.contains("\"key_data\":"));
        assert!(!serialized_preview.contains("\"passphrase\":"));
        assert!(!serialized_preview.contains("\"ciphertext\":"));
        assert!(!serialized_preview.contains("\"nonce\":"));
        assert!(preview.hosts[0].credential_available);
        assert!(preview.hosts[0].has_private_key);
        assert!(preview.hosts[0].has_password);

        let host_id = host.public_id.clone();
        let pending = pending_import_with_groups(normalized.hosts, normalized.groups);
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let result = commit_pending(
            &db,
            &vault,
            pending,
            &commit_request(vec![host_id], true, true),
        )
        .expect("commit referenced records");

        assert_eq!(result.0.credentials_stored, 1);
        assert!(vault.saved.lock().unwrap().iter().any(|(_, credential)| {
            matches!(
                credential,
                StoredCredential::PrivateKeyData {
                    key_data,
                    passphrase: Some(passphrase)
                } if key_data == private_key && passphrase == "current-passphrase"
            )
        }));
        let saved_host = &db.list_hosts().expect("list hosts")[0];
        assert_eq!(saved_host.port, 2244);
        assert_eq!(saved_host.username, "joined-user");
        assert_eq!(saved_host.auth_type, "privateKeyData");
        assert_eq!(saved_host.proxy_jump, None);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn latest_rows_normalize_iso_offsets_and_numeric_epoch_units() {
        let rows = source(vec![
            row(
                "hosts",
                "iso-host",
                v8_object(&[
                    ("id", v8_string("iso-id")),
                    ("updated_at", v8_string("2025-01-01T00:30:00+01:00")),
                    ("label", v8_string("iso-stale")),
                    ("host", v8_string("iso.example")),
                ]),
            ),
            row(
                "hosts",
                "iso-host",
                v8_object(&[
                    ("id", v8_string("iso-id")),
                    ("updated_at", v8_string("2025-01-01T00:00:00Z")),
                    ("label", v8_string("iso-current")),
                    ("host", v8_string("iso.example")),
                ]),
            ),
            row(
                "hosts",
                "epoch-host",
                v8_object(&[
                    ("id", v8_string("epoch-id")),
                    ("updated_at", v8_string("1735689599000")),
                    ("label", v8_string("epoch-stale")),
                    ("host", v8_string("epoch.example")),
                ]),
            ),
            row(
                "hosts",
                "epoch-host",
                v8_object(&[
                    ("id", v8_string("epoch-id")),
                    ("updated_at", v8_string("2025-01-01T00:00:00Z")),
                    ("label", v8_string("epoch-current")),
                    ("host", v8_string("epoch.example")),
                ]),
            ),
        ]);
        let normalized = normalize_source_rows(rows).expect("normalize timestamps");
        let labels = normalized
            .hosts
            .iter()
            .map(|host| host.label.as_str())
            .collect::<Vec<_>>();
        assert_eq!(labels, vec!["iso-current", "epoch-current"]);
    }

    #[test]
    fn invalid_update_markers_use_source_order_and_emit_static_warning() {
        let rows = source(vec![
            row(
                "hosts",
                "invalid-host",
                v8_object(&[
                    ("updated_at", v8_string("not-a-timestamp")),
                    ("label", v8_string("first")),
                    ("host", v8_string("invalid.example")),
                ]),
            ),
            row(
                "hosts",
                "invalid-host",
                v8_object(&[
                    ("updated_at", v8_string("also-invalid")),
                    ("label", v8_string("second")),
                    ("host", v8_string("invalid.example")),
                ]),
            ),
        ]);
        let normalized = normalize_source_rows(rows).expect("normalize invalid timestamps");
        assert_eq!(normalized.hosts[0].label, "second");
        assert!(normalized
            .warnings
            .iter()
            .any(|warning| warning == WARN_INCOMPARABLE_UPDATE));
    }

    #[test]
    fn legacy_inline_identity_and_proxy_aliases_remain_bounded_fallbacks() {
        let private_key = "-----BEGIN OPENSSH PRIVATE KEY-----\nlegacy-key";
        let rows = source(vec![
            row(
                "hosts",
                "host-ref",
                v8_object(&[
                    ("id", v8_string("host-ref")),
                    ("name", v8_string("Referenced host")),
                    ("hostname", v8_string("referenced.example")),
                    ("username", v8_string("alice")),
                    ("sshIdentityId", v8_string("identity-ref")),
                    ("proxyId", v8_string("proxy-ref")),
                    ("notes", v8_string("source notes")),
                ]),
            ),
            row(
                "ssh_identities",
                "identity-ref",
                v8_object(&[
                    ("id", v8_string("identity-ref")),
                    ("keyId", v8_string("key-ref")),
                ]),
            ),
            row(
                "keys",
                "key-ref",
                v8_object(&[
                    ("id", v8_string("key-ref")),
                    ("privateKey", v8_string(private_key)),
                    ("passphrase", v8_string("legacy-passphrase")),
                ]),
            ),
            row(
                "proxies",
                "proxy-ref",
                v8_object(&[
                    ("id", v8_string("proxy-ref")),
                    ("targetId", v8_string("jump-host-ref")),
                ]),
            ),
        ]);

        let normalized = normalize_source_rows(rows).expect("normalize referenced records");
        assert_eq!(normalized.hosts.len(), 1);
        let host = &normalized.hosts[0];
        assert_eq!(host.notes.as_deref(), Some("source notes"));
        assert_eq!(
            host.private_key
                .as_ref()
                .map(|secret| secret.value.as_str()),
            Some(private_key)
        );
        assert_eq!(
            host.passphrase.as_ref().map(|secret| secret.value.as_str()),
            Some("legacy-passphrase")
        );
        assert!(host.proxy.is_none());
        assert!(host
            .warnings
            .iter()
            .any(|warning| warning == WARN_PROXY_NOT_LINKED));

        let preview = preview_for_test(&normalized, &[]);
        let serialized_preview = serde_json::to_string(&preview).expect("serialize preview");
        assert!(!serialized_preview.contains(private_key));
        assert!(!serialized_preview.contains("legacy-passphrase"));
        assert!(!serialized_preview.contains("\"privateKey\":"));
        assert!(!serialized_preview.contains("\"key_data\":"));
        assert!(!serialized_preview.contains("\"passphrase\":"));
        assert!(!serialized_preview.contains("\"ciphertext\":"));
        assert!(!serialized_preview.contains("\"nonce\":"));
        assert!(preview.hosts[0].credential_available);
        assert!(preview.hosts[0].proxy.is_none());

        let host_id = host.public_id.clone();
        let pending = pending_import_with_groups(normalized.hosts, normalized.groups);
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let result = commit_pending(
            &db,
            &vault,
            pending,
            &commit_request(vec![host_id], true, true),
        )
        .expect("commit referenced records");

        assert_eq!(result.0.credentials_stored, 1);
        assert!(vault.saved.lock().unwrap().iter().any(|(_, credential)| {
            matches!(
                credential,
                StoredCredential::PrivateKeyData {
                    key_data,
                    passphrase: Some(passphrase)
                } if key_data == private_key && passphrase == "legacy-passphrase"
            )
        }));
        let saved_host = &db.list_hosts().expect("list hosts")[0];
        assert_eq!(saved_host.auth_type, "privateKeyData");
        assert_eq!(saved_host.proxy_jump, None);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn proxy_allowlist_accepts_only_non_secret_jump_metadata() {
        assert_eq!(
            safe_proxy_value("alice@jump.example:2222").as_deref(),
            Some("alice@jump.example:2222")
        );
        assert_eq!(
            safe_proxy_value("[2001:db8::1]:22").as_deref(),
            Some("[2001:db8::1]:22")
        );
        assert!(safe_proxy_value("ssh://alice:secret@jump.example").is_none());
        assert!(safe_proxy_value("sshpass -p secret ssh jump.example").is_none());
        assert!(safe_proxy_value("jump.example?password=secret").is_none());
        assert!(safe_proxy_value("alice:secret@jump.example").is_none());
    }

    #[test]
    fn unsafe_proxy_text_is_neither_previewed_nor_persisted() {
        let rows = source(vec![row(
            "hosts",
            "unsafe-proxy",
            v8_object(&[
                ("host", v8_string("target.example")),
                (
                    "proxy",
                    v8_string("sshpass -p fixture-secret ssh jump.example"),
                ),
            ]),
        )]);
        let normalized = normalize_source_rows(rows).expect("normalize unsafe proxy");
        assert!(normalized.hosts[0].proxy.is_none());
        assert!(normalized.hosts[0]
            .warnings
            .iter()
            .any(|warning| warning == WARN_PROXY_UNSAFE));
        let serialized = serde_json::to_string(&preview_for_test(&normalized, &[])).unwrap();
        assert!(!serialized.contains("fixture-secret"));

        let host_id = normalized.hosts[0].public_id.clone();
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        commit_pending(
            &db,
            &vault,
            pending_import(normalized.hosts),
            &commit_request(vec![host_id], false, false),
        )
        .expect("commit without proxy text");
        assert!(db.list_hosts().unwrap()[0].proxy_jump.is_none());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn multiple_proxy_relationships_are_not_guessed() {
        let rows = source(vec![
            row(
                "hosts",
                "multi-proxy-host",
                v8_object(&[
                    ("id", v8_string("multi-proxy-host")),
                    ("host", v8_string("multi-proxy.example")),
                    (
                        "proxyId",
                        v8_array(&[v8_string("proxy-one"), v8_string("proxy-two")]),
                    ),
                ]),
            ),
            row(
                "proxies",
                "proxy-one",
                v8_object(&[
                    ("id", v8_string("proxy-one")),
                    ("targetId", v8_string("jump-one")),
                ]),
            ),
            row(
                "proxies",
                "proxy-two",
                v8_object(&[
                    ("id", v8_string("proxy-two")),
                    ("targetId", v8_string("jump-two")),
                ]),
            ),
        ]);

        let normalized = normalize_source_rows(rows).expect("normalize multi-proxy records");
        assert!(normalized.hosts[0].proxy.is_none());
        assert!(normalized.hosts[0]
            .warnings
            .iter()
            .any(|warning| warning == WARN_PROXY_RELATIONSHIP));
        assert!(normalized
            .warnings
            .iter()
            .any(|warning| warning == WARN_PROXY_RELATIONSHIP));
    }

    #[test]
    fn nested_group_rows_flatten_paths_and_commit_flat_group_association() {
        let rows = source(vec![
            row(
                "groups",
                "root",
                v8_object(&[("id", v8_string("root")), ("name", v8_string("Cloud"))]),
            ),
            row(
                "groups",
                "child",
                v8_object(&[
                    ("id", v8_string("child")),
                    ("name", v8_string("Production")),
                    ("parentId", v8_string("root")),
                ]),
            ),
            row(
                "hosts",
                "host",
                v8_object(&[
                    ("id", v8_string("host")),
                    ("label", v8_string("prod")),
                    ("address", v8_string("10.0.0.8")),
                    ("username", v8_string("root")),
                    ("groupId", v8_string("child")),
                ]),
            ),
        ]);

        let normalized = normalize_source_rows(rows).expect("normalize groups");
        assert_eq!(normalized.groups.len(), 2);
        let child = normalized
            .groups
            .iter()
            .find(|g| g.source_id == "child")
            .unwrap();
        assert_eq!(child.name, "Cloud / Production");
        assert!(child.parent_source_id.is_none());
        assert_eq!(
            normalized.hosts[0].group_source_id.as_deref(),
            Some("child")
        );
        let preview = preview_for_test(&normalized, &[]);
        assert_eq!(preview.groups[1].name, "Cloud / Production");
        assert_eq!(
            preview.hosts[0].group_id.as_deref(),
            Some(child.public_id.as_str())
        );
        assert!(!serde_json::to_string(&preview)
            .expect("serialize preview")
            .contains("parent_id"));

        let host_id = normalized.hosts[0].public_id.clone();
        let pending = pending_import_with_groups(normalized.hosts, normalized.groups);
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let result = commit_pending(
            &db,
            &vault,
            pending,
            &commit_request(vec![host_id], false, false),
        )
        .expect("commit flattened group");
        assert_eq!(result.0.imported_groups, 1);
        let groups = db.list_groups().expect("list groups");
        assert_eq!(groups[0].name, "Cloud / Production");
        assert_ne!(groups[0].created_at, "datetime('now')");
        assert_ne!(groups[0].updated_at, "datetime('now')");
        assert_eq!(
            db.list_hosts().expect("list hosts")[0].group_id.as_deref(),
            Some(groups[0].id.as_str())
        );
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn metadata_only_is_the_default_and_preview_token_is_opaque() {
        let request = TermiusPreviewRequest::default();
        assert!(request.metadata_only);
        let deserialized: TermiusPreviewRequest = serde_json::from_str("{}").expect("defaults");
        assert!(deserialized.metadata_only);

        let normalized = NormalizedImport {
            hosts: vec![],
            groups: vec![],
            warnings: vec![],
        };
        let preview = preview_for_test(&normalized, &[]);
        assert!(!preview.preview_token.is_empty());
    }

    #[test]
    fn ipc_commit_contract_accepts_opaque_ids_and_explicit_confirmation() {
        let request: TermiusCommitRequest = serde_json::from_value(serde_json::json!({
            "preview_token": "opaque-preview-token",
            "selectedIds": ["opaque-host-id"],
            "includeCredentials": true,
            "credentialsConfirmed": true
        }))
        .expect("deserialize IPC request");
        assert_eq!(request.selected_ids, vec!["opaque-host-id"]);
        assert!(request.include_credentials);
        assert!(request.credentials_confirmed);

        let error = serde_json::to_value(TermiusImportError::CleanupPending).unwrap();
        assert_eq!(error["kind"], "cleanup_pending");
        assert_eq!(error["message"], "Termius credential cleanup is pending");

        let preview = preview_for_test(
            &NormalizedImport {
                hosts: vec![pending_host("wire", "wire.example", Some("wire-secret"))],
                groups: Vec::new(),
                warnings: Vec::new(),
            },
            &[],
        );
        let wire = serde_json::to_value(preview).unwrap();
        assert!(wire["preview_token"].is_string());
        assert_eq!(wire["hosts"][0]["id"], "opaque-wire");
        assert!(!wire.to_string().contains("wire-secret"));
    }

    #[test]
    fn preview_tokens_expire_and_are_single_use() {
        let state = TermiusImportState::new();
        let token = state
            .insert_at(
                NormalizedImport {
                    hosts: vec![],
                    groups: vec![],
                    warnings: vec![],
                },
                Instant::now(),
            )
            .expect("insert preview");
        assert!(state.take(&token).is_ok());
        assert!(matches!(
            state.take(&token),
            Err(TermiusImportError::PreviewExpired)
        ));

        let expired = state
            .insert_at(
                NormalizedImport {
                    hosts: vec![],
                    groups: vec![],
                    warnings: vec![],
                },
                Instant::now() - Duration::from_secs(PREVIEW_TTL_SECONDS + 1),
            )
            .expect("insert expired preview");
        assert!(matches!(
            state.take(&expired),
            Err(TermiusImportError::PreviewExpired)
        ));
    }

    #[test]
    fn timer_evicts_expired_preview_and_drops_pending_state_without_follow_up_operation() {
        let state = TermiusImportState::with_ttl(Duration::from_millis(10));
        let drop_probe = std::sync::Arc::new(PendingDropProbe::new());
        let token = "opaque-expiry-token".to_string();
        let pending = PendingPreview {
            normalized: NormalizedImport {
                hosts: vec![],
                groups: vec![],
                warnings: vec![],
            },
            created_at: Instant::now(),
            retained_bytes: 0,
            drop_probe: Some(drop_probe.clone()),
        };
        state
            .insert_pending_for_test(token.clone(), pending)
            .expect("insert preview");
        assert_eq!(state.len(), 1);

        assert!(
            drop_probe.wait_for_drop(Duration::from_secs(1)),
            "spawned expiry timer did not remove the pending preview"
        );
        assert_eq!(state.len(), 0);
        assert_eq!(
            drop_probe.dropped.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "expiration must drop the pending normalized record"
        );
    }

    #[test]
    fn preview_state_has_a_hard_count_bound() {
        let state = TermiusImportState::new();
        for _ in 0..MAX_PREVIEW_STATES {
            state
                .insert(NormalizedImport {
                    hosts: vec![],
                    groups: vec![],
                    warnings: vec![],
                })
                .expect("preview within bound");
        }
        assert_eq!(state.len(), MAX_PREVIEW_STATES);
        assert_eq!(
            state.insert(NormalizedImport {
                hosts: vec![],
                groups: vec![],
                warnings: vec![],
            }),
            Err(TermiusImportError::TooManyPreviews)
        );
    }

    #[test]
    fn preview_state_releases_aggregate_bytes_on_take_and_expiry() {
        let state = TermiusImportState::with_limits(Duration::from_millis(10), 16);
        let token = state
            .insert(NormalizedImport {
                hosts: vec![],
                groups: vec![],
                warnings: vec!["12345678".to_string()],
            })
            .expect("first preview");
        assert_eq!(state.retained_bytes(), 8);
        assert!(matches!(
            state.insert(NormalizedImport {
                hosts: vec![],
                groups: vec![],
                warnings: vec!["123456789".to_string()],
            }),
            Err(TermiusImportError::PreviewLimit)
        ));
        assert_eq!(state.retained_bytes(), 8);
        drop(state.take(&token).expect("take preview"));
        assert_eq!(state.retained_bytes(), 0);

        state
            .insert(NormalizedImport {
                hosts: vec![],
                groups: vec![],
                warnings: vec!["12345678".to_string()],
            })
            .expect("expiring preview");
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(state.retained_bytes(), 0);
    }

    #[test]
    fn metadata_only_commit_never_writes_credentials() {
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let pending = pending_import(vec![pending_host("one", "one.example", Some("secret"))]);
        let request = commit_request(vec!["opaque-one".to_string()], false, false);

        let result = commit_pending(&db, &vault, pending, &request).expect("metadata commit");
        assert_eq!(result.0.imported_hosts, 1);
        assert_eq!(result.0.credentials_stored, 0);
        assert_eq!(vault.saved_len(), 0);
        assert_eq!(db.list_hosts().expect("list hosts").len(), 1);
        assert_eq!(db.list_hosts().unwrap()[0].auth_type, "password");
        assert_ne!(db.list_hosts().unwrap()[0].created_at, "datetime('now')");
        assert_ne!(db.list_hosts().unwrap()[0].updated_at, "datetime('now')");
        let serialized = serde_json::to_string(&result.0).expect("serialize result");
        assert!(!serialized.contains("secret"));
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn metadata_only_raw_private_key_has_no_vault_dependency() {
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let mut host = pending_host("raw-key", "raw-key.example", None);
        host.private_key = Some(SecretText {
            value: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key".to_string(),
        });
        let pending = pending_import(vec![host]);
        let result = commit_pending(
            &db,
            &vault,
            pending,
            &commit_request(vec!["opaque-raw-key".to_string()], false, false),
        )
        .expect("metadata-only private-key commit");

        assert_eq!(result.0.credentials_stored, 0);
        assert_eq!(vault.saved_len(), 0);
        assert_eq!(
            db.list_hosts().expect("list hosts")[0].auth_type,
            "password"
        );
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn key_path_policy_stores_only_key_passphrase_and_keeps_private_key_auth() {
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let mut host = pending_host("key-path", "key-path.example", Some("ignored-password"));
        host.key_path = Some("/keys/id_ed25519".to_string());
        host.passphrase = Some(SecretText {
            value: "key-passphrase".to_string(),
        });

        let result = commit_pending(
            &db,
            &vault,
            pending_import(vec![host]),
            &commit_request(vec!["opaque-key-path".to_string()], true, true),
        )
        .expect("key-path commit");

        assert_eq!(result.0.credentials_stored, 1);
        assert!(vault.saved.lock().unwrap().iter().any(|(_, credential)| {
            matches!(credential, StoredCredential::KeyPassphrase { passphrase } if passphrase == "key-passphrase")
        }));
        assert!(!vault
            .saved
            .lock()
            .unwrap()
            .iter()
            .any(|(_, credential)| { matches!(credential, StoredCredential::Password { .. }) }));
        assert_eq!(db.list_hosts().unwrap()[0].auth_type, "privateKey");
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn credential_opt_in_requires_explicit_confirmation() {
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let pending = pending_import(vec![pending_host("one", "one.example", Some("secret"))]);
        let request = commit_request(vec!["opaque-one".to_string()], true, false);

        assert!(matches!(
            commit_pending(&db, &vault, pending, &request),
            Err(TermiusImportError::CredentialsConfirmationRequired)
        ));
        assert_eq!(vault.saved_len(), 0);
        assert!(db.list_hosts().expect("list hosts").is_empty());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn credential_opt_in_stores_password_and_private_key_in_vault_only() {
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let mut key_host = pending_host("key", "key.example", None);
        key_host.private_key = Some(SecretText {
            value: "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-key".to_string(),
        });
        key_host.passphrase = Some(SecretText {
            value: "fixture-passphrase".to_string(),
        });
        let pending = pending_import(vec![
            pending_host("password", "password.example", Some("fixture-password")),
            key_host,
        ]);
        let request = commit_request(
            vec!["opaque-password".to_string(), "opaque-key".to_string()],
            true,
            true,
        );

        let result = commit_pending(&db, &vault, pending, &request).expect("credential commit");
        assert_eq!(result.0.credentials_stored, 2);
        assert_eq!(vault.saved_len(), 2);
        let saved = vault.saved.lock().unwrap();
        assert!(saved.iter().any(|(_, credential)| matches!(
            credential,
            StoredCredential::Password { password } if password == "fixture-password"
        )));
        assert!(saved.iter().any(|(_, credential)| matches!(
            credential,
            StoredCredential::PrivateKeyData { key_data, passphrase: Some(passphrase) }
                if key_data.contains("fixture-key") && passphrase == "fixture-passphrase"
        )));
        drop(saved);
        let hosts = db.list_hosts().expect("list hosts");
        assert_eq!(
            hosts
                .iter()
                .filter(|host| host.auth_type == "privateKeyData")
                .count(),
            1
        );
        assert!(!serde_json::to_string(&result.0)
            .unwrap()
            .contains("fixture"));
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn selected_ids_deduplicate_against_db_and_within_selection() {
        let (db, path) = temp_db();
        let existing = pending_host("existing", "same.example", Some("old"));
        let existing_pending = pending_import(vec![existing.clone()]);
        let seed_request = commit_request(vec!["opaque-existing".to_string()], false, false);
        let vault = FakeVault::new(None);
        commit_pending(&db, &vault, existing_pending, &seed_request).expect("seed");

        let duplicate_db = pending_host("db-duplicate", "same.example", Some("new"));
        let duplicate_selection = pending_host("selection-duplicate", "unique.example", None);
        let duplicate_selection_again =
            pending_host("selection-duplicate-2", "unique.example", None);
        let unique = pending_host("unique", "other.example", None);
        let pending = pending_import(vec![
            duplicate_db,
            duplicate_selection,
            duplicate_selection_again,
            unique,
        ]);
        let request = commit_request(
            vec![
                "opaque-db-duplicate".to_string(),
                "opaque-selection-duplicate".to_string(),
                "opaque-selection-duplicate-2".to_string(),
                "opaque-unique".to_string(),
            ],
            false,
            false,
        );
        let result = commit_pending(&db, &vault, pending, &request).expect("dedup commit");
        assert_eq!(result.0.imported_hosts, 2);
        assert_eq!(result.0.skipped_hosts, 2);
        assert_eq!(db.list_hosts().expect("list hosts").len(), 3);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn vault_failure_at_each_stage_rolls_back_every_staged_entry() {
        for fail_at in 1..=3 {
            let (db, path) = temp_db();
            let vault = FakeVault::new(Some(fail_at));
            let pending = pending_import(vec![
                pending_host("one", "one.example", Some("one")),
                pending_host("two", "two.example", Some("two")),
                pending_host("three", "three.example", Some("three")),
            ]);
            let request = commit_request(
                vec![
                    "opaque-one".to_string(),
                    "opaque-two".to_string(),
                    "opaque-three".to_string(),
                ],
                true,
                true,
            );

            assert!(matches!(
                commit_pending(&db, &vault, pending, &request),
                Err(TermiusImportError::CommitFailed)
            ));
            assert_eq!(vault.saved_len(), 0);
            assert_eq!(vault.deleted_len(), 3);
            assert!(db.list_hosts().expect("list hosts").is_empty());
            let _ = std::fs::remove_dir_all(path);
        }
    }

    #[test]
    fn db_failure_removes_all_staged_vault_entries() {
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let prepared = PreparedImport {
            groups: Vec::new(),
            hosts: vec![saved_host_for_test("invalid", Some("missing-group"))],
            credentials: vec![(
                "generated-host-id".to_string(),
                StoredCredential::Password {
                    password: "db-failure-secret".to_string(),
                },
            )],
            skipped_hosts: 0,
        };

        assert!(matches!(
            persist_prepared(&db, &vault, prepared, &[]),
            Err(TermiusImportError::CommitFailed)
        ));
        assert_eq!(vault.saved_len(), 0);
        assert_eq!(vault.deleted_len(), 1);
        assert!(db.list_groups().expect("list groups").is_empty());
        assert!(db.list_hosts().expect("list hosts").is_empty());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn cleanup_failures_are_journaled_and_recovered_without_secret_data() {
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        vault.fail_next_deletes(2);
        let prepared = PreparedImport {
            groups: Vec::new(),
            hosts: vec![saved_host_for_test("invalid", Some("missing-group"))],
            credentials: vec![(
                "generated-cleanup-id".to_string(),
                StoredCredential::Password {
                    password: "cleanup-secret".to_string(),
                },
            )],
            skipped_hosts: 0,
        };

        assert!(matches!(
            persist_prepared(&db, &vault, prepared, &[]),
            Err(TermiusImportError::CleanupPending)
        ));
        assert_eq!(
            db.list_vault_cleanup().unwrap(),
            vec!["generated-cleanup-id"]
        );
        assert!(recover_vault_cleanup(&db, &vault));
        assert!(db.list_vault_cleanup().unwrap().is_empty());
        assert_eq!(vault.saved_len(), 0);

        let snapshot = db.export_db_snapshot().unwrap();
        assert!(!snapshot
            .windows("cleanup-secret".len())
            .any(|window| window == b"cleanup-secret"));
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn startup_recovery_deletes_a_vault_entry_staged_before_db_commit() {
        let (db, path) = temp_db();
        let vault = FakeVault::new(None);
        let host_id = "generated-crash-window-id".to_string();
        db.enqueue_vault_cleanup(std::slice::from_ref(&host_id))
            .expect("journal staging intent");
        vault
            .save(
                &host_id,
                &StoredCredential::Password {
                    password: "crash-window-secret".to_string(),
                },
            )
            .expect("stage credential");

        assert!(recover_vault_cleanup(&db, &vault));
        assert_eq!(vault.saved_len(), 0);
        assert!(db.list_vault_cleanup().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn transaction_time_duplicate_removes_its_staged_credential_and_journal() {
        let (db, path) = temp_db();
        db.save_host(&saved_host_for_test("existing", None))
            .expect("seed duplicate host key");
        let vault = FakeVault::new(None);
        let mut duplicate = saved_host_for_test("generated-duplicate", None);
        duplicate.host = "existing.example".to_string();
        let prepared = PreparedImport {
            groups: Vec::new(),
            hosts: vec![duplicate],
            credentials: vec![(
                "generated-duplicate".to_string(),
                StoredCredential::Password {
                    password: "transaction-race-secret".to_string(),
                },
            )],
            skipped_hosts: 0,
        };

        let result = persist_prepared(&db, &vault, prepared, &[]).expect("deduplicated commit");
        assert_eq!(result.0.imported_hosts, 0);
        assert_eq!(result.0.skipped_hosts, 1);
        assert_eq!(result.0.credentials_stored, 0);
        assert_eq!(vault.saved_len(), 0);
        assert!(db.list_vault_cleanup().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(path);
    }
}
