/*
 * Owner signing for dataset metadata (Task 9, AD-8): pure-Rust ed25519, no OS
 * deps, a few hundred KB (ed25519-dalek v2).
 *
 * The owner holds a keypair whose 32-byte seed lives in the credential store
 * (`sync:{datasetId}:signing`, see `sync::secrets`); every owner push carries
 * a detached signature over `DatasetMeta::signing_preimage()`, and pulls
 * verify it against the fingerprint pinned on the local row at join time.
 * Single-user unsigned datasets keep working: no pin plus no signature is a
 * pass, and pinning happens on the first pull that carries one.
 *
 * Nothing here touches the network, the database, or the credential store —
 * key persistence is `secrets`, verification policy is `pull`, so the whole
 * module is unit-testable over bytes.
 */

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::meta::DatasetMeta;
use super::SyncError;

/// Length of an ed25519 seed, public key, and signature on the wire.
pub const SEED_LEN: usize = 32;
const SIGNATURE_LEN: usize = 64;

/// Fresh keypair from the OS CSPRNG. The seed is returned zeroizing; the
/// caller persists it through `secrets` and never logs it.
pub fn generate_keypair() -> Result<(Zeroizing<[u8; SEED_LEN]>, VerifyingKey), SyncError> {
    let mut seed = Zeroizing::new([0u8; SEED_LEN]);
    getrandom::getrandom(seed.as_mut_slice()).map_err(|e| SyncError::Crypto(e.to_string()))?;
    let signing = signing_key_from_seed(seed.as_slice())?;
    let verifying = signing.verifying_key();
    Ok((seed, verifying))
}

/// Rebuild a signing key from its stored seed. A wrong length is a corrupt
/// credential, not a missing one.
pub fn signing_key_from_seed(seed: &[u8]) -> Result<SigningKey, SyncError> {
    let bytes: [u8; SEED_LEN] = seed
        .try_into()
        .map_err(|_| SyncError::Crypto("the stored owner signing key is corrupt".into()))?;
    Ok(SigningKey::from_bytes(&bytes))
}
/// Lowercase hex SHA-256 of the 32-byte public key. This is what the meta file
/// and the local row pin as `ownerFingerprint`.
pub fn fingerprint(verifying: &VerifyingKey) -> String {
    hex_of(&Sha256::digest(verifying.as_bytes()))
}

/// The 32-byte public key as base64, for the plaintext `ownerPubkey` metadata
/// field members verify against.
pub fn public_key_b64(signing: &SigningKey) -> String {
    BASE64.encode(signing.verifying_key().as_bytes())
}

/// Sign `meta`, returning the fingerprint to publish beside the base64
/// signature. The preimage covers identity, generation, digest, and timestamp
/// — never the signature itself, and never the key wrap, so a passphrase
/// rotation does not invalidate the signature over the payload.
pub fn sign(meta: &DatasetMeta, signing: &SigningKey) -> Result<(String, String), SyncError> {
    let fingerprint = fingerprint(&signing.verifying_key());
    let signature = BASE64.encode(signing.sign(&meta.signing_preimage()).to_bytes());
    Ok((fingerprint, signature))
}

pub fn verify(meta: &DatasetMeta, pinned_fingerprint: &str) -> Result<(), SyncError> {
    let mismatch = || {
        SyncError::Crypto(
            "this dataset was signed by a different owner — it may have been replaced on the server; \
             nothing was applied, ask the dataset owner to publish again"
                .into(),
        )
    };
    /* The reported fingerprint must name the pinned key: a bundle that names
     * another key is foreign even when its own signature checks out. */
    let Some(reported) = meta.owner_fingerprint.as_deref() else {
        return Err(mismatch());
    };
    if !constant_time_eq(reported.as_bytes(), pinned_fingerprint.as_bytes()) {
        return Err(mismatch());
    }
    /* The published public key must hash to the pinned fingerprint — a
     * fingerprint alone cannot verify an ed25519 signature, so the key
     * travels in the plaintext metadata and is bound to the pin here. */
    let Some(pubkey) = meta.owner_pubkey.as_deref() else {
        return Err(mismatch());
    };
    let raw_key = BASE64.decode(pubkey.as_bytes()).map_err(|_| mismatch())?;
    let key_bytes: [u8; SEED_LEN] = raw_key.as_slice().try_into().map_err(|_| mismatch())?;
    if fingerprint(&VerifyingKey::from_bytes(&key_bytes).map_err(|_| mismatch())?) != reported {
        return Err(mismatch());
    }
    let Some(signature) = meta.signature.as_deref() else {
        return Err(mismatch());
    };
    let raw = BASE64
        .decode(signature.as_bytes())
        .map_err(|_| mismatch())?;
    let bytes: [u8; SIGNATURE_LEN] = raw.as_slice().try_into().map_err(|_| mismatch())?;
    let verifying = VerifyingKey::from_bytes(&key_bytes).map_err(|_| mismatch())?;
    verifying
        .verify(&meta.signing_preimage(), &Signature::from_bytes(&bytes))
        .map_err(|_| mismatch())
}

/// Verify-then-pin policy for one pulled bundle. A pinned row enforces its
/// pin; an unpinned row pins the bundle's fingerprint when the bundle is
/// signed and valid, and passes unsigned bundles through untouched. Returns
/// the fingerprint the row should store afterwards (`None` pins nothing).
pub fn verify_for_pull(
    pinned: Option<&str>,
    meta: &DatasetMeta,
) -> Result<Option<String>, SyncError> {
    match pinned {
        Some(pinned) => {
            verify(meta, pinned)?;
            Ok(Some(pinned.to_string()))
        }
        None => match meta.owner_fingerprint.as_deref() {
            None => Ok(None),
            Some(reported) => {
                /* Signed by someone: the signature must check out against the
                 * key it names before that key becomes this row's pin, or a
                 * garbage fingerprint would be pinned on first pull. */
                verify(meta, reported)?;
                Ok(Some(reported.to_string()))
            }
        },
    }
}

fn hex_of(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

/* Length-first comparison over the fingerprint bytes: fingerprints are not
 * secret, but there is no reason to order-depend the check. */
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::codec::{generate_dataset_key, rewrap_dataset_key, unwrap_dataset_key};

    const PASSPHRASE: &str = "correct horse battery staple";
    const ROTATED: &str = "a completely different passphrase 123";

    fn meta() -> DatasetMeta {
        DatasetMeta {
            format_version: 1,
            dataset_id: "ds-nova".into(),
            generation: 3,
            payload_sha256: "a".repeat(64),
            key_wrap: crate::sync::codec::wrap_dataset_key(
                PASSPHRASE,
                &generate_dataset_key().unwrap(),
            )
            .unwrap(),
            updated_at: "2026-09-18T10:00:00Z".into(),
            writer_client_id: "client-1".into(),
            owner_fingerprint: None,
            owner_pubkey: None,
            signature: None,
        }
    }

    fn signed_meta() -> (DatasetMeta, SigningKey, String) {
        let (seed, _) = generate_keypair().unwrap();
        let signing = signing_key_from_seed(seed.as_slice()).unwrap();
        let mut meta = meta();
        let (fingerprint, signature) = sign(&meta, &signing).unwrap();
        meta.owner_fingerprint = Some(fingerprint.clone());
        meta.owner_pubkey = Some(public_key_b64(&signing));
        meta.signature = Some(signature);
        (meta, signing, fingerprint)
    }

    #[test]
    fn a_signed_generation_verifies_against_its_fingerprint() {
        let (meta, _, fingerprint) = signed_meta();
        verify(&meta, &fingerprint).expect("valid signature verifies");
        assert_eq!(fingerprint.len(), 64, "hex SHA-256 of the public key");
        assert!(fingerprint.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            fingerprint,
            fingerprint.to_lowercase(),
            "fingerprints are lowercase hex"
        );
    }

    #[test]
    fn a_tampered_digest_is_rejected() {
        let (mut meta, _, fingerprint) = signed_meta();
        meta.payload_sha256 = "b".repeat(64);
        let error = verify(&meta, &fingerprint).expect_err("tampered digest must fail");
        assert!(error.to_string().contains("signed by a different owner"));
    }

    #[test]
    fn a_foreign_key_is_rejected() {
        let (meta, _, _) = signed_meta();
        let (_, foreign) = generate_keypair().unwrap();
        let foreign_fingerprint = fingerprint(&foreign);
        let error = verify(&meta, &foreign_fingerprint).expect_err("foreign key must fail");
        assert!(error.to_string().contains("signed by a different owner"));
    }

    #[test]
    fn a_missing_signature_on_a_pinned_dataset_is_rejected() {
        let (mut meta, _, fingerprint) = signed_meta();
        meta.signature = None;
        let error = verify(&meta, &fingerprint).expect_err("missing signature must fail");
        assert!(error.to_string().contains("signed by a different owner"));

        meta.owner_fingerprint = None;
        let error = verify(&meta, &fingerprint).expect_err("missing fingerprint must fail");
        assert!(error.to_string().contains("signed by a different owner"));
    }

    #[test]
    fn an_unpinned_row_pins_the_first_valid_signature_and_passes_unsigned_through() {
        let (signed, _, fingerprint) = signed_meta();
        assert_eq!(
            verify_for_pull(None, &signed).unwrap(),
            Some(fingerprint),
            "first signed pull pins the fingerprint"
        );
        assert_eq!(
            verify_for_pull(None, &meta()).unwrap(),
            None,
            "unsigned datasets pin nothing"
        );
        let error = verify_for_pull(Some("0".repeat(64).as_str()), &signed)
            .expect_err("pinned row rejects foreign bundles");
        assert!(error.to_string().contains("signed by a different owner"));
    }

    #[test]
    fn a_pubkey_that_does_not_match_the_pin_is_rejected() {
        /* An attacker bundle: valid signature under the attacker's key, with
         * the attacker's key published beside it — but the row pinned the
         * owner's fingerprint, so the key-to-pin binding fails first. */
        let (owner_meta, _, owner_fingerprint) = signed_meta();
        let (attacker_seed, _) = generate_keypair().unwrap();
        let attacker = signing_key_from_seed(attacker_seed.as_slice()).unwrap();
        let mut forged = meta();
        forged.generation = owner_meta.generation;
        let (_, signature) = sign(&forged, &attacker).unwrap();
        forged.owner_fingerprint = Some(owner_fingerprint.clone());
        forged.owner_pubkey = Some(public_key_b64(&attacker));
        forged.signature = Some(signature);
        let error =
            verify(&forged, &owner_fingerprint).expect_err("a key outside the pin must fail");
        assert!(error.to_string().contains("signed by a different owner"));
    }

    #[test]
    fn rotation_keeps_the_new_passphrase_readable_and_the_old_failing() {
        let (mut meta, signing, _fingerprint) = signed_meta();
        let rotated = rewrap_dataset_key(PASSPHRASE, ROTATED, &meta.key_wrap).unwrap();
        meta.key_wrap = rotated;
        meta.generation += 1;
        /* Rotation publishes a new generation, so the owner re-signs the new
         * preimage; the payload — and its digest — are untouched. */
        let (fingerprint, signature) = sign(&meta, &signing).unwrap();
        meta.owner_fingerprint = Some(fingerprint.clone());
        meta.owner_pubkey = Some(public_key_b64(&signing));
        meta.signature = Some(signature);

        unwrap_dataset_key(ROTATED, &meta.key_wrap).expect("new passphrase opens the wrap");
        assert!(
            matches!(
                unwrap_dataset_key(PASSPHRASE, &meta.key_wrap),
                Err(SyncError::Decrypt)
            ),
            "the old passphrase must hit the wrong-passphrase path"
        );
        verify(&meta, &fingerprint).expect("re-signed rotation verifies");
    }
}
