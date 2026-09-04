/*
 * Local filesystem inspection module for the host explorer.
 *
 * Provides typed Tauri commands for retrieving the user home directory and
 * listing local directories with normalized metadata, breadcrumb segments,
 * parent derivation, and symlink classification. All filesystem I/O is
 * performed within `tokio::task::spawn_blocking` to avoid blocking the async
 * runtime executor. Error messages are sanitized and path-free to prevent
 * leaking local filesystem structure in logs and telemetry.
 */

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

// ─── Errors ───────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum LocalFsError {
    #[error("Failed to determine home directory")]
    HomeDirNotFound,
    #[error("Path not found")]
    NotFound,
    #[error("Permission denied")]
    PermissionDenied,
    #[error("Path is not a directory")]
    NotADirectory,
    #[error("Invalid path")]
    InvalidPath,
    #[error("Local I/O error: {0}")]
    IoError(String),
}

impl From<std::io::Error> for LocalFsError {
    fn from(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => LocalFsError::NotFound,
            std::io::ErrorKind::PermissionDenied => LocalFsError::PermissionDenied,
            std::io::ErrorKind::NotADirectory => LocalFsError::NotADirectory,
            std::io::ErrorKind::InvalidInput => LocalFsError::InvalidPath,
            _ => LocalFsError::IoError(err.to_string()),
        }
    }
}

/// Serialize as `{ kind, message }` — matching SftpError and SshError convention.
impl Serialize for LocalFsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("LocalFsError", 2)?;
        let kind = match self {
            LocalFsError::HomeDirNotFound => "home_dir_not_found",
            LocalFsError::NotFound => "not_found",
            LocalFsError::PermissionDenied => "permission_denied",
            LocalFsError::NotADirectory => "not_a_directory",
            LocalFsError::InvalidPath => "invalid_path",
            LocalFsError::IoError(_) => "io_error",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

// ─── Data types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BreadcrumbSegment {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LocalEntryType {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub entry_type: LocalEntryType,
    pub size: u64,
    pub modified: Option<u64>,
    pub is_symlink: bool,
    pub permissions: Option<u32>,
    pub permissions_display: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LocalDirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub segments: Vec<BreadcrumbSegment>,
    pub entries: Vec<LocalEntry>,
}

// ─── Pure Helpers ─────────────────────────────────────────────────────────────

/*
 * Convert a raw Unix mode word into a 9-character `rwxrwxrwx` string.
 * Only the lower 9 permission bits are examined, matching the SFTP formatting.
 */
pub fn format_permissions(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    let flags: [(u32, char); 9] = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for (bit, ch) in flags {
        s.push(if mode & bit != 0 { ch } else { '-' });
    }
    s
}

/*
 * Build breadcrumb segments and derive the parent directory path across platforms.
 * Uses std::path::Component to cleanly handle Unix roots (/), Windows drive
 * prefixes (C:\), and UNC network shares (\\server\share\) without manual
 * slash-splitting.
 */
pub fn build_breadcrumbs_and_parent(path: &Path) -> (Option<String>, Vec<BreadcrumbSegment>) {
    let mut segments = Vec::new();
    let mut current = PathBuf::new();

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                current.push(prefix.as_os_str());
            }
            Component::RootDir => {
                current.push(component.as_os_str());
                let p_str = current.to_string_lossy().to_string();
                segments.push(BreadcrumbSegment {
                    label: p_str.clone(),
                    path: p_str,
                });
            }
            Component::Normal(name) => {
                let had_root = !current.as_os_str().is_empty();
                current.push(name);
                let p_str = current.to_string_lossy().to_string();
                let label = if had_root {
                    name.to_string_lossy().to_string()
                } else {
                    p_str.clone()
                };
                segments.push(BreadcrumbSegment { label, path: p_str });
            }
            Component::CurDir => {}
            Component::ParentDir => {
                current.pop();
                segments.pop();
            }
        }
    }

    if segments.is_empty() && !current.as_os_str().is_empty() {
        let p_str = current.to_string_lossy().to_string();
        segments.push(BreadcrumbSegment {
            label: p_str.clone(),
            path: p_str,
        });
    }

    let parent = path.parent().and_then(|p| {
        let s = p.to_string_lossy().to_string();
        if s.is_empty() || p == path {
            None
        } else {
            Some(s)
        }
    });

    (parent, segments)
}

/*
 * Classify a directory entry using symlink_metadata (lstat) followed by
 * metadata (stat) to resolve target types. Broken symlinks remain classified
 * as Symlink with is_symlink = true. Unix permission bits are extracted via
 * std::os::unix::fs::MetadataExt on Unix targets and left None on Windows.
 */
pub fn classify_entry(
    full_path: &Path,
    symlink_meta: &std::fs::Metadata,
) -> (
    LocalEntryType,
    bool,
    u64,
    Option<u64>,
    Option<u32>,
    Option<String>,
) {
    let is_symlink = symlink_meta.file_type().is_symlink();

    let (entry_type, resolved_meta) = if is_symlink {
        match std::fs::metadata(full_path) {
            Ok(target_meta) => {
                let target_type = if target_meta.is_dir() {
                    LocalEntryType::Directory
                } else if target_meta.is_file() {
                    LocalEntryType::File
                } else {
                    LocalEntryType::Other
                };
                (target_type, Some(target_meta))
            }
            Err(_) => (LocalEntryType::Symlink, None),
        }
    } else if symlink_meta.is_dir() {
        (LocalEntryType::Directory, None)
    } else if symlink_meta.is_file() {
        (LocalEntryType::File, None)
    } else {
        (LocalEntryType::Other, None)
    };

    let meta_for_size = resolved_meta.as_ref().unwrap_or(symlink_meta);
    let size = if entry_type == LocalEntryType::Directory {
        0
    } else {
        meta_for_size.len()
    };

    let modified = symlink_meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());

    #[cfg(unix)]
    let (permissions, permissions_display) = {
        use std::os::unix::fs::MetadataExt;
        let mode = symlink_meta.mode() & 0o777;
        (Some(mode), Some(format_permissions(mode)))
    };

    #[cfg(not(unix))]
    let (permissions, permissions_display) = (None, None);

    (
        entry_type,
        is_symlink,
        size,
        modified,
        permissions,
        permissions_display,
    )
}

// ─── Blocking Operations ──────────────────────────────────────────────────────

/*
 * Enumerate directory contents on a worker thread. Normalizes path display,
 * breadcrumbs, parent path, and entries sorted with directories first.
 */
fn list_dir_blocking(path_str: String) -> Result<LocalDirectoryListing, LocalFsError> {
    let input_path = PathBuf::from(&path_str);
    if !input_path.exists() {
        return Err(LocalFsError::NotFound);
    }
    if !input_path.is_dir() {
        return Err(LocalFsError::NotADirectory);
    }

    let canonical_path = input_path
        .canonicalize()
        .unwrap_or_else(|_| input_path.clone());

    let (parent, segments) = build_breadcrumbs_and_parent(&canonical_path);
    let display_path = canonical_path.to_string_lossy().to_string();

    let read_dir = std::fs::read_dir(&canonical_path)?;
    let mut entries = Vec::new();

    for dir_entry in read_dir {
        let entry = match dir_entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let file_name = entry.file_name().to_string_lossy().to_string();
        let child_path = entry.path();

        let symlink_meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => match std::fs::symlink_metadata(&child_path) {
                Ok(m) => m,
                Err(_) => continue,
            },
        };

        let (entry_type, is_symlink, size, modified, permissions, permissions_display) =
            classify_entry(&child_path, &symlink_meta);

        entries.push(LocalEntry {
            name: file_name,
            path: child_path.to_string_lossy().to_string(),
            entry_type,
            size,
            modified,
            is_symlink,
            permissions,
            permissions_display,
        });
    }

    entries.sort_by(|a, b| {
        let a_dir = a.entry_type == LocalEntryType::Directory;
        let b_dir = b.entry_type == LocalEntryType::Directory;
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(LocalDirectoryListing {
        path: display_path,
        parent,
        segments,
        entries,
    })
}

// ─── Tauri Commands ───────────────────────────────────────────────────────────

/*
 * Returns the current user's home directory as an absolute string.
 */
#[tauri::command]
pub async fn local_home_dir() -> Result<String, LocalFsError> {
    tokio::task::spawn_blocking(|| {
        dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .ok_or(LocalFsError::HomeDirNotFound)
    })
    .await
    .map_err(|e| LocalFsError::IoError(e.to_string()))?
}

/*
 * Returns a normalized directory listing for the given local path.
 * Runs in a blocking worker thread to avoid tying up the async executor.
 */
#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<LocalDirectoryListing, LocalFsError> {
    tokio::task::spawn_blocking(move || list_dir_blocking(path))
        .await
        .map_err(|e| LocalFsError::IoError(e.to_string()))?
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    #[test]
    fn test_format_permissions() {
        assert_eq!(format_permissions(0o755), "rwxr-xr-x");
        assert_eq!(format_permissions(0o644), "rw-r--r--");
        assert_eq!(format_permissions(0o700), "rwx------");
        assert_eq!(format_permissions(0o000), "---------");
        assert_eq!(format_permissions(0o777), "rwxrwxrwx");
    }

    #[test]
    fn test_build_breadcrumbs_unix_root() {
        let path = Path::new("/");
        let (parent, segments) = build_breadcrumbs_and_parent(path);
        assert_eq!(parent, None);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].label, "/");
        assert_eq!(segments[0].path, "/");
    }

    #[test]
    fn test_build_breadcrumbs_unix_nested() {
        let path = Path::new("/Users/test/Documents");
        let (parent, segments) = build_breadcrumbs_and_parent(path);
        assert_eq!(parent, Some("/Users/test".to_string()));
        assert_eq!(segments.len(), 4);
        assert_eq!(
            segments[0],
            BreadcrumbSegment {
                label: "/".into(),
                path: "/".into()
            }
        );
        assert_eq!(
            segments[1],
            BreadcrumbSegment {
                label: "Users".into(),
                path: "/Users".into()
            }
        );
        assert_eq!(
            segments[2],
            BreadcrumbSegment {
                label: "test".into(),
                path: "/Users/test".into()
            }
        );
        assert_eq!(
            segments[3],
            BreadcrumbSegment {
                label: "Documents".into(),
                path: "/Users/test/Documents".into()
            }
        );
    }

    #[test]
    fn test_classify_entry_file_and_dir() {
        let temp = tempfile::tempdir().unwrap();
        let file_path = temp.path().join("sample.txt");
        File::create(&file_path).unwrap();

        let sub_dir = temp.path().join("child");
        std::fs::create_dir(&sub_dir).unwrap();

        let file_meta = std::fs::symlink_metadata(&file_path).unwrap();
        let (file_type, file_symlink, _, _, _, _) = classify_entry(&file_path, &file_meta);
        assert_eq!(file_type, LocalEntryType::File);
        assert!(!file_symlink);

        let dir_meta = std::fs::symlink_metadata(&sub_dir).unwrap();
        let (dir_type, dir_symlink, _, _, _, _) = classify_entry(&sub_dir, &dir_meta);
        assert_eq!(dir_type, LocalEntryType::Directory);
        assert!(!dir_symlink);
    }

    #[cfg(unix)]
    #[test]
    fn test_classify_entry_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let target_file = temp.path().join("target.txt");
        File::create(&target_file).unwrap();

        let link_file = temp.path().join("link.txt");
        std::os::unix::fs::symlink(&target_file, &link_file).unwrap();

        let link_meta = std::fs::symlink_metadata(&link_file).unwrap();
        let (entry_type, is_symlink, _, _, _, _) = classify_entry(&link_file, &link_meta);
        assert_eq!(entry_type, LocalEntryType::File);
        assert!(is_symlink);

        // Broken symlink
        let broken_link = temp.path().join("broken.txt");
        std::os::unix::fs::symlink(temp.path().join("nonexistent.txt"), &broken_link).unwrap();
        let broken_meta = std::fs::symlink_metadata(&broken_link).unwrap();
        let (b_type, b_symlink, _, _, _, _) = classify_entry(&broken_link, &broken_meta);
        assert_eq!(b_type, LocalEntryType::Symlink);
        assert!(b_symlink);
    }

    #[test]
    fn test_local_fs_error_serialization() {
        let err = LocalFsError::NotFound;
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, r#"{"kind":"not_found","message":"Path not found"}"#);
    }
}
