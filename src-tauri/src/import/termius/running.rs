/*
 * Chromium's POSIX LevelDB environment protects LOCK with an fcntl record
 * lock. The probe must use that same ABI, because BSD flock locks are a
 * separate namespace and would report a false "closed" result for a live
 * Termius process. The lock is requested non-blockingly and released at once.
 */

use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RunningError {
    #[error("Termius is running")]
    Running,
    #[error("Termius running state is undetermined on this platform")]
    Undetermined,
    #[error("cannot probe Termius lock")]
    Io,
}

/*
 * The guard owns the descriptor used for Chromium's advisory record lock.
 * Keeping that descriptor and guard alive across source ingestion closes the
 * check-then-open race; the future command layer must run this synchronous
 * filesystem operation on a blocking task.
 */
#[derive(Debug)]
pub struct LockGuard {
    #[cfg(unix)]
    file: std::fs::File,
}

#[cfg(unix)]
fn set_record_lock(fd: std::os::fd::RawFd, lock_type: libc::c_short) -> std::io::Result<()> {
    let mut lock = libc::flock {
        l_type: lock_type,
        l_whence: libc::SEEK_SET as libc::c_short,
        l_start: 0,
        l_len: 0,
        l_pid: 0,
    };
    let result = unsafe { libc::fcntl(fd, libc::F_SETLK, &mut lock) };
    if result == -1 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn is_lock_conflict(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || matches!(
            error.raw_os_error(),
            Some(code) if code == libc::EACCES || code == libc::EAGAIN
        )
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;

            let _ = set_record_lock(self.file.as_raw_fd(), libc::F_UNLCK as libc::c_short);
        }
    }
}

/// Acquire the Termius LevelDB record lock without blocking.
pub fn acquire(leveldb: &Path) -> Result<LockGuard, RunningError> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;

        /*
         * POSIX requires a descriptor opened for writing before F_SETLK can
         * request F_WRLCK. This does not write the file or create it; it only
         * opens Chromium's existing LOCK file with the access it uses for
         * record-lock probing.
         */
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(leveldb.join("LOCK"))
            .map_err(|_| RunningError::Io)?;
        if let Err(error) = set_record_lock(lock.as_raw_fd(), libc::F_WRLCK as libc::c_short) {
            if is_lock_conflict(&error) {
                return Err(RunningError::Running);
            }
            return Err(RunningError::Io);
        }

        Ok(LockGuard { file: lock })
    }

    #[cfg(not(unix))]
    {
        let _ = leveldb;
        Err(RunningError::Undetermined)
    }
}

/// Probe whether Termius is closed, releasing the lock immediately.
pub fn check(leveldb: &Path) -> Result<(), RunningError> {
    let _guard = acquire(leveldb)?;
    Ok(())
}

#[cfg(all(test, unix))]
pub(crate) mod test_support {
    use super::set_record_lock;
    use std::fs::OpenOptions;
    use std::io::{self, BufRead, BufReader, Read, Write};
    use std::os::fd::AsRawFd;
    use std::path::Path;
    use std::process::{Command, Stdio};

    const LOCK_HOLDER_PATH: &str = "TERMIUS_TEST_LOCK_HOLDER_PATH";
    const LOCK_HOLDER_TEST: &str = "import::termius::running::test_support::lock_holder";
    const LOCK_PROBE_PATH: &str = "TERMIUS_TEST_LOCK_PROBE_PATH";
    const LOCK_PROBE_TEST: &str = "import::termius::running::test_support::lock_probe";

    /*
     * fcntl record locks are associated with a process, so a same-process
     * fixture would not contend with the probe. Run the holder in this test
     * binary as a child process and synchronize after its lock is acquired.
     */
    pub(crate) fn with_held_lock(path: &Path, action: impl FnOnce()) {
        let lock_path = path.join("LOCK");
        let mut child = Command::new(std::env::current_exe().expect("test executable"))
            .args(["--exact", LOCK_HOLDER_TEST, "--nocapture"])
            .env(LOCK_HOLDER_PATH, lock_path.as_os_str())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn lock-holder test");

        let stdout = child.stdout.take().expect("lock-holder stdout");
        let mut ready = BufReader::new(stdout);
        let mut line = String::new();
        let mut found_ready = false;
        while ready
            .read_line(&mut line)
            .expect("read lock-holder readiness")
            != 0
        {
            if line.trim() == "ready" {
                found_ready = true;
                break;
            }
            line.clear();
        }
        assert!(found_ready, "lock-holder did not report readiness");

        action();

        drop(child.stdin.take());
        assert!(child.wait().expect("wait for lock-holder test").success());
    }

    pub(crate) fn lock_is_available_from_child(path: &Path) -> bool {
        let lock_path = path.join("LOCK");
        let output = Command::new(std::env::current_exe().expect("test executable"))
            .args(["--exact", LOCK_PROBE_TEST, "--nocapture"])
            .env(LOCK_PROBE_PATH, lock_path.as_os_str())
            .output()
            .expect("spawn lock probe test");
        assert!(
            output.status.success(),
            "lock probe test failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).contains("available")
    }

    #[test]
    fn lock_holder() {
        let Some(path) = std::env::var_os(LOCK_HOLDER_PATH) else {
            return;
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .expect("open lock-holder file");
        set_record_lock(file.as_raw_fd(), libc::F_WRLCK as libc::c_short)
            .expect("acquire lock-holder record lock");
        println!("ready");
        io::stdout().flush().expect("flush lock-holder readiness");

        let mut release = [0u8; 1];
        let _ = io::stdin().read(&mut release);
    }

    #[test]
    fn lock_probe() {
        let Some(path) = std::env::var_os(LOCK_PROBE_PATH) else {
            return;
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .expect("open lock-probe file");
        match set_record_lock(file.as_raw_fd(), libc::F_WRLCK as libc::c_short) {
            Ok(()) => {
                println!("available");
                set_record_lock(file.as_raw_fd(), libc::F_UNLCK as libc::c_short)
                    .expect("unlock lock-probe file");
            }
            Err(error) if super::is_lock_conflict(&error) => println!("blocked"),
            Err(error) => panic!("unexpected lock-probe error: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[cfg(unix)]
    #[test]
    fn unlocked_lock_file_is_not_running() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("LOCK"), b"").unwrap();
        assert_eq!(check(root.path()), Ok(()));
    }

    #[cfg(unix)]
    #[test]
    fn held_lock_is_reported_as_running() {
        let root = tempdir().unwrap();
        let lock = root.path().join("LOCK");
        fs::write(&lock, b"").unwrap();
        test_support::with_held_lock(root.path(), || {
            assert_eq!(check(root.path()), Err(RunningError::Running));
        });
    }

    #[cfg(unix)]
    #[test]
    fn acquired_guard_remains_contended_until_drop() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("LOCK"), b"").unwrap();

        let guard = acquire(root.path()).unwrap();
        assert!(!test_support::lock_is_available_from_child(root.path()));
        drop(guard);
        assert!(test_support::lock_is_available_from_child(root.path()));
    }

    #[cfg(not(unix))]
    #[test]
    fn unsupported_platform_is_undetermined() {
        assert_eq!(check(Path::new("")), Err(RunningError::Undetermined));
    }
}
