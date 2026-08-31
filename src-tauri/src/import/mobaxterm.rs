use std::collections::HashSet;
use std::fs::File;
use std::io::Read;

use crate::types::SshError;

use super::SshConfigEntry;

const MAX_MOBAXTERM_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_MOBAXTERM_ENTRIES: usize = 10_000;
const MAX_SESSION_FIELDS: usize = 128;

/* MobaXterm stores bookmark rows as versioned, delimiter-separated values
 * inside INI-like `[Bookmarks*]` sections. The parser reads only a bounded
 * byte range, accepts the two encodings found in exported files, and uses
 * stable field indexes so newer trailing fields can be ignored safely. */

/// Parse a MobaXterm `.mxtsessions` or `MobaXterm.ini` file from disk.
pub fn parse_mobaxterm(
    path: &str,
    existing_hosts: &[(String, String, u16)],
) -> Result<Vec<SshConfigEntry>, SshError> {
    let mut file = File::open(path)
        .map_err(|_| SshError::IoError("Cannot read MobaXterm import file".to_string()))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take((MAX_MOBAXTERM_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| SshError::IoError("Cannot read MobaXterm import file".to_string()))?;
    parse_mobaxterm_bytes(&bytes, existing_hosts)
}

/// Parse MobaXterm file bytes. This is public for deterministic parser tests;
/// production callers should use [`parse_mobaxterm`] so Rust owns file reads.
pub fn parse_mobaxterm_bytes(
    bytes: &[u8],
    existing_hosts: &[(String, String, u16)],
) -> Result<Vec<SshConfigEntry>, SshError> {
    if bytes.len() > MAX_MOBAXTERM_FILE_BYTES {
        return Err(SshError::IoError(
            "MobaXterm import file is too large".to_string(),
        ));
    }

    let text = decode_mobaxterm_bytes(bytes)?;
    parse_bookmark_sections(&text, existing_hosts)
}

fn decode_mobaxterm_bytes(bytes: &[u8]) -> Result<String, SshError> {
    let content = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    match std::str::from_utf8(content) {
        Ok(text) => Ok(text.to_string()),
        Err(_) => Ok(decode_cp1252(content)),
    }
}

fn decode_cp1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| char::from_u32(cp1252_codepoint(*byte)).unwrap_or('\u{fffd}'))
        .collect()
}

fn cp1252_codepoint(byte: u8) -> u32 {
    match byte {
        0x80 => 0x20ac,
        0x82 => 0x201a,
        0x83 => 0x0192,
        0x84 => 0x201e,
        0x85 => 0x2026,
        0x86 => 0x2020,
        0x87 => 0x2021,
        0x88 => 0x02c6,
        0x89 => 0x2030,
        0x8a => 0x0160,
        0x8b => 0x2039,
        0x8c => 0x0152,
        0x8e => 0x017d,
        0x91 => 0x2018,
        0x92 => 0x2019,
        0x93 => 0x201c,
        0x94 => 0x201d,
        0x95 => 0x2022,
        0x96 => 0x2013,
        0x97 => 0x2014,
        0x98 => 0x02dc,
        0x99 => 0x2122,
        0x9a => 0x0161,
        0x9b => 0x203a,
        0x9c => 0x0153,
        0x9e => 0x017e,
        0x9f => 0x0178,
        0x81 | 0x8d | 0x8f | 0x90 | 0x9d => 0xfffd,
        other => u32::from(other),
    }
}

fn parse_bookmark_sections(
    text: &str,
    existing_hosts: &[(String, String, u16)],
) -> Result<Vec<SshConfigEntry>, SshError> {
    let existing_keys: HashSet<(String, String, u16)> = existing_hosts.iter().cloned().collect();
    let mut seen_keys = HashSet::new();
    let mut in_bookmarks = false;
    let mut current_group_path: Option<String> = None;
    let mut entries = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') {
            continue;
        }

        if is_bookmark_section(trimmed) {
            in_bookmarks = true;
            current_group_path = None;
            continue;
        }
        if trimmed.starts_with('[') {
            in_bookmarks = false;
            current_group_path = None;
            continue;
        }
        if !in_bookmarks {
            continue;
        }

        let Some((raw_key, raw_value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        let value = raw_value.trim();

        if key.eq_ignore_ascii_case("subrep") {
            current_group_path = flatten_group_path(value);
            continue;
        }
        if key.eq_ignore_ascii_case("imgnum")
            || key.is_empty()
            || !(value.starts_with('#') || value.starts_with("; logout"))
        {
            continue;
        }

        let Some(mut entry) = parse_session_record(key, value, current_group_path.as_deref())
        else {
            continue;
        };

        let dedup_key = (
            entry.hostname.clone().unwrap_or_default(),
            entry.user.clone().unwrap_or_default(),
            entry.port.unwrap_or(22),
        );
        if !seen_keys.insert(dedup_key.clone()) {
            continue;
        }
        entry.already_exists = existing_keys.contains(&dedup_key);

        if entries.len() >= MAX_MOBAXTERM_ENTRIES {
            return Err(SshError::IoError(
                "MobaXterm import contains too many sessions".to_string(),
            ));
        }
        entries.push(entry);
    }

    Ok(entries)
}

fn is_bookmark_section(line: &str) -> bool {
    let Some(name) = line
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .map(str::trim)
    else {
        return false;
    };
    let normalized = name.to_ascii_lowercase();
    if normalized == "bookmarks" {
        return true;
    }
    let Some(suffix) = normalized.strip_prefix("bookmarks_") else {
        return false;
    };
    !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
}

fn flatten_group_path(value: &str) -> Option<String> {
    let parts = value
        .split(['\\', '/'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(" / "))
}

fn parse_session_record(
    label: &str,
    encoded: &str,
    group_path: Option<&str>,
) -> Option<SshConfigEntry> {
    let encoded = encoded
        .strip_prefix("; logout")
        .map(str::trim_start)
        .unwrap_or(encoded);
    if !encoded.starts_with('#') {
        return None;
    }

    let mut outer = encoded.splitn(7, '#');
    outer.next()?;
    let _icon = outer.next()?;
    let first_group = outer.next()?;
    let _terminal_settings = outer.next();
    let _start_mode = outer.next();
    let comments = outer.next().unwrap_or_default();

    let fields = first_group
        .split('%')
        .take(MAX_SESSION_FIELDS)
        .collect::<Vec<_>>();
    let session_type = fields.first()?.trim();
    match session_type {
        "0" => parse_ssh_record(label, &fields, group_path, comments),
        "7" => parse_sftp_record(label, &fields, group_path, comments),
        _ => None,
    }
}

fn parse_ssh_record(
    label: &str,
    fields: &[&str],
    group_path: Option<&str>,
    comments: &str,
) -> Option<SshConfigEntry> {
    let hostname = required_field(fields, 1)?;
    let user = normalize_username(field(fields, 3));
    let mut warnings = Vec::new();

    let port = parse_port_with_warnings(fields, 2, &mut warnings);
    let proxy_jump = parse_ssh_gateway(fields, &mut warnings);
    warn_for_ssh_proxy(fields, &mut warnings);

    Some(SshConfigEntry {
        host_alias: label.to_string(),
        hostname: Some(hostname.to_string()),
        user: Some(user),
        port: Some(port),
        identity_file: nonempty_field(fields, 14),
        proxy_jump,
        keep_alive_interval: None,
        is_pattern: false,
        already_exists: false,
        group_path: group_path.map(str::to_string),
        startup_command: decode_optional_value(field(fields, 7)),
        notes: decode_optional_value(comments),
        warnings,
    })
}

fn parse_sftp_record(
    label: &str,
    fields: &[&str],
    group_path: Option<&str>,
    comments: &str,
) -> Option<SshConfigEntry> {
    let hostname = required_field(fields, 1)?;
    let mut warnings = Vec::new();
    let port = parse_port_with_warnings(fields, 2, &mut warnings);
    warn_for_sftp_proxy(fields, &mut warnings);

    Some(SshConfigEntry {
        host_alias: label.to_string(),
        hostname: Some(hostname.to_string()),
        user: Some(normalize_username(field(fields, 3))),
        port: Some(port),
        identity_file: nonempty_field(fields, 9),
        proxy_jump: None,
        keep_alive_interval: None,
        is_pattern: false,
        already_exists: false,
        group_path: group_path.map(str::to_string),
        startup_command: None,
        notes: decode_optional_value(comments),
        warnings,
    })
}

fn field<'a>(fields: &'a [&str], index: usize) -> &'a str {
    fields.get(index).copied().unwrap_or_default().trim()
}

fn required_field<'a>(fields: &'a [&str], index: usize) -> Option<&'a str> {
    let value = field(fields, index);
    (!value.is_empty()).then_some(value)
}

fn nonempty_field(fields: &[&str], index: usize) -> Option<String> {
    let value = field(fields, index);
    (!value.is_empty()).then(|| value.to_string())
}

fn normalize_username(value: &str) -> String {
    if value.is_empty() || value.eq_ignore_ascii_case("<default>") {
        "root".to_string()
    } else {
        value.to_string()
    }
}

fn parse_port_with_warnings(fields: &[&str], index: usize, warnings: &mut Vec<String>) -> u16 {
    let value = field(fields, index);
    if value.is_empty() {
        return 22;
    }
    match value.parse::<u16>().ok().filter(|port| *port != 0) {
        Some(port) => port,
        None => {
            add_warning(warnings, "An invalid MobaXterm port was replaced with 22.");
            22
        }
    }
}

fn decode_optional_value(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    Some(
        value
            .replace("__DIEZE__", "#")
            .replace("__PTVIRG__", ";")
            .replace("__PERCENT__", "%"),
    )
}

fn gateway_list(value: &str) -> Vec<&str> {
    if value.trim().is_empty() {
        Vec::new()
    } else {
        value.split("__PIPE__").map(str::trim).collect()
    }
}

fn parse_ssh_gateway(fields: &[&str], warnings: &mut Vec<String>) -> Option<String> {
    let hosts = gateway_list(field(fields, 8));
    let ports = gateway_list(field(fields, 9));
    let users = gateway_list(field(fields, 10));
    let gateway_key = field(fields, 15);
    let gateway_present = !hosts.is_empty() || !ports.is_empty() || !users.is_empty();

    if !gateway_key.is_empty() {
        add_warning(
            warnings,
            "MobaXterm gateway key settings are not supported; only the target key path was preserved.",
        );
    }
    if !gateway_present {
        return None;
    }

    let gateway_count = hosts.len().max(ports.len()).max(users.len());
    if gateway_count != 1 || hosts.first().is_none_or(|host| host.is_empty()) {
        add_warning(
            warnings,
            "Multiple or incomplete MobaXterm SSH gateways are not supported; no ProxyJump was imported.",
        );
        return None;
    }

    let host = hosts[0];
    let user = users.first().copied().filter(|value| !value.is_empty());
    let port = ports
        .first()
        .copied()
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<u16>().ok().filter(|port| *port != 0))
        .unwrap_or(22);
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    Some(match user {
        Some(user) => format!("{user}@{host}:{port}"),
        None => format!("{host}:{port}"),
    })
}

fn warn_for_ssh_proxy(fields: &[&str], warnings: &mut Vec<String>) {
    let proxy_type = field(fields, 19);
    let has_proxy_values = !field(fields, 20).is_empty()
        || !field(fields, 22).is_empty()
        || !field(fields, 26).is_empty();
    if (!proxy_type.is_empty() && proxy_type != "0") || has_proxy_values {
        add_warning(
            warnings,
            "MobaXterm proxy settings are not supported; proxy fields were not imported.",
        );
    }
}

fn warn_for_sftp_proxy(fields: &[&str], warnings: &mut Vec<String>) {
    let proxy_type = field(fields, 10);
    let has_proxy_values = !field(fields, 11).is_empty()
        || !field(fields, 13).is_empty()
        || !field(fields, 14).is_empty();
    if (!proxy_type.is_empty() && proxy_type != "0") || has_proxy_values {
        add_warning(
            warnings,
            "MobaXterm SFTP proxy settings are not supported; proxy fields were not imported.",
        );
    }
}

fn add_warning(warnings: &mut Vec<String>, warning: &'static str) {
    if !warnings.iter().any(|existing| existing == warning) {
        warnings.push(warning.to_string());
    }
}

/* These tests pin the shared preview contract and the data that must survive
 * MobaXterm's versioned bookmark record format before the parser is added. */
#[cfg(test)]
mod tests {
    use super::{parse_mobaxterm_bytes, MAX_MOBAXTERM_ENTRIES};

    const SSH_RECORD: &str =
        "#109#0%target.example%2222%alice%%-1%-1%echo __PTVIRG__ ready%gateway.example%2200%jump%%-1%0%C:\\keys\\target.ppk%gateway-key%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0#MobaFont%10%0%0%0%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%0%-1#0#production server#-1";

    #[test]
    fn parses_utf8_bom_ssh_record_and_preserves_import_metadata() {
        let contents = format!(
            "[Bookmarks]\nSubRep=Production\\\\Web\nAlpha={}\n",
            SSH_RECORD
        );
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(contents.as_bytes());

        let entries = parse_mobaxterm_bytes(&bytes, &[]).expect("parse UTF-8 BOM");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host_alias, "Alpha");
        assert_eq!(entries[0].hostname.as_deref(), Some("target.example"));
        assert_eq!(entries[0].user.as_deref(), Some("alice"));
        assert_eq!(entries[0].port, Some(2222));
        assert_eq!(entries[0].group_path.as_deref(), Some("Production / Web"));
        assert_eq!(entries[0].startup_command.as_deref(), Some("echo ; ready"));
        assert_eq!(entries[0].notes.as_deref(), Some("production server"));
        assert_eq!(
            entries[0].proxy_jump.as_deref(),
            Some("jump@gateway.example:2200")
        );
        assert_eq!(
            entries[0].identity_file.as_deref(),
            Some("C:\\keys\\target.ppk")
        );
    }

    #[test]
    fn keeps_username_less_sftp_sessions_as_root_and_reads_cp1252() {
        let mut contents = b"[Bookmarks]\r\nSubRep=\r\nSftp ".to_vec();
        contents.push(0x80);
        contents.extend_from_slice(b"=#140#7%files.example%22%%%0%0%/srv/files%0%C:\\keys\\files.ppk%0%0%0%0%0%0%0%0#MobaFont%10%0%0%0%15%0%0%0%0%0%0%0%0%0%0#0#Caf");
        contents.push(0xe9);
        contents.extend_from_slice(b"#-1\r\n");
        let entries = parse_mobaxterm_bytes(&contents, &[]).expect("parse CP1252");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].host_alias, "Sftp €");
        assert_eq!(entries[0].hostname.as_deref(), Some("files.example"));
        assert_eq!(entries[0].user.as_deref(), Some("root"));
        assert_eq!(entries[0].port, Some(22));
        assert_eq!(entries[0].notes.as_deref(), Some("Café"));
        assert_eq!(
            entries[0].identity_file.as_deref(),
            Some("C:\\keys\\files.ppk")
        );
    }

    #[test]
    fn skips_duplicate_addresses_and_marks_existing_hosts() {
        let first = "#109#0%host.example%22%root%";
        let contents =
            format!("[Bookmarks]\nOne={first}\nTwo={first}\nThree=#109#0%other.example%22%root%\n");
        let entries = parse_mobaxterm_bytes(
            contents.as_bytes(),
            &[("host.example".to_string(), "root".to_string(), 22)],
        )
        .expect("parse duplicates");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].host_alias, "One");
        assert!(entries[0].already_exists);
        assert_eq!(entries[1].hostname.as_deref(), Some("other.example"));
    }

    #[test]
    fn warns_for_multiple_gateways_without_copying_gateway_values() {
        let record = "#109#0%target.example%22%root%%-1%-1%%gw1__PIPE__gw2%22__PIPE__22%u1__PIPE__u2%0%0%0%%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0%0#MobaFont#0#-1";
        let entries =
            parse_mobaxterm_bytes(format!("[Bookmarks]\nTarget={record}\n").as_bytes(), &[])
                .expect("parse multiple gateway record");

        assert_eq!(entries.len(), 1);
        assert!(entries[0].proxy_jump.is_none());
        assert!(entries[0]
            .warnings
            .iter()
            .any(|warning| warning.contains("MobaXterm SSH gateways are not supported")));
        assert!(!entries[0]
            .warnings
            .iter()
            .any(|warning| warning.contains("gw1")));
    }

    #[test]
    fn rejects_an_unbounded_input_file() {
        let bytes = vec![b'a'; 16 * 1024 * 1024 + 1];
        let error = parse_mobaxterm_bytes(&bytes, &[]).expect_err("size limit");
        assert!(error.to_string().contains("too large"));
    }

    #[test]
    fn accepts_versioned_sections_optional_logout_and_ignores_trailing_fields() {
        let mut fields = vec!["0", "nested.example", "22", ""];
        fields.extend(std::iter::repeat_n("ignored", 180));
        let record = format!("#109#{}#MobaFont#0#nested note#-1", fields.join("%"));
        let contents = format!(
            "[Other]\nIgnored=#109#4%not-an-ssh-host%3389\n[BOOKMARKS_12]\nSubRep=Parent\\\\Child\nNested=; logout{record}\n"
        );

        let entries = parse_mobaxterm_bytes(contents.as_bytes(), &[]).expect("parse sections");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].hostname.as_deref(), Some("nested.example"));
        assert_eq!(entries[0].user.as_deref(), Some("root"));
        assert_eq!(entries[0].group_path.as_deref(), Some("Parent / Child"));
        assert_eq!(entries[0].notes.as_deref(), Some("nested note"));
    }

    #[test]
    fn rejects_more_than_the_session_limit() {
        let mut contents = String::from("[Bookmarks]\n");
        for index in 0..=MAX_MOBAXTERM_ENTRIES {
            contents.push_str(&format!(
                "Host {index}=#109#0%host-{index}.example%22%root%\n"
            ));
        }

        let error = parse_mobaxterm_bytes(contents.as_bytes(), &[]).expect_err("entry limit");
        assert!(error.to_string().contains("too many sessions"));
    }
}
