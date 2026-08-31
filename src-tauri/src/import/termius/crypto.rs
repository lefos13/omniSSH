/*
 * The crypto layer authenticates the exact envelope body with the supplied
 * 32-byte local key. A successful empty Vec is deliberately returned as-is;
 * authentication, not plaintext length, determines success.
 */

use crate::import::termius::envelope::{parse, EnvelopeError};
use thiserror::Error;
use xsalsa20poly1305::{aead::Aead, Key, KeyInit, Nonce, XSalsa20Poly1305};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("invalid encrypted data")]
    Envelope(#[from] EnvelopeError),
    #[error("decryption failed")]
    Decryption,
}

pub fn decrypt(key: &[u8; 32], value: &str) -> Result<Vec<u8>, CryptoError> {
    let envelope = parse(value)?.ok_or(CryptoError::Envelope(EnvelopeError::Invalid))?;
    XSalsa20Poly1305::new(Key::from_slice(key))
        .decrypt(
            Nonce::from_slice(&envelope.nonce),
            envelope.ciphertext.as_ref(),
        )
        .map_err(|_| CryptoError::Decryption)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::termius::envelope::HEADER;
    use base64::{engine::general_purpose::STANDARD, Engine};

    fn seal(key: &[u8; 32], plaintext: &[u8]) -> String {
        let nonce = [0x09u8; 24];
        let body = XSalsa20Poly1305::new(Key::from_slice(key))
            .encrypt(Nonce::from_slice(&nonce), plaintext)
            .unwrap();
        let mut raw = Vec::from(HEADER);
        raw.extend(nonce);
        raw.extend(body);
        STANDARD.encode(raw)
    }

    #[test]
    fn round_trip() {
        let key = [0x07u8; 32];
        assert_eq!(decrypt(&key, &seal(&key, b"hello")).unwrap(), b"hello");
    }

    #[test]
    fn wrong_key_fails_authentication() {
        let key = [0x07u8; 32];
        assert_eq!(
            decrypt(&[0x08u8; 32], &seal(&key, b"hello")),
            Err(CryptoError::Decryption)
        );
    }

    #[test]
    fn tampering_fails_authentication() {
        let key = [0x07u8; 32];
        let mut raw = STANDARD.decode(seal(&key, b"hello")).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 1;
        assert_eq!(
            decrypt(&key, &STANDARD.encode(raw)),
            Err(CryptoError::Decryption)
        );
    }

    #[test]
    fn empty_plaintext_is_a_valid_result() {
        let key = [0x07u8; 32];
        assert!(decrypt(&key, &seal(&key, b"")).unwrap().is_empty());
    }
}
