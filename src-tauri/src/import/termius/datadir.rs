/*
 * Termius uses different Electron roots by platform, with the App Store
 * build living in a macOS container. Candidate construction is kept separate
 * from resolution so tests can use temporary roots without touching a real
 * user profile.
 */

use std::path::{Path, PathBuf};

pub const LEVELDB_RELATIVE: &str = "IndexedDB/file__0.indexeddb.leveldb";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDir {
    pub path: PathBuf,
}

impl DataDir {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn leveldb_path(&self) -> PathBuf {
        self.path.join(LEVELDB_RELATIVE)
    }
}

pub fn candidate_dirs() -> Vec<DataDir> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    candidate_dirs_for(&home, appdata.as_deref())
}

pub fn resolve() -> Option<PathBuf> {
    resolve_candidates(&candidate_dirs())
}

fn candidate_dirs_for(home: &Path, _appdata: Option<&Path>) -> Vec<DataDir> {
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    {
        candidates.push(DataDir::new(
            home.join("Library/Application Support/Termius"),
        ));
    }

    #[cfg(target_os = "linux")]
    {
        candidates.push(DataDir::new(home.join(".config/Termius")));
    }

    #[cfg(target_os = "windows")]
    if let Some(appdata) = _appdata {
        candidates.push(DataDir::new(appdata.join("Termius")));
    }

    #[cfg(target_os = "macos")]
    {
        let containers = home.join("Library/Containers");
        let mut matches = std::fs::read_dir(containers)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("ermius")
            })
            .map(|entry| {
                DataDir::new(
                    entry
                        .path()
                        .join("Data/Library/Application Support/Termius"),
                )
            })
            .collect::<Vec<_>>();
        matches.sort_by(|left, right| left.path.cmp(&right.path));
        candidates.extend(matches);
    }

    candidates
}

fn resolve_candidates(candidates: &[DataDir]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(DataDir::leveldb_path)
        .find(|leveldb| leveldb.join("CURRENT").is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn resolves_only_a_leveldb_with_current() {
        let root = tempdir().unwrap();
        let first = DataDir::new(root.path().join("first"));
        let second = DataDir::new(root.path().join("second"));
        fs::create_dir_all(second.leveldb_path()).unwrap();
        fs::write(second.leveldb_path().join("CURRENT"), "MANIFEST-000001\n").unwrap();
        assert_eq!(
            resolve_candidates(&[first, second.clone()]),
            Some(second.leveldb_path())
        );
    }

    #[test]
    fn ignores_manifest_without_current() {
        let root = tempdir().unwrap();
        let candidate = DataDir::new(root.path().join("profile"));
        fs::create_dir_all(candidate.leveldb_path()).unwrap();
        fs::write(candidate.leveldb_path().join("MANIFEST-000001"), "").unwrap();
        assert_eq!(resolve_candidates(&[candidate]), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn app_store_container_glob_is_sorted_after_dmg_candidate() {
        let root = tempdir().unwrap();
        let containers = root.path().join("Library/Containers");
        fs::create_dir_all(&containers).unwrap();
        fs::create_dir_all(containers.join("z-ermius")).unwrap();
        fs::create_dir_all(containers.join("a-Termius")).unwrap();
        let candidates = candidate_dirs_for(root.path(), None);
        assert_eq!(
            candidates[0].path,
            root.path().join("Library/Application Support/Termius")
        );
        assert_eq!(
            candidates[1].path,
            containers.join("a-Termius/Data/Library/Application Support/Termius")
        );
        assert_eq!(
            candidates[2].path,
            containers.join("z-ermius/Data/Library/Application Support/Termius")
        );
    }
}
