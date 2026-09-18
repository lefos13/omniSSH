/*
 * Where a dataset's secrets live.
 *
 * Two secrets per dataset, both in the OS keychain under a namespaced key:
 *
 *   sync:{dataset_id}:server      SSH password, or the private key's passphrase
 *   sync:{dataset_id}:passphrase  dataset passphrase that unwraps the dataset key
 *
 * The OS keychain rather than the App Vault, deliberately: App Vault records
 * are keyed per host and readable only while the vault is unlocked, but sync
 * has to run on app start (pull-on-start) before the user has had a chance to
 * unlock anything. Namespacing matches the existing `s3:{id}` convention, so
 * backup/restore and factory reset can enumerate sync secrets the same way.
 *
 * Nothing here logs a key's value, and no secret is ever written to SQLite —
 * `sync_datasets` holds only KDF parameters and the wrapped dataset key.
 */

use crate::vault::{self, StoredCredential, VaultError};

use super::SyncError;

/// Shortest accepted dataset passphrase, matching the App Vault master password
/// floor so the two feel consistent.
pub const MIN_PASSPHRASE_LEN: usize = 12;

/// `app_settings` key holding this installation's stable sync identity.
pub const CLIENT_ID_SETTING: &str = "sync_client_id";

/* Every published generation records which machine wrote it. The transport's
 * per-connection id cannot serve for that — it is fresh on every connect — so
 * the identity is persisted once per installation and reused. It is a random
 * opaque id, never a hostname or a username: the metadata file is plaintext on
 * someone else's server.
 *
 * Deny-listed from `app_settings` sync (`codec::APP_SETTINGS_DENY_LIST`), or
 * every machine sharing a dataset would inherit the same identity and "another
 * computer published this" would be undetectable.
 */
pub fn client_id(db: &crate::db::HostDb) -> Result<String, SyncError> {
    if let Some(existing) = db.get_setting(CLIENT_ID_SETTING)? {
        if !existing.trim().is_empty() {
            return Ok(existing);
        }
    }
    let fresh = uuid::Uuid::new_v4().to_string();
    db.save_setting(CLIENT_ID_SETTING, &fresh)?;
    Ok(fresh)
}

pub fn server_secret_key(dataset_id: &str) -> String {
    format!("sync:{dataset_id}:server")
}

pub fn passphrase_key(dataset_id: &str) -> String {
    format!("sync:{dataset_id}:passphrase")
}

/// Every keychain key a dataset owns. Used when a dataset is removed and by the
/// backup / factory-reset sweeps.
pub fn dataset_secret_keys(dataset_id: &str) -> [String; 2] {
    [server_secret_key(dataset_id), passphrase_key(dataset_id)]
}

pub fn validate_passphrase(passphrase: &str) -> Result<(), SyncError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_LEN {
        return Err(SyncError::Crypto(format!(
            "the dataset passphrase must be at least {MIN_PASSPHRASE_LEN} characters"
        )));
    }
    Ok(())
}

pub fn save_server_secret(
    dataset_id: &str,
    credential: &StoredCredential,
) -> Result<(), SyncError> {
    vault::save_credential(&server_secret_key(dataset_id), credential)?;
    Ok(())
}

/// The stored server secret. `NotFound` means the dataset was saved on another
/// machine (restored from a backup) and needs its secret re-entered.
pub fn load_server_secret(dataset_id: &str) -> Result<StoredCredential, SyncError> {
    match vault::get_credential(&server_secret_key(dataset_id)) {
        Ok(credential) => Ok(credential),
        Err(VaultError::NotFound(_)) => Err(SyncError::NotFound(
            "this dataset has no stored server credential on this machine — re-enter it in Settings"
                .into(),
        )),
        Err(error) => Err(error.into()),
    }
}

pub fn save_passphrase(dataset_id: &str, passphrase: &str) -> Result<(), SyncError> {
    validate_passphrase(passphrase)?;
    vault::save_credential(
        &passphrase_key(dataset_id),
        &StoredCredential::Password {
            password: passphrase.to_string(),
        },
    )?;
    Ok(())
}

pub fn load_passphrase(dataset_id: &str) -> Result<String, SyncError> {
    match vault::get_credential(&passphrase_key(dataset_id)) {
        Ok(StoredCredential::Password { ref password }) => Ok(password.clone()),
        Ok(other) => Err(SyncError::Vault(format!(
            "the stored dataset passphrase has an unexpected form ({other:?})"
        ))),
        Err(VaultError::NotFound(_)) => Err(SyncError::NotFound(
            "this dataset has no stored passphrase on this machine — re-enter it in Settings"
                .into(),
        )),
        Err(error) => Err(error.into()),
    }
}

pub fn has_server_secret(dataset_id: &str) -> bool {
    vault::has_credential(&server_secret_key(dataset_id))
}

pub fn has_passphrase(dataset_id: &str) -> bool {
    vault::has_credential(&passphrase_key(dataset_id))
}

/// Remove both secrets. A missing entry is success, so removing a dataset twice
/// is not an error.
pub fn delete_dataset_secrets(dataset_id: &str) -> Result<(), SyncError> {
    for key in dataset_secret_keys(dataset_id) {
        vault::delete_credential(&key)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_namespaced_per_dataset_and_purpose() {
        assert_eq!(server_secret_key("ds-1"), "sync:ds-1:server");
        assert_eq!(passphrase_key("ds-1"), "sync:ds-1:passphrase");
        assert_eq!(
            dataset_secret_keys("ds-1"),
            [
                "sync:ds-1:server".to_string(),
                "sync:ds-1:passphrase".to_string()
            ]
        );
        // Two datasets never collide, and neither collides with a host id or an
        // `s3:{id}` record.
        assert_ne!(server_secret_key("ds-1"), server_secret_key("ds-2"));
        assert!(server_secret_key("ds-1").starts_with("sync:"));
    }

    #[test]
    fn passphrases_shorter_than_the_floor_are_rejected() {
        assert!(validate_passphrase(&"x".repeat(MIN_PASSPHRASE_LEN)).is_ok());
        let error = validate_passphrase("short").expect_err("must be rejected");
        assert!(error.to_string().contains("at least 12 characters"));
        // Counted in characters, not bytes: a 12-emoji passphrase is fine.
        assert!(validate_passphrase(&"🔐".repeat(MIN_PASSPHRASE_LEN)).is_ok());
        assert!(validate_passphrase(&"🔐".repeat(MIN_PASSPHRASE_LEN - 1)).is_err());
    }
}
