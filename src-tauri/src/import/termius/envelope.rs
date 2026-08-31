/*
 * Termius marks encrypted fields with a binary version header inside a
 * base64 envelope. Structural validation happens here so callers never
 * select a key by attempting to decrypt an arbitrary plaintext field.
 */

use base64::{engine::general_purpose::STANDARD, Engine};
use thiserror::Error;

pub const HEADER: [u8; 2] = [0x04, 0x01];
pub const NONCE_LEN: usize = 24;
pub const TAG_LEN: usize = 16;
pub const MIN_ENVELOPE_LEN: usize = HEADER.len() + NONCE_LEN + TAG_LEN;
pub const MAX_ENVELOPE_LEN: usize = 16 * 1024 * 1024;
pub const MAX_ENVELOPE_BASE64_LEN: usize = MAX_ENVELOPE_LEN.div_ceil(3) * 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EnvelopeError {
    #[error("unknown Termius cipher header {header:02x?}")]
    UnknownHeader { header: [u8; 2] },
    #[error("invalid Termius encrypted field envelope")]
    Invalid,
    #[error("Termius encrypted field envelope exceeds the size limit")]
    Oversize,
}

/// Decode only base64 strings large enough to contain a secretbox envelope.
///
/// Short or non-base64 strings are ordinary plaintext fields. A structurally
/// complete envelope with an unfamiliar header is returned for strict failure
/// by [`parse`], rather than being silently treated as plaintext.
pub fn decode_candidate(value: &str) -> Option<Vec<u8>> {
    if value.len() < MIN_ENVELOPE_LEN.div_ceil(3) * 4 || value.len() > MAX_ENVELOPE_BASE64_LEN {
        return None;
    }

    let raw = STANDARD.decode(value).ok()?;
    (raw.len() >= MIN_ENVELOPE_LEN && raw.len() <= MAX_ENVELOPE_LEN).then_some(raw)
}

pub fn parse(value: &str) -> Result<Option<Envelope>, EnvelopeError> {
    if value.len() > MAX_ENVELOPE_BASE64_LEN && has_base64_shape(value) {
        return Err(EnvelopeError::Oversize);
    }
    let Some(raw) = decode_candidate(value) else {
        return Ok(None);
    };

    let header = [raw[0], raw[1]];
    if header != HEADER {
        return Err(EnvelopeError::UnknownHeader { header });
    }

    let mut nonce = [0; NONCE_LEN];
    nonce.copy_from_slice(&raw[HEADER.len()..HEADER.len() + NONCE_LEN]);
    Ok(Some(Envelope {
        nonce,
        ciphertext: raw[HEADER.len() + NONCE_LEN..].to_vec(),
    }))
}

fn has_base64_shape(value: &str) -> bool {
    value.len().is_multiple_of(4)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

/// Return the first nested field whose decoded bytes carry the known header.
///
/// The result is the original base64 text, not decrypted content. Traversal
/// is deterministic for arrays and JSON objects, and unfamiliar complete
/// envelopes are propagated to keep format changes visible to callers.
pub fn first_encrypted_field(record: &serde_json::Value) -> Result<Option<&str>, EnvelopeError> {
    match record {
        serde_json::Value::String(value) => {
            parse(value).map(|parsed| parsed.map(|_| value.as_str()))
        }
        serde_json::Value::Array(values) => {
            for value in values {
                if let Some(found) = first_encrypted_field(value)? {
                    return Ok(Some(found));
                }
            }
            Ok(None)
        }
        serde_json::Value::Object(values) => {
            for value in values.values() {
                if let Some(found) = first_encrypted_field(value)? {
                    return Ok(Some(found));
                }
            }
            Ok(None)
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn encoded(raw: &[u8]) -> String {
        STANDARD.encode(raw)
    }

    fn valid_envelope() -> String {
        let mut raw = Vec::from(HEADER);
        raw.extend([0xabu8; NONCE_LEN]);
        raw.extend([0xcdu8; TAG_LEN]);
        encoded(&raw)
    }

    #[test]
    fn detects_only_a_structurally_complete_known_header() {
        let encrypted = valid_envelope();
        assert!(parse(&encrypted).unwrap().is_some());
        assert_eq!(parse("not base64").unwrap(), None);
        assert_eq!(parse(&encoded(&[HEADER[0], HEADER[1]])).unwrap(), None);
    }

    #[test]
    fn reports_unknown_header_instead_of_skipping_it() {
        let mut raw = vec![0x04, 0x02];
        raw.extend([0u8; NONCE_LEN + TAG_LEN]);
        assert_eq!(
            parse(&encoded(&raw)),
            Err(EnvelopeError::UnknownHeader {
                header: [0x04, 0x02]
            })
        );
    }

    #[test]
    fn extracts_nonce_and_ciphertext_and_finds_real_encrypted_field() {
        let encrypted = valid_envelope();
        let parsed = parse(&encrypted).unwrap().unwrap();
        assert_eq!(parsed.nonce, [0xabu8; NONCE_LEN]);
        assert_eq!(parsed.ciphertext, vec![0xcdu8; TAG_LEN]);

        let plaintext_decoy = encoded(&[0x11u8; TAG_LEN]);
        let record = json!({
            "display_name": plaintext_decoy,
            "nested": ["ordinary text", encrypted]
        });
        assert_eq!(
            first_encrypted_field(&record).unwrap(),
            Some(encrypted.as_str())
        );
    }

    #[test]
    fn rejects_oversize_base64_before_decoding() {
        let value = "A".repeat(MAX_ENVELOPE_BASE64_LEN + 4);
        assert_eq!(decode_candidate(&value), None);
        assert_eq!(parse(&value), Err(EnvelopeError::Oversize));
    }
}
