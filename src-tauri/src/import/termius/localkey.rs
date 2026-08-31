/*
 * Keychain lookup is intentionally candidate-agnostic across the desktop,
 * App Store, DMG bundle, and Linux Snap service names. Only an authenticated
 * ciphertext validator may select the returned 32-byte key.
 */

use base64::{engine::general_purpose::STANDARD, Engine};
use thiserror::Error;
use zeroize::Zeroize;

const MAX_LOCAL_KEY_BASE64_LEN: usize = 44;
const LOCAL_KEY_CANDIDATES: [(&str, &str); 4] = [
    ("termius-app", "localKey"),
    ("Termius", "localKey"),
    ("Termius (MAS)", "localKey"),
    ("com.termius-dmg.mac", "localKey"),
];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum LocalKeyError {
    #[error("no valid Termius local key was found")]
    NotFound,
}

pub fn decode_local_key(value: &str) -> Result<[u8; 32], LocalKeyError> {
    let value = value.trim();
    if value.len() > MAX_LOCAL_KEY_BASE64_LEN {
        return Err(LocalKeyError::NotFound);
    }
    /* Decode into a temporary only long enough to validate its exact size and
     * copy the key into the fixed-size return value. The heap buffer is then
     * cleared on both valid and invalid length paths. */
    let mut bytes = STANDARD
        .decode(value)
        .map_err(|_| LocalKeyError::NotFound)?;
    if bytes.len() != 32 {
        bytes.zeroize();
        return Err(LocalKeyError::NotFound);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    bytes.zeroize();
    Ok(key)
}

pub fn find_local_key(validate: impl Fn(&[u8; 32]) -> bool) -> Result<[u8; 32], LocalKeyError> {
    for (service, account) in LOCAL_KEY_CANDIDATES {
        let Ok(entry) = keyring::Entry::new(service, account) else {
            continue;
        };
        let Ok(mut encoded) = entry.get_password() else {
            continue;
        };
        /* Keychain strings and rejected candidate keys are short-lived secret
         * buffers; clear them before trying the next candidate or returning. */
        let decoded = decode_local_key(&encoded);
        encoded.zeroize();
        let Ok(mut key) = decoded else {
            continue;
        };
        if validate(&key) {
            return Ok(key);
        }
        key.zeroize();
    }
    Err(LocalKeyError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::termius::crypto::decrypt;
    use crate::import::termius::envelope::HEADER;
    use keyring::credential::{
        Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
    };
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex, Once};
    use xsalsa20poly1305::{
        aead::{Aead, KeyInit},
        Key, Nonce, XSalsa20Poly1305,
    };

    type MockStore = HashMap<(String, String), Vec<u8>>;
    static MOCK_STORE: LazyLock<Mutex<MockStore>> = LazyLock::new(|| Mutex::new(HashMap::new()));
    static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    #[derive(Debug)]
    struct MemCredential {
        key: (String, String),
    }

    impl CredentialApi for MemCredential {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            MOCK_STORE
                .lock()
                .unwrap()
                .insert(self.key.clone(), secret.to_vec());
            Ok(())
        }

        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            MOCK_STORE
                .lock()
                .unwrap()
                .get(&self.key)
                .cloned()
                .ok_or(keyring::Error::NoEntry)
        }

        fn delete_credential(&self) -> keyring::Result<()> {
            MOCK_STORE.lock().unwrap().remove(&self.key);
            Ok(())
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    #[derive(Debug)]
    struct MemBuilder;

    impl CredentialBuilderApi for MemBuilder {
        fn build(
            &self,
            _: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<Credential>> {
            Ok(Box::new(MemCredential {
                key: (service.to_owned(), user.to_owned()),
            }))
        }

        fn as_any(&self) -> &dyn std::any::Any {
            self
        }

        fn persistence(&self) -> CredentialPersistence {
            CredentialPersistence::UntilDelete
        }
    }

    fn init_mock_keystore() {
        static ONCE: Once = Once::new();
        ONCE.call_once(|| keyring::set_default_credential_builder(Box::new(MemBuilder)));
    }

    fn clear_candidates() {
        for &(service, account) in &LOCAL_KEY_CANDIDATES {
            if let Ok(entry) = keyring::Entry::new(service, account) {
                let _ = entry.delete_credential();
            }
        }
    }

    fn envelope_for(key: &[u8; 32], plaintext: &[u8]) -> String {
        let nonce = [0x44u8; 24];
        let body = XSalsa20Poly1305::new(Key::from_slice(key))
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .unwrap();
        let mut raw = Vec::from(HEADER);
        raw.extend(nonce);
        raw.extend(body);
        STANDARD.encode(raw)
    }

    #[test]
    fn local_key_requires_exactly_32_decoded_bytes() {
        let key = [0x33u8; 32];
        assert_eq!(decode_local_key(&STANDARD.encode(key)), Ok(key));
        assert_eq!(
            decode_local_key(&STANDARD.encode([0u8; 31])),
            Err(LocalKeyError::NotFound)
        );
        assert_eq!(decode_local_key("not base64"), Err(LocalKeyError::NotFound));
    }

    #[test]
    fn validator_selects_authenticated_mas_candidate_over_decoy() {
        let _serial = TEST_LOCK.lock().unwrap();
        init_mock_keystore();
        clear_candidates();
        let decoy = [0x11u8; 32];
        let valid = [0x22u8; 32];
        keyring::Entry::new("Termius", "localKey")
            .unwrap()
            .set_password(&STANDARD.encode(decoy))
            .unwrap();
        keyring::Entry::new("Termius (MAS)", "localKey")
            .unwrap()
            .set_password(&STANDARD.encode(valid))
            .unwrap();

        let ciphertext = envelope_for(&valid, b"synthetic validation");
        assert_eq!(
            find_local_key(|candidate| decrypt(candidate, &ciphertext).is_ok()),
            Ok(valid)
        );
        clear_candidates();
    }

    #[test]
    fn known_keychain_candidates_have_deterministic_service_account_order() {
        assert_eq!(
            LOCAL_KEY_CANDIDATES,
            [
                ("termius-app", "localKey"),
                ("Termius", "localKey"),
                ("Termius (MAS)", "localKey"),
                ("com.termius-dmg.mac", "localKey"),
            ]
        );
    }

    #[test]
    fn validator_rejects_decoys_and_reaches_every_known_service() {
        let _serial = TEST_LOCK.lock().unwrap();
        init_mock_keystore();
        clear_candidates();
        let valid = [0x77u8; 32];
        let ciphertext = envelope_for(&valid, b"synthetic validation");

        for (index, &(service, account)) in LOCAL_KEY_CANDIDATES.iter().enumerate() {
            let key = if index + 1 == LOCAL_KEY_CANDIDATES.len() {
                valid
            } else {
                [u8::try_from(index + 1).unwrap(); 32]
            };
            keyring::Entry::new(service, account)
                .unwrap()
                .set_password(&STANDARD.encode(key))
                .unwrap();
        }

        assert_eq!(
            find_local_key(|candidate| decrypt(candidate, &ciphertext).is_ok()),
            Ok(valid)
        );
        clear_candidates();
    }
}
