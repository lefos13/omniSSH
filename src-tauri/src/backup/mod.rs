//! Encrypted backup / restore of all anySCP data.
//!
//! A backup is a compact **binary container** (not JSON): a small plaintext
//! header — magic, KDF parameters, salt, nonce — followed directly by the raw
//! **AES-256-GCM** ciphertext. The header is the AEAD associated data, so any
//! tampering with the parameters is detected. The key is derived from the
//! user's passphrase with **Argon2id**; the payload (a raw SQLite snapshot plus
//! the selected System Keychain credentials) is gzip-compressed before
//! encryption. App Vault ciphertext always remains in the database snapshot.
//! Secrets never touch disk in plaintext, and a backup is useless without the
//! passphrase.
//!
//! - Export: snapshot the DB ([`crate::db::HostDb::export_db_snapshot`]) +
//!   optionally gather eligible credentials from the OS keychain → frame +
//!   gzip → seal → write the container bytes. Local-vault ciphertext remains
//!   inside the encrypted database snapshot and is never read into this map.
//! - Import: open the container with the passphrase → gunzip → restore the DB
//!   snapshot ([`crate::db::HostDb::import_db_snapshot`]) + write credentials
//!   back to the keychain. A wrong password fails the AEAD tag check and is
//!   reported as such; nothing is modified.
//!
//! ## Container layout (little-endian)
//! ```text
//! magic "ASCPBAK\x01" (8) | kdf_id u8 | m_kib u32 | t u32 | p u32 |
//! compression u8 | salt_len u8 | salt | nonce_len u8 | nonce | ciphertext…
//! ```

pub mod commands;

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::db::{CredentialStorage, HostDb};
use crate::vault::{self, StoredCredential, VaultError};

// ─── Constants ─────────────────────────────────────────────────────────────────

/// Container magic + format version (last byte). Bumping the version byte lets
/// future formats be told apart and rejected cleanly.
const MAGIC: &[u8; 8] = b"ASCPBAK\x01";
const KDF_ARGON2ID: u8 = 1;
const COMPRESSION_NONE: u8 = 0;
const COMPRESSION_GZIP: u8 = 1;
// Argon2id parameters: m = 64 MiB, t = 3, p = 1 — strong, well under a second on
// modern hardware. Written into the header so import derives the same key.
const ARGON2_M_KIB: u32 = 64 * 1024;
const ARGON2_T: u32 = 3;
const ARGON2_P: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

// ─── Error ─────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("Database error: {0}")]
    Db(String),
    #[error("Incorrect password, or the backup file is corrupt")]
    Decrypt,
    #[error("Crypto error: {0}")]
    Crypto(String),
    #[error("Not a valid anySCP backup file: {0}")]
    Format(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("A System Keychain credential could not be read; no backup was written")]
    KeychainRead,
}

/// Serialize as `{ kind, message }` — same convention as the other error types.
impl Serialize for BackupError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("BackupError", 2)?;
        let kind = match self {
            BackupError::Db(_) => "db",
            BackupError::Decrypt => "decrypt",
            BackupError::Crypto(_) => "crypto",
            BackupError::Format(_) => "format",
            BackupError::Io(_) => "io",
            BackupError::KeychainRead => "credential_read",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<crate::db::DbError> for BackupError {
    fn from(e: crate::db::DbError) -> Self {
        BackupError::Db(e.to_string())
    }
}

// ─── On-disk format ──────────────────────────────────────────────────────────

/// KDF parameters carried in the header (algorithm is fixed to Argon2id).
struct KdfParams {
    algorithm: &'static str,
    m_kib: u32,
    t: u32,
    p: u32,
}

/// Bounds-checked sequential reader over the (untrusted) container bytes. Every
/// accessor returns a `Format` error rather than panicking on a short read.
struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], BackupError> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| BackupError::Format("backup header overflow".into()))?;
        if end > self.data.len() {
            return Err(BackupError::Format("truncated backup file".into()));
        }
        let out = &self.data[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, BackupError> {
        Ok(self.take(1)?[0])
    }

    fn u32_le(&mut self) -> Result<u32, BackupError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

// ─── Crypto ─────────────────────────────────────────────────────────────────────

fn derive_key(
    password: &str,
    salt: &[u8],
    p: &KdfParams,
) -> Result<Zeroizing<[u8; KEY_LEN]>, BackupError> {
    if p.algorithm != "argon2id" {
        return Err(BackupError::Format(format!(
            "unsupported KDF {:?}",
            p.algorithm
        )));
    }
    // The KDF parameters come from the (untrusted) envelope on import. Reject
    // out-of-range values so a malicious file can't request, say, a 16 GiB
    // Argon2 allocation and OOM-kill the app before the tag check. The ceilings
    // sit well above our own export parameters (64 MiB / t=3 / p=1).
    if p.m_kib < 8 || p.m_kib > 1 << 20 || p.t < 1 || p.t > 16 || p.p < 1 || p.p > 16 {
        return Err(BackupError::Format(
            "backup KDF parameters are out of the supported range".into(),
        ));
    }
    let params = Params::new(p.m_kib, p.t, p.p, Some(KEY_LEN))
        .map_err(|e| BackupError::Crypto(e.to_string()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| BackupError::Crypto(e.to_string()))?;
    Ok(Zeroizing::new(key))
}

/// Encrypt `plaintext` into a self-describing binary container. The header
/// (magic + KDF params + compression + salt + nonce) is both written verbatim
/// and used as the AEAD associated data, so any edit to it fails decryption.
fn seal(password: &str, plaintext: &[u8], compression: u8) -> Result<Vec<u8>, BackupError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut salt).map_err(|e| BackupError::Crypto(e.to_string()))?;
    getrandom::getrandom(&mut nonce).map_err(|e| BackupError::Crypto(e.to_string()))?;

    let mut header = Vec::with_capacity(MAGIC.len() + 14 + SALT_LEN + NONCE_LEN);
    header.extend_from_slice(MAGIC);
    header.push(KDF_ARGON2ID);
    header.extend_from_slice(&ARGON2_M_KIB.to_le_bytes());
    header.extend_from_slice(&ARGON2_T.to_le_bytes());
    header.extend_from_slice(&ARGON2_P.to_le_bytes());
    header.push(compression);
    header.push(SALT_LEN as u8);
    header.extend_from_slice(&salt);
    header.push(NONCE_LEN as u8);
    header.extend_from_slice(&nonce);

    let kdf = KdfParams {
        algorithm: "argon2id",
        m_kib: ARGON2_M_KIB,
        t: ARGON2_T,
        p: ARGON2_P,
    };
    let key = derive_key(password, &salt, &kdf)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &header,
            },
        )
        .map_err(|e| BackupError::Crypto(e.to_string()))?;

    let mut out = header;
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

// ─── Compression + binary framing ──────────────────────────────────────────────
//
// The plaintext is a compact binary frame — `[u32-LE creds_json_len | creds_json
// | raw db bytes]` — then gzip-compressed before encryption. Framing keeps the
// SQLite snapshot as raw bytes (no base64 bloat inside the payload), and gzip
// crushes the snapshot's zero-filled pages, so the backup file is a fraction of
// the raw DB size instead of ~1.8x it.

fn gzip(data: &[u8]) -> Result<Vec<u8>, BackupError> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data)
        .map_err(|e| BackupError::Crypto(e.to_string()))?;
    enc.finish().map_err(|e| BackupError::Crypto(e.to_string()))
}

fn gunzip(data: &[u8]) -> Result<Vec<u8>, BackupError> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut out = Vec::new();
    GzDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|_| BackupError::Format("backup payload is corrupt".into()))?;
    Ok(out)
}

fn encode_frame(creds_json: &[u8], db: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + creds_json.len() + db.len());
    frame.extend_from_slice(&(creds_json.len() as u32).to_le_bytes());
    frame.extend_from_slice(creds_json);
    frame.extend_from_slice(db);
    frame
}

/// Split a frame back into `(creds_json, db_bytes)`.
fn decode_frame(frame: &[u8]) -> Result<(&[u8], &[u8]), BackupError> {
    if frame.len() < 4 {
        return Err(BackupError::Format("truncated backup payload".into()));
    }
    let len = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    let rest = &frame[4..];
    if len > rest.len() {
        return Err(BackupError::Format("corrupt backup payload framing".into()));
    }
    Ok((&rest[..len], &rest[len..]))
}

/// Parse a binary container, derive the key, and decrypt. Returns the decrypted
/// plaintext and the compression byte. Every malformed/truncated input yields a
/// `Format` error; a wrong password (or any tampering, including the header)
/// yields `Decrypt` via the GCM tag check.
fn open(password: &str, data: &[u8]) -> Result<(Zeroizing<Vec<u8>>, u8), BackupError> {
    let mut r = Reader::new(data);
    if r.take(MAGIC.len())? != MAGIC {
        return Err(BackupError::Format("not an anySCP backup file".into()));
    }
    let kdf_id = r.u8()?;
    if kdf_id != KDF_ARGON2ID {
        return Err(BackupError::Format(format!("unsupported KDF id {kdf_id}")));
    }
    let m_kib = r.u32_le()?;
    let t = r.u32_le()?;
    let p = r.u32_le()?;
    let compression = r.u8()?;
    let salt_len = r.u8()? as usize;
    let salt = r.take(salt_len)?.to_vec();
    let nonce_len = r.u8()? as usize;
    let nonce = r.take(nonce_len)?;
    if nonce.len() != NONCE_LEN {
        return Err(BackupError::Format("invalid nonce length".into()));
    }
    // Everything consumed so far is the header; it is the AEAD associated data.
    let header = &data[..r.pos];
    let ciphertext = &data[r.pos..];

    let kdf = KdfParams {
        algorithm: "argon2id",
        m_kib,
        t,
        p,
    };
    // derive_key clamps the (untrusted) KDF parameters before use.
    let key = derive_key(password, &salt, &kdf)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()));
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: header,
            },
        )
        .map_err(|_| BackupError::Decrypt)?;
    Ok((Zeroizing::new(plaintext), compression))
}

// ─── Orchestration (sync — callers use spawn_blocking) ──────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreflightSummary {
    pub keychain_host_candidates: usize,
    pub local_vault_hosts: usize,
    pub s3_candidates: usize,
}

/// Count credential-storage candidates without reading any credential values.
pub fn backup_preflight(db: &HostDb) -> Result<BackupPreflightSummary, BackupError> {
    let hosts = db.list_hosts()?;
    Ok(BackupPreflightSummary {
        keychain_host_candidates: hosts
            .iter()
            .filter(|host| host.credential_storage == CredentialStorage::Keychain)
            .count(),
        local_vault_hosts: hosts
            .iter()
            .filter(|host| host.credential_storage == CredentialStorage::LocalVault)
            .count(),
        s3_candidates: db.list_s3_connections()?.len(),
    })
}

trait CredentialReader {
    fn get(&self, key: &str) -> Result<StoredCredential, VaultError>;
}

struct SystemKeychainReader;

impl CredentialReader for SystemKeychainReader {
    fn get(&self, key: &str) -> Result<StoredCredential, VaultError> {
        vault::get_credential(key)
    }
}

/// Build the encrypted backup container, optionally including System Keychain credentials.
pub fn build_backup(
    db: &HostDb,
    password: &str,
    include_credentials: bool,
) -> Result<Vec<u8>, BackupError> {
    build_backup_with_reader(db, password, include_credentials, &SystemKeychainReader)
}

/* Credential collection is separated from the native reader so tests can
 * verify the no-prompt path and failure contract without touching a user's
 * keychain. Missing items are valid for hosts that do not require a secret;
 * every other read failure aborts with a redacted error. */
fn build_backup_with_reader(
    db: &HostDb,
    password: &str,
    include_credentials: bool,
    reader: &dyn CredentialReader,
) -> Result<Vec<u8>, BackupError> {
    let db_bytes = db.export_db_snapshot()?;

    /* Only keychain-backed host credentials are copied into the credential map.
     * Local-vault rows already live in the encrypted DB snapshot; reading them
     * here would create a plaintext backup path and could leak stale duplicates. */
    let mut credentials: BTreeMap<String, StoredCredential> = BTreeMap::new();
    if include_credentials {
        for h in db.list_hosts()? {
            if h.credential_storage == CredentialStorage::Keychain {
                match reader.get(&h.id) {
                    Ok(credential) => {
                        credentials.insert(h.id, credential);
                    }
                    Err(VaultError::NotFound(_)) => {}
                    Err(_) => return Err(BackupError::KeychainRead),
                }
            }
        }
        for s in db.list_s3_connections()? {
            let key = format!("s3:{}", s.id);
            match reader.get(&key) {
                Ok(credential) => {
                    credentials.insert(key, credential);
                }
                Err(VaultError::NotFound(_)) => {}
                Err(_) => return Err(BackupError::KeychainRead),
            }
        }
    }

    /* Every plaintext serialization layer owns a zeroizing buffer. This covers
     * early returns from compression/encryption as well as the success path. */
    let creds_json = Zeroizing::new(
        serde_json::to_vec(&credentials).map_err(|e| BackupError::Crypto(e.to_string()))?,
    );
    let frame = Zeroizing::new(encode_frame(&creds_json, &db_bytes));
    let compressed = Zeroizing::new(gzip(&frame)?);
    seal(password, &compressed, COMPRESSION_GZIP)
}

/// Decrypt and restore a backup container, replacing all current data and
/// credentials.
pub fn restore_backup(db: &HostDb, password: &str, container: &[u8]) -> Result<(), BackupError> {
    let (plaintext, compression) = open(password, container)?;
    let frame = match compression {
        COMPRESSION_GZIP => Zeroizing::new(gunzip(&plaintext)?),
        COMPRESSION_NONE => plaintext,
        other => {
            return Err(BackupError::Format(format!(
                "unsupported backup compression id {other}"
            )))
        }
    };
    let (creds_json, db_bytes) = decode_frame(&frame)?;
    let credentials: BTreeMap<String, StoredCredential> = serde_json::from_slice(creds_json)
        .map_err(|e| BackupError::Crypto(format!("payload parse failed: {e}")))?;

    // 1. Replace the database (validated + migrated + transactional inside).
    db.import_db_snapshot(db_bytes)?;
    /* Restore only records whose restored host still points at the keychain.
     * A local-vault host keeps its ciphertext in SQLite and must never be
     * materialized through the OS keychain during backup import. */
    for (key, cred) in &credentials {
        let restore_to_keychain = if key.starts_with("s3:") {
            true
        } else {
            matches!(
                db.get_host(key)?,
                Some(host) if host.credential_storage == CredentialStorage::Keychain
            )
        };
        if restore_to_keychain {
            if let Err(e) = vault::save_credential(key, cred) {
                tracing::warn!(key = %key, error = %e, "restore: failed to write credential to keychain");
            }
        }
    }
    Ok(())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SavedHost;
    use crate::vault::VaultError;
    use std::cell::RefCell;

    /* Backup orchestration tests use an in-memory credential reader so they
     * can prove which records would touch the OS keychain without opening
     * native authorization dialogs or persisting test secrets. */
    struct TestCredentialReader {
        reads: RefCell<Vec<String>>,
        credentials: BTreeMap<String, StoredCredential>,
        error_key: Option<String>,
    }

    impl CredentialReader for TestCredentialReader {
        fn get(&self, key: &str) -> Result<StoredCredential, VaultError> {
            self.reads.borrow_mut().push(key.to_string());
            if self.error_key.as_deref() == Some(key) {
                return Err(VaultError::Keychain(
                    "private native keychain detail".to_string(),
                ));
            }
            self.credentials
                .get(key)
                .cloned()
                .ok_or_else(|| VaultError::NotFound(key.to_string()))
        }
    }

    fn sample_host(id: &str, storage: CredentialStorage) -> SavedHost {
        SavedHost {
            id: id.to_string(),
            label: format!("Host {id}"),
            host: "192.0.2.1".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_type: "password".to_string(),
            credential_storage: storage,
            group_id: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
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

    fn test_db() -> (HostDb, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("anyscp-backup-{}", uuid::Uuid::new_v4()));
        let db = HostDb::new(&dir).expect("test db");
        (db, dir)
    }

    fn decoded_credentials(password: &str, container: &[u8]) -> BTreeMap<String, StoredCredential> {
        let (plaintext, compression) = open(password, container).expect("open backup");
        assert_eq!(compression, COMPRESSION_GZIP);
        let frame = gunzip(&plaintext).expect("gunzip backup");
        let (credentials, _) = decode_frame(&frame).expect("decode frame");
        serde_json::from_slice(credentials).expect("decode credentials")
    }

    fn roundtrip(password: &str, msg: &[u8]) -> Vec<u8> {
        let container = seal(password, msg, COMPRESSION_NONE).expect("seal");
        let (plaintext, comp) = open(password, &container).expect("open");
        assert_eq!(comp, COMPRESSION_NONE);
        plaintext.to_vec()
    }

    #[test]
    fn seal_open_roundtrip() {
        let msg = br#"{"hello":"world"}"#;
        assert_eq!(roundtrip("correct horse battery staple", msg), msg);
    }

    #[test]
    fn container_starts_with_magic_and_hides_plaintext() {
        let container = seal("pw", b"TOP-SECRET-MARKER", COMPRESSION_NONE).unwrap();
        assert!(container.starts_with(MAGIC));
        // The plaintext marker must not appear anywhere in the container.
        assert!(!container
            .windows(b"TOP-SECRET-MARKER".len())
            .any(|w| w == b"TOP-SECRET-MARKER"));
    }

    #[test]
    fn wrong_password_fails() {
        let container = seal("right-password", b"secret data", COMPRESSION_NONE).expect("seal");
        let err = open("wrong-password", &container).expect_err("must fail");
        assert!(matches!(err, BackupError::Decrypt), "got {err:?}");
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let mut container = seal("pw", b"secret data", COMPRESSION_NONE).expect("seal");
        // Flip the last byte (inside the ciphertext/tag).
        *container.last_mut().unwrap() ^= 0xff;
        assert!(matches!(open("pw", &container), Err(BackupError::Decrypt)));
    }

    #[test]
    fn tampered_header_fails() {
        let mut container = seal("pw", b"secret data", COMPRESSION_NONE).expect("seal");
        // Flip the compression byte in the header — it's part of the AEAD AAD,
        // so the tag check must fail.
        let comp_off = MAGIC.len() + 1 + 4 + 4 + 4; // after magic+kdf_id+m+t+p
        container[comp_off] ^= 0xff;
        assert!(matches!(open("pw", &container), Err(BackupError::Decrypt)));
    }

    #[test]
    fn each_backup_is_unique() {
        let a = seal("pw", b"data", COMPRESSION_NONE).unwrap();
        let b = seal("pw", b"data", COMPRESSION_NONE).unwrap();
        // Fresh salt + nonce per backup → different bytes despite same input.
        assert_ne!(a, b);
    }

    #[test]
    fn rejects_bad_magic() {
        let mut container = seal("pw", b"x", COMPRESSION_NONE).unwrap();
        container[0] ^= 0xff;
        assert!(matches!(
            open("pw", &container),
            Err(BackupError::Format(_))
        ));
    }

    #[test]
    fn rejects_truncated_container() {
        let container = seal("pw", b"x", COMPRESSION_NONE).unwrap();
        // Cut into the header — the reader must error, not panic.
        assert!(matches!(
            open("pw", &container[..5]),
            Err(BackupError::Format(_))
        ));
        assert!(matches!(open("pw", &[]), Err(BackupError::Format(_))));
    }

    #[test]
    fn frame_roundtrips() {
        let creds = br#"{"host-1":{"type":"Password","password":"x"}}"#;
        let db = &[0u8, 1, 2, 3, 255, 254];
        let frame = encode_frame(creds, db);
        let (c, d) = decode_frame(&frame).expect("decode");
        assert_eq!(c, creds);
        assert_eq!(d, db);
    }

    #[test]
    fn frame_empty_db() {
        let frame = encode_frame(b"{}", &[]);
        let (c, d) = decode_frame(&frame).expect("decode");
        assert_eq!(c, b"{}");
        assert!(d.is_empty());
    }

    #[test]
    fn decode_frame_rejects_truncated() {
        assert!(decode_frame(&[1, 2]).is_err()); // < 4 bytes
                                                 // Length header claims more creds bytes than exist.
        assert!(decode_frame(&[10, 0, 0, 0, b'x']).is_err());
    }

    #[test]
    fn gzip_roundtrips_and_shrinks_zeros() {
        let data = vec![0u8; 64 * 1024]; // mimics SQLite's zero-filled pages
        let z = gzip(&data).expect("gzip");
        assert!(z.len() < data.len() / 10, "zeros should compress hugely");
        assert_eq!(gunzip(&z).expect("gunzip"), data);
    }

    #[test]
    fn gunzip_rejects_garbage() {
        assert!(matches!(
            gunzip(b"not gzip data"),
            Err(BackupError::Format(_))
        ));
    }

    #[test]
    fn build_and_restore_roundtrip_is_compact() {
        use crate::db::HostDb;
        let dir1 = std::env::temp_dir().join(format!("anyscp-bk-src-{}", uuid::Uuid::new_v4()));
        let dir2 = std::env::temp_dir().join(format!("anyscp-bk-dst-{}", uuid::Uuid::new_v4()));
        let src = HostDb::new(&dir1).expect("src db");
        src.save_setting("app_theme", "light")
            .expect("seed setting");

        let backup = build_backup(&src, "hunter2-strong-pw", true).expect("build_backup");

        // Compression + framing + binary container: the encrypted backup is far
        // smaller than the raw SQLite snapshot (the old JSON+double-base64 format
        // was ~1.8x the snapshot).
        let raw = src.export_db_snapshot().expect("snapshot");
        assert!(
            backup.len() < raw.len(),
            "backup {} should be smaller than raw snapshot {}",
            backup.len(),
            raw.len()
        );

        let dst = HostDb::new(&dir2).expect("dst db");
        // Wrong password must fail (and the GCM tag check means nothing restores).
        assert!(restore_backup(&dst, "wrong-pw", &backup).is_err());
        // Correct password restores the data.
        restore_backup(&dst, "hunter2-strong-pw", &backup).expect("restore_backup");
        assert!(dst
            .load_all_settings()
            .expect("settings")
            .iter()
            .any(|(k, v)| k == "app_theme" && v == "light"));

        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn credential_payload_round_trips_private_key_data() {
        /* Backup credentials share the vault's tagged representation; this
         * guards the encrypted payload's compatibility without exposing key
         * material outside Rust test memory. */
        let mut credentials = BTreeMap::new();
        credentials.insert(
            "host-id".to_string(),
            StoredCredential::PrivateKeyData {
                key_data: "private-key-data".to_string(),
                passphrase: Some("passphrase".to_string()),
            },
        );
        let encoded = Zeroizing::new(serde_json::to_vec(&credentials).expect("encode credentials"));
        let decoded: BTreeMap<String, StoredCredential> =
            serde_json::from_slice(&encoded).expect("decode credentials");
        assert!(matches!(
            decoded.get("host-id"),
            Some(StoredCredential::PrivateKeyData {
                key_data,
                passphrase: Some(passphrase),
            }) if key_data == "private-key-data" && passphrase == "passphrase"
        ));
    }

    #[test]
    fn decrypted_backup_plaintext_uses_zeroizing_ownership() {
        fn assert_zeroizing(_: &Zeroizing<Vec<u8>>) {}

        let container = seal("pw", b"sensitive-payload", COMPRESSION_NONE).unwrap();
        let (plaintext, _) = open("pw", &container).unwrap();
        assert_zeroizing(&plaintext);
        assert_eq!(plaintext.as_slice(), b"sensitive-payload");
    }

    #[test]
    fn preflight_counts_keychain_local_vault_and_s3_candidates() {
        let (db, dir) = test_db();
        db.save_host(&sample_host("keychain-1", CredentialStorage::Keychain))
            .expect("save keychain host");
        db.save_host(&sample_host("keychain-2", CredentialStorage::Keychain))
            .expect("save keychain host");
        db.save_host(&sample_host("local-1", CredentialStorage::LocalVault))
            .expect("save local vault host");
        db.save_s3_connection(
            "s3-1",
            "S3",
            "aws",
            "us-east-1",
            None,
            None,
            false,
            None,
            None,
            None,
            None,
        )
        .expect("save s3 connection");

        let summary = backup_preflight(&db).expect("preflight");
        assert_eq!(summary.keychain_host_candidates, 2);
        assert_eq!(summary.local_vault_hosts, 1);
        assert_eq!(summary.s3_candidates, 1);
        assert_eq!(
            serde_json::to_value(summary).expect("serialize"),
            serde_json::json!({
                "keychainHostCandidates": 2,
                "localVaultHosts": 1,
                "s3Candidates": 1
            })
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skipped_keychain_export_performs_no_reads_and_restores() {
        let (src, src_dir) = test_db();
        let (dst, dst_dir) = test_db();
        src.save_host(&sample_host("keychain-1", CredentialStorage::Keychain))
            .expect("save host");
        let reader = TestCredentialReader {
            reads: RefCell::new(Vec::new()),
            credentials: BTreeMap::new(),
            error_key: Some("keychain-1".to_string()),
        };

        let backup = build_backup_with_reader(&src, "password", false, &reader)
            .expect("build without keychain");
        assert!(reader.reads.borrow().is_empty());
        assert!(decoded_credentials("password", &backup).is_empty());
        restore_backup(&dst, "password", &backup).expect("restore");
        assert!(dst.get_host("keychain-1").expect("get host").is_some());

        let _ = std::fs::remove_dir_all(src_dir);
        let _ = std::fs::remove_dir_all(dst_dir);
    }

    #[test]
    fn full_export_reads_only_keychain_candidates_and_skips_missing_items() {
        let (db, dir) = test_db();
        db.save_host(&sample_host("keychain-1", CredentialStorage::Keychain))
            .expect("save keychain host");
        db.save_host(&sample_host("missing", CredentialStorage::Keychain))
            .expect("save missing host");
        db.save_host(&sample_host("local-1", CredentialStorage::LocalVault))
            .expect("save local host");
        db.save_s3_connection(
            "bucket",
            "Bucket",
            "aws",
            "us-east-1",
            None,
            None,
            false,
            None,
            None,
            None,
            None,
        )
        .expect("save s3 connection");
        let reader = TestCredentialReader {
            reads: RefCell::new(Vec::new()),
            credentials: BTreeMap::from([
                (
                    "keychain-1".to_string(),
                    StoredCredential::Password {
                        password: "host-secret".to_string(),
                    },
                ),
                (
                    "s3:bucket".to_string(),
                    StoredCredential::Password {
                        password: "s3-secret".to_string(),
                    },
                ),
            ]),
            error_key: None,
        };

        let backup = build_backup_with_reader(&db, "password", true, &reader).expect("build");
        let reads = reader.reads.borrow();
        assert!(reads.contains(&"keychain-1".to_string()));
        assert!(reads.contains(&"missing".to_string()));
        assert!(reads.contains(&"s3:bucket".to_string()));
        assert!(!reads.contains(&"local-1".to_string()));
        assert_eq!(decoded_credentials("password", &backup).len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn full_export_redacts_keychain_failures() {
        let (db, dir) = test_db();
        db.save_host(&sample_host(
            "sensitive-host-id",
            CredentialStorage::Keychain,
        ))
        .expect("save host");
        let reader = TestCredentialReader {
            reads: RefCell::new(Vec::new()),
            credentials: BTreeMap::new(),
            error_key: Some("sensitive-host-id".to_string()),
        };

        let error = build_backup_with_reader(&db, "password", true, &reader)
            .expect_err("keychain failure must abort");
        assert!(matches!(error, BackupError::KeychainRead));
        let serialized = serde_json::to_string(&error).expect("serialize error");
        assert!(serialized.contains("credential_read"));
        assert!(!serialized.contains("sensitive-host-id"));
        assert!(!serialized.contains("private native keychain detail"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
