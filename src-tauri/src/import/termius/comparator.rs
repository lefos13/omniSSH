/*
 * Chromium's IndexedDB LevelDB comparator orders decoded key prefixes and
 * encoded IDBKeys, rather than comparing their serialized bytes directly.
 * This implementation keeps the comparison allocation-free and falls back
 * to byte order only for malformed keys, which cannot be safely interpreted.
 */

use rusty_leveldb::Cmp;
use std::cmp::Ordering;

pub const IDB_COMPARATOR_NAME: &str = "idb_cmp1";

const GLOBAL_MAX_SIMPLE_TYPE: u8 = 7;
const GLOBAL_SCOPES_PREFIX_TYPE: u8 = 50;
const DATABASE_MAX_SIMPLE_TYPE: u8 = 6;
const OBJECT_STORE_DATA_INDEX: u64 = 1;
const EXISTS_ENTRY_INDEX: u64 = 2;
const BLOB_ENTRY_INDEX: u64 = 3;
const MIN_INDEX_DATA_INDEX: u64 = 30;
const MAX_IDB_COLLECTION_LENGTH: u64 = 1_000_000;
const MAX_IDB_KEY_DEPTH: usize = 128;

#[derive(Clone, Copy, Debug, Default)]
pub struct IdbComparator;

#[derive(Clone, Copy)]
struct KeyPrefix {
    database_id: u64,
    object_store_id: u64,
    index_id: u64,
    consumed: usize,
}

#[derive(Clone, Copy)]
struct EncodedComparison {
    ordering: Ordering,
    consumed_a: usize,
    consumed_b: usize,
}

#[derive(Clone, Copy)]
enum PrefixKind {
    GlobalMetadata,
    DatabaseMetadata,
    ObjectStoreData,
    ExistsEntry,
    BlobEntry,
    IndexData,
}

impl KeyPrefix {
    fn kind(self) -> Option<PrefixKind> {
        if self.database_id == 0 {
            Some(PrefixKind::GlobalMetadata)
        } else if self.object_store_id == 0 {
            Some(PrefixKind::DatabaseMetadata)
        } else {
            match self.index_id {
                OBJECT_STORE_DATA_INDEX => Some(PrefixKind::ObjectStoreData),
                EXISTS_ENTRY_INDEX => Some(PrefixKind::ExistsEntry),
                BLOB_ENTRY_INDEX => Some(PrefixKind::BlobEntry),
                MIN_INDEX_DATA_INDEX.. => Some(PrefixKind::IndexData),
                _ => None,
            }
        }
    }
}

impl Cmp for IdbComparator {
    fn cmp(&self, a: &[u8], b: &[u8]) -> Ordering {
        compare_keys(a, b).unwrap_or_else(|| a.cmp(b))
    }

    fn find_shortest_sep(&self, from: &[u8], _: &[u8]) -> Vec<u8> {
        from.to_vec()
    }

    fn find_short_succ(&self, key: &[u8]) -> Vec<u8> {
        key.to_vec()
    }

    fn id(&self) -> &'static str {
        IDB_COMPARATOR_NAME
    }
}

fn decode_varint(input: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for index in 0..10 {
        let byte = *input.get(index)?;
        if index == 9 && byte & 0x7f > 1 {
            return None;
        }
        value |= u64::from(byte & 0x7f) << (index * 7);
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
    }
    None
}

fn decode_truncated_int(input: &[u8]) -> Option<u64> {
    if input.is_empty() || input.len() > 8 {
        return None;
    }
    let mut value = 0u64;
    for (index, byte) in input.iter().copied().enumerate() {
        value |= u64::from(byte) << (index * 8);
    }
    Some(value)
}

fn decode_prefix(input: &[u8]) -> Option<KeyPrefix> {
    let first = *input.first()?;
    let database_len = usize::from((first >> 5) & 0x07) + 1;
    let object_store_len = usize::from((first >> 2) & 0x07) + 1;
    let index_len = usize::from(first & 0x03) + 1;
    let total = 1usize
        .checked_add(database_len)?
        .checked_add(object_store_len)?
        .checked_add(index_len)?;
    if input.len() < total {
        return None;
    }
    let database_start = 1;
    let object_store_start = database_start + database_len;
    let index_start = object_store_start + object_store_len;
    Some(KeyPrefix {
        database_id: decode_truncated_int(&input[database_start..object_store_start])?,
        object_store_id: decode_truncated_int(&input[object_store_start..index_start])?,
        index_id: decode_truncated_int(&input[index_start..total])?,
        consumed: total,
    })
}

fn compare_keys(a: &[u8], b: &[u8]) -> Option<Ordering> {
    let prefix_a = decode_prefix(a)?;
    let prefix_b = decode_prefix(b)?;

    for (left, right) in [
        (prefix_a.database_id, prefix_b.database_id),
        (prefix_a.object_store_id, prefix_b.object_store_id),
        (prefix_a.index_id, prefix_b.index_id),
    ] {
        let ordering = left.cmp(&right);
        if ordering != Ordering::Equal {
            return Some(ordering);
        }
    }

    let suffix_a = &a[prefix_a.consumed..];
    let suffix_b = &b[prefix_b.consumed..];
    match prefix_a.kind()? {
        PrefixKind::GlobalMetadata => compare_global_metadata(suffix_a, suffix_b),
        PrefixKind::DatabaseMetadata => compare_database_metadata(suffix_a, suffix_b),
        PrefixKind::ObjectStoreData | PrefixKind::ExistsEntry | PrefixKind::BlobEntry => {
            compare_record_suffix(suffix_a, suffix_b)
        }
        PrefixKind::IndexData => compare_index_suffix(suffix_a, suffix_b),
    }
}

fn compare_global_metadata(a: &[u8], b: &[u8]) -> Option<Ordering> {
    let (&type_a, &type_b) = (a.first()?, b.first()?);
    let ordering = type_a.cmp(&type_b);
    if ordering != Ordering::Equal {
        return Some(ordering);
    }
    if type_a < GLOBAL_MAX_SIMPLE_TYPE {
        return Some(Ordering::Equal);
    }

    match type_a {
        GLOBAL_SCOPES_PREFIX_TYPE => Some(a[1..].cmp(&b[1..])),
        100 => compare_one_varint(&a[1..], &b[1..]),
        201 => {
            let (origin_a, used_a) = decode_string_with_length(&a[1..])?;
            let (origin_b, used_b) = decode_string_with_length(&b[1..])?;
            let ordering = origin_a.cmp(origin_b);
            if ordering != Ordering::Equal {
                return Some(ordering);
            }
            let (name_a, _) = decode_string_with_length(a.get(1 + used_a..)?)?;
            let (name_b, _) = decode_string_with_length(b.get(1 + used_b..)?)?;
            Some(name_a.cmp(name_b))
        }
        _ => None,
    }
}

fn compare_database_metadata(a: &[u8], b: &[u8]) -> Option<Ordering> {
    let (&type_a, &type_b) = (a.first()?, b.first()?);
    let ordering = type_a.cmp(&type_b);
    if ordering != Ordering::Equal {
        return Some(ordering);
    }
    if type_a < DATABASE_MAX_SIMPLE_TYPE {
        return Some(Ordering::Equal);
    }

    match type_a {
        50 => {
            let (store_a, used_a) = decode_varint(a.get(1..)?)?;
            let (store_b, used_b) = decode_varint(b.get(1..)?)?;
            compare_numbers_then_byte(store_a, store_b, a.get(1 + used_a..)?, b.get(1 + used_b..)?)
        }
        100 => {
            let (store_a, store_used_a) = decode_varint(a.get(1..)?)?;
            let (store_b, store_used_b) = decode_varint(b.get(1..)?)?;
            let (index_a, index_used_a) = decode_varint(a.get(1 + store_used_a..)?)?;
            let (index_b, index_used_b) = decode_varint(b.get(1 + store_used_b..)?)?;
            let ordering = store_a.cmp(&store_b);
            if ordering != Ordering::Equal {
                return Some(ordering);
            }
            let ordering = index_a.cmp(&index_b);
            if ordering != Ordering::Equal {
                return Some(ordering);
            }
            Some(
                a.get(1 + store_used_a + index_used_a..)?
                    .first()?
                    .cmp(b.get(1 + store_used_b + index_used_b..)?.first()?),
            )
        }
        150 => compare_one_varint(a.get(1..)?, b.get(1..)?),
        151 => {
            let (store_a, used_a) = decode_varint(a.get(1..)?)?;
            let (store_b, used_b) = decode_varint(b.get(1..)?)?;
            let (index_a, _) = decode_varint(a.get(1 + used_a..)?)?;
            let (index_b, _) = decode_varint(b.get(1 + used_b..)?)?;
            let ordering = store_a.cmp(&store_b);
            if ordering != Ordering::Equal {
                return Some(ordering);
            }
            Some(index_a.cmp(&index_b))
        }
        200 => {
            let (name_a, _) = decode_string_with_length(a.get(1..)?)?;
            let (name_b, _) = decode_string_with_length(b.get(1..)?)?;
            Some(name_a.cmp(name_b))
        }
        201 => {
            let (store_a, used_a) = decode_varint(a.get(1..)?)?;
            let (store_b, used_b) = decode_varint(b.get(1..)?)?;
            let ordering = store_a.cmp(&store_b);
            if ordering != Ordering::Equal {
                return Some(ordering);
            }
            let (name_a, _) = decode_string_with_length(a.get(1 + used_a..)?)?;
            let (name_b, _) = decode_string_with_length(b.get(1 + used_b..)?)?;
            Some(name_a.cmp(name_b))
        }
        _ => None,
    }
}

fn compare_numbers_then_byte(
    first_a: u64,
    first_b: u64,
    rest_a: &[u8],
    rest_b: &[u8],
) -> Option<Ordering> {
    let ordering = first_a.cmp(&first_b);
    if ordering != Ordering::Equal {
        return Some(ordering);
    }
    Some(rest_a.first()?.cmp(rest_b.first()?))
}

fn compare_one_varint(a: &[u8], b: &[u8]) -> Option<Ordering> {
    Some(decode_varint(a)?.0.cmp(&decode_varint(b)?.0))
}

fn decode_string_with_length(input: &[u8]) -> Option<(&[u8], usize)> {
    let (units, varint_len) = decode_varint(input)?;
    if units > MAX_IDB_COLLECTION_LENGTH {
        return None;
    }
    let byte_len = usize::try_from(units).ok()?.checked_mul(2)?;
    let end = varint_len.checked_add(byte_len)?;
    Some((input.get(varint_len..end)?, end))
}

fn compare_record_suffix(a: &[u8], b: &[u8]) -> Option<Ordering> {
    if a.is_empty() || b.is_empty() {
        return Some(a.len().cmp(&b.len()));
    }
    Some(compare_idb_key(a, b, 0)?.ordering)
}

fn compare_index_suffix(a: &[u8], b: &[u8]) -> Option<Ordering> {
    /*
     * Cmp::cmp is Chromium's CompareKeys(..., false for index_keys), so
     * primary keys and sequence numbers remain part of persisted ordering.
     */
    if a.is_empty() || b.is_empty() {
        return Some(a.len().cmp(&b.len()));
    }
    let index_comparison = compare_idb_key(a, b, 0)?;
    if index_comparison.ordering != Ordering::Equal {
        return Some(index_comparison.ordering);
    }

    let mut rest_a = a.get(index_comparison.consumed_a..)?;
    let mut rest_b = b.get(index_comparison.consumed_b..)?;
    let sequence_a = if rest_a.is_empty() {
        -1i128
    } else {
        let (value, used) = decode_varint(rest_a)?;
        rest_a = &rest_a[used..];
        i128::from(value)
    };
    let sequence_b = if rest_b.is_empty() {
        -1i128
    } else {
        let (value, used) = decode_varint(rest_b)?;
        rest_b = &rest_b[used..];
        i128::from(value)
    };

    if rest_a.is_empty() || rest_b.is_empty() {
        return Some(rest_a.len().cmp(&rest_b.len()));
    }
    let primary_comparison = compare_idb_key(rest_a, rest_b, 0)?;
    if primary_comparison.ordering != Ordering::Equal {
        return Some(primary_comparison.ordering);
    }
    Some(sequence_a.cmp(&sequence_b))
}

fn idb_key_rank(tag: u8) -> Option<u8> {
    match tag {
        // These values mirror blink::mojom::IDBKeyType's serialized ordering.
        0 => Some(0), // Invalid/Null is the upper sentinel.
        4 => Some(1), // Array.
        6 => Some(2), // Binary.
        1 => Some(3), // String.
        2 => Some(4), // Date.
        3 => Some(5), // Number.
        5 => Some(7), // Min is the lower sentinel.
        _ => None,
    }
}

fn compare_idb_key(a: &[u8], b: &[u8], depth: usize) -> Option<EncodedComparison> {
    if depth > MAX_IDB_KEY_DEPTH {
        return None;
    }
    let (&tag_a, &tag_b) = (a.first()?, b.first()?);
    let rank_a = idb_key_rank(tag_a)?;
    let rank_b = idb_key_rank(tag_b)?;
    if rank_a != rank_b {
        return Some(EncodedComparison {
            ordering: rank_b.cmp(&rank_a),
            consumed_a: 1,
            consumed_b: 1,
        });
    }

    match tag_a {
        0 | 5 => Some(EncodedComparison {
            ordering: Ordering::Equal,
            consumed_a: 1,
            consumed_b: 1,
        }),
        1 => {
            let (payload_a, used_a) = decode_string_with_length(a.get(1..)?)?;
            let (payload_b, used_b) = decode_string_with_length(b.get(1..)?)?;
            Some(EncodedComparison {
                ordering: payload_a.cmp(payload_b),
                consumed_a: 1 + used_a,
                consumed_b: 1 + used_b,
            })
        }
        6 => {
            let (payload_a, used_a) = decode_binary_with_length(a.get(1..)?)?;
            let (payload_b, used_b) = decode_binary_with_length(b.get(1..)?)?;
            Some(EncodedComparison {
                ordering: payload_a.cmp(payload_b),
                consumed_a: 1 + used_a,
                consumed_b: 1 + used_b,
            })
        }
        2 | 3 => {
            let bytes_a = a.get(1..9)?;
            let bytes_b = b.get(1..9)?;
            let value_a = f64::from_ne_bytes(bytes_a.try_into().ok()?);
            let value_b = f64::from_ne_bytes(bytes_b.try_into().ok()?);
            let ordering = if value_a < value_b {
                Ordering::Less
            } else if value_a > value_b {
                Ordering::Greater
            } else {
                Ordering::Equal
            };
            Some(EncodedComparison {
                ordering,
                consumed_a: 9,
                consumed_b: 9,
            })
        }
        4 => {
            let (count_a, count_len_a) = decode_varint(&a[1..])?;
            let (count_b, count_len_b) = decode_varint(&b[1..])?;
            if count_a > MAX_IDB_COLLECTION_LENGTH || count_b > MAX_IDB_COLLECTION_LENGTH {
                return None;
            }
            let count_a = usize::try_from(count_a).ok()?;
            let count_b = usize::try_from(count_b).ok()?;
            let mut offset_a = 1 + count_len_a;
            let mut offset_b = 1 + count_len_b;
            for _ in 0..count_a.min(count_b) {
                let comparison =
                    compare_idb_key(a.get(offset_a..)?, b.get(offset_b..)?, depth + 1)?;
                offset_a = offset_a.checked_add(comparison.consumed_a)?;
                offset_b = offset_b.checked_add(comparison.consumed_b)?;
                if comparison.ordering != Ordering::Equal {
                    return Some(comparison);
                }
            }
            Some(EncodedComparison {
                ordering: count_a.cmp(&count_b),
                consumed_a: offset_a,
                consumed_b: offset_b,
            })
        }
        _ => None,
    }
}

fn decode_binary_with_length(input: &[u8]) -> Option<(&[u8], usize)> {
    let (length, varint_len) = decode_varint(input)?;
    if length > MAX_IDB_COLLECTION_LENGTH {
        return None;
    }
    let length = usize::try_from(length).ok()?;
    let end = varint_len.checked_add(length)?;
    Some((input.get(varint_len..end)?, end))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn encode_int(mut value: u64) -> Vec<u8> {
        let mut bytes = Vec::new();
        loop {
            bytes.push(value as u8);
            value >>= 8;
            if value == 0 {
                return bytes;
            }
        }
    }

    fn prefix(database: u64, object_store: u64, index: u64) -> Vec<u8> {
        fn byte_len(value: u64) -> usize {
            if value == 0 {
                1
            } else {
                ((64 - value.leading_zeros()) as usize).div_ceil(8)
            }
        }

        let database_len = byte_len(database);
        let object_store_len = byte_len(object_store);
        let index_len = byte_len(index);
        let first = (((database_len - 1) as u8) << 5)
            | (((object_store_len - 1) as u8) << 2)
            | ((index_len - 1) as u8);
        let mut bytes = vec![first];
        bytes.extend(encode_int(database));
        bytes.extend(encode_int(object_store));
        bytes.extend(encode_int(index));
        bytes
    }

    fn string_key(value: &str) -> Vec<u8> {
        let mut bytes = vec![1];
        bytes.extend(encode_varint(value.encode_utf16().count() as u64));
        bytes.extend(value.encode_utf16().flat_map(u16::to_be_bytes));
        bytes
    }

    fn global_database_name(origin: &str, name: &str) -> Vec<u8> {
        fn append_string(bytes: &mut Vec<u8>, value: &str) {
            bytes.extend(encode_varint(value.encode_utf16().count() as u64));
            bytes.extend(value.encode_utf16().flat_map(u16::to_be_bytes));
        }

        let mut bytes = prefix(0, 0, 0);
        bytes.push(201);
        append_string(&mut bytes, origin);
        append_string(&mut bytes, name);
        bytes
    }

    #[test]
    fn exposes_chromiums_real_comparator_name() {
        assert_eq!(IdbComparator.id(), "idb_cmp1");
    }

    #[test]
    fn compares_truncated_prefix_ids_numerically_not_bytewise() {
        let low = prefix(511, 1, OBJECT_STORE_DATA_INDEX);
        let high = prefix(512, 1, OBJECT_STORE_DATA_INDEX);
        assert_eq!(low.cmp(&high), Ordering::Greater);
        assert_eq!(IdbComparator.cmp(&low, &high), Ordering::Less);
    }

    #[test]
    fn follows_chromium_idb_key_type_order() {
        let base = prefix(1, 1, OBJECT_STORE_DATA_INDEX);
        let keys = [
            vec![5],
            [vec![3], 0.0f64.to_ne_bytes().to_vec()].concat(),
            [vec![2], 0.0f64.to_ne_bytes().to_vec()].concat(),
            string_key(""),
            vec![6, 0],
            vec![4, 0],
            vec![0],
        ];
        let encoded = keys
            .iter()
            .map(|suffix| [base.as_slice(), suffix.as_slice()].concat())
            .collect::<Vec<_>>();
        for pair in encoded.windows(2) {
            assert_eq!(IdbComparator.cmp(&pair[0], &pair[1]), Ordering::Less);
        }
    }

    #[test]
    fn compares_metadata_strings_by_value_not_length_prefix() {
        let z = global_database_name("origin", "z");
        let aa = global_database_name("origin", "aa");
        assert_eq!(IdbComparator.cmp(&z, &aa), Ordering::Greater);
    }

    #[test]
    fn compares_chromium_scope_suffixes_bytewise() {
        let mut lower = prefix(0, 0, 0);
        lower.extend([50, 1, 0x7f]);
        let mut higher = prefix(0, 0, 0);
        higher.extend([50, 1, 0x80]);

        assert_eq!(
            compare_global_metadata(&[50, 1, 0x7f], &[50, 1, 0x80]),
            Some(Ordering::Less)
        );
        assert_eq!(IdbComparator.cmp(&lower, &higher), Ordering::Less);
    }

    #[test]
    fn index_comparison_includes_primary_key_and_sequence_number() {
        let base = prefix(1, 1, MIN_INDEX_DATA_INDEX);
        let index_key = string_key("same");
        let mut first = base.clone();
        first.extend(&index_key);
        first.push(0);
        first.extend(string_key("a"));

        let mut second = base;
        second.extend(index_key);
        second.push(0);
        second.extend(string_key("b"));

        assert_eq!(IdbComparator.cmp(&first, &second), Ordering::Less);

        let mut sequence_one = prefix(1, 1, MIN_INDEX_DATA_INDEX);
        sequence_one.extend(string_key("same"));
        sequence_one.push(1);
        sequence_one.extend(string_key("primary"));
        let mut sequence_two = prefix(1, 1, MIN_INDEX_DATA_INDEX);
        sequence_two.extend(string_key("same"));
        sequence_two.push(2);
        sequence_two.extend(string_key("primary"));
        assert_eq!(
            IdbComparator.cmp(&sequence_one, &sequence_two),
            Ordering::Less
        );
    }

    #[test]
    fn binary_keys_compare_payloads_and_report_exact_consumed_lengths() {
        let first = [6, 2, 0xaa, 0xbb];
        let second = [6, 3, 0xaa, 0xbc, 0xdd];
        let comparison = compare_idb_key(&first, &second, 0).unwrap();
        assert_eq!(comparison.ordering, Ordering::Less);
        assert_eq!(comparison.consumed_a, first.len());
        assert_eq!(comparison.consumed_b, second.len());

        let mut indexed_first = prefix(1, 1, MIN_INDEX_DATA_INDEX);
        indexed_first.extend(first);
        indexed_first.push(0);
        indexed_first.extend(string_key("primary"));
        let mut indexed_second = prefix(1, 1, MIN_INDEX_DATA_INDEX);
        indexed_second.extend(second);
        indexed_second.push(0);
        indexed_second.extend(string_key("primary"));
        assert_eq!(
            IdbComparator.cmp(&indexed_first, &indexed_second),
            Ordering::Less
        );
        assert_eq!(
            compare_index_suffix(&indexed_first[4..], &indexed_second[4..]),
            Some(Ordering::Less)
        );
    }
}
