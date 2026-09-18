/*
 * Sync bundle codec: dataset-key wrapping, sealing, and the record payload.
 *
 * Two independent crypto steps, deliberately kept apart:
 *
 * 1. Key wrapping — Argon2id(passphrase, salt) → a 32-byte wrapping key that
 *    seals the random dataset key (DK) with AES-256-GCM under a fixed AAD. The
 *    wrap lives in the remote *plaintext* metadata file and is useless without
 *    the passphrase. Rotating the passphrase rewraps DK only.
 * 2. Payload sealing — DK encrypts the gzipped JSON record document with
 *    AES-256-GCM. The container header (magic, format byte, compression, nonce)
 *    is written verbatim *and* used as the AEAD associated data, so editing a
 *    header byte fails the tag check instead of silently changing framing.
 *
 * Container layout (little-endian):
 *   magic "OMNISYNC\x01" (9) | payload_format u8 | compression u8 |
 *   nonce_len u8 | nonce | ciphertext…
 *
 * Nothing here touches the filesystem, the database, or Tauri: the codec is a
 * pure function over bytes so the whole wire contract is unit-testable.
 */

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, KeyInit, Payload as AeadPayload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::db::{HostGroup, HostPluginConfig, SavedHost};
use crate::portforward::PortForwardRule;
use crate::s3::S3Connection;
use crate::snippets::{Snippet, SnippetFolder};
use crate::vault::StoredCredential;

use super::SyncError;

// ─── Constants ───────────────────────────────────────────────────────────────

/// Container magic + container-format version (last byte).
const MAGIC: &[u8; 9] = b"OMNISYNC\x01";
const COMPRESSION_GZIP: u8 = 1;
/// Highest payload document version this build can read and the one it writes.
pub const PAYLOAD_FORMAT_VERSION: u32 = 1;

/// Argon2id parameters for passphrase → wrapping key. Same cost as the backup
/// container (m = 64 MiB, t = 3, p = 1): strong, well under a second.
const ARGON2_M_KIB: u32 = 64 * 1024;
const ARGON2_T: u32 = 3;
const ARGON2_P: u32 = 1;
const SALT_LEN: usize = 16;
/// AES-GCM nonce length. Public because a persisted key wrap stores
/// `nonce || ciphertext` in one blob column.
pub const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// AAD binding the wrapped dataset key to its purpose, so a wrap can never be
/// replayed as a payload nonce/ciphertext pair or vice versa.
const KEY_WRAP_AAD: &[u8] = b"omniSSH/sync/dataset-key/v1";

/// `app_settings` keys that are machine-local and must never travel in a
/// dataset: an update the user skipped on one machine, the editor registry
/// (absolute binary paths that do not exist on another host), and this
/// machine's credential-storage backend choice (the other machine may have no
/// App Vault configured).
pub const APP_SETTINGS_DENY_LIST: &[&str] = &[
    "app_skipped_update",
    "editors_config",
    "editors_seeded",
    "default_credential_storage",
    /* This machine's sync identity. It must never travel in a dataset, or
     * every machine would claim to be the same writer and "another computer
     * published this" could never be detected. */
    "sync_client_id",
];

// ─── Keys ────────────────────────────────────────────────────────────────────

/// A dataset key. Zeroized on drop; never serialized.
pub type DatasetKey = Zeroizing<[u8; KEY_LEN]>;

/// Passphrase-wrapped dataset key, stored in the remote plaintext metadata
/// file. Byte fields are base64 so the metadata stays readable JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyWrap {
    /// Always `"argon2id"` today; present so a future KDF is distinguishable.
    pub kdf: String,
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
    #[serde(with = "b64")]
    pub salt: Vec<u8>,
    #[serde(with = "b64")]
    pub nonce: Vec<u8>,
    #[serde(with = "b64")]
    pub wrapped_key: Vec<u8>,
}

/// base64 (de)serialization for the byte fields of [`KeyWrap`].
mod b64 {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&BASE64.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let encoded = String::deserialize(deserializer)?;
        BASE64
            .decode(encoded.as_bytes())
            .map_err(serde::de::Error::custom)
    }
}

/// Fresh random dataset key from the OS CSPRNG.
pub fn generate_dataset_key() -> Result<DatasetKey, SyncError> {
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    getrandom::getrandom(key.as_mut()).map_err(|e| SyncError::Crypto(e.to_string()))?;
    Ok(key)
}

/* The KDF parameters in a wrap come from an untrusted remote file, so they are
 * range-checked before Argon2 is asked to allocate: a hostile metadata file
 * must not be able to request a 16 GiB hash and OOM-kill the app before the
 * tag check rejects it. The ceilings sit far above our own parameters. */
fn derive_wrapping_key(
    passphrase: &str,
    salt: &[u8],
    m_kib: u32,
    t: u32,
    p: u32,
) -> Result<Zeroizing<[u8; KEY_LEN]>, SyncError> {
    if salt.len() < 8 || salt.len() > 64 {
        return Err(SyncError::Format("dataset key salt length invalid".into()));
    }
    if !(8..=1 << 20).contains(&m_kib) || !(1..=16).contains(&t) || !(1..=16).contains(&p) {
        return Err(SyncError::Format(
            "dataset key KDF parameters are out of the supported range".into(),
        ));
    }
    let params =
        Params::new(m_kib, t, p, Some(KEY_LEN)).map_err(|e| SyncError::Crypto(e.to_string()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|e| SyncError::Crypto(e.to_string()))?;
    Ok(key)
}

/// Wrap `dataset_key` under a key derived from `passphrase`.
pub fn wrap_dataset_key(passphrase: &str, dataset_key: &DatasetKey) -> Result<KeyWrap, SyncError> {
    if passphrase.is_empty() {
        return Err(SyncError::Crypto(
            "dataset passphrase must not be empty".into(),
        ));
    }
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut salt).map_err(|e| SyncError::Crypto(e.to_string()))?;
    getrandom::getrandom(&mut nonce).map_err(|e| SyncError::Crypto(e.to_string()))?;

    let wrapping_key = derive_wrapping_key(passphrase, &salt, ARGON2_M_KIB, ARGON2_T, ARGON2_P)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(wrapping_key.as_ref()));
    let wrapped_key = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            AeadPayload {
                msg: dataset_key.as_ref(),
                aad: KEY_WRAP_AAD,
            },
        )
        .map_err(|e| SyncError::Crypto(e.to_string()))?;

    Ok(KeyWrap {
        kdf: "argon2id".into(),
        m_kib: ARGON2_M_KIB,
        t: ARGON2_T,
        p: ARGON2_P,
        salt: salt.to_vec(),
        nonce: nonce.to_vec(),
        wrapped_key,
    })
}

/// Recover the dataset key from a wrap. A wrong passphrase, a tampered wrap, or
/// a swapped AAD all fail the GCM tag check and yield [`SyncError::Decrypt`].
pub fn unwrap_dataset_key(passphrase: &str, wrap: &KeyWrap) -> Result<DatasetKey, SyncError> {
    if wrap.kdf != "argon2id" {
        return Err(SyncError::Format(format!(
            "unsupported dataset key KDF {:?}",
            wrap.kdf
        )));
    }
    if wrap.nonce.len() != NONCE_LEN {
        return Err(SyncError::Format("dataset key nonce length invalid".into()));
    }
    let wrapping_key = derive_wrapping_key(passphrase, &wrap.salt, wrap.m_kib, wrap.t, wrap.p)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(wrapping_key.as_ref()));
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&wrap.nonce),
                AeadPayload {
                    msg: wrap.wrapped_key.as_slice(),
                    aad: KEY_WRAP_AAD,
                },
            )
            .map_err(|_| SyncError::Decrypt)?,
    );
    if plaintext.len() != KEY_LEN {
        return Err(SyncError::Format("dataset key length invalid".into()));
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&plaintext);
    Ok(key)
}

/// Re-wrap the same dataset key under a new passphrase. The payload is
/// untouched, so every published generation stays readable after a rotation.
pub fn rewrap_dataset_key(
    current_passphrase: &str,
    new_passphrase: &str,
    wrap: &KeyWrap,
) -> Result<KeyWrap, SyncError> {
    let key = unwrap_dataset_key(current_passphrase, wrap)?;
    wrap_dataset_key(new_passphrase, &key)
}

// ─── Payload document ────────────────────────────────────────────────────────

/// One synced entity: identity and merge metadata alongside the record itself.
///
/// `updated_at` is the last-writer-wins clock and `revision` the tiebreak;
/// `credential` is populated only for hosts and S3 connections, and only when
/// the dataset opts into credential sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record<T> {
    pub id: String,
    #[serde(default)]
    pub revision: u64,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<StoredCredential>,
    pub data: T,
}

fn is_false(value: &bool) -> bool {
    !*value
}

pub type HostRecord = Record<SavedHost>;
pub type GroupRecord = Record<HostGroup>;
pub type SnippetRecord = Record<Snippet>;
pub type SnippetFolderRecord = Record<SnippetFolder>;
pub type PortForwardRecord = Record<PortForwardRule>;
pub type S3ConnectionRecord = Record<S3Connection>;
pub type HostPluginRecord = Record<HostPluginConfig>;

/// `app_settings` has no per-row timestamp, so the whole key/value map is one
/// record with a single clock rather than one record per key.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsRecord {
    pub updated_at: String,
    pub entries: BTreeMap<String, String>,
}

/// Build an app-settings record with the machine-local deny-list applied, so a
/// denied key cannot reach the payload even if a caller passes it in.
pub fn app_settings_record<I>(updated_at: impl Into<String>, entries: I) -> AppSettingsRecord
where
    I: IntoIterator<Item = (String, String)>,
{
    AppSettingsRecord {
        updated_at: updated_at.into(),
        entries: entries
            .into_iter()
            .filter(|(key, _)| !APP_SETTINGS_DENY_LIST.contains(&key.as_str()))
            .collect(),
    }
}

/// The enabled content kinds of a dataset. A section that is `None` was not
/// synced by the writer and is never applied on pull — turning a content toggle
/// off is not a delete.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSections {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hosts: Option<Vec<HostRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<GroupRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippets: Option<Vec<SnippetRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet_folders: Option<Vec<SnippetFolderRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_forwards: Option<Vec<PortForwardRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s3_connections: Option<Vec<S3ConnectionRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_plugins: Option<Vec<HostPluginRecord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_settings: Option<AppSettingsRecord>,
}

/// A deleted entity. `entity_type` carries the database-side entity discriminant
/// (`host`, `group`, `snippet`, `snippetFolder`, `portForward`, `s3Connection`,
/// `hostPlugin`, `appSettings`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub entity_type: String,
    pub entity_id: String,
    pub deleted_at: String,
}

/// The decrypted dataset document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPayload {
    pub format_version: u32,
    pub dataset_id: String,
    pub generation: u64,
    #[serde(default)]
    pub sections: SyncSections,
    #[serde(default)]
    pub tombstones: Vec<Tombstone>,
}

impl SyncPayload {
    /// An empty document for `dataset_id` at `generation`, stamped with the
    /// format version this build writes.
    pub fn new(dataset_id: impl Into<String>, generation: u64) -> Self {
        Self {
            format_version: PAYLOAD_FORMAT_VERSION,
            dataset_id: dataset_id.into(),
            generation,
            sections: SyncSections::default(),
            tombstones: Vec::new(),
        }
    }

    /* Validation runs on every decoded document before any record is applied:
     * a newer writer must be refused with an upgrade instruction rather than
     * silently dropping sections this build does not understand. */
    fn validate(&self) -> Result<(), SyncError> {
        if self.format_version > PAYLOAD_FORMAT_VERSION {
            return Err(SyncError::Version(format!(
                "this dataset was written by a newer version of OmniSSH (format {} > {}); update OmniSSH first",
                self.format_version, PAYLOAD_FORMAT_VERSION
            )));
        }
        if self.dataset_id.trim().is_empty() {
            return Err(SyncError::Format("dataset id is empty".into()));
        }
        Ok(())
    }
}

// ─── Compression ─────────────────────────────────────────────────────────────

fn gzip(data: &[u8]) -> Result<Vec<u8>, SyncError> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(data)
        .map_err(|e| SyncError::Crypto(e.to_string()))?;
    encoder
        .finish()
        .map_err(|e| SyncError::Crypto(e.to_string()))
}

fn gunzip(data: &[u8]) -> Result<Vec<u8>, SyncError> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut out = Vec::new();
    GzDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|_| SyncError::Format("sync payload is corrupt".into()))?;
    Ok(out)
}

// ─── Sealing ─────────────────────────────────────────────────────────────────

/// Seal `payload` with the dataset key into a self-describing container.
pub fn seal_payload(dataset_key: &DatasetKey, payload: &SyncPayload) -> Result<Vec<u8>, SyncError> {
    payload.validate()?;
    let json = Zeroizing::new(
        serde_json::to_vec(payload).map_err(|e| SyncError::Serialization(e.to_string()))?,
    );
    let compressed = gzip(&json)?;

    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|e| SyncError::Crypto(e.to_string()))?;

    let mut header = Vec::with_capacity(MAGIC.len() + 3 + NONCE_LEN);
    header.extend_from_slice(MAGIC);
    header.push(PAYLOAD_FORMAT_VERSION as u8);
    header.push(COMPRESSION_GZIP);
    header.push(NONCE_LEN as u8);
    header.extend_from_slice(&nonce);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(dataset_key.as_ref()));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            AeadPayload {
                msg: &compressed,
                aad: &header,
            },
        )
        .map_err(|e| SyncError::Crypto(e.to_string()))?;

    let mut out = header;
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Open a container with the dataset key and decode the document.
///
/// Malformed or truncated input yields [`SyncError::Format`]; a wrong key or any
/// tampering (including a single header byte) yields [`SyncError::Decrypt`].
pub fn open_payload(dataset_key: &DatasetKey, container: &[u8]) -> Result<SyncPayload, SyncError> {
    let header_len = MAGIC.len() + 3 + NONCE_LEN;
    if container.len() < header_len {
        return Err(SyncError::Format("truncated sync bundle".into()));
    }
    if &container[..MAGIC.len()] != MAGIC.as_slice() {
        return Err(SyncError::Format("not an OmniSSH sync bundle".into()));
    }
    let mut pos = MAGIC.len();
    let container_format = container[pos];
    pos += 1;
    if u32::from(container_format) > PAYLOAD_FORMAT_VERSION {
        return Err(SyncError::Version(format!(
            "this dataset was written by a newer version of OmniSSH (format {container_format} > {PAYLOAD_FORMAT_VERSION}); update OmniSSH first"
        )));
    }
    let compression = container[pos];
    pos += 1;
    if compression != COMPRESSION_GZIP {
        return Err(SyncError::Format(format!(
            "unsupported sync compression id {compression}"
        )));
    }
    let nonce_len = container[pos] as usize;
    pos += 1;
    if nonce_len != NONCE_LEN {
        return Err(SyncError::Format("invalid nonce length".into()));
    }
    let nonce = &container[pos..pos + NONCE_LEN];
    pos += NONCE_LEN;

    // Everything consumed so far is the header, and the header is the AAD.
    let header = &container[..pos];
    let ciphertext = &container[pos..];

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(dataset_key.as_ref()));
    let compressed = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(nonce),
                AeadPayload {
                    msg: ciphertext,
                    aad: header,
                },
            )
            .map_err(|_| SyncError::Decrypt)?,
    );
    let json = Zeroizing::new(gunzip(&compressed)?);
    let payload: SyncPayload =
        serde_json::from_slice(&json).map_err(|e| SyncError::Serialization(e.to_string()))?;
    payload.validate()?;
    Ok(payload)
}

// ─── Digests ─────────────────────────────────────────────────────────────────

/// Lowercase hex SHA-256 of the sealed bundle. Published in the remote metadata
/// so a reader can detect a truncated or mismatched `dataset.bin` before
/// spending Argon2 time, and so a push can prove which bytes it based itself on.
pub fn payload_digest(container: &[u8]) -> String {
    hex(Sha256::digest(container).as_slice())
}

/* Fields that change without anyone editing anything: SQLite stamps some of
 * them (`updated_at = datetime('now')` on a port-forward or S3 write) and the
 * app bumps others as a side effect of use. They are excluded from the content
 * hash for two reasons:
 *
 *  - Applying a pulled record locally re-stamps `updated_at`, so a hash that
 *    included it would never match the remote's and the record would ping-pong
 *    between the two machines forever.
 *  - Opening a terminal or running a snippet would otherwise count as an edit
 *    and drag a whole dataset into a needless push.
 *
 * The timestamps still travel in the record wrapper, where they act as the
 * last-writer-wins clock — they just do not define what "changed" means.
 */
const VOLATILE_FIELDS: &[&str] = &[
    "created_at",
    "updated_at",
    "createdAt",
    "updatedAt",
    "last_used_at",
    "lastUsedAt",
    "last_connected_at",
    "lastConnectedAt",
    "connection_count",
    "connectionCount",
    "use_count",
    "useCount",
    "total_bytes",
    "totalBytes",
];

/// SHA-256 over a record's content, ignoring [`VOLATILE_FIELDS`]. This is the
/// merge base hash: two rows with the same hash are the same record, whatever
/// their timestamps say.
pub fn content_digest<T: Serialize>(record: &T) -> Result<String, SyncError> {
    let mut value =
        serde_json::to_value(record).map_err(|e| SyncError::Serialization(e.to_string()))?;
    strip_volatile(&mut value);
    // `serde_json::Value::Object` is a BTreeMap here, so the encoding is stable.
    let bytes = serde_json::to_vec(&value).map_err(|e| SyncError::Serialization(e.to_string()))?;
    Ok(hex(Sha256::digest(&bytes).as_slice()))
}

fn strip_volatile(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for field in VOLATILE_FIELDS {
                map.remove(*field);
            }
            for (_, nested) in map.iter_mut() {
                strip_volatile(nested);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                strip_volatile(item);
            }
        }
        _ => {}
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// base64 of arbitrary bytes, for the plaintext metadata file's signature and
/// digest fields.
pub fn b64_encode(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

/// Inverse of [`b64_encode`], rejecting malformed input as a format error.
pub fn b64_decode(encoded: &str) -> Result<Vec<u8>, SyncError> {
    BASE64
        .decode(encoded.as_bytes())
        .map_err(|e| SyncError::Format(format!("invalid base64 in sync metadata: {e}")))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CredentialStorage;

    fn host(id: &str, label: &str) -> SavedHost {
        SavedHost {
            id: id.into(),
            label: label.into(),
            host: "10.0.0.5".into(),
            port: 22,
            username: "deployer".into(),
            auth_type: "password".into(),
            credential_storage: CredentialStorage::LocalVault,
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

    fn host_record(id: &str, label: &str, credential: Option<StoredCredential>) -> HostRecord {
        let data = host(id, label);
        Record {
            id: data.id.clone(),
            revision: 3,
            updated_at: data.updated_at.clone(),
            deleted: false,
            credential,
            data,
        }
    }

    fn payload_with_hosts() -> SyncPayload {
        let mut payload = SyncPayload::new("ds-nova", 7);
        payload.sections.hosts = Some(vec![host_record(
            "host-1",
            "nova-db-01",
            Some(StoredCredential::Password {
                password: "s3cret-pass".into(),
            }),
        )]);
        payload.tombstones.push(Tombstone {
            entity_type: "host".into(),
            entity_id: "host-gone".into(),
            deleted_at: "2026-09-03T00:00:00Z".into(),
        });
        payload
    }

    #[test]
    fn seals_and_opens_round_trip() {
        let key = generate_dataset_key().unwrap();
        let sealed = seal_payload(&key, &payload_with_hosts()).unwrap();
        let opened = open_payload(&key, &sealed).unwrap();

        assert_eq!(opened.dataset_id, "ds-nova");
        assert_eq!(opened.generation, 7);
        let hosts = opened.sections.hosts.expect("hosts section");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].data.label, "nova-db-01");
        assert_eq!(hosts[0].revision, 3);
        match hosts[0].credential.as_ref().expect("credential") {
            StoredCredential::Password { password } => assert_eq!(password, "s3cret-pass"),
            other => panic!("unexpected credential variant: {other:?}"),
        }
        assert_eq!(opened.tombstones.len(), 1);
        assert_eq!(opened.tombstones[0].entity_id, "host-gone");
    }

    #[test]
    fn sealed_bundle_leaks_no_plaintext() {
        let key = generate_dataset_key().unwrap();
        let sealed = seal_payload(&key, &payload_with_hosts()).unwrap();
        for needle in [
            "nova-db-01".as_bytes(),
            "10.0.0.5".as_bytes(),
            "deployer".as_bytes(),
            "s3cret-pass".as_bytes(),
            "ds-nova".as_bytes(),
        ] {
            assert!(
                !sealed.windows(needle.len()).any(|w| w == needle),
                "plaintext {:?} found in sealed bundle",
                String::from_utf8_lossy(needle)
            );
        }
    }

    #[test]
    fn wrong_key_fails_the_tag_check() {
        let key = generate_dataset_key().unwrap();
        let other = generate_dataset_key().unwrap();
        let sealed = seal_payload(&key, &payload_with_hosts()).unwrap();
        assert!(matches!(
            open_payload(&other, &sealed),
            Err(SyncError::Decrypt)
        ));
    }

    #[test]
    fn header_and_ciphertext_tampering_is_detected() {
        let key = generate_dataset_key().unwrap();
        let sealed = seal_payload(&key, &payload_with_hosts()).unwrap();

        // Flip a nonce byte inside the header: header is the AAD, so this fails
        // the tag check rather than silently decrypting to garbage.
        let mut tampered_header = sealed.clone();
        let nonce_offset = MAGIC.len() + 3;
        tampered_header[nonce_offset] ^= 0x01;
        assert!(matches!(
            open_payload(&key, &tampered_header),
            Err(SyncError::Decrypt)
        ));

        let mut tampered_body = sealed.clone();
        let last = tampered_body.len() - 1;
        tampered_body[last] ^= 0xff;
        assert!(matches!(
            open_payload(&key, &tampered_body),
            Err(SyncError::Decrypt)
        ));
    }

    #[test]
    fn malformed_containers_are_format_errors() {
        let key = generate_dataset_key().unwrap();
        let sealed = seal_payload(&key, &payload_with_hosts()).unwrap();

        assert!(matches!(
            open_payload(&key, &sealed[..8]),
            Err(SyncError::Format(_))
        ));

        let mut wrong_magic = sealed.clone();
        wrong_magic[0] = b'X';
        assert!(matches!(
            open_payload(&key, &wrong_magic),
            Err(SyncError::Format(_))
        ));

        let mut wrong_compression = sealed.clone();
        wrong_compression[MAGIC.len() + 1] = 9;
        assert!(matches!(
            open_payload(&key, &wrong_compression),
            Err(SyncError::Format(_))
        ));

        let mut wrong_nonce_len = sealed;
        wrong_nonce_len[MAGIC.len() + 2] = 8;
        assert!(matches!(
            open_payload(&key, &wrong_nonce_len),
            Err(SyncError::Format(_))
        ));
    }

    #[test]
    fn newer_container_format_is_refused_with_an_upgrade_hint() {
        let key = generate_dataset_key().unwrap();
        let mut sealed = seal_payload(&key, &payload_with_hosts()).unwrap();
        sealed[MAGIC.len()] = (PAYLOAD_FORMAT_VERSION + 1) as u8;
        match open_payload(&key, &sealed) {
            Err(SyncError::Version(message)) => assert!(message.contains("update OmniSSH first")),
            other => panic!("expected a version error, got {other:?}"),
        }
    }

    #[test]
    fn newer_document_format_is_refused_before_encoding() {
        let key = generate_dataset_key().unwrap();
        let mut payload = SyncPayload::new("ds-nova", 1);
        payload.format_version = PAYLOAD_FORMAT_VERSION + 1;
        assert!(matches!(
            seal_payload(&key, &payload),
            Err(SyncError::Version(_))
        ));
    }

    #[test]
    fn empty_dataset_id_is_rejected() {
        let key = generate_dataset_key().unwrap();
        let payload = SyncPayload::new("  ", 1);
        assert!(matches!(
            seal_payload(&key, &payload),
            Err(SyncError::Format(_))
        ));
    }

    #[test]
    fn absent_sections_stay_absent() {
        let key = generate_dataset_key().unwrap();
        let mut payload = SyncPayload::new("ds-bank", 2);
        payload.sections.snippets = Some(Vec::new());
        let opened = open_payload(&key, &seal_payload(&key, &payload).unwrap()).unwrap();

        // An enabled-but-empty section and a disabled section must stay
        // distinguishable: the first means "nothing to sync", the second
        // "do not touch these rows on pull".
        assert!(opened
            .sections
            .snippets
            .as_ref()
            .is_some_and(|snippets| snippets.is_empty()));
        assert!(opened.sections.hosts.is_none());
        assert!(opened.sections.port_forwards.is_none());
        assert!(opened.sections.app_settings.is_none());
    }

    #[test]
    fn app_settings_deny_list_is_applied_at_encode_time() {
        let record = app_settings_record(
            "2026-09-04T00:00:00Z",
            [
                ("app_theme".to_string(), "dark".to_string()),
                ("app_skipped_update".to_string(), "1.4.2".to_string()),
                (
                    "editors_config".to_string(),
                    "{\"editors\":[{\"execPath\":\"/usr/local/bin/code\"}]}".to_string(),
                ),
                ("editors_seeded".to_string(), "true".to_string()),
                (
                    "default_credential_storage".to_string(),
                    "localVault".to_string(),
                ),
                ("terminal_font_size".to_string(), "14".to_string()),
            ],
        );

        assert_eq!(record.entries.len(), 2);
        assert_eq!(
            record.entries.get("app_theme").map(String::as_str),
            Some("dark")
        );
        assert_eq!(
            record.entries.get("terminal_font_size").map(String::as_str),
            Some("14")
        );
        for denied in APP_SETTINGS_DENY_LIST {
            assert!(
                !record.entries.contains_key(*denied),
                "denied key {denied} reached the payload"
            );
        }

        let key = generate_dataset_key().unwrap();
        let mut payload = SyncPayload::new("ds-nova", 3);
        payload.sections.app_settings = Some(record);
        let sealed = seal_payload(&key, &payload).unwrap();
        assert!(!sealed
            .windows("editors_config".len())
            .any(|w| w == b"editors_config"));
    }

    #[test]
    fn key_wrap_round_trips_and_rejects_a_wrong_passphrase() {
        let key = generate_dataset_key().unwrap();
        let wrap = wrap_dataset_key("correct horse battery staple", &key).unwrap();
        let recovered = unwrap_dataset_key("correct horse battery staple", &wrap).unwrap();
        assert_eq!(recovered.as_ref(), key.as_ref());
        assert!(matches!(
            unwrap_dataset_key("wrong passphrase", &wrap),
            Err(SyncError::Decrypt)
        ));
        assert!(matches!(
            wrap_dataset_key("", &key),
            Err(SyncError::Crypto(_))
        ));
    }

    #[test]
    fn rewrap_keeps_published_payloads_readable() {
        let key = generate_dataset_key().unwrap();
        let sealed = seal_payload(&key, &payload_with_hosts()).unwrap();
        let wrap = wrap_dataset_key("old-pass-phrase", &key).unwrap();

        let rotated = rewrap_dataset_key("old-pass-phrase", "new-pass-phrase", &wrap).unwrap();
        assert_ne!(rotated.wrapped_key, wrap.wrapped_key);
        assert_ne!(rotated.salt, wrap.salt);

        let recovered = unwrap_dataset_key("new-pass-phrase", &rotated).unwrap();
        let opened = open_payload(&recovered, &sealed).unwrap();
        assert_eq!(opened.generation, 7);
        assert!(matches!(
            unwrap_dataset_key("old-pass-phrase", &rotated),
            Err(SyncError::Decrypt)
        ));
    }

    #[test]
    fn tampered_wrap_and_hostile_kdf_parameters_are_rejected() {
        let key = generate_dataset_key().unwrap();
        let wrap = wrap_dataset_key("pass-phrase-here", &key).unwrap();

        let mut tampered = wrap.clone();
        tampered.wrapped_key[0] ^= 0x01;
        assert!(matches!(
            unwrap_dataset_key("pass-phrase-here", &tampered),
            Err(SyncError::Decrypt)
        ));

        let mut foreign_kdf = wrap.clone();
        foreign_kdf.kdf = "scrypt".into();
        assert!(matches!(
            unwrap_dataset_key("pass-phrase-here", &foreign_kdf),
            Err(SyncError::Format(_))
        ));

        // A hostile metadata file must not be able to request a huge Argon2
        // allocation before the tag check rejects it.
        let mut huge = wrap.clone();
        huge.m_kib = 16 * 1024 * 1024;
        assert!(matches!(
            unwrap_dataset_key("pass-phrase-here", &huge),
            Err(SyncError::Format(_))
        ));

        let mut short_salt = wrap;
        short_salt.salt = vec![0u8; 4];
        assert!(matches!(
            unwrap_dataset_key("pass-phrase-here", &short_salt),
            Err(SyncError::Format(_))
        ));
    }

    #[test]
    fn key_wrap_serializes_as_base64_json_without_key_material() {
        let key = generate_dataset_key().unwrap();
        let wrap = wrap_dataset_key("pass-phrase-here", &key).unwrap();
        let json = serde_json::to_string(&wrap).unwrap();

        assert!(json.contains("\"kdf\":\"argon2id\""));
        assert!(json.contains("\"wrappedKey\":\""));
        assert!(!json.contains(&b64_encode(key.as_ref())));

        let parsed: KeyWrap = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, wrap);
    }

    #[test]
    fn digests_are_stable_and_content_addressed() {
        let key = generate_dataset_key().unwrap();
        let sealed = seal_payload(&key, &payload_with_hosts()).unwrap();
        assert_eq!(payload_digest(&sealed), payload_digest(&sealed));
        assert_eq!(payload_digest(&sealed).len(), 64);
        assert_ne!(payload_digest(&sealed), payload_digest(b"other bytes"));

        let first = host_record("host-1", "nova-db-01", None);
        let same = host_record("host-1", "nova-db-01", None);
        let different = host_record("host-1", "nova-db-02", None);
        assert_eq!(
            content_digest(&first).unwrap(),
            content_digest(&same).unwrap()
        );
        assert_ne!(
            content_digest(&first).unwrap(),
            content_digest(&different).unwrap()
        );
    }

    #[test]
    fn base64_helpers_round_trip_and_reject_garbage() {
        let encoded = b64_encode(&[0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(b64_decode(&encoded).unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
        assert!(matches!(
            b64_decode("not*base64"),
            Err(SyncError::Format(_))
        ));
    }
}
