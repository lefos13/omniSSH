/*
 * Chromium stores IndexedDB records behind compact key prefixes and keeps
 * database/store names in metadata records. This reader resolves that
 * metadata first, then exposes raw wanted-database rows for later deduping.
 * Its LevelDB environment makes every mutating operation a no-op, because
 * importing must not alter a live or cold Termius profile.
 */

use super::comparator::IdbComparator;
use super::running::{acquire, RunningError};
use rusty_leveldb::env::{Env, FileLock, Logger, RandomAccess};
use rusty_leveldb::{LdbIterator, Options, Status, StatusCode, DB};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;

pub const WANTED_DATABASES: &[&str] = &[
    "hosts",
    "keys",
    "ssh_identities",
    "ssh_configs",
    "proxies",
    "groups",
    "tags",
    "tag_hosts",
    "pf_rules",
    "known_hosts",
];

const GLOBAL_SCHEMA_TYPE: u8 = 0;
const GLOBAL_MAX_DATABASE_ID_TYPE: u8 = 1;
const GLOBAL_DATA_VERSION_TYPE: u8 = 2;
const GLOBAL_BLOB_JOURNAL_TYPE: u8 = 3;
const GLOBAL_LIVE_BLOB_JOURNAL_TYPE: u8 = 4;
const GLOBAL_EARLIEST_SWEEP_TYPE: u8 = 5;
const GLOBAL_EARLIEST_COMPACTION_TYPE: u8 = 6;
const GLOBAL_MAX_SIMPLE_TYPE: u8 = 7;
const GLOBAL_SCOPES_PREFIX_TYPE: u8 = 50;
const GLOBAL_DATABASE_FREE_LIST_TYPE: u8 = 100;
const GLOBAL_DATABASE_NAME_TYPE: u8 = 201;
const DATABASE_OBJECT_STORE_METADATA_TYPE: u8 = 50;
const DATABASE_INDEX_METADATA_TYPE: u8 = 100;
const DATABASE_OBJECT_STORE_FREE_LIST_TYPE: u8 = 150;
const DATABASE_INDEX_FREE_LIST_TYPE: u8 = 151;
const DATABASE_OBJECT_STORE_NAMES_TYPE: u8 = 200;
const DATABASE_INDEX_NAMES_TYPE: u8 = 201;
const OBJECT_STORE_NAME_METADATA_TYPE: u8 = 0;
const OBJECT_STORE_DATA_INDEX: u64 = 1;
const EXISTS_ENTRY_INDEX: u64 = 2;
const BLOB_ENTRY_INDEX: u64 = 3;
const MIN_INDEX_DATA_INDEX: u64 = 30;
const MAX_COLLECTION_LENGTH: usize = 1_000_000;
pub const MAX_RAW_ROWS: usize = 100_000;
pub const MAX_RAW_BYTES: usize = 128 * 1024 * 1024;

pub type RawKeyValue = (Vec<u8>, Vec<u8>);

#[derive(Debug, Clone, PartialEq)]
pub enum IdbKey {
    Null,
    String(String),
    Date(f64),
    Number(f64),
    Array(Vec<IdbKey>),
    Binary(Vec<u8>),
    Min,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub database_name: String,
    pub object_store_name: String,
    pub idb_key: IdbKey,
    /// The value exactly as returned by LevelDB, including Chromium's record
    /// version prefix when one is present.
    pub value_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SourceRows {
    pub rows: Vec<Row>,
    /// Number of raw rows per wanted database, before any business-key dedup.
    pub counts: BTreeMap<String, usize>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SourceError {
    #[error("cannot open Termius LevelDB")]
    Open,
    #[error("cannot read Termius LevelDB")]
    LevelDb,
    #[error("Termius LevelDB input limit exceeded: {detail}")]
    Limit { detail: String },
    #[error(transparent)]
    Running(#[from] RunningError),
    #[error(
        "malformed IndexedDB data for database {database}, object store {store} at byte offset {offset}: {detail}"
    )]
    Malformed {
        database: String,
        store: String,
        offset: usize,
        detail: String,
    },
    #[error(
        "unsupported IndexedDB encoding for database {database}, object store {store}: {detail}"
    )]
    Unsupported {
        database: String,
        store: String,
        detail: String,
    },
    #[error("missing IndexedDB metadata for database {database}, object store {store}")]
    MissingMetadata { database: String, store: String },
}

fn malformed(database: &str, store: &str, offset: usize, detail: impl Into<String>) -> SourceError {
    SourceError::Malformed {
        database: database.to_owned(),
        store: store.to_owned(),
        offset,
        detail: detail.into(),
    }
}

fn unsupported(database: &str, store: &str, detail: impl Into<String>) -> SourceError {
    SourceError::Unsupported {
        database: database.to_owned(),
        store: store.to_owned(),
        detail: detail.into(),
    }
}

fn decode_varint_in(
    input: &[u8],
    database: &str,
    store: &str,
    offset_base: usize,
) -> Result<(u64, usize), SourceError> {
    let start = offset_base;
    let mut value = 0u64;
    for (index, byte) in input.iter().copied().enumerate() {
        if index >= 10 || (index == 9 && byte & 0x7f > 1) {
            return Err(malformed(
                database,
                store,
                start,
                "varint overflows 64 bits",
            ));
        }
        value |= u64::from(byte & 0x7f) << (index * 7);
        if byte & 0x80 == 0 {
            return Ok((value, index + 1));
        }
    }
    Err(malformed(
        database,
        store,
        start + input.len(),
        "truncated varint",
    ))
}

/// Decode Chromium's little-endian base-128 unsigned varint and return its
/// value plus the number of consumed bytes.
pub fn decode_varint(input: &[u8]) -> Result<(u64, usize), SourceError> {
    decode_varint_in(input, "<wire>", "<wire>", 0)
}

fn decode_truncated_int(
    input: &[u8],
    database: &str,
    store: &str,
    offset: usize,
) -> Result<u64, SourceError> {
    if input.is_empty() {
        return Err(malformed(
            database,
            store,
            offset,
            "empty truncated integer",
        ));
    }
    if input.len() > 8 {
        return Err(malformed(
            database,
            store,
            offset,
            "truncated integer is wider than 64 bits",
        ));
    }
    let mut value = 0u64;
    for (index, byte) in input.iter().copied().enumerate() {
        value |= u64::from(byte) << (index * 8);
    }
    Ok(value)
}

fn decode_utf16_be(
    bytes: &[u8],
    database: &str,
    store: &str,
    offset: usize,
) -> Result<String, SourceError> {
    if !bytes.len().is_multiple_of(2) {
        return Err(malformed(
            database,
            store,
            offset,
            "UTF-16BE payload has an odd byte length",
        ));
    }
    let units = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[b0, b1]| u16::from_be_bytes([b0, b1]))
        .collect::<Vec<_>>();
    String::from_utf16(&units).map_err(|_| {
        malformed(
            database,
            store,
            offset,
            "UTF-16BE payload contains an invalid surrogate",
        )
    })
}

fn decode_string_with_length(
    input: &[u8],
    database: &str,
    store: &str,
    offset: usize,
) -> Result<(String, usize), SourceError> {
    let (units, varint_len) = decode_varint_in(input, database, store, offset)?;
    let units = usize::try_from(units)
        .map_err(|_| malformed(database, store, offset, "string length does not fit usize"))?;
    if units > MAX_COLLECTION_LENGTH {
        return Err(malformed(
            database,
            store,
            offset,
            "string length exceeds safety limit",
        ));
    }
    let byte_len = units
        .checked_mul(2)
        .ok_or_else(|| malformed(database, store, offset, "string length overflows"))?;
    let end = varint_len
        .checked_add(byte_len)
        .ok_or_else(|| malformed(database, store, offset, "string end overflows"))?;
    let bytes = input.get(varint_len..end).ok_or_else(|| {
        malformed(
            database,
            store,
            offset + varint_len,
            "truncated UTF-16BE string",
        )
    })?;
    Ok((
        decode_utf16_be(bytes, database, store, offset + varint_len)?,
        end,
    ))
}

fn decode_idb_key_at(
    input: &[u8],
    database: &str,
    store: &str,
    offset_base: usize,
    depth: usize,
) -> Result<(IdbKey, usize), SourceError> {
    if depth > 128 {
        return Err(malformed(
            database,
            store,
            offset_base,
            "IDBKey nesting exceeds safety limit",
        ));
    }
    let tag = *input
        .first()
        .ok_or_else(|| malformed(database, store, offset_base, "missing IDBKey type byte"))?;
    match tag {
        0 => Ok((IdbKey::Null, 1)),
        1 => {
            let (value, used) =
                decode_string_with_length(&input[1..], database, store, offset_base + 1)?;
            Ok((IdbKey::String(value), used + 1))
        }
        2 | 3 => {
            let bytes = input.get(1..9).ok_or_else(|| {
                malformed(database, store, offset_base + 1, "truncated IDBKey number")
            })?;
            let number = f64::from_ne_bytes(bytes.try_into().expect("eight-byte slice"));
            let key = if tag == 2 {
                IdbKey::Date(number)
            } else {
                IdbKey::Number(number)
            };
            Ok((key, 9))
        }
        4 => {
            let (count, count_len) =
                decode_varint_in(&input[1..], database, store, offset_base + 1)?;
            let count = usize::try_from(count).map_err(|_| {
                malformed(
                    database,
                    store,
                    offset_base + 1,
                    "IDBKey array length does not fit usize",
                )
            })?;
            if count > MAX_COLLECTION_LENGTH {
                return Err(malformed(
                    database,
                    store,
                    offset_base + 1,
                    "IDBKey array is too large",
                ));
            }
            let mut used = 1 + count_len;
            let mut values = Vec::with_capacity(count);
            for _ in 0..count {
                let (value, consumed) = decode_idb_key_at(
                    &input[used..],
                    database,
                    store,
                    offset_base + used,
                    depth + 1,
                )?;
                values.push(value);
                used = used.checked_add(consumed).ok_or_else(|| {
                    malformed(database, store, offset_base, "IDBKey array end overflows")
                })?;
            }
            Ok((IdbKey::Array(values), used))
        }
        5 => Ok((IdbKey::Min, 1)),
        6 => {
            let (length, length_len) =
                decode_varint_in(&input[1..], database, store, offset_base + 1)?;
            let length = usize::try_from(length).map_err(|_| {
                malformed(
                    database,
                    store,
                    offset_base + 1,
                    "IDBKey binary length does not fit usize",
                )
            })?;
            if length > MAX_COLLECTION_LENGTH {
                return Err(malformed(
                    database,
                    store,
                    offset_base + 1,
                    "IDBKey binary value is too large",
                ));
            }
            let end = 1usize
                .checked_add(length_len)
                .and_then(|prefix| prefix.checked_add(length))
                .ok_or_else(|| {
                    malformed(database, store, offset_base, "IDBKey binary end overflows")
                })?;
            let bytes = input.get(1 + length_len..end).ok_or_else(|| {
                malformed(
                    database,
                    store,
                    offset_base + 1 + length_len,
                    "truncated IDBKey binary value",
                )
            })?;
            Ok((IdbKey::Binary(bytes.to_vec()), end))
        }
        other => Err(unsupported(
            database,
            store,
            format!("unsupported IDBKey type byte 0x{other:02x}"),
        )),
    }
}

/// Decode one Chromium IDBKey and return it with the consumed byte count.
pub fn decode_idb_key(input: &[u8]) -> Result<(IdbKey, usize), SourceError> {
    decode_idb_key_at(input, "<wire>", "<wire>", 0, 0)
}

#[derive(Debug, Clone, Copy)]
struct KeyPrefix {
    database_id: u64,
    object_store_id: u64,
    index_id: u64,
    consumed: usize,
}

fn decode_key_prefix(input: &[u8], database: &str, store: &str) -> Result<KeyPrefix, SourceError> {
    let first = *input
        .first()
        .ok_or_else(|| malformed(database, store, 0, "missing IndexedDB key prefix"))?;
    let database_len = usize::from((first >> 5) & 0x07) + 1;
    let object_store_len = usize::from((first >> 2) & 0x07) + 1;
    let index_len = usize::from(first & 0x03) + 1;
    let total = 1usize
        .checked_add(database_len)
        .and_then(|value| value.checked_add(object_store_len))
        .and_then(|value| value.checked_add(index_len))
        .ok_or_else(|| malformed(database, store, 0, "IndexedDB key prefix length overflows"))?;
    if input.len() < total {
        return Err(malformed(
            database,
            store,
            input.len(),
            "truncated IndexedDB key prefix",
        ));
    }
    let mut cursor = 1;
    let database_id = decode_truncated_int(
        &input[cursor..cursor + database_len],
        database,
        store,
        cursor,
    )?;
    cursor += database_len;
    let object_store_id = decode_truncated_int(
        &input[cursor..cursor + object_store_len],
        database,
        store,
        cursor,
    )?;
    cursor += object_store_len;
    let index_id =
        decode_truncated_int(&input[cursor..cursor + index_len], database, store, cursor)?;
    Ok(KeyPrefix {
        database_id,
        object_store_id,
        index_id,
        consumed: total,
    })
}

fn is_wanted(name: &str) -> bool {
    WANTED_DATABASES.contains(&name)
}

#[derive(Default)]
struct Metadata {
    databases: HashMap<u64, String>,
    stores: HashMap<(u64, u64), String>,
}

fn parse_global_metadata(
    key: &[u8],
    value: &[u8],
    prefix: KeyPrefix,
    metadata: &mut Metadata,
) -> Result<(), SourceError> {
    let suffix = &key[prefix.consumed..];
    let Some(&kind) = suffix.first() else {
        return Err(malformed(
            "<global>",
            "<metadata>",
            prefix.consumed,
            "missing global metadata type",
        ));
    };
    match kind {
        GLOBAL_DATABASE_NAME_TYPE => {
            let (origin, origin_len) = decode_string_with_length(
                &suffix[1..],
                "<global>",
                "<metadata>",
                prefix.consumed + 1,
            )?;
            let (database_name, database_len) = decode_string_with_length(
                &suffix[1 + origin_len..],
                "<global>",
                "<metadata>",
                prefix.consumed + 1 + origin_len,
            )?;
            if 1 + origin_len + database_len != suffix.len() {
                return Err(malformed(
                    "<global>",
                    "<metadata>",
                    prefix.consumed + 1 + origin_len + database_len,
                    "trailing bytes in database-name metadata key",
                ));
            }
            let database_id = decode_truncated_int(value, "<global>", "<metadata>", 0)?;
            if database_id == 0 {
                return Err(malformed(
                    "<global>",
                    "<metadata>",
                    0,
                    "database-name metadata contains id zero",
                ));
            }
            let _ = origin;
            metadata
                .databases
                .entry(database_id)
                .or_insert(database_name);
        }
        GLOBAL_SCHEMA_TYPE
        | GLOBAL_MAX_DATABASE_ID_TYPE
        | GLOBAL_DATA_VERSION_TYPE
        | GLOBAL_BLOB_JOURNAL_TYPE
        | GLOBAL_LIVE_BLOB_JOURNAL_TYPE
        | GLOBAL_EARLIEST_SWEEP_TYPE
        | GLOBAL_EARLIEST_COMPACTION_TYPE
        | GLOBAL_SCOPES_PREFIX_TYPE
        | GLOBAL_DATABASE_FREE_LIST_TYPE => {}
        other => {
            return Err(unsupported(
                "<global>",
                "<metadata>",
                format!("unsupported global metadata type byte 0x{other:02x}"),
            ));
        }
    }
    Ok(())
}

fn parse_database_metadata(
    key: &[u8],
    value: &[u8],
    prefix: KeyPrefix,
    metadata: &mut Metadata,
) -> Result<(), SourceError> {
    let database = format!("id:{}", prefix.database_id);
    let suffix = &key[prefix.consumed..];
    let Some(&kind) = suffix.first() else {
        return Err(malformed(
            &database,
            "<metadata>",
            prefix.consumed,
            "missing database metadata type",
        ));
    };
    match kind {
        DATABASE_OBJECT_STORE_METADATA_TYPE => {
            let (object_store_id, id_len) =
                decode_varint_in(&suffix[1..], &database, "<metadata>", prefix.consumed + 1)?;
            let metadata_type = *suffix.get(1 + id_len).ok_or_else(|| {
                malformed(
                    &database,
                    "<metadata>",
                    prefix.consumed + 1 + id_len,
                    "missing object-store metadata subtype",
                )
            })?;
            if 2 + id_len != suffix.len() {
                return Err(malformed(
                    &database,
                    "<metadata>",
                    prefix.consumed + 2 + id_len,
                    "trailing bytes in object-store metadata key",
                ));
            }
            if object_store_id == 0 {
                return Err(malformed(
                    &database,
                    "<metadata>",
                    prefix.consumed + 1,
                    "object-store metadata contains id zero",
                ));
            }
            if metadata_type == OBJECT_STORE_NAME_METADATA_TYPE {
                let name = decode_utf16_be(value, &database, "<metadata>", 0)?;
                metadata
                    .stores
                    .insert((prefix.database_id, object_store_id), name);
            } else if metadata_type > 7 {
                return Err(unsupported(
                    &database,
                    "<metadata>",
                    format!("unsupported object-store metadata subtype 0x{metadata_type:02x}"),
                ));
            }
        }
        DATABASE_OBJECT_STORE_NAMES_TYPE => {
            let (name, name_len) = decode_string_with_length(
                &suffix[1..],
                &database,
                "<metadata>",
                prefix.consumed + 1,
            )?;
            if 1 + name_len != suffix.len() {
                return Err(malformed(
                    &database,
                    "<metadata>",
                    prefix.consumed + 1 + name_len,
                    "trailing bytes in object-store name key",
                ));
            }
            let object_store_id = decode_truncated_int(value, &database, "<metadata>", 0)?;
            if object_store_id == 0 {
                return Err(malformed(
                    &database,
                    "<metadata>",
                    0,
                    "object-store name maps to id zero",
                ));
            }
            metadata
                .stores
                .insert((prefix.database_id, object_store_id), name);
        }
        DATABASE_INDEX_METADATA_TYPE
        | DATABASE_OBJECT_STORE_FREE_LIST_TYPE
        | DATABASE_INDEX_FREE_LIST_TYPE
        | DATABASE_INDEX_NAMES_TYPE
        | 0..=5 => {}
        other => {
            return Err(unsupported(
                &database,
                "<metadata>",
                format!("unsupported database metadata type byte 0x{other:02x}"),
            ));
        }
    }
    Ok(())
}

fn read_only_options() -> Options {
    Options {
        cmp: std::rc::Rc::new(Box::new(IdbComparator)),
        create_if_missing: false,
        error_if_exists: false,
        reuse_logs: true,
        reuse_manifest: true,
        env: Rc::new(Box::new(ReadOnlyEnv)),
        ..Options::default()
    }
}

#[derive(Clone, Copy, Default)]
struct ReadOnlyEnv;

impl Env for ReadOnlyEnv {
    fn open_sequential_file(&self, path: &Path) -> rusty_leveldb::Result<Box<dyn Read>> {
        Ok(Box::new(File::open(path).map_err(Status::from)?))
    }

    fn open_random_access_file(&self, path: &Path) -> rusty_leveldb::Result<Box<dyn RandomAccess>> {
        Ok(Box::new(File::open(path).map_err(Status::from)?))
    }

    fn open_writable_file(&self, _: &Path) -> rusty_leveldb::Result<Box<dyn Write>> {
        Ok(Box::new(io::sink()))
    }

    fn open_appendable_file(&self, _: &Path) -> rusty_leveldb::Result<Box<dyn Write>> {
        Ok(Box::new(io::sink()))
    }

    fn exists(&self, path: &Path) -> rusty_leveldb::Result<bool> {
        Ok(path.exists())
    }

    fn children(&self, path: &Path) -> rusty_leveldb::Result<Vec<PathBuf>> {
        fs::read_dir(path)
            .map_err(Status::from)?
            .map(|entry| {
                entry
                    .map(|entry| PathBuf::from(entry.file_name()))
                    .map_err(Status::from)
            })
            .collect()
    }

    fn size_of(&self, path: &Path) -> rusty_leveldb::Result<usize> {
        let length = File::open(path)
            .map_err(Status::from)?
            .metadata()
            .map_err(Status::from)?
            .len();
        usize::try_from(length)
            .map_err(|_| Status::new(StatusCode::IOError, "file size exceeds addressable memory"))
    }

    fn delete(&self, _: &Path) -> rusty_leveldb::Result<()> {
        Ok(())
    }

    fn mkdir(&self, _: &Path) -> rusty_leveldb::Result<()> {
        Ok(())
    }

    fn rmdir(&self, _: &Path) -> rusty_leveldb::Result<()> {
        Ok(())
    }

    fn rename(&self, _: &Path, _: &Path) -> rusty_leveldb::Result<()> {
        Ok(())
    }

    fn lock(&self, _: &Path) -> rusty_leveldb::Result<FileLock> {
        // running.rs performs the explicit advisory LOCK probe. The LevelDB
        // reader must not create or exclusively lock this file itself.
        Ok(FileLock { id: String::new() })
    }

    fn unlock(&self, _: FileLock) -> rusty_leveldb::Result<()> {
        Ok(())
    }

    fn new_logger(&self, _: &Path) -> rusty_leveldb::Result<Logger> {
        Ok(Logger::new(Box::new(io::sink())))
    }

    fn micros(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as u64
    }

    fn sleep_for(&self, micros: u32) {
        std::thread::sleep(Duration::from_micros(u64::from(micros)));
    }
}

/*
 * LevelDB returns owned key/value buffers from its iterator. Enforce both
 * dimensions of the ingestion budget before moving each pair into the
 * collection, so a corrupt profile cannot make the reader retain an
 * unbounded number of rows or bytes.
 */
fn collect_raw_rows<I>(
    pairs: I,
    max_rows: usize,
    max_bytes: usize,
) -> Result<Vec<RawKeyValue>, SourceError>
where
    I: IntoIterator<Item = RawKeyValue>,
{
    let mut rows = Vec::new();
    let mut total_bytes = 0usize;
    for (key, value) in pairs {
        if rows.len() >= max_rows {
            return Err(SourceError::Limit {
                detail: "raw row count exceeds configured limit".into(),
            });
        }
        let pair_bytes = key
            .len()
            .checked_add(value.len())
            .ok_or_else(|| SourceError::Limit {
                detail: "raw key/value byte count overflows".into(),
            })?;
        total_bytes = total_bytes
            .checked_add(pair_bytes)
            .ok_or_else(|| SourceError::Limit {
                detail: "raw key/value byte count overflows".into(),
            })?;
        if total_bytes > max_bytes {
            return Err(SourceError::Limit {
                detail: "raw key/value bytes exceed configured limit".into(),
            });
        }
        rows.push((key, value));
    }
    Ok(rows)
}

/// Iterate a LevelDB directory without opening it for writes. The caller must
/// hold the source lock for the complete operation.
fn read_leveldb(path: &Path) -> Result<Vec<RawKeyValue>, SourceError> {
    if !path.join("CURRENT").is_file() {
        return Err(SourceError::Open);
    }
    let mut database = DB::open(path, read_only_options()).map_err(|_| SourceError::Open)?;
    let mut iterator = database.new_iter().map_err(|_| SourceError::LevelDb)?;
    collect_raw_rows(
        std::iter::from_fn(|| iterator.next()),
        MAX_RAW_ROWS,
        MAX_RAW_BYTES,
    )
}

/// Strip Chromium's record-version varint while retaining the value bytes.
/// `read_rows` intentionally keeps the original LevelDB value untouched.
pub fn decode_record_value(value: &[u8]) -> Result<&[u8], SourceError> {
    let (_, consumed) = decode_varint(value)?;
    value.get(consumed..).ok_or_else(|| {
        malformed(
            "<record>",
            "<record>",
            consumed,
            "record-version prefix exceeds value length",
        )
    })
}

/*
 * Both public row-reading entry points route through this function. The guard
 * remains alive until every LevelDB and parsing operation has completed, so a
 * profile cannot reopen or mutate between the closed check and data access.
 */
pub fn read_rows(path: &Path) -> Result<SourceRows, SourceError> {
    read_source(path)
}

fn read_rows_unchecked(path: &Path) -> Result<SourceRows, SourceError> {
    let raw = read_leveldb(path)?;
    let wanted: HashSet<&str> = WANTED_DATABASES.iter().copied().collect();
    let mut metadata = Metadata::default();

    for (key, value) in &raw {
        let prefix = decode_key_prefix(key, "<global>", "<metadata>")?;
        if prefix.database_id == 0 && prefix.object_store_id == 0 && prefix.index_id == 0 {
            parse_global_metadata(key, value, prefix, &mut metadata)?;
        } else if prefix.database_id > 0 && prefix.object_store_id == 0 && prefix.index_id == 0 {
            parse_database_metadata(key, value, prefix, &mut metadata)?;
        }
    }

    let mut counts = BTreeMap::new();
    for database_name in metadata.databases.values() {
        if wanted.contains(database_name.as_str()) {
            counts.entry(database_name.clone()).or_insert(0);
        }
    }

    let mut rows = Vec::new();
    for (key, value) in raw {
        let prefix = decode_key_prefix(key.as_slice(), "<record>", "<record>")?;
        if prefix.database_id == 0 || prefix.object_store_id == 0 {
            continue;
        }
        let database_name = metadata
            .databases
            .get(&prefix.database_id)
            .cloned()
            .ok_or_else(|| SourceError::MissingMetadata {
                database: format!("id:{}", prefix.database_id),
                store: format!("id:{}", prefix.object_store_id),
            })?;
        if !wanted.contains(database_name.as_str()) {
            continue;
        }
        if prefix.index_id != OBJECT_STORE_DATA_INDEX {
            if prefix.index_id == EXISTS_ENTRY_INDEX
                || prefix.index_id == BLOB_ENTRY_INDEX
                || prefix.index_id >= MIN_INDEX_DATA_INDEX
            {
                continue;
            }
            let database = metadata
                .databases
                .get(&prefix.database_id)
                .cloned()
                .unwrap_or_else(|| database_name.clone());
            let store = metadata
                .stores
                .get(&(prefix.database_id, prefix.object_store_id))
                .cloned()
                .unwrap_or_else(|| format!("id:{}", prefix.object_store_id));
            return Err(unsupported(
                &database,
                &store,
                format!("unsupported IndexedDB index id {}", prefix.index_id),
            ));
        }
        let object_store_name = metadata
            .stores
            .get(&(prefix.database_id, prefix.object_store_id))
            .cloned()
            .ok_or_else(|| SourceError::MissingMetadata {
                database: database_name.clone(),
                store: format!("id:{}", prefix.object_store_id),
            })?;
        let encoded_key = &key[prefix.consumed..];
        let (idb_key, consumed) = decode_idb_key_at(
            encoded_key,
            &database_name,
            &object_store_name,
            prefix.consumed,
            0,
        )?;
        if consumed != encoded_key.len() {
            return Err(malformed(
                &database_name,
                &object_store_name,
                prefix.consumed + consumed,
                "trailing bytes after record IDBKey",
            ));
        }
        *counts.entry(database_name.clone()).or_insert(0) += 1;
        rows.push(Row {
            database_name,
            object_store_name,
            idb_key,
            value_bytes: value,
        });
    }
    Ok(SourceRows { rows, counts })
}

/// Read the wanted IndexedDB rows from a closed Termius LevelDB directory.
/// The lock probe runs before rusty-leveldb opens the database.
pub fn read_source(path: &Path) -> Result<SourceRows, SourceError> {
    let _lock = acquire(path)?;
    read_rows_unchecked(path)
}

pub fn is_leveldb_path(path: &Path) -> bool {
    path.join("CURRENT").is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::termius::comparator::IDB_COMPARATOR_NAME;
    #[cfg(unix)]
    use crate::import::termius::running::test_support::with_held_lock;
    use crate::import::termius::v8::{self, Value};
    use rusty_leveldb::{Options, DB};
    use std::fs;
    use std::rc::Rc;
    use tempfile::tempdir;

    fn encode_varint(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            bytes.push(byte);
            if value == 0 {
                return bytes;
            }
        }
    }

    fn encode_int(value: u64) -> Vec<u8> {
        let mut value = value;
        let mut bytes = Vec::new();
        loop {
            bytes.push(value as u8);
            value >>= 8;
            if value == 0 {
                return bytes;
            }
        }
    }

    fn encode_utf16_be(value: &str) -> Vec<u8> {
        value
            .encode_utf16()
            .flat_map(|unit| unit.to_be_bytes())
            .collect()
    }

    fn encode_string_with_length(value: &str) -> Vec<u8> {
        let units = value.encode_utf16().count() as u64;
        let mut bytes = encode_varint(units);
        bytes.extend(encode_utf16_be(value));
        bytes
    }

    fn prefix(database: u64, store: u64, index: u64) -> Vec<u8> {
        fn byte_len(value: u64) -> usize {
            if value == 0 {
                1
            } else {
                ((64 - value.leading_zeros()) as usize).div_ceil(8)
            }
        }
        let database_len = byte_len(database);
        let store_len = byte_len(store);
        let index_len = byte_len(index);
        assert!((1..=8).contains(&database_len));
        assert!((1..=8).contains(&store_len));
        assert!((1..=4).contains(&index_len));
        let first = (((database_len - 1) as u8) << 5)
            | (((store_len - 1) as u8) << 2)
            | ((index_len - 1) as u8);
        let mut bytes = vec![first];
        bytes.extend(encode_int(database));
        bytes.extend(encode_int(store));
        bytes.extend(encode_int(index));
        bytes
    }

    fn database_name_key(origin: &str, name: &str) -> Vec<u8> {
        let mut key = prefix(0, 0, 0);
        key.push(GLOBAL_DATABASE_NAME_TYPE);
        key.extend(encode_string_with_length(origin));
        key.extend(encode_string_with_length(name));
        key
    }

    fn store_name_key(database: u64, name: &str) -> Vec<u8> {
        let mut key = prefix(database, 0, 0);
        key.push(DATABASE_OBJECT_STORE_NAMES_TYPE);
        key.extend(encode_string_with_length(name));
        key
    }

    fn store_metadata_name_key(database: u64, store: u64) -> Vec<u8> {
        let mut key = prefix(database, 0, 0);
        key.push(DATABASE_OBJECT_STORE_METADATA_TYPE);
        key.extend(encode_varint(store));
        key.push(OBJECT_STORE_NAME_METADATA_TYPE);
        key
    }

    fn record_key(database: u64, store: u64, id: &str) -> Vec<u8> {
        let mut key = prefix(database, store, OBJECT_STORE_DATA_INDEX);
        key.push(1);
        key.extend(encode_string_with_length(id));
        key
    }

    fn v8_record(id: i32) -> Vec<u8> {
        let mut value = vec![b'o', b'"', 2, b'i', b'd', b'I'];
        let zigzag = ((id << 1) ^ (id >> 31)) as u32;
        value.extend(encode_varint(u64::from(zigzag)));
        value.extend([b'{', 1]);
        value
    }

    fn write_fixture(path: &Path) {
        let options = Options {
            cmp: Rc::new(Box::new(IdbComparator)),
            create_if_missing: true,
            ..Options::default()
        };
        let mut database = DB::open(path, options).unwrap();
        database
            .put(&database_name_key("https://example.invalid", "hosts"), &[1])
            .unwrap();
        database.put(&store_name_key(1, "default"), &[1]).unwrap();
        database
            .put(&store_metadata_name_key(1, 1), &encode_utf16_be("default"))
            .unwrap();
        database
            .put(&record_key(1, 1, "host-1"), &v8_record(42))
            .unwrap();
        database
            .put(
                &database_name_key("https://example.invalid", "history_commands"),
                &[2],
            )
            .unwrap();
        let mut scope_metadata_key = prefix(0, 0, 0);
        scope_metadata_key.extend([50, 0]);
        database.put(&scope_metadata_key, &[1]).unwrap();
        let mut compaction_metadata_key = prefix(0, 0, 0);
        compaction_metadata_key.push(GLOBAL_EARLIEST_COMPACTION_TYPE);
        database.put(&compaction_metadata_key, &[0; 8]).unwrap();
        database.flush().unwrap();
        database.close().unwrap();
        fs::write(path.join("LOCK"), b"").unwrap();
    }

    #[test]
    fn decodes_golden_varints_and_record_versions() {
        assert_eq!(decode_varint(&[0]).unwrap(), (0, 1));
        assert_eq!(decode_varint(&[0x7f]).unwrap(), (127, 1));
        assert_eq!(decode_varint(&[0x80, 0x01]).unwrap(), (128, 2));
        assert_eq!(decode_varint(&[0xac, 0x02]).unwrap(), (300, 2));
        assert_eq!(
            decode_record_value(&[0xac, 0x02, 0x11, 0x22]).unwrap(),
            &[0x11, 0x22]
        );
        assert!(decode_varint(&[0x80]).is_err());
    }

    #[test]
    fn decodes_golden_idb_keys() {
        assert_eq!(decode_idb_key(&[0]).unwrap(), (IdbKey::Null, 1));

        let mut string_key = vec![1];
        string_key.extend(encode_string_with_length("é"));
        assert_eq!(
            decode_idb_key(&string_key).unwrap(),
            (IdbKey::String("é".into()), string_key.len())
        );

        let mut number_key = vec![3];
        number_key.extend(1.5f64.to_ne_bytes());
        assert_eq!(
            decode_idb_key(&number_key).unwrap(),
            (IdbKey::Number(1.5), 9)
        );

        let mut date_key = vec![2];
        date_key.extend((-42.0f64).to_ne_bytes());
        assert_eq!(decode_idb_key(&date_key).unwrap(), (IdbKey::Date(-42.0), 9));

        assert_eq!(decode_idb_key(&[5]).unwrap(), (IdbKey::Min, 1));

        let binary_key = [6, 3, 0xaa, 0xbb, 0xcc];
        assert_eq!(
            decode_idb_key(&binary_key).unwrap(),
            (IdbKey::Binary(vec![0xaa, 0xbb, 0xcc]), 5)
        );

        let array_key = [4, 2, 0, 1, 1, 0, b'a'];
        assert_eq!(
            decode_idb_key(&array_key).unwrap().0,
            IdbKey::Array(vec![IdbKey::Null, IdbKey::String("a".into())])
        );
    }

    #[test]
    fn synthetic_leveldb_rows_resolve_metadata_and_v8_values() {
        let directory = tempdir().unwrap();
        write_fixture(directory.path());
        let before = snapshot_files(directory.path());

        let current = fs::read_to_string(directory.path().join("CURRENT")).unwrap();
        let manifest = fs::read(directory.path().join(current.trim())).unwrap();
        assert!(manifest
            .windows(IDB_COMPARATOR_NAME.len())
            .any(|window| window == IDB_COMPARATOR_NAME.as_bytes()));

        let result = read_source(directory.path()).unwrap();
        assert_eq!(result.counts.get("hosts"), Some(&1));
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].database_name, "hosts");
        assert_eq!(result.rows[0].object_store_name, "default");
        assert_eq!(result.rows[0].idb_key, IdbKey::String("host-1".into()));
        assert_eq!(v8::decode(&result.rows[0].value_bytes).unwrap(), {
            let mut object = BTreeMap::new();
            object.insert("id".into(), Value::Int32(42));
            Value::Object(object)
        });

        assert_eq!(before, snapshot_files(directory.path()));
    }

    #[test]
    fn bounded_raw_collection_rejects_row_and_byte_limits() {
        let rows = vec![(vec![0u8], vec![])];
        assert!(matches!(
            collect_raw_rows(rows, 0, 10),
            Err(SourceError::Limit { detail }) if detail.contains("row count")
        ));

        let rows = vec![(vec![0u8, 1], vec![2, 3])];
        assert!(matches!(
            collect_raw_rows(rows, 10, 3),
            Err(SourceError::Limit { detail }) if detail.contains("bytes")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn high_level_read_rejects_a_held_lock_before_leveldb_access() {
        let directory = tempdir().unwrap();
        let lock_path = directory.path().join("LOCK");
        fs::write(&lock_path, b"").unwrap();
        with_held_lock(directory.path(), || {
            assert_eq!(
                read_source(directory.path()),
                Err(SourceError::Running(RunningError::Running))
            );
        });
    }

    #[test]
    fn source_errors_do_not_display_a_leveldb_path() {
        let path = Path::new("/private/synthetic/Termius/IndexedDB/file.leveldb");
        let error = read_leveldb(path).unwrap_err();
        assert!(!error.to_string().contains(path.to_string_lossy().as_ref()));
    }

    fn snapshot_files(path: &Path) -> BTreeMap<String, Vec<u8>> {
        fs::read_dir(path)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    fs::read(entry.path()).unwrap(),
                )
            })
            .collect()
    }
}
