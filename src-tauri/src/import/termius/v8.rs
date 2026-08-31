/*
 * This models the small structured-clone subset used by Termius records.
 * Values remain an explicit enum so JavaScript undefined is not conflated
 * with JSON null; unknown tags fail with their source offset.
 */

use std::collections::BTreeMap;
use thiserror::Error;

const V8_VERSION_TAG: u8 = 0xff;
const V8_LATEST_VERSION: u32 = 15;
const PADDING_TAG: u8 = 0x00;
const VERIFY_OBJECT_COUNT_TAG: u8 = b'?';
const UNDEFINED_TAG: u8 = b'_';
const NULL_TAG: u8 = b'0';
const TRUE_TAG: u8 = b'T';
const FALSE_TAG: u8 = b'F';
const INT32_TAG: u8 = b'I';
const UINT32_TAG: u8 = b'U';
const DOUBLE_TAG: u8 = b'N';
const UTF8_STRING_TAG: u8 = b'S';
const ONE_BYTE_STRING_TAG: u8 = b'"';
const TWO_BYTE_STRING_TAG: u8 = b'c';
const BEGIN_OBJECT_TAG: u8 = b'o';
const END_OBJECT_TAG: u8 = b'{';
const BEGIN_DENSE_ARRAY_TAG: u8 = b'A';
const END_DENSE_ARRAY_TAG: u8 = b'$';
const MAX_DEPTH: usize = 128;
const MAX_COLLECTION_LENGTH: usize = 1_000_000;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Undefined,
    Bool(bool),
    Int32(i32),
    Uint32(u32),
    Float64(f64),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum V8Error {
    #[error("unsupported V8 structured-clone tag 0x{tag:02x} at offset {offset}")]
    Unsupported { tag: u8, offset: usize },
    #[error("unsupported V8 structured-clone version {version} at offset {offset}")]
    UnsupportedVersion { version: u32, offset: usize },
    #[error("truncated V8 structured-clone value at offset {offset}")]
    Truncated { offset: usize },
    #[error("invalid V8 structured-clone data at offset {offset}")]
    Invalid { offset: usize },
    #[error("V8 structured-clone nesting or collection limit exceeded at offset {offset}")]
    Limit { offset: usize },
}

pub fn decode(bytes: &[u8]) -> Result<Value, V8Error> {
    let mut decoder = Decoder { bytes, offset: 0 };
    decoder.read_header()?;
    let value = decoder.value(0)?;
    decoder.ensure_padding_only()?;
    Ok(value)
}

pub fn string_field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    match value {
        Value::Object(values) => match values.get(name) {
            Some(Value::String(string)) => Some(string),
            _ => None,
        },
        _ => None,
    }
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn read_header(&mut self) -> Result<(), V8Error> {
        if self.bytes.first() != Some(&V8_VERSION_TAG) {
            return Ok(());
        }

        let offset = self.offset;
        self.offset += 1;
        let version = self.varint()?;
        if version > V8_LATEST_VERSION {
            return Err(V8Error::UnsupportedVersion { version, offset });
        }
        Ok(())
    }

    fn byte(&mut self) -> Result<u8, V8Error> {
        let byte = *self.bytes.get(self.offset).ok_or(V8Error::Truncated {
            offset: self.offset,
        })?;
        self.offset += 1;
        Ok(byte)
    }

    fn take<const N: usize>(&mut self) -> Result<[u8; N], V8Error> {
        let end = self.offset.checked_add(N).ok_or(V8Error::Limit {
            offset: self.offset,
        })?;
        let bytes = self.bytes.get(self.offset..end).ok_or(V8Error::Truncated {
            offset: self.offset,
        })?;
        self.offset = end;
        bytes.try_into().map_err(|_| V8Error::Invalid {
            offset: self.offset - N,
        })
    }

    fn varint(&mut self) -> Result<u32, V8Error> {
        let start = self.offset;
        let mut value = 0u32;
        for index in 0..5 {
            let byte = self.byte()?;
            let shift = index * 7;
            if index == 4 && byte & 0x7f > 0x0f {
                return Err(V8Error::Invalid { offset: start });
            }
            value |= u32::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(V8Error::Invalid { offset: start })
    }

    fn read_tag(&mut self) -> Result<(u8, usize), V8Error> {
        loop {
            let offset = self.offset;
            let tag = self.byte()?;
            if tag != PADDING_TAG {
                return Ok((tag, offset));
            }
        }
    }

    fn ensure_padding_only(&mut self) -> Result<(), V8Error> {
        while self.offset < self.bytes.len() {
            let offset = self.offset;
            if self.byte()? != PADDING_TAG {
                return Err(V8Error::Invalid { offset });
            }
        }
        Ok(())
    }

    fn length(&mut self, offset: usize) -> Result<usize, V8Error> {
        let length = self.varint()? as usize;
        if length > MAX_COLLECTION_LENGTH {
            return Err(V8Error::Limit { offset });
        }
        Ok(length)
    }

    fn string(&mut self, tag: u8, offset: usize) -> Result<String, V8Error> {
        let byte_length = self.varint()? as usize;
        if byte_length > MAX_COLLECTION_LENGTH {
            return Err(V8Error::Limit { offset });
        }

        match tag {
            UTF8_STRING_TAG => {
                let bytes = self.take_slice(byte_length)?;
                String::from_utf8(bytes.to_vec()).map_err(|_| V8Error::Invalid { offset })
            }
            ONE_BYTE_STRING_TAG => {
                let bytes = self.take_slice(byte_length)?;
                Ok(bytes.iter().map(|byte| char::from(*byte)).collect())
            }
            TWO_BYTE_STRING_TAG => {
                if !byte_length.is_multiple_of(2) {
                    return Err(V8Error::Invalid { offset });
                }
                let bytes = self.take_slice(byte_length)?;
                let units = bytes
                    .chunks_exact(2)
                    .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
                    .collect::<Vec<_>>();
                String::from_utf16(&units).map_err(|_| V8Error::Invalid { offset })
            }
            _ => Err(V8Error::Unsupported { tag, offset }),
        }
    }

    fn take_slice(&mut self, length: usize) -> Result<&'a [u8], V8Error> {
        let end = self.offset.checked_add(length).ok_or(V8Error::Limit {
            offset: self.offset,
        })?;
        let bytes = self.bytes.get(self.offset..end).ok_or(V8Error::Truncated {
            offset: self.offset,
        })?;
        self.offset = end;
        Ok(bytes)
    }

    fn value(&mut self, depth: usize) -> Result<Value, V8Error> {
        if depth > MAX_DEPTH {
            return Err(V8Error::Limit {
                offset: self.offset,
            });
        }

        let (tag, offset) = self.read_tag()?;
        match tag {
            VERIFY_OBJECT_COUNT_TAG => {
                self.varint()?;
                self.value(depth)
            }
            UNDEFINED_TAG => Ok(Value::Undefined),
            NULL_TAG => Ok(Value::Null),
            TRUE_TAG => Ok(Value::Bool(true)),
            FALSE_TAG => Ok(Value::Bool(false)),
            INT32_TAG => {
                let encoded = self.varint()?;
                let value = ((encoded >> 1) as i32) ^ -((encoded & 1) as i32);
                Ok(Value::Int32(value))
            }
            UINT32_TAG => Ok(Value::Uint32(self.varint()?)),
            DOUBLE_TAG => Ok(Value::Float64(f64::from_ne_bytes(self.take()?))),
            UTF8_STRING_TAG | ONE_BYTE_STRING_TAG | TWO_BYTE_STRING_TAG => {
                Ok(Value::String(self.string(tag, offset)?))
            }
            BEGIN_OBJECT_TAG => self.object(depth),
            BEGIN_DENSE_ARRAY_TAG => self.dense_array(depth, offset),
            _ => Err(V8Error::Unsupported { tag, offset }),
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, V8Error> {
        let mut values = BTreeMap::new();
        let mut property_count = 0usize;
        loop {
            let (tag, tag_offset) = self.peek_tag()?;
            if tag == END_OBJECT_TAG {
                self.read_tag()?;
                let expected_count = self.length(tag_offset)?;
                if expected_count != property_count {
                    return Err(V8Error::Invalid { offset: tag_offset });
                }
                return Ok(Value::Object(values));
            }
            if tag == PADDING_TAG {
                unreachable!("peek_tag skips padding");
            }
            if property_count >= MAX_COLLECTION_LENGTH {
                return Err(V8Error::Limit { offset: tag_offset });
            }

            let key = match self.value(depth + 1)? {
                Value::String(key) => key,
                _ => return Err(V8Error::Invalid { offset: tag_offset }),
            };
            let value = self.value(depth + 1)?;
            values.insert(key, value);
            property_count = property_count
                .checked_add(1)
                .ok_or(V8Error::Limit { offset: tag_offset })?;
        }
    }

    fn dense_array(&mut self, depth: usize, offset: usize) -> Result<Value, V8Error> {
        let length = self.length(offset)?;
        let mut values = Vec::with_capacity(length);
        for _ in 0..length {
            values.push(self.value(depth + 1)?);
        }

        let mut property_count = 0usize;
        loop {
            let (tag, tag_offset) = self.peek_tag()?;
            if tag == END_DENSE_ARRAY_TAG {
                self.read_tag()?;
                let expected_property_count = self.length(tag_offset)?;
                let encoded_length = self.varint()?;
                if expected_property_count != property_count || encoded_length as usize != length {
                    return Err(V8Error::Invalid { offset: tag_offset });
                }
                return Ok(Value::Array(values));
            }
            if property_count >= MAX_COLLECTION_LENGTH {
                return Err(V8Error::Limit { offset: tag_offset });
            }

            let key = self.value(depth + 1)?;
            if !matches!(key, Value::String(_)) {
                return Err(V8Error::Invalid { offset: tag_offset });
            }
            self.value(depth + 1)?;
            property_count = property_count
                .checked_add(1)
                .ok_or(V8Error::Limit { offset: tag_offset })?;
        }
    }

    fn peek_tag(&self) -> Result<(u8, usize), V8Error> {
        let mut offset = self.offset;
        while self.bytes.get(offset) == Some(&PADDING_TAG) {
            offset += 1;
        }
        let tag = *self
            .bytes
            .get(offset)
            .ok_or(V8Error::Truncated { offset })?;
        Ok((tag, offset))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(value: u32) -> Vec<u8> {
        let mut value = value;
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

    #[test]
    fn decodes_golden_primitive_tags() {
        assert_eq!(decode(b"0").unwrap(), Value::Null);
        assert_eq!(decode(b"_").unwrap(), Value::Undefined);
        assert_eq!(decode(b"T").unwrap(), Value::Bool(true));
        assert_eq!(decode(b"F").unwrap(), Value::Bool(false));
        assert_eq!(decode(&[b'I', 0x03]).unwrap(), Value::Int32(-2));
        assert_eq!(decode(&[b'U', 0xac, 0x02]).unwrap(), Value::Uint32(300));

        let mut double = vec![b'N'];
        double.extend(std::f64::consts::PI.to_le_bytes());
        assert_eq!(
            decode(&double).unwrap(),
            Value::Float64(std::f64::consts::PI)
        );
    }

    #[test]
    fn decodes_header_and_string_encodings() {
        assert_eq!(
            decode(&[0xff, 0x0f, b'"', 0x02, b'h', b'i']).unwrap(),
            Value::String("hi".into())
        );

        let two_byte = [0xff, 0x0f, b'c', 0x02, 0xe9, 0x00];
        assert_eq!(decode(&two_byte).unwrap(), Value::String("é".into()));

        let padded = [0xff, 0x0f, 0x00, b'c', 0x02, b'a', 0x00];
        assert_eq!(decode(&padded).unwrap(), Value::String("a".into()));
    }

    #[test]
    fn decodes_plain_object_and_dense_array_wire_shapes() {
        let object = [b'o', b'"', 0x01, b'x', b'I', 0x02, b'{', 0x01];
        let mut expected = BTreeMap::new();
        expected.insert("x".into(), Value::Int32(1));
        assert_eq!(decode(&object).unwrap(), Value::Object(expected));

        let array = [b'A', 0x02, b'I', 0x00, b'U', 0x02, b'$', 0x00, 0x02];
        assert_eq!(
            decode(&array).unwrap(),
            Value::Array(vec![Value::Int32(0), Value::Uint32(2)])
        );
    }

    #[test]
    fn unsupported_tag_reports_tag_and_byte_offset() {
        assert_eq!(
            decode(&[0x09]),
            Err(V8Error::Unsupported {
                tag: 0x09,
                offset: 0
            })
        );
        assert_eq!(
            decode(&[0x00, 0x09]),
            Err(V8Error::Unsupported {
                tag: 0x09,
                offset: 1
            })
        );
    }

    #[test]
    fn rejects_trailing_non_padding_data() {
        assert_eq!(decode(b"0T"), Err(V8Error::Invalid { offset: 1 }));
        assert!(decode(&[b'0', 0, 0]).is_ok());
        assert_eq!(varint(300), vec![0xac, 0x02]);
    }

    #[test]
    fn rejects_mismatched_property_counts() {
        assert_eq!(
            decode(&[b'o', b'{', 0x01]),
            Err(V8Error::Invalid { offset: 1 })
        );
        assert_eq!(
            decode(&[b'A', 0x00, b'$', 0x01, 0x00]),
            Err(V8Error::Invalid { offset: 2 })
        );
    }

    #[test]
    fn limits_object_and_dense_array_extra_properties() {
        let mut object = Vec::with_capacity(1 + (MAX_COLLECTION_LENGTH + 1) * 3);
        object.push(BEGIN_OBJECT_TAG);
        for _ in 0..=MAX_COLLECTION_LENGTH {
            object.extend([ONE_BYTE_STRING_TAG, 0, NULL_TAG]);
        }
        assert!(matches!(decode(&object), Err(V8Error::Limit { .. })));

        let mut array = Vec::with_capacity(2 + (MAX_COLLECTION_LENGTH + 1) * 3);
        array.extend([BEGIN_DENSE_ARRAY_TAG, 0]);
        for _ in 0..=MAX_COLLECTION_LENGTH {
            array.extend([ONE_BYTE_STRING_TAG, 0, NULL_TAG]);
        }
        assert!(matches!(decode(&array), Err(V8Error::Limit { .. })));
    }
}
