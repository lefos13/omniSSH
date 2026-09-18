/*
 * The dataset's plaintext metadata file (`dataset.meta.json`).
 *
 * Everything a client needs *before* it can decrypt: which dataset this is,
 * which generation is published, the digest of the sealed bundle, and the
 * passphrase-wrapped dataset key. It deliberately contains no secret — the
 * wrap is useless without the passphrase — so an operator can inspect the file
 * over plain `sftp` and see nothing about the hosts inside.
 *
 * `generation` plus `payloadSha256` are the optimistic-concurrency token: a
 * push states the generation it based itself on, and a mismatch means another
 * client published in between, so the local side must pull and re-merge rather
 * than clobber. `ownerFingerprint`/`signature` are populated by the owner-role
 * signing work and verified by members; they are optional here so a
 * single-user dataset needs no signing key.
 *
 * The same document carries each generation's record counts under
 * `recordCounts` (Task 11), so the rollback UI can say what a retained
 * generation holds without downloading or decrypting it. They sit outside
 * `DatasetMeta` — and therefore outside the signed preimage — deliberately:
 * counts are advisory display data, a reader that predates the key ignores it,
 * and an older signature stays valid over the fields it does cover.
 */

use serde::{Deserialize, Serialize};

use super::codec::KeyWrap;
use super::SyncError;

/// Metadata format written by this build. Bumped independently of the payload
/// format because a reader must parse metadata before it can read a payload.
pub const META_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetMeta {
    pub format_version: u32,
    pub dataset_id: String,
    /// Monotonic publish counter. Starts at 1 for the first published bundle.
    pub generation: u64,
    /// Lowercase hex SHA-256 of `dataset.bin` as published.
    pub payload_sha256: String,
    pub key_wrap: KeyWrap,
    /// ISO-8601 timestamp of the publish.
    pub updated_at: String,
    /// Opaque id of the client that published this generation, for support and
    /// for attributing a stale lock.
    pub writer_client_id: String,
    /// Owner's ed25519 public-key fingerprint, when the dataset is signed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_fingerprint: Option<String>,
    /* The 32-byte owner public key (base64) the signature below was made
     * with. Members verify against it after checking it hashes to the pinned
     * fingerprint: a fingerprint alone cannot verify an ed25519 signature, so
     * the key must travel in the plaintext metadata beside it. Optional like
     * the other signing fields, so unsigned datasets serialize exactly as
     * before. */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_pubkey: Option<String>,
    /// base64 ed25519 signature over the signing preimage below.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// What one published generation carried, per content kind.
///
/// Every field is serde-defaulted, so a generation published before this
/// information existed parses as zeroes rather than failing — and so does a
/// document written by a build that adds a kind this one does not know.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetRecordCounts {
    #[serde(default)]
    pub hosts: usize,
    #[serde(default)]
    pub groups: usize,
    #[serde(default)]
    pub snippets: usize,
    #[serde(default)]
    pub snippet_folders: usize,
    #[serde(default)]
    pub port_forwards: usize,
    #[serde(default)]
    pub s3_connections: usize,
    #[serde(default)]
    pub host_plugins: usize,
    #[serde(default)]
    pub app_settings: bool,
    /// Deletions the generation published.
    #[serde(default)]
    pub tombstones: usize,
    /* Hosts that left the dataset's scope with this generation. Reported apart
     * from a deletion because the two mean opposite things. */
    #[serde(default)]
    pub scope_removals: usize,
    #[serde(default)]
    pub credentials_included: usize,
}

/// The metadata file as written: the typed fields plus the advisory counts.
#[derive(Serialize)]
struct MetaDocument<'a> {
    #[serde(flatten)]
    meta: &'a DatasetMeta,
    #[serde(rename = "recordCounts", skip_serializing_if = "Option::is_none")]
    record_counts: Option<&'a DatasetRecordCounts>,
}

/// Reads only the counts out of a metadata document, ignoring every other key —
/// which is also how a reader of an older or newer build reads this file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CountsDocument {
    #[serde(default)]
    record_counts: Option<DatasetRecordCounts>,
}

impl DatasetMeta {
    /// Parse untrusted metadata bytes.
    pub fn parse(bytes: &[u8]) -> Result<Self, SyncError> {
        let meta: Self = serde_json::from_slice(bytes)
            .map_err(|e| SyncError::Format(format!("dataset metadata is not readable: {e}")))?;
        if meta.format_version > META_FORMAT_VERSION {
            return Err(SyncError::Version(format!(
                "this dataset's metadata was written by a newer version of OmniSSH (format {} > {META_FORMAT_VERSION}); update OmniSSH first",
                meta.format_version
            )));
        }
        if meta.dataset_id.trim().is_empty() {
            return Err(SyncError::Format("dataset metadata has no id".into()));
        }
        Ok(meta)
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, SyncError> {
        serde_json::to_vec_pretty(self).map_err(|e| SyncError::Serialization(e.to_string()))
    }

    /// The same document with this generation's record counts beside the typed
    /// fields, which is what a publisher writes and a reader of history reads.
    pub fn to_bytes_with_counts(
        &self,
        counts: Option<&DatasetRecordCounts>,
    ) -> Result<Vec<u8>, SyncError> {
        serde_json::to_vec_pretty(&MetaDocument {
            meta: self,
            record_counts: counts,
        })
        .map_err(|e| SyncError::Serialization(e.to_string()))
    }

    /* The signed preimage covers exactly the fields that make a published
     * generation what it is: dataset identity, its position in the chain, the
     * bundle bytes (by digest), and when it was published. It excludes the
     * signature and fingerprint themselves, and excludes the key wrap so a
     * passphrase rotation does not invalidate a signature over the payload. */
    pub fn signing_preimage(&self) -> Vec<u8> {
        format!(
            "omniSSH/sync/meta/v1\n{}\n{}\n{}\n{}\n{}",
            self.format_version,
            self.dataset_id,
            self.generation,
            self.payload_sha256,
            self.updated_at
        )
        .into_bytes()
    }
}

/// The record counts carried in a metadata document, when it has any.
///
/// Used on the live `dataset.meta.json` and on the `history/<generation>.meta.json`
/// copies alike: both are the same document, and neither needs a passphrase to
/// read.
pub fn record_counts_in(bytes: &[u8]) -> Option<DatasetRecordCounts> {
    serde_json::from_slice::<CountsDocument>(bytes)
        .ok()
        .and_then(|document| document.record_counts)
}

/// What the UI shows about a dataset already published at a probed path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingDataset {
    pub dataset_id: String,
    pub generation: u64,
    pub updated_at: String,
    /// Whether the publisher signed this generation (owner-role datasets do).
    pub signed: bool,
    pub owner_fingerprint: Option<String>,
}

impl From<&DatasetMeta> for ExistingDataset {
    fn from(meta: &DatasetMeta) -> Self {
        Self {
            dataset_id: meta.dataset_id.clone(),
            generation: meta.generation,
            updated_at: meta.updated_at.clone(),
            signed: meta.signature.is_some(),
            owner_fingerprint: meta.owner_fingerprint.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::codec::{generate_dataset_key, wrap_dataset_key};

    fn meta() -> DatasetMeta {
        let key = generate_dataset_key().unwrap();
        DatasetMeta {
            format_version: META_FORMAT_VERSION,
            dataset_id: "ds-nova".into(),
            generation: 4,
            payload_sha256: "a".repeat(64),
            key_wrap: wrap_dataset_key("dataset-passphrase", &key).unwrap(),
            updated_at: "2026-09-18T10:00:00Z".into(),
            writer_client_id: "client-7".into(),
            owner_fingerprint: None,
            owner_pubkey: None,
            signature: None,
        }
    }

    #[test]
    fn round_trips_as_camel_case_json() {
        let original = meta();
        let bytes = original.to_bytes().unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();

        assert!(text.contains("\"datasetId\": \"ds-nova\""));
        assert!(text.contains("\"payloadSha256\""));
        assert!(text.contains("\"wrappedKey\""));
        // Optional signing fields stay absent for an unsigned dataset.
        assert!(!text.contains("signature"));
        assert!(!text.contains("ownerFingerprint"));

        assert_eq!(DatasetMeta::parse(&bytes).unwrap(), original);
    }

    /* Record counts travel in the same document without joining the typed
     * metadata: a reader parses the file as before, and the counts are
     * readable on their own for the history listing. */
    #[test]
    fn record_counts_ride_beside_the_typed_metadata() {
        let original = meta();
        let counts = DatasetRecordCounts {
            hosts: 12,
            groups: 4,
            snippets: 7,
            tombstones: 2,
            credentials_included: 3,
            ..DatasetRecordCounts::default()
        };
        let bytes = original.to_bytes_with_counts(Some(&counts)).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        assert!(text.contains("\"recordCounts\""));
        assert!(text.contains("\"hosts\": 12"));

        assert_eq!(DatasetMeta::parse(&bytes).unwrap(), original);
        assert_eq!(record_counts_in(&bytes), Some(counts));

        // A file written without counts stays a valid document, and reads back
        // as "no counts" rather than failing the listing.
        let bare = original.to_bytes().unwrap();
        assert!(!String::from_utf8(bare.clone())
            .unwrap()
            .contains("recordCounts"));
        assert!(DatasetMeta::parse(&bare).is_ok());
        assert_eq!(record_counts_in(&bare), None);
    }

    /* A counts object written by another build may carry kinds this one does
     * not know, or omit kinds it does; neither may fail the listing. */
    #[test]
    fn counts_tolerate_a_document_written_by_another_build() {
        let document = br#"{
            "formatVersion": 1,
            "datasetId": "ds-nova",
            "generation": 2,
            "recordCounts": { "hosts": 5, "unknownKind": 9 }
        }"#;
        let counts = record_counts_in(document).expect("counts are readable");
        assert_eq!(counts.hosts, 5);
        assert_eq!(counts.groups, 0, "a kind this build omits reads as zero");
        assert_eq!(record_counts_in(b"not a metadata document"), None);
    }

    #[test]
    fn rejects_unreadable_newer_and_idless_metadata() {
        assert!(matches!(
            DatasetMeta::parse(b"{not json"),
            Err(SyncError::Format(_))
        ));

        let mut newer = meta();
        newer.format_version = META_FORMAT_VERSION + 1;
        match DatasetMeta::parse(&newer.to_bytes().unwrap()) {
            Err(SyncError::Version(message)) => assert!(message.contains("update OmniSSH first")),
            other => panic!("expected a version error, got {other:?}"),
        }

        let mut idless = meta();
        idless.dataset_id = "   ".into();
        assert!(matches!(
            DatasetMeta::parse(&idless.to_bytes().unwrap()),
            Err(SyncError::Format(_))
        ));
    }

    #[test]
    fn signing_preimage_covers_identity_generation_and_digest_only() {
        let base = meta();
        let preimage = base.signing_preimage();

        let mut other_generation = base.clone();
        other_generation.generation = 5;
        assert_ne!(other_generation.signing_preimage(), preimage);

        let mut other_digest = base.clone();
        other_digest.payload_sha256 = "b".repeat(64);
        assert_ne!(other_digest.signing_preimage(), preimage);

        // Rotating the passphrase rewraps the key but must not invalidate a
        // signature over the published payload.
        let mut rotated = base.clone();
        rotated.key_wrap =
            wrap_dataset_key("new-passphrase", &generate_dataset_key().unwrap()).unwrap();
        assert_eq!(rotated.signing_preimage(), preimage);

        // The signature itself is never part of what it signs.
        let mut signed = base;
        signed.signature = Some("c2lnbmF0dXJl".into());
        assert_eq!(signed.signing_preimage(), preimage);
    }

    #[test]
    fn existing_dataset_summary_reports_signed_state() {
        let mut source = meta();
        let unsigned = ExistingDataset::from(&source);
        assert_eq!(unsigned.dataset_id, "ds-nova");
        assert_eq!(unsigned.generation, 4);
        assert!(!unsigned.signed);

        source.signature = Some("c2ln".into());
        source.owner_fingerprint = Some("SHA256:abc".into());
        let signed = ExistingDataset::from(&source);
        assert!(signed.signed);
        assert_eq!(signed.owner_fingerprint.as_deref(), Some("SHA256:abc"));
    }
}
