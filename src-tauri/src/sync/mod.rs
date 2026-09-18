/*
 * Encrypted dataset sync — user-owned remote host datasets.
 *
 * A "dataset" is a scoped slice of the local database (hosts, groups, snippets,
 * port-forward rules, S3 connections, per-host plugin config, app settings)
 * published to a directory on a server the user controls. The payload is sealed
 * with a random 32-byte dataset key; that key is itself wrapped by an Argon2id
 * key derived from a per-dataset passphrase, so rotating the passphrase rewraps
 * 32 bytes instead of re-encrypting the dataset, and a teammate can join a
 * shared dataset with the passphrase alone.
 *
 * This module owns only the wire format and its crypto ([`codec`]). Transport,
 * merge, and the Tauri command surface land in sibling modules and never
 * re-implement sealing or key wrapping.
 */

pub mod codec;
pub mod collect;
pub mod commands;
pub mod dataset;
/* Task 7 checks that span the dataset *list* — two rows on one server, and what
 * removing one of them leaves behind. Kept apart from `dataset` so the filter
 * `sync::datasets` selects exactly these. */
#[cfg(test)]
mod datasets;
pub mod merge;
pub mod meta;
pub mod pull;
pub mod push;
pub mod scheduler;
pub mod scope;
pub mod secrets;
pub mod signing;
pub mod transport;

use serde::ser::{Serialize, SerializeStruct, Serializer};

/// Failure modes of the sync wire format.
///
/// Serialized as `{ kind, message }` — the same convention as `SshError`,
/// `DbError`, `VaultError`, and `BackupError` — so the frontend can branch on
/// `kind` instead of matching on prose.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    /// The container is not a sync bundle, is truncated, or its header is
    /// malformed. Never depends on the passphrase.
    #[error("{0}")]
    Format(String),
    /// A cryptographic primitive or the OS CSPRNG failed.
    #[error("{0}")]
    Crypto(String),
    /// AEAD tag check failed: wrong passphrase, wrong dataset key, or tampering.
    #[error("wrong dataset passphrase (or the bundle was tampered with)")]
    Decrypt,
    /// The bundle was written by a newer payload format than this build knows.
    #[error("{0}")]
    Version(String),
    /// The payload could not be encoded to / decoded from JSON.
    #[error("{0}")]
    Serialization(String),
    /// The sync endpoint could not be reached or authenticated.
    #[error("{0}")]
    Unreachable(String),
    /// SSH/SFTP I/O against the endpoint failed after connecting.
    #[error("{0}")]
    Transport(String),
    /// The remote is missing the SFTP subsystem (e.g. an SCP-only server).
    #[error("{0}")]
    SftpUnavailable(String),
    /// Another client holds the dataset lock.
    #[error("{0}")]
    Locked(String),
    /// The remote moved on (or holds a different dataset): the local side must
    /// pull and re-merge before it may publish.
    #[error("{0}")]
    Conflict(String),
    /// The dataset is pull-only for this role: members cannot publish, and a
    /// row cannot become an owner without the owner signing key on this machine.
    #[error("{0}")]
    RoleDenied(String),
    /// A credential could not be read — typically a locked App Vault.
    #[error("{0}")]
    Vault(String),
    /// No such dataset, secret, or remote object.
    #[error("{0}")]
    NotFound(String),
    /// Local persistence failed.
    #[error("{0}")]
    Database(String),
}

impl SyncError {
    fn kind(&self) -> &'static str {
        match self {
            Self::Format(_) => "format",
            Self::Crypto(_) => "crypto",
            Self::Decrypt => "decrypt",
            Self::Version(_) => "version",
            Self::Serialization(_) => "serialization",
            Self::Unreachable(_) => "unreachable",
            Self::Transport(_) => "transport",
            Self::SftpUnavailable(_) => "sftpUnavailable",
            Self::Locked(_) => "locked",
            Self::Conflict(_) => "conflict",
            Self::RoleDenied(_) => "roleDenied",
            Self::Vault(_) => "vault",
            Self::NotFound(_) => "notFound",
            Self::Database(_) => "database",
        }
    }
}

impl Serialize for SyncError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("SyncError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<crate::db::DbError> for SyncError {
    fn from(error: crate::db::DbError) -> Self {
        Self::Database(error.to_string())
    }
}

/* A locked App Vault is the one credential failure the user can act on, so it
 * keeps its own kind; every other vault failure is reported verbatim. */
impl From<crate::vault::VaultError> for SyncError {
    fn from(error: crate::vault::VaultError) -> Self {
        Self::Vault(error.to_string())
    }
}
