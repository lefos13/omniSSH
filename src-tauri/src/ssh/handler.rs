use std::path::{Path, PathBuf};

use async_trait::async_trait;
use russh::client;
use russh_keys::key::PublicKey;

/*
 * Host-key verification for every SSH transport handshake.
 *
 * The handler is the only place russh asks whether a server's key is trusted,
 * and it runs for terminals, SFTP/SCP, port forwards, sync and health probes
 * alike. Keys are matched against the user's OpenSSH `~/.ssh/known_hosts`
 * (hashed host entries included). A known key must match exactly; an unknown
 * host is recorded on first use, like OpenSSH, so a later key change is
 * rejected instead of silently accepted. This is trust-on-first-use, not a
 * substitute for comparing fingerprints out of band, but it closes the
 * accept-any-key behaviour that made every connection MITM-able.
 *
 * Health probes use `probe` so an unauthenticated ping cannot poison
 * known_hosts. File errors do not brick connections: an unreadable or
 * unparseable known_hosts is logged and treated as unverifiable.
 */

pub struct SshClientHandler {
    host: String,
    port: u16,
    known_hosts_path: Option<PathBuf>,
    learn_unknown: bool,
}

impl SshClientHandler {
    /// Handler for an authenticated connection: unknown hosts are learned.
    pub fn connect(host: &str, port: u16) -> Self {
        Self {
            host: host.to_string(),
            port,
            known_hosts_path: default_known_hosts_path(),
            learn_unknown: true,
        }
    }

    /// Handler for an unauthenticated health probe: verify known keys but
    /// never write a first-use entry.
    pub fn probe(host: &str, port: u16) -> Self {
        Self {
            host: host.to_string(),
            port,
            known_hosts_path: default_known_hosts_path(),
            learn_unknown: false,
        }
    }
}

#[async_trait]
impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    /// Called when the server presents its host key.
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let Some(path) = self.known_hosts_path.clone() else {
            tracing::warn!(
                host = %self.host,
                "no home directory; SSH host key cannot be verified"
            );
            return Ok(true);
        };

        let host = self.host.clone();
        let port = self.port;
        let learn_unknown = self.learn_unknown;
        let key = server_public_key.clone();

        match tokio::task::spawn_blocking(move || {
            verify_host_key(&host, port, &key, &path, learn_unknown)
        })
        .await
        {
            Ok(HostKeyOutcome::Trusted) => Ok(true),
            Ok(HostKeyOutcome::Changed { line }) => Err(russh::Error::KeyChanged { line }),
            Ok(HostKeyOutcome::Unverifiable(reason)) => {
                tracing::warn!(
                    host = %self.host,
                    port = self.port,
                    %reason,
                    "SSH host key could not be checked against known_hosts"
                );
                Ok(true)
            }
            Err(join_error) => {
                tracing::error!(
                    host = %self.host,
                    error = %join_error,
                    "SSH host key verification task failed"
                );
                Err(russh::Error::UnknownKey)
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HostKeyOutcome {
    Trusted,
    Changed { line: usize },
    Unverifiable(String),
}

/// Check `key` against `path`, learning the key for an unknown host when
/// `learn_unknown` is set. Split out from the async handler so it stays
/// synchronous and unit-testable with a temporary known_hosts file.
pub(crate) fn verify_host_key(
    host: &str,
    port: u16,
    key: &PublicKey,
    path: &Path,
    learn_unknown: bool,
) -> HostKeyOutcome {
    match russh_keys::known_hosts::check_known_hosts_path(host, port, key, path) {
        Ok(true) => HostKeyOutcome::Trusted,
        Ok(false) => {
            if learn_unknown {
                if let Err(error) =
                    russh_keys::known_hosts::learn_known_hosts_path(host, port, key, path)
                {
                    return HostKeyOutcome::Unverifiable(format!(
                        "could not record host key: {error}"
                    ));
                }
            }
            HostKeyOutcome::Trusted
        }
        Err(russh_keys::Error::KeyChanged { line }) => HostKeyOutcome::Changed { line },
        Err(error) => HostKeyOutcome::Unverifiable(format!("known_hosts read failed: {error}")),
    }
}

fn default_known_hosts_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_keys::key::KeyPair;

    fn key_pair() -> KeyPair {
        KeyPair::generate_ed25519()
    }

    #[test]
    fn unknown_host_is_learned_then_trusted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        let key = key_pair().clone_public_key().expect("public key");

        assert_eq!(
            verify_host_key("example.test", 22, &key, &path, true),
            HostKeyOutcome::Trusted
        );
        let contents = std::fs::read_to_string(&path).expect("known_hosts written");
        assert!(contents.contains("example.test "), "got {contents:?}");

        assert_eq!(
            verify_host_key("example.test", 22, &key, &path, true),
            HostKeyOutcome::Trusted
        );
    }

    #[test]
    fn non_default_port_uses_bracketed_host_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        let key = key_pair().clone_public_key().expect("public key");

        assert_eq!(
            verify_host_key("example.test", 2222, &key, &path, true),
            HostKeyOutcome::Trusted
        );
        let contents = std::fs::read_to_string(&path).expect("known_hosts written");
        assert!(
            contents.contains("[example.test]:2222 "),
            "got {contents:?}"
        );
    }

    #[test]
    fn changed_key_is_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        let original = key_pair().clone_public_key().expect("public key");
        let replacement = key_pair().clone_public_key().expect("public key");

        assert_eq!(
            verify_host_key("example.test", 22, &original, &path, true),
            HostKeyOutcome::Trusted
        );
        assert!(
            matches!(
                verify_host_key("example.test", 22, &replacement, &path, true),
                HostKeyOutcome::Changed { .. }
            ),
            "a replacement key must be rejected"
        );
    }

    #[test]
    fn probe_does_not_record_unknown_hosts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        let key = key_pair().clone_public_key().expect("public key");

        assert_eq!(
            verify_host_key("example.test", 22, &key, &path, false),
            HostKeyOutcome::Trusted
        );
        assert!(!path.exists(), "probe must not create known_hosts");
    }

    #[test]
    fn probe_still_rejects_a_changed_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("known_hosts");
        let original = key_pair().clone_public_key().expect("public key");
        let replacement = key_pair().clone_public_key().expect("public key");

        assert_eq!(
            verify_host_key("example.test", 22, &original, &path, true),
            HostKeyOutcome::Trusted
        );
        assert!(
            matches!(
                verify_host_key("example.test", 22, &replacement, &path, false),
                HostKeyOutcome::Changed { .. }
            ),
            "a probe must still reject a changed key"
        );
    }
}
