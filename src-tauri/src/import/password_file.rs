/* OmniSSH password-file parser.
 *
 * Format:
 *   - One `user@host = password` line per entry.
 *   - `#` and `;` comment lines, blank lines skipped.
 *   - CRLF or LF line endings; the last line may lack a terminator.
 *   - No section headers, no protocol/port prefixes.
 *   - UTF-8 (with optional BOM) or CP-1252 encoding.
 *   - MobaXterm's "Stored Passwords" export is one producer of this format.
 *
 * Secret-handling rules:
 *   - Passwords are stored in `zeroize::Zeroizing<String>` and zeroed on drop.
 *   - `Debug` is implemented manually on `PasswordEntry` to redact the secret.
 *   - Passwords never appear in `Display`, error strings, or tracing output.
 *   - `Serialize` is intentionally NOT derived on types that hold secrets. */

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;

use zeroize::Zeroizing;

use crate::types::SshError;

use super::mobaxterm::decode_mobaxterm_bytes;

/// Maximum byte size accepted for a password file (1 MiB).
pub const MAX_PASSWORD_FILE_BYTES: usize = 1024 * 1024;

/* A (user, host) pair used for deduplication and conflict tracking.
 * Host is stored lowercased for case-insensitive comparison. */
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct PasswordKey {
    pub user: String,
    pub host_lower: String,
}

impl std::fmt::Debug for PasswordKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasswordKey")
            .field("user", &self.user)
            .field("host_lower", &self.host_lower)
            .finish()
    }
}

/// A single parsed password entry with the original-case host preserved.
pub struct PasswordEntry {
    pub user: String,
    pub host: String,
    pub password: Zeroizing<String>,
}

impl std::fmt::Debug for PasswordEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasswordEntry")
            .field("user", &self.user)
            .field("host", &self.host)
            .field("password", &"[REDACTED]")
            .finish()
    }
}

/// Result of parsing a password file.
pub struct ParsedPasswordFile {
    pub entries: Vec<PasswordEntry>,
    pub conflicts: Vec<PasswordKey>,
    pub malformed_lines: Vec<usize>,
}

impl std::fmt::Debug for ParsedPasswordFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParsedPasswordFile")
            .field("entries", &self.entries)
            .field("conflicts", &self.conflicts)
            .field("malformed_lines", &self.malformed_lines)
            .finish()
    }
}

impl ParsedPasswordFile {
    /// Look up a password entry by user (case-sensitive) and host
    /// (ASCII case-insensitive).
    pub fn find(&self, user: &str, host: &str) -> Option<&PasswordEntry> {
        let host_lower = host.to_ascii_lowercase();
        self.entries
            .iter()
            .find(|e| e.user == user && e.host.to_ascii_lowercase() == host_lower)
    }

    /// Check whether a (user, host) pair was marked as a conflict (same key,
    /// different passwords). Host comparison is ASCII case-insensitive.
    pub fn is_conflict(&self, user: &str, host: &str) -> bool {
        let host_lower = host.to_ascii_lowercase();
        self.conflicts
            .iter()
            .any(|k| k.user == user && k.host_lower == host_lower)
    }
}

/// Read and parse a password file from disk with a bounded read.
pub fn read_password_file(path: &str) -> Result<ParsedPasswordFile, SshError> {
    let mut file =
        File::open(path).map_err(|_| SshError::IoError("Cannot read password file".to_string()))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take((MAX_PASSWORD_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| SshError::IoError("Cannot read password file".to_string()))?;
    parse_password_bytes(&bytes)
}

/// Parse raw bytes from a password file.
pub fn parse_password_bytes(bytes: &[u8]) -> Result<ParsedPasswordFile, SshError> {
    if bytes.len() > MAX_PASSWORD_FILE_BYTES {
        return Err(SshError::IoError("Password file is too large".to_string()));
    }

    let text = decode_mobaxterm_bytes(bytes)?;

    /* Track entries by their normalized key. Each key maps to either a single
     * known password (Some) or a conflict marker (None). This lets us detect
     * exact duplicates (same key + same password → collapse) vs true conflicts
     * (same key + different password → remove from entries, add to conflicts). */
    let mut key_map: HashMap<PasswordKey, Option<Zeroizing<String>>> = HashMap::new();
    let mut entries: Vec<PasswordEntry> = Vec::new();
    let mut conflicts: Vec<PasswordKey> = Vec::new();
    let mut malformed_lines: Vec<usize> = Vec::new();

    for (index, raw_line) in text.split('\n').enumerate() {
        let line_number = index + 1;
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);

        /* Skip blank/whitespace-only lines and comment lines. */
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }

        /* Split on the first " = " (spaced delimiter); fall back to the first
         * bare "=" if the spaced form is absent. */
        let (raw_key, raw_value) = if let Some(pos) = line.find(" = ") {
            let key = &line[..pos];
            let value = &line[pos + 3..];
            (key, value)
        } else if let Some(pos) = line.find('=') {
            let key = &line[..pos];
            let value = &line[pos + 1..];
            (key, value)
        } else {
            malformed_lines.push(line_number);
            continue;
        };

        let key_str = raw_key.trim();

        /* Reject keys containing whitespace, empty values, or keys that
         * don't match the user@host pattern (split on last @). */
        if key_str.contains(char::is_whitespace) || raw_value.is_empty() {
            malformed_lines.push(line_number);
            continue;
        }

        let Some(at_pos) = key_str.rfind('@') else {
            malformed_lines.push(line_number);
            continue;
        };
        let user_part = &key_str[..at_pos];
        let host_part = &key_str[at_pos + 1..];
        if user_part.is_empty() || host_part.is_empty() {
            malformed_lines.push(line_number);
            continue;
        }

        let password = Zeroizing::new(raw_value.to_string());
        let pk = PasswordKey {
            user: user_part.to_string(),
            host_lower: host_part.to_ascii_lowercase(),
        };

        match key_map.get(&pk) {
            Some(Some(existing_pw)) => {
                if *existing_pw == password {
                    /* Exact duplicate — collapse (skip this line). */
                    continue;
                }
                /* Conflict: same key, different password. Remove the
                 * existing entry, mark the key as conflicted. */
                key_map.insert(pk.clone(), None);
                entries.retain(|e| {
                    !(e.user == pk.user && e.host.to_ascii_lowercase() == pk.host_lower)
                });
                conflicts.push(pk);
            }
            Some(None) => {
                /* Already a known conflict — ignore further lines. */
                continue;
            }
            None => {
                key_map.insert(pk, Some(password.clone()));
                entries.push(PasswordEntry {
                    user: user_part.to_string(),
                    host: host_part.to_string(),
                    password,
                });
            }
        }
    }

    Ok(ParsedPasswordFile {
        entries,
        conflicts,
        malformed_lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ── Fixture: the user's real export (4 weblogic entries, CRLF, no trailing
     * newline). Verifies the exact byte sequence the plan was designed around. */
    #[test]
    fn parses_real_export_fixture() {
        let bytes = b"weblogic@10.94.97.29 = pass4\r\nweblogic@10.94.97.28 = pass3\r\nweblogic@10.94.97.27 = pass2\r\nweblogic@10.94.97.26 = pass1";
        let result = parse_password_bytes(bytes).expect("parse fixture");

        assert_eq!(result.entries.len(), 4);
        assert!(result.conflicts.is_empty());
        assert!(result.malformed_lines.is_empty());

        assert_eq!(result.entries[0].user, "weblogic");
        assert_eq!(result.entries[0].host, "10.94.97.29");
        assert_eq!(*result.entries[0].password, "pass4");

        assert_eq!(result.entries[1].host, "10.94.97.28");
        assert_eq!(*result.entries[1].password, "pass3");

        assert_eq!(result.entries[2].host, "10.94.97.27");
        assert_eq!(*result.entries[2].password, "pass2");

        assert_eq!(result.entries[3].host, "10.94.97.26");
        assert_eq!(*result.entries[3].password, "pass1");
    }

    /* ── Value containing `=` signs. */
    #[test]
    fn preserves_equals_in_value() {
        let bytes = b"admin@example.com = p=a=ss";
        let result = parse_password_bytes(bytes).expect("parse");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(*result.entries[0].password, "p=a=ss");
    }

    /* ── Value containing inner and trailing spaces. */
    #[test]
    fn preserves_inner_and_trailing_spaces_in_value() {
        let bytes = b"admin@example.com = hello world  ";
        let result = parse_password_bytes(bytes).expect("parse");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(*result.entries[0].password, "hello world  ");
    }

    /* ── Value containing `@`. */
    #[test]
    fn preserves_at_in_value() {
        let bytes = b"admin@example.com = p@ss@word";
        let result = parse_password_bytes(bytes).expect("parse");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(*result.entries[0].password, "p@ss@word");
    }

    /* ── Key splits on the last `@`. */
    #[test]
    fn splits_key_on_last_at() {
        let bytes = b"user@name@host.example = secret";
        let result = parse_password_bytes(bytes).expect("parse");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].user, "user@name");
        assert_eq!(result.entries[0].host, "host.example");
        assert_eq!(*result.entries[0].password, "secret");
    }

    /* ── Blank lines and comment lines are skipped. */
    #[test]
    fn skips_blank_and_comment_lines() {
        let bytes = b"# comment\n; another\n\n  \nuser@host = pw\n";
        let result = parse_password_bytes(bytes).expect("parse");
        assert_eq!(result.entries.len(), 1);
        assert!(result.malformed_lines.is_empty());
    }

    /* ── Malformed lines reported by 1-based line number. */
    #[test]
    fn reports_malformed_line_numbers() {
        let bytes = b"good@host = pw\nno-at-sign = val\nmissing_eq\n@nouser = val\nuser@ = val\nuser@host =\n";
        let result = parse_password_bytes(bytes).expect("parse");
        assert_eq!(result.entries.len(), 1);
        /* Line 2: no @ in key. Line 3: no =. Line 4: empty user.
         * Line 5: empty host. Line 6: empty value. */
        assert_eq!(result.malformed_lines, vec![2, 3, 4, 5, 6]);
    }

    /* ── Exact duplicate collapse. */
    #[test]
    fn collapses_exact_duplicates() {
        let bytes = b"user@host = pass\nuser@host = pass\n";
        let result = parse_password_bytes(bytes).expect("parse");
        assert_eq!(result.entries.len(), 1);
        assert!(result.conflicts.is_empty());
    }

    /* ── Conflict exclusion: same key, different passwords. */
    #[test]
    fn marks_conflicts_and_excludes_both_values() {
        let bytes = b"user@host = pass1\nuser@host = pass2\n";
        let result = parse_password_bytes(bytes).expect("parse");
        assert!(result.entries.is_empty());
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].user, "user");
        assert_eq!(result.conflicts[0].host_lower, "host");
    }

    /* ── Conflict when a third line with the same key appears. */
    #[test]
    fn conflict_ignores_further_lines_for_same_key() {
        let bytes = b"u@h = a\nu@h = b\nu@h = c\n";
        let result = parse_password_bytes(bytes).expect("parse");
        assert!(result.entries.is_empty());
        assert_eq!(result.conflicts.len(), 1);
    }

    /* ── Host lookup is case-insensitive. */
    #[test]
    fn find_is_host_case_insensitive() {
        let bytes = b"alice@Example.COM = secret";
        let result = parse_password_bytes(bytes).expect("parse");
        assert!(result.find("alice", "example.com").is_some());
        assert!(result.find("alice", "EXAMPLE.COM").is_some());
        assert!(result.find("alice", "Example.COM").is_some());
    }

    /* ── User lookup is case-sensitive. */
    #[test]
    fn find_is_user_case_sensitive() {
        let bytes = b"Alice@host = secret";
        let result = parse_password_bytes(bytes).expect("parse");
        assert!(result.find("Alice", "host").is_some());
        assert!(result.find("alice", "host").is_none());
    }

    /* ── is_conflict helper. */
    #[test]
    fn is_conflict_matches_correctly() {
        let bytes = b"u@Host = a\nu@host = b\n";
        let result = parse_password_bytes(bytes).expect("parse");
        assert!(result.is_conflict("u", "HOST"));
        assert!(result.is_conflict("u", "host"));
        assert!(!result.is_conflict("other", "host"));
    }

    /* ── Host case-insensitive dedup: same user, hosts differ only in case,
     * same password → collapse to one entry. */
    #[test]
    fn host_case_insensitive_duplicate_collapses() {
        let bytes = b"user@HOST = pass\nuser@host = pass\n";
        let result = parse_password_bytes(bytes).expect("parse");
        assert_eq!(result.entries.len(), 1);
        assert!(result.conflicts.is_empty());
    }

    /* ── Host case-insensitive conflict. */
    #[test]
    fn host_case_insensitive_conflict() {
        let bytes = b"user@HOST = pass1\nuser@host = pass2\n";
        let result = parse_password_bytes(bytes).expect("parse");
        assert!(result.entries.is_empty());
        assert_eq!(result.conflicts.len(), 1);
    }

    /* ── Over 1 MiB rejection. */
    #[test]
    fn rejects_oversized_input() {
        let bytes = vec![b'a'; MAX_PASSWORD_FILE_BYTES + 1];
        let error = parse_password_bytes(&bytes).expect_err("size limit");
        assert_eq!(error.to_string(), "I/O error: Password file is too large");
    }

    /* ── BOM is stripped before parsing. */
    #[test]
    fn handles_utf8_bom() {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(b"user@host = pw");
        let result = parse_password_bytes(&bytes).expect("parse BOM");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].user, "user");
    }

    /* ── CP-1252 byte decodes through shared decode_mobaxterm_bytes. */
    #[test]
    fn handles_cp1252_input() {
        let mut bytes = b"user@host = p".to_vec();
        bytes.push(0xe9); // é in CP-1252
        bytes.extend_from_slice(b"ss");
        let result = parse_password_bytes(&bytes).expect("parse CP-1252");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(*result.entries[0].password, "péss");
    }

    /* ── CRLF line endings. */
    #[test]
    fn handles_crlf() {
        let bytes = b"a@h1 = p1\r\nb@h2 = p2\r\n";
        let result = parse_password_bytes(bytes).expect("parse CRLF");
        assert_eq!(result.entries.len(), 2);
    }

    /* ── Last line without trailing newline. */
    #[test]
    fn handles_missing_trailing_newline() {
        let bytes = b"a@h1 = p1\nb@h2 = p2";
        let result = parse_password_bytes(bytes).expect("parse no trailing newline");
        assert_eq!(result.entries.len(), 2);
        assert_eq!(*result.entries[1].password, "p2");
    }

    /* ── Bare `=` fallback when no spaced form is present. */
    #[test]
    fn bare_equals_fallback() {
        let bytes = b"user@host=password";
        let result = parse_password_bytes(bytes).expect("parse bare =");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].user, "user");
        assert_eq!(result.entries[0].host, "host");
        assert_eq!(*result.entries[0].password, "password");
    }

    /* ── Debug output never contains the password. */
    #[test]
    fn debug_redacts_password() {
        let entry = PasswordEntry {
            user: "admin".to_string(),
            host: "example.com".to_string(),
            password: Zeroizing::new("super-secret-123".to_string()),
        };
        let debug_output = format!("{:?}", entry);
        assert!(
            !debug_output.contains("super-secret-123"),
            "Debug output must not contain the password"
        );
        assert!(debug_output.contains("REDACTED"));
    }

    /* ── read_password_file rejects missing files. */
    #[test]
    fn read_password_file_rejects_missing_file() {
        let error =
            read_password_file("/nonexistent/path/passwords.txt").expect_err("missing file");
        assert!(error.to_string().contains("Cannot read password file"));
    }

    /* ── read_password_file rejects files larger than MAX_PASSWORD_FILE_BYTES. */
    #[test]
    fn read_password_file_rejects_oversized_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("big.txt");
        let data = vec![b'x'; MAX_PASSWORD_FILE_BYTES + 1];
        std::fs::write(&path, &data).expect("write oversized file");

        let error = read_password_file(path.to_str().unwrap()).expect_err("size limit");
        assert_eq!(error.to_string(), "I/O error: Password file is too large");
    }

    /* ── read_password_file round-trip for a valid file. */
    #[test]
    fn read_password_file_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("passwords.txt");
        std::fs::write(&path, b"user@host = pw").expect("write");

        let result = read_password_file(path.to_str().unwrap()).expect("parse");
        assert_eq!(result.entries.len(), 1);
        assert_eq!(*result.entries[0].password, "pw");
    }
}
