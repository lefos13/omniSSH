//! Offline Termius local-data reader foundation.
//!
//! The later import workflow can resolve a candidate data directory, probe
//! its LevelDB lock, read raw IndexedDB rows, decode their V8 values, locate a
//! keychain local key by authenticated validation, and decrypt individual
//! fields. This module intentionally contains no Tauri commands or commit
//! policy; it only exposes the trusted source primitives.

/*
 * These modules are intentionally exposed as a dormant crate-internal API
 * until a later stream adds the import commands. The parent import module is
 * private today, so each child needs only this narrow dead-code allowance;
 * no module-wide warning suppression is used.
 */
#[allow(dead_code)]
pub mod comparator;
#[allow(dead_code)]
pub mod crypto;
#[allow(dead_code)]
pub mod datadir;
#[allow(dead_code)]
pub mod envelope;
#[allow(dead_code)]
pub mod localkey;
#[allow(dead_code)]
pub mod running;
#[allow(dead_code)]
pub mod source;
#[allow(dead_code)]
pub mod v8;

#[allow(unused_imports)]
pub use comparator::{IdbComparator, IDB_COMPARATOR_NAME};
#[allow(unused_imports)]
pub use crypto::{decrypt, CryptoError};
#[allow(unused_imports)]
pub use datadir::{candidate_dirs, resolve, DataDir, LEVELDB_RELATIVE};
#[allow(unused_imports)]
pub use envelope::{
    decode_candidate, first_encrypted_field, parse, Envelope, EnvelopeError, HEADER,
    MAX_ENVELOPE_BASE64_LEN, MAX_ENVELOPE_LEN, MIN_ENVELOPE_LEN, NONCE_LEN, TAG_LEN,
};
#[allow(unused_imports)]
pub use localkey::{decode_local_key, find_local_key, LocalKeyError};
#[allow(unused_imports)]
pub use running::{check, RunningError};
#[allow(unused_imports)]
pub use source::{
    decode_idb_key, decode_record_value, decode_varint, is_leveldb_path, read_leveldb, read_rows,
    read_source, IdbKey, RawKeyValue, Row, SourceError, SourceRows, MAX_RAW_BYTES, MAX_RAW_ROWS,
    WANTED_DATABASES,
};
#[allow(unused_imports)]
pub use v8::{decode, string_field, V8Error, Value};
