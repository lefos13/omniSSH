/* Local-vault crypto is deliberately independent of persistence and session
 * state: callers supply the derived key and host identifier, while this module
 * owns the authenticated envelope and zeroizes plaintext intermediates. */
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use std::sync::{Arc, MutexGuard};
use zeroize::{Zeroize, Zeroizing};

use crate::db::{CredentialStorage, HostDb, VaultCredentialRekey, VaultMetadata};

use super::{StoredCredential, VaultError};

const ARGON2_M_KIB: u32 = 64 * 1024;
const ARGON2_T: u32 = 3;
const ARGON2_P: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const MIN_MASTER_PASSWORD_LEN: usize = 12;
const CREDENTIAL_AAD_PREFIX: &[u8] = b"omniSSH/local-vault/credential/";
const VERIFIER_AAD: &[u8] = b"omniSSH/local-vault/verifier/v1";
const VERIFIER_PLAINTEXT: &[u8] = b"omniSSH-local-vault-verifier-v1";

/// Session-only key material. The persisted database contains only ciphertext;
/// this mutex is the sole owner of the key after setup or successful unlock.
pub struct LocalVault {
    session_key: std::sync::Mutex<Option<Zeroizing<[u8; KEY_LEN]>>>,
    operation_lock: std::sync::Mutex<()>,
}

impl LocalVault {
    pub fn new() -> Self {
        Self {
            session_key: std::sync::Mutex::new(None),
            operation_lock: std::sync::Mutex::new(()),
        }
    }

    fn begin_operation(&self) -> Result<MutexGuard<'_, ()>, VaultError> {
        self.operation_lock.lock().map_err(|error| {
            VaultError::Database(format!("local vault operation lock poisoned: {error}"))
        })
    }

    fn set_session_key(&self, key: [u8; KEY_LEN]) -> Result<(), VaultError> {
        let mut session_key = self.session_key.lock().map_err(|error| {
            VaultError::Database(format!("local vault state lock poisoned: {error}"))
        })?;
        *session_key = Some(Zeroizing::new(key));
        Ok(())
    }

    fn session_key(&self) -> Result<Zeroizing<[u8; KEY_LEN]>, VaultError> {
        let session_key = self.session_key.lock().map_err(|error| {
            VaultError::Database(format!("local vault state lock poisoned: {error}"))
        })?;
        session_key
            .as_ref()
            .map(|key| Zeroizing::new(**key))
            .ok_or(VaultError::LocalVaultLocked)
    }

    pub fn is_unlocked(&self) -> bool {
        self.session_key
            .lock()
            .map(|session_key| session_key.is_some())
            .unwrap_or(false)
    }

    pub fn lock_session(&self) {
        if let Ok(_operation) = self.begin_operation() {
            if let Ok(mut session_key) = self.session_key.lock() {
                session_key.take();
            }
        }
    }
}

impl Default for LocalVault {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LocalVault {
    fn drop(&mut self) {
        self.lock_session();
    }
}

fn derive_key(master_password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; KEY_LEN]>, VaultError> {
    if master_password.is_empty() {
        return Err(VaultError::InvalidData(
            "master password must not be empty".to_string(),
        ));
    }
    if salt.len() != SALT_LEN {
        return Err(VaultError::InvalidData(
            "local vault metadata has an invalid salt".to_string(),
        ));
    }

    let params = Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(KEY_LEN))
        .map_err(|error| VaultError::Crypto(error.to_string()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(master_password.as_bytes(), salt, &mut key)
        .map_err(|error| VaultError::Crypto(error.to_string()))?;
    Ok(Zeroizing::new(key))
}

fn validate_new_master_password(master_password: &str) -> Result<(), VaultError> {
    if master_password.len() < MIN_MASTER_PASSWORD_LEN {
        return Err(VaultError::InvalidData(format!(
            "master password must be at least {MIN_MASTER_PASSWORD_LEN} characters"
        )));
    }
    Ok(())
}

fn credential_aad(host_id: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(CREDENTIAL_AAD_PREFIX.len() + host_id.len());
    aad.extend_from_slice(CREDENTIAL_AAD_PREFIX);
    aad.extend_from_slice(host_id.as_bytes());
    aad
}

fn encrypt_bytes(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, VaultError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|error| VaultError::Crypto(error.to_string()))
}

fn decrypt_bytes(
    key: &[u8; KEY_LEN],
    nonce: &[u8],
    aad: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    if nonce.len() != NONCE_LEN {
        return Err(VaultError::InvalidData(
            "local vault metadata has an invalid nonce".to_string(),
        ));
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| VaultError::Crypto("local vault authentication failed".into()))?;
    Ok(Zeroizing::new(plaintext))
}

fn encrypt_credential(
    key: &[u8; KEY_LEN],
    host_id: &str,
    credential: &StoredCredential,
) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|error| VaultError::Crypto(error.to_string()))?;
    let mut plaintext = Zeroizing::new(
        serde_json::to_vec(credential)
            .map_err(|error| VaultError::InvalidData(error.to_string()))?,
    );
    let aad = credential_aad(host_id);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad,
            },
        )
        .map_err(|error| VaultError::Crypto(error.to_string()));
    plaintext.zeroize();
    Ok((nonce.to_vec(), ciphertext?))
}

fn decrypt_credential(
    key: &[u8; KEY_LEN],
    host_id: &str,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<StoredCredential, VaultError> {
    let aad = credential_aad(host_id);
    let plaintext = decrypt_bytes(key, nonce, &aad, ciphertext).map_err(|error| match error {
        VaultError::InvalidData(_) => error,
        _ => VaultError::Crypto("local vault credential authentication failed".into()),
    })?;
    serde_json::from_slice(&plaintext)
        .map_err(|_| VaultError::InvalidData("local vault credential is corrupt".to_string()))
}

fn zeroize_credential(credential: &mut StoredCredential) {
    match credential {
        StoredCredential::Password { password } => password.zeroize(),
        StoredCredential::KeyPassphrase { passphrase } => passphrase.zeroize(),
        StoredCredential::PrivateKeyData {
            key_data,
            passphrase,
        } => {
            key_data.zeroize();
            if let Some(passphrase) = passphrase {
                passphrase.zeroize();
            }
        }
    }
}

fn random_bytes<const N: usize>() -> Result<[u8; N], VaultError> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).map_err(|error| VaultError::Crypto(error.to_string()))?;
    Ok(bytes)
}

/* Setup and unlock use a sealed, fixed verifier rather than persisting a
 * password-derived hash. AES-GCM authenticates the verifier and the metadata
 * remains useless without the master password-derived session key. */
fn setup_local_vault(
    db: &HostDb,
    state: &LocalVault,
    master_password: &str,
) -> Result<(), VaultError> {
    let _operation = state.begin_operation()?;
    if db.is_local_vault_configured()? {
        return Err(VaultError::LocalVaultAlreadyConfigured);
    }
    validate_new_master_password(master_password)?;
    let salt = random_bytes::<SALT_LEN>()?;
    let key = derive_key(master_password, &salt)?;
    let verifier_nonce = random_bytes::<NONCE_LEN>()?;
    let verifier_ciphertext =
        encrypt_bytes(&key, &verifier_nonce, VERIFIER_AAD, VERIFIER_PLAINTEXT)?;
    let metadata = VaultMetadata {
        salt: salt.to_vec(),
        verifier_nonce: verifier_nonce.to_vec(),
        verifier_ciphertext,
    };

    db.save_vault_metadata(&metadata)?;
    state.set_session_key(*key)
}

fn unlock_local_vault(
    db: &HostDb,
    state: &LocalVault,
    master_password: &str,
) -> Result<(), VaultError> {
    let _operation = state.begin_operation()?;
    let metadata = db
        .get_vault_metadata()?
        .ok_or(VaultError::LocalVaultNotConfigured)?;
    let key = verify_master_password(&metadata, master_password)?;
    state.set_session_key(*key)
}

fn verify_master_password(
    metadata: &VaultMetadata,
    master_password: &str,
) -> Result<Zeroizing<[u8; KEY_LEN]>, VaultError> {
    let key = derive_key(master_password, &metadata.salt)
        .map_err(|_| VaultError::InvalidMasterPassword)?;
    let verifier = decrypt_bytes(
        &key,
        &metadata.verifier_nonce,
        VERIFIER_AAD,
        &metadata.verifier_ciphertext,
    )
    .map_err(|_| VaultError::InvalidMasterPassword)?;
    if verifier.as_slice() != VERIFIER_PLAINTEXT {
        return Err(VaultError::InvalidMasterPassword);
    }
    Ok(key)
}

/* Rekeying authenticates the current password, re-encrypts every host value
 * with fresh nonces, and commits metadata plus ciphertext in one transaction. */
fn change_local_vault_master_password(
    db: &HostDb,
    state: &LocalVault,
    current_master_password: &str,
    new_master_password: &str,
) -> Result<(), VaultError> {
    let _operation = state.begin_operation()?;
    validate_new_master_password(new_master_password)?;
    let previous_metadata = db
        .get_vault_metadata()?
        .ok_or(VaultError::LocalVaultNotConfigured)?;
    let previous_key = verify_master_password(&previous_metadata, current_master_password)?;

    let salt = random_bytes::<SALT_LEN>()?;
    let key = derive_key(new_master_password, &salt)?;
    let verifier_nonce = random_bytes::<NONCE_LEN>()?;
    let verifier_ciphertext =
        encrypt_bytes(&key, &verifier_nonce, VERIFIER_AAD, VERIFIER_PLAINTEXT)?;
    let metadata = VaultMetadata {
        salt: salt.to_vec(),
        verifier_nonce: verifier_nonce.to_vec(),
        verifier_ciphertext,
    };

    let credentials = db
        .list_local_vault_credentials()?
        .into_iter()
        .map(|(host_id, previous_ciphertext)| {
            let (nonce, ciphertext) = unpack_credential_blob(&previous_ciphertext)?;
            let mut credential = decrypt_credential(&previous_key, &host_id, nonce, ciphertext)?;
            let encrypted = encrypt_credential(&key, &host_id, &credential);
            zeroize_credential(&mut credential);
            let (nonce, ciphertext) = encrypted?;
            Ok(VaultCredentialRekey {
                host_id,
                previous_ciphertext,
                ciphertext: pack_credential_blob(&nonce, &ciphertext)?,
            })
        })
        .collect::<Result<Vec<_>, VaultError>>()?;

    db.replace_vault_metadata_and_credentials(&previous_metadata, &metadata, &credentials)?;
    state.set_session_key(*key)
}

fn pack_credential_blob(nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, VaultError> {
    if nonce.len() != NONCE_LEN {
        return Err(VaultError::InvalidData(
            "local vault credential has an invalid nonce".to_string(),
        ));
    }
    let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(ciphertext);
    Ok(blob)
}

fn unpack_credential_blob(blob: &[u8]) -> Result<(&[u8], &[u8]), VaultError> {
    if blob.len() < NONCE_LEN {
        return Err(VaultError::InvalidData(
            "local vault credential is corrupt".to_string(),
        ));
    }
    Ok(blob.split_at(NONCE_LEN))
}

impl From<crate::db::DbError> for VaultError {
    fn from(error: crate::db::DbError) -> Self {
        Self::Database(error.to_string())
    }
}

/* The resolver branches on the persisted marker before touching the keychain.
 * This makes a local-vault host fail closed while locked and prevents an old
 * keychain copy from becoming an accidental fallback credential source. */
pub(crate) fn resolve_host_credential(
    db: &HostDb,
    state: &LocalVault,
    host_id: &str,
    storage: CredentialStorage,
) -> Result<StoredCredential, VaultError> {
    let _operation = state.begin_operation()?;
    match storage {
        CredentialStorage::Keychain => super::get_credential(host_id),
        CredentialStorage::LocalVault => {
            let key = state.session_key()?;
            let blob = db
                .get_local_vault_credential(host_id)?
                .ok_or_else(|| VaultError::NotFound(host_id.to_string()))?;
            let (nonce, ciphertext) = unpack_credential_blob(&blob)?;
            decrypt_credential(&key, host_id, nonce, ciphertext)
        }
    }
}

/* Bulk migration shares the per-host keychain-to-vault move, so the steps
 * live here without the operation and session locks: callers hold the
 * operation guard and pass the derived session key, keeping single-host and
 * bulk sweeps on one code path with identical checks and rollback ordering. */
fn migrate_host_to_vault(
    db: &HostDb,
    key: &[u8; KEY_LEN],
    host_id: &str,
) -> Result<(), VaultError> {
    let host = db
        .get_host(host_id)?
        .ok_or_else(|| VaultError::NotFound(host_id.to_string()))?;
    if host.credential_storage == CredentialStorage::LocalVault {
        return Ok(());
    }
    if host.auth_type != "password" {
        return Err(VaultError::UnsupportedCredential(
            "only password-authenticated hosts can be migrated".to_string(),
        ));
    }

    let credential = super::get_credential(host_id)?;
    let password = match &credential {
        StoredCredential::Password { .. } => &credential,
        _ => {
            return Err(VaultError::UnsupportedCredential(
                "the host does not have a password credential".to_string(),
            ))
        }
    };
    let (nonce, ciphertext) = encrypt_credential(key, host_id, password)?;
    let blob = pack_credential_blob(&nonce, &ciphertext)?;

    db.save_local_vault_credential(host_id, &blob)?;
    if let Err(error) = db.set_credential_storage(host_id, CredentialStorage::LocalVault) {
        let _ = db.delete_local_vault_credential(host_id);
        return Err(error.into());
    }

    if let Err(error) = super::delete_credential(host_id) {
        let marker_rollback = db.set_credential_storage(host_id, CredentialStorage::Keychain);
        let value_rollback = db.delete_local_vault_credential(host_id);
        if marker_rollback.is_err() || value_rollback.is_err() {
            return Err(VaultError::Database(
                "local vault migration could not be rolled back after keychain deletion failed"
                    .to_string(),
            ));
        }
        return Err(error);
    }
    Ok(())
}

fn migrate_host_password(db: &HostDb, state: &LocalVault, host_id: &str) -> Result<(), VaultError> {
    let _operation = state.begin_operation()?;
    let key = state.session_key()?;
    migrate_host_to_vault(db, &key, host_id)
}

fn move_host_to_keychain(db: &HostDb, state: &LocalVault, host_id: &str) -> Result<(), VaultError> {
    let _operation = state.begin_operation()?;
    let host = db
        .get_host(host_id)?
        .ok_or_else(|| VaultError::NotFound(host_id.to_string()))?;
    if host.credential_storage == CredentialStorage::Keychain {
        return Ok(());
    }
    if host.auth_type != "password" {
        return Err(VaultError::UnsupportedCredential(
            "only password-authenticated hosts can use the local vault".to_string(),
        ));
    }

    let key = state.session_key()?;
    let blob = db
        .get_local_vault_credential(host_id)?
        .ok_or_else(|| VaultError::NotFound(host_id.to_string()))?;
    let (nonce, ciphertext) = unpack_credential_blob(&blob)?;
    let credential = decrypt_credential(&key, host_id, nonce, ciphertext)?;
    if !matches!(credential, StoredCredential::Password { .. }) {
        return Err(VaultError::UnsupportedCredential(
            "the local vault entry is not a password credential".to_string(),
        ));
    }

    super::save_credential(host_id, &credential)?;
    if let Err(error) = db.set_credential_storage(host_id, CredentialStorage::Keychain) {
        let _ = super::delete_credential(host_id);
        return Err(error.into());
    }
    if let Err(error) = db.delete_local_vault_credential(host_id) {
        let marker_rollback = db.set_credential_storage(host_id, CredentialStorage::LocalVault);
        let keychain_rollback = super::delete_credential(host_id);
        if marker_rollback.is_err() || keychain_rollback.is_err() {
            return Err(VaultError::Database(
                "moving the host to the keychain could not be rolled back".to_string(),
            ));
        }
        return Err(error.into());
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVaultStatus {
    pub configured: bool,
    pub unlocked: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPreflightSummary {
    pub migratable: usize,
    pub already_in_vault: usize,
    pub non_migratable: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkMigrationResult {
    pub migrated: usize,
    pub skipped: usize,
    pub failed: Vec<BulkMigrationFailure>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkMigrationFailure {
    pub host_id: String,
    pub host_label: String,
    pub error: String,
}

/* The preflight only counts persisted storage markers, so the frontend can
 * size the migration offer while the vault is locked; no key material or
 * keychain access happens. */
fn migration_preflight(db: &HostDb) -> Result<MigrationPreflightSummary, VaultError> {
    let mut summary = MigrationPreflightSummary {
        migratable: 0,
        already_in_vault: 0,
        non_migratable: 0,
    };
    for host in db.list_hosts()? {
        match host.credential_storage {
            CredentialStorage::LocalVault => summary.already_in_vault += 1,
            CredentialStorage::Keychain if host.auth_type == "password" => summary.migratable += 1,
            CredentialStorage::Keychain => summary.non_migratable += 1,
        }
    }
    Ok(summary)
}

/* The sweep holds the single operation guard across the whole loop:
 * re-entering the per-host wrapper would deadlock on the non-reentrant
 * operation lock. The session key is captured once up front, so a locked
 * vault fails before any host is touched, and per-host failures are recorded
 * instead of aborting the remaining hosts. */
fn migrate_all_from_keychain(
    db: &HostDb,
    state: &LocalVault,
) -> Result<BulkMigrationResult, VaultError> {
    let _operation = state.begin_operation()?;
    let key = state.session_key()?;
    let mut result = BulkMigrationResult {
        migrated: 0,
        skipped: 0,
        failed: Vec::new(),
    };
    for host in db.list_hosts()? {
        if host.credential_storage != CredentialStorage::Keychain || host.auth_type != "password" {
            continue;
        }
        match migrate_host_to_vault(db, &key, &host.id) {
            Ok(()) => result.migrated += 1,
            Err(VaultError::NotFound(_)) => result.skipped += 1,
            Err(error) => result.failed.push(BulkMigrationFailure {
                host_id: host.id.clone(),
                host_label: host.label.clone(),
                error: error.to_string(),
            }),
        }
    }
    Ok(result)
}

fn blocking_task_error(error: tokio::task::JoinError) -> VaultError {
    VaultError::Database(format!("local vault task failed: {error}"))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_vault_setup(
    master_password: String,
    db: tauri::State<'_, Arc<HostDb>>,
    state: tauri::State<'_, Arc<LocalVault>>,
) -> Result<(), VaultError> {
    let master_password = Zeroizing::new(master_password);
    let db = Arc::clone(&db);
    let state = Arc::clone(&state);
    tokio::task::spawn_blocking(move || setup_local_vault(&db, &state, &master_password))
        .await
        .map_err(blocking_task_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_vault_unlock(
    master_password: String,
    db: tauri::State<'_, Arc<HostDb>>,
    state: tauri::State<'_, Arc<LocalVault>>,
) -> Result<(), VaultError> {
    let master_password = Zeroizing::new(master_password);
    let db = Arc::clone(&db);
    let state = Arc::clone(&state);
    tokio::task::spawn_blocking(move || unlock_local_vault(&db, &state, &master_password))
        .await
        .map_err(blocking_task_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_vault_change_master_password(
    current_master_password: String,
    new_master_password: String,
    db: tauri::State<'_, Arc<HostDb>>,
    state: tauri::State<'_, Arc<LocalVault>>,
) -> Result<(), VaultError> {
    /* Both inputs live only for this blocking operation. The new derived key
     * replaces the session key only after SQLite commits every ciphertext. */
    let current_master_password = Zeroizing::new(current_master_password);
    let new_master_password = Zeroizing::new(new_master_password);
    let db = Arc::clone(&db);
    let state = Arc::clone(&state);
    tokio::task::spawn_blocking(move || {
        change_local_vault_master_password(
            &db,
            &state,
            &current_master_password,
            &new_master_password,
        )
    })
    .await
    .map_err(blocking_task_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_vault_lock(state: tauri::State<'_, Arc<LocalVault>>) -> Result<(), VaultError> {
    state.lock_session();
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_vault_status(
    db: tauri::State<'_, Arc<HostDb>>,
    state: tauri::State<'_, Arc<LocalVault>>,
) -> Result<LocalVaultStatus, VaultError> {
    let db = Arc::clone(&db);
    let state = Arc::clone(&state);
    tokio::task::spawn_blocking(move || {
        Ok(LocalVaultStatus {
            configured: db.is_local_vault_configured()?,
            unlocked: state.is_unlocked(),
        })
    })
    .await
    .map_err(blocking_task_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_vault_migrate_host_password(
    host_id: String,
    db: tauri::State<'_, Arc<HostDb>>,
    state: tauri::State<'_, Arc<LocalVault>>,
) -> Result<(), VaultError> {
    let db = Arc::clone(&db);
    let state = Arc::clone(&state);
    tokio::task::spawn_blocking(move || migrate_host_password(&db, &state, &host_id))
        .await
        .map_err(blocking_task_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_vault_move_host_to_keychain(
    host_id: String,
    db: tauri::State<'_, Arc<HostDb>>,
    state: tauri::State<'_, Arc<LocalVault>>,
) -> Result<(), VaultError> {
    let db = Arc::clone(&db);
    let state = Arc::clone(&state);
    tokio::task::spawn_blocking(move || move_host_to_keychain(&db, &state, &host_id))
        .await
        .map_err(blocking_task_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_vault_migration_preflight(
    db: tauri::State<'_, Arc<HostDb>>,
) -> Result<MigrationPreflightSummary, VaultError> {
    let db = Arc::clone(&db);
    tokio::task::spawn_blocking(move || migration_preflight(&db))
        .await
        .map_err(blocking_task_error)?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn local_vault_migrate_all_from_keychain(
    db: tauri::State<'_, Arc<HostDb>>,
    state: tauri::State<'_, Arc<LocalVault>>,
) -> Result<BulkMigrationResult, VaultError> {
    let db = Arc::clone(&db);
    let state = Arc::clone(&state);
    tokio::task::spawn_blocking(move || migrate_all_from_keychain(&db, &state))
        .await
        .map_err(blocking_task_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SavedHost;

    fn password_host(id: &str) -> SavedHost {
        SavedHost {
            id: id.to_string(),
            label: id.to_string(),
            host: "192.0.2.1".to_string(),
            port: 22,
            username: "test".to_string(),
            auth_type: "password".to_string(),
            credential_storage: CredentialStorage::Keychain,
            group_id: None,
            created_at: "2026-01-01T00:00:00".to_string(),
            updated_at: "2026-01-01T00:00:00".to_string(),
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
            connection_count: None,
        }
    }

    fn derive_test_key(master_password: &str, salt: &[u8]) -> Zeroizing<[u8; KEY_LEN]> {
        derive_key(master_password, salt).expect("derive test key")
    }

    #[test]
    fn local_credential_round_trip_is_bound_to_host_id() {
        let key = derive_test_key("master-password", b"salt-for-test!!!");
        let credential = StoredCredential::Password {
            password: "correct horse battery staple".to_string(),
        };

        let (nonce, ciphertext) = encrypt_credential(&key, "host-a", &credential).expect("encrypt");
        let decrypted = decrypt_credential(&key, "host-a", &nonce, &ciphertext).expect("decrypt");

        assert!(
            matches!(decrypted, StoredCredential::Password { ref password } if password == "correct horse battery staple")
        );
        assert!(decrypt_credential(&key, "host-b", &nonce, &ciphertext).is_err());
    }

    #[test]
    fn local_credential_rejects_wrong_key_and_malformed_nonce() {
        let key = derive_test_key("master-password", b"salt-for-test!!!");
        let wrong_key = derive_test_key("different-password", b"salt-for-test!!!");
        let credential = StoredCredential::Password {
            password: "secret".to_string(),
        };
        let (nonce, ciphertext) = encrypt_credential(&key, "host-a", &credential).expect("encrypt");

        assert!(decrypt_credential(&wrong_key, "host-a", &nonce, &ciphertext).is_err());
        assert!(decrypt_credential(&key, "host-a", &[0; 11], &ciphertext).is_err());
    }

    #[test]
    fn local_credential_encryption_uses_a_fresh_nonce() {
        let key = derive_test_key("master-password", b"salt-for-test!!!");
        let credential = StoredCredential::Password {
            password: "secret".to_string(),
        };

        let (nonce_a, ciphertext_a) =
            encrypt_credential(&key, "host-a", &credential).expect("encrypt");
        let (nonce_b, ciphertext_b) =
            encrypt_credential(&key, "host-a", &credential).expect("encrypt");

        assert_ne!(nonce_a, nonce_b);
        assert_ne!(ciphertext_a, ciphertext_b);
    }

    #[test]
    fn local_vault_session_starts_locked_and_lock_clears_key() {
        let state = LocalVault::new();
        assert!(!state.is_unlocked());

        state
            .set_session_key([7; KEY_LEN])
            .expect("set session key");
        assert!(state.is_unlocked());

        state.lock_session();
        assert!(!state.is_unlocked());
        assert!(matches!(
            state.session_key(),
            Err(VaultError::LocalVaultLocked)
        ));
    }

    #[test]
    fn setup_seals_verifier_and_unlock_requires_master_password() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("database");
        let state = LocalVault::new();

        assert!(!db.is_local_vault_configured().expect("initial status"));
        setup_local_vault(&db, &state, "master-password").expect("setup");
        assert!(db.is_local_vault_configured().expect("configured status"));
        assert!(state.is_unlocked());

        let metadata = db
            .get_vault_metadata()
            .expect("metadata lookup")
            .expect("metadata");
        assert_eq!(metadata.salt.len(), SALT_LEN);
        assert_eq!(metadata.verifier_nonce.len(), NONCE_LEN);
        assert!(!metadata
            .verifier_ciphertext
            .windows(b"master-password".len())
            .any(|window| window == b"master-password"));

        state.lock_session();
        assert!(matches!(
            unlock_local_vault(&db, &state, "wrong-password"),
            Err(VaultError::InvalidMasterPassword)
        ));
        assert!(!state.is_unlocked());
        unlock_local_vault(&db, &state, "master-password").expect("unlock");
        assert!(state.is_unlocked());
        assert!(matches!(
            setup_local_vault(&db, &state, "another-password"),
            Err(VaultError::LocalVaultAlreadyConfigured)
        ));
    }

    #[test]
    fn changing_the_master_password_invalidates_the_previous_password() {
        /* Rekeying must authenticate the old secret, atomically replace vault
         * metadata, and leave the session usable with only the new secret. */
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("database");
        let state = LocalVault::new();

        setup_local_vault(&db, &state, "original-master-password").expect("setup");
        change_local_vault_master_password(
            &db,
            &state,
            "original-master-password",
            "replacement-master-password",
        )
        .expect("change master password");

        state.lock_session();
        assert!(matches!(
            unlock_local_vault(&db, &state, "original-master-password"),
            Err(VaultError::InvalidMasterPassword)
        ));
        unlock_local_vault(&db, &state, "replacement-master-password")
            .expect("unlock with replacement password");
    }

    #[test]
    fn changing_the_master_password_reencrypts_existing_host_credentials() {
        /* A rekey must preserve host secrets while making both the former key
         * and the previous ciphertext unusable for subsequent resolution. */
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("database");
        let state = LocalVault::new();
        db.save_host(&password_host("vault-host"))
            .expect("save host");
        setup_local_vault(&db, &state, "original-master-password").expect("setup");

        let key = state.session_key().expect("session key");
        let credential = StoredCredential::Password {
            password: "host-password".to_string(),
        };
        let (nonce, ciphertext) =
            encrypt_credential(&key, "vault-host", &credential).expect("encrypt");
        let original_blob = pack_credential_blob(&nonce, &ciphertext).expect("pack credential");
        db.save_local_vault_credential("vault-host", &original_blob)
            .expect("save encrypted credential");
        db.set_credential_storage("vault-host", CredentialStorage::LocalVault)
            .expect("mark encrypted credential");

        change_local_vault_master_password(
            &db,
            &state,
            "original-master-password",
            "replacement-master-password",
        )
        .expect("change master password");

        let replacement_blob = db
            .get_local_vault_credential("vault-host")
            .expect("read encrypted credential")
            .expect("credential exists");
        assert_ne!(replacement_blob, original_blob);
        state.lock_session();
        unlock_local_vault(&db, &state, "replacement-master-password")
            .expect("unlock with replacement password");
        assert!(matches!(
            resolve_host_credential(&db, &state, "vault-host", CredentialStorage::LocalVault),
            Ok(StoredCredential::Password { ref password }) if password == "host-password"
        ));
    }

    #[test]
    fn wrong_current_password_leaves_the_vault_unchanged() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("database");
        let state = LocalVault::new();
        setup_local_vault(&db, &state, "original-master-password").expect("setup");
        let metadata = db.get_vault_metadata().expect("metadata");

        assert!(matches!(
            change_local_vault_master_password(
                &db,
                &state,
                "wrong-master-password",
                "replacement-master-password",
            ),
            Err(VaultError::InvalidMasterPassword)
        ));
        assert_eq!(db.get_vault_metadata().expect("metadata"), metadata);
        assert!(state.is_unlocked());
        state.lock_session();
        unlock_local_vault(&db, &state, "original-master-password")
            .expect("original password remains valid");
    }

    #[test]
    fn changing_the_master_password_enforces_the_minimum_length_in_rust() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("database");
        let state = LocalVault::new();
        setup_local_vault(&db, &state, "original-master-password").expect("setup");

        assert!(matches!(
            change_local_vault_master_password(&db, &state, "original-master-password", "short"),
            Err(VaultError::InvalidData(_))
        ));
        state.lock_session();
        unlock_local_vault(&db, &state, "original-master-password")
            .expect("original password remains valid");
    }

    #[test]
    fn locked_local_resolver_fails_before_reading_credential_data() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("database");
        let state = LocalVault::new();

        assert!(matches!(
            resolve_host_credential(&db, &state, "host-a", CredentialStorage::LocalVault),
            Err(VaultError::LocalVaultLocked)
        ));
    }

    #[test]
    fn migration_preflight_counts_storage_and_auth_combinations() {
        /* Counts must match the bulk-migration eligibility rule exactly:
         * keychain password hosts are migratable, local-vault hosts are done,
         * and every other keychain auth type must never be offered migration. */
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("database");
        db.save_host(&password_host("keychain-password-a"))
            .expect("save host");
        db.save_host(&password_host("keychain-password-b"))
            .expect("save host");
        db.save_host(&password_host("vault-password"))
            .expect("save host");
        db.set_credential_storage("vault-password", CredentialStorage::LocalVault)
            .expect("mark local vault storage");
        let mut keychain_key_host = password_host("keychain-key");
        keychain_key_host.auth_type = "privateKey".to_string();
        db.save_host(&keychain_key_host).expect("save host");
        let mut keychain_key_data_host = password_host("keychain-key-data");
        keychain_key_data_host.auth_type = "privateKeyData".to_string();
        db.save_host(&keychain_key_data_host).expect("save host");

        let summary = migration_preflight(&db).expect("preflight summary");
        assert_eq!(summary.migratable, 2);
        assert_eq!(summary.already_in_vault, 1);
        assert_eq!(summary.non_migratable, 2);
    }

    #[test]
    fn bulk_migration_requires_an_unlocked_vault() {
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("database");
        let state = LocalVault::new();
        db.save_host(&password_host("locked-vault-candidate"))
            .expect("save host");

        assert!(matches!(
            migrate_all_from_keychain(&db, &state),
            Err(VaultError::LocalVaultLocked)
        ));
    }

    #[test]
    fn bulk_migration_ignores_hosts_outside_the_keychain_password_sweep() {
        /* An unlocked sweep with no eligible hosts must complete without
         * touching the OS keychain: already-vaulted and non-password rows are
         * filtered before any credential lookup would happen. */
        let directory = tempfile::tempdir().expect("tempdir");
        let db = HostDb::new(directory.path()).expect("database");
        let state = LocalVault::new();
        setup_local_vault(&db, &state, "master-password").expect("setup");
        db.save_host(&password_host("already-in-vault"))
            .expect("save host");
        db.set_credential_storage("already-in-vault", CredentialStorage::LocalVault)
            .expect("mark local vault storage");
        let mut keychain_key_host = password_host("keychain-key");
        keychain_key_host.auth_type = "privateKey".to_string();
        db.save_host(&keychain_key_host).expect("save host");

        let result = migrate_all_from_keychain(&db, &state).expect("bulk migration");
        assert_eq!(result.migrated, 0);
        assert_eq!(result.skipped, 0);
        assert!(result.failed.is_empty());
    }
}
