# Implementation Plan: Encrypted Remote Host Dataset Sync (self-hosted)

Status: **awaiting human review** — no code has been written.
Task list: `tasks/todo.md` (checklist target; this repo has no external tracker).

## Overview

Add user-owned, end-to-end-encrypted sync of the host dataset to a server the user
chooses (IP/host, port, SSH credentials, remote path), driven entirely from
Settings. A new machine configures the same endpoint + dataset passphrase and
pulls the identical host set. Phase 2 generalises one endpoint into **N named
datasets** (e.g. `NOVA`, `Bank of Cyprus`) with an **owner** who can push and
**members** who can only pull, so a team shares one source of truth per customer.

Non-goals (explicit): no OmniSSH-hosted cloud service, no account system, no
telemetry, no plaintext secrets on the remote, no interactive three-way merge UI,
no SCP-only remote support (rejected with an actionable error, mirroring
`relay`).

## What already exists (verified, not assumed)

| Building block | Location | Reuse decision |
| --- | --- | --- |
| Argon2id + AES-256-GCM sealed container, header-as-AAD, gzip framing | `src-tauri/src/backup/mod.rs` | Copy the *pattern*, new magic `OMNISYNC\x01`; do not reuse `ASCPBAK` (different payload semantics + rotation needs) |
| Whole-DB snapshot export/import | `db::HostDb::export_db_snapshot` / `import_db_snapshot` | **Not** the sync payload — replace-only, cannot scope or merge. Left untouched for local backups |
| App Vault (session key, verifier, per-host AES-GCM blob, AAD-bound) | `src-tauri/src/vault/local.rs` | Stores sync secrets (dataset passphrase, server password, owner signing key) |
| OS keychain credential store | `src-tauri/src/vault/mod.rs`, service `com.anyscp.credentials` | Second storage backend for the same sync secrets, chosen by `defaultCredentialStorage` |
| SSH connect + ephemeral sessions | `ssh::manager::SshManager::connect(HostConfig, …)`, `types::session::{HostConfig, AuthMethod}` | Sync transport opens an ephemeral session and disconnects |
| SFTP sessions + file ops | `sftp::SftpManager`, `sftp_open/list_dir/mkdir/rename/delete` | Remote object store for the dataset bundle |
| SFTP-only manager precedent (own events, own queue, shared `SftpManager`) | `src-tauri/src/relay/mod.rs` | Structural template for `src-tauri/src/sync/` |
| Migration ladder, current `schema_version = 20` | `db::HostDb::run_migrations` | Sync tables land as migrations **21** (schema) and, if needed, 22 |
| `COPYABLE_TABLES`, `factory_reset` + `ResetKeys` | `src-tauri/src/db/mod.rs` | Must be extended for every new table / secret key namespace |
| Settings sections (`SectionId` union + `SECTIONS`) and Backup UI | `src/components/settings/SettingsPage.tsx` (`data` section) | New `sync` section beside `security`/`data` |
| Dockerised SSH targets + `resetApp()` / `relaunchApp()` | `tests/e2e/docker-compose.yml`, `tests/e2e/helpers/reset.ts` | New `sshd-sync` target; "second machine" is simulated by `resetApp()` between push and pull |

Gap analysis — what genuinely does not exist yet:

1. **No record-level change tracking.** `saved_hosts`/`host_groups` have
   `updated_at` but deletes are hard deletes, so a pull cannot distinguish
   "deleted remotely" from "not yet created locally". Tombstones are mandatory.
2. **No per-record sync base state**, so no way to tell a local edit from a
   remote edit → no correct merge without a stored base.
3. **No remote object store abstraction** (all SFTP paths today hang off a
   user-visible explorer session).
4. **No endpoint/dataset persistence or secret namespace** for sync.

## Architecture Decisions

**AD-1 — Payload is a versioned record document, not a SQLite snapshot.**
A dataset must be scopeable (only NOVA hosts) and mergeable (two machines edit
different hosts). A raw-DB snapshot can only replace everything. Payload =
gzipped JSON `{formatVersion, datasetId, generation, sections{…},
tombstones[]}` — one section per enabled content kind (AD-11), every record
carrying `id`, `revision`, `updatedAt`, `deleted`, and (hosts/S3 only) an
optional credential object.

**AD-2 — Container `OMNISYNC\x01`, same crypto primitives as backup.**
Header (magic, kdf id, m/t/p, compression, salt, nonce) written verbatim **and**
used as AEAD associated data; AES-256-GCM over gzip payload. Tampering with
parameters fails the tag check. Crypto choices are copied deliberately so there
is exactly one KDF/AEAD story in the codebase.

**AD-3 — Two-level keys: dataset key (DK) wrapped by a passphrase-derived key.**
DK is 32 random bytes and encrypts the payload. `wrappedDk =
AES-GCM(Argon2id(passphrase, salt), DK)` lives in the remote plaintext metadata
file. Consequences, all wanted: passphrase rotation rewraps 32 bytes instead of
re-encrypting the dataset; a member joins with the passphrase alone; the App
Vault master password stays machine-local (a shared dataset cannot depend on one
user's master password, and master-password rotation must not invalidate remote
data). See Open Question 1 — the default UI still offers "same as my App Vault
master password" as a *prefill*, never as a derivation shortcut.

**AD-4 — Remote layout is a small object set, written atomically.**

```
<root>/
  dataset.meta.json      plaintext, non-secret: formatVersion, datasetId, generation,
                         payloadSha256, kdf params + salt, wrappedDk, ownerFingerprint,
                         updatedAt, writerClientId, signature (phase 2)
  dataset.bin            OMNISYNC container (encrypted payload)
  dataset.lock           advisory lock, created with SFTP CREATE|EXCL, holds clientId+ts,
                         stale after 60 s
  history/<generation>.bin + .meta.json   last 10 generations, for rollback
```

Writes are upload-to-`.tmp-<uuid>` then rename over the target (remove-then-
rename fallback where the server rejects overwrite-rename). `generation` +
`payloadSha256` give optimistic concurrency: a push whose base generation is not
the remote's current generation must re-pull and re-merge.

**AD-5 — Merge is record-level last-writer-wins over a stored base, with
tombstones.** Local `sync_record_state` keeps `(dataset_id, entity_type,
entity_id, remote_revision, base_hash)` = the last agreed state. Classification
per record: unchanged / local-only / remote-only / both-changed. Both-changed
resolves by newest `updated_at` (ties → higher `revision`, then lexical id) and
writes a row into a conflict log surfaced in the UI as "kept the newer copy".
Deterministic, explainable, no interactive merge surface in v1.

**AD-6 — Credentials are opt-in per dataset and never leave the container.**
On push, each in-scope host's secret is resolved exactly as
`backup::build_backup` does (keychain read, or App Vault decrypt, which requires
an unlocked vault) and embedded in the encrypted payload; a secret that cannot
be read is reported, never silently skipped.
On pull, a credential is written **straight into its final store**: the App
Vault (AES-GCM ciphertext in the DB) when this machine prefers the vault and it
is unlocked, otherwise the OS keychain. The keychain-then-migrate hop was
rejected — it would write the pulled plaintext into a second OS-managed store
only to delete it moments later, costing extra macOS authorization prompts and
opening a window where the secret exists somewhere the user never asked for.
Fallbacks are explicit: a locked or unconfigured vault falls back to the
keychain (a vault marker without decryptable ciphertext would make the host
unusable), and a non-password credential (private-key passphrase) stays in the
keychain because the vault's reveal/rekey paths are password-shaped. The
incoming row's own storage marker is ignored — it describes the publisher's
machine, not this one.

**AD-7 — Transport reuses `SshManager` + `SftpManager` through a new
`sync::transport`.** An ephemeral `HostConfig` is built from the endpoint row
(password or key auth via existing `AuthMethod`), the session is opened,
used, and disconnected. Rejected alternative: `ssh_exec_command` with base64
pipes — slower, quoting-fragile, and duplicates transport logic that already
exists. SCP-only remotes are rejected with an actionable error, exactly as
`relay` does.

**AD-8 — Roles are cryptographic + server-side, client flags are advisory.**
Owner holds an ed25519 signing key (in the vault) and signs
`dataset.meta.json`; `ownerFingerprint` is pinned locally on first join, and
members reject unsigned/mismatched metadata — so a member cannot forge a dataset
update that other clients accept. Actual write *prevention* is the remote's job
(read-only SSH account, or `chmod` on the root). The UI states this plainly and
a preflight writes a probe file to detect a member account that can still write.

**AD-13 — Automatic sync is opt-in with user-set cadences (resolved by the
user).** `auto_sync` defaults off for every dataset and both cadences default
to 0 = "never on its own": `pull_interval_secs` (60–86400 when set) and
`push_debounce_secs` (5–3600 when set) are configured per dataset in Settings.
Out-of-range values are rejected rather than clamped. Local change detection
fingerprints the database (max `updated_at`, row counts, tombstone count, per
enabled content kind, volatile columns excluded) instead of requiring every
store to announce mutations — so imports, restores, and future features are
covered by construction.

**AD-14 — A debug build never shares state with an installed release.**
`resolve_data_dir` gives debug builds `…/com.omnissh.desktop-dev` and
`vault::service_name` gives them the `com.anyscp.credentials.dev` keychain
namespace, so `pnpm tauri dev` and the E2E binary cannot read, overwrite, or
factory-reset the user's production hosts, settings, or credentials.
`OMNISSH_DATA_DIR` overrides the directory outright for deliberate cases.

**AD-15 — Concurrent writers converge; the cost is stated, not hidden.**
Measured with two databases against one dataset
(`sync::pull::live::two_machines_editing_at_once_converge_and_the_older_edit_is_logged`):
the `O_EXCL` lock serialises writers, a stale push is refused outright with
`Conflict` (never overwritten), the loser pulls and merges, and once both sides
match neither machine republishes — so no corruption and no generation
ping-pong. Edits to *different* records on two machines both survive. The one
real loss is a *same-record* simultaneous edit: newest `updated_at` wins and the
older copy is recorded in the conflict log rather than merged field-by-field,
and wall-clock skew between machines can misorder "newest". The Settings UI
states this in the auto-sync block, and a pull whose generation came from
another installation says so — which requires a stable per-install
`sync_client_id` in `app_settings` (deny-listed from sync; the transport's
per-connection id cannot attribute a writer).
Open, deliberately not solved here: two app instances on **one** machine share
one database and one keychain. `tauri-plugin-single-instance` is the fix; it is
a new dependency and therefore a user decision.

**AD-16 — A local wipe is never a remote delete.** `factory_reset` deletes rows
with raw SQL, so it records no tombstones and cannot publish a wipe to a shared
dataset; it also clears `sync_record_state` (so the wiped machine stops claiming
those records as its merge base) and purges each dataset's `sync:{id}:*`
keychain entries. A reset followed by a pull restores the dataset instead of
erasing it for everyone.

**AD-9 — Dataset-managed hosts are read-only locally by default.** A member
editing a synced host would lose the edit on the next pull. The editor blocks
edits on managed hosts with an explicit "Detach from dataset" escape hatch
(which drops the record from `sync_record_state` and clears the managed flag).
Fail closed beats silent data loss.

**AD-10 — Schema is multi-dataset from day one.** Phase 1 ships one dataset row
and a single-dataset UI, but `sync_datasets` / `sync_dataset_members` /
`sync_record_state` / `sync_conflicts` are created plural in migration 21 so
phase 2 adds rows and UI, not a migration rewrite.

**AD-11 — Content kinds are per-dataset opt-in toggles (resolved Q2).** A
dataset selects any subset of: `hosts` (+`hostCredentials` sub-toggle),
`groups`, `snippets` (+`snippetFolders`), `portForwards`, `s3Connections`
(+`s3Credentials` sub-toggle), `hostPlugins`, `appSettings`. Stored as a
`content_flags` JSON column on `sync_datasets`; the payload carries only enabled
sections, and a disabled section is never applied on pull (so turning a toggle
off is not a delete). Referential integrity is enforced at push time: enabling
`hosts` forces `groups` for referenced groups, `portForwards`/`hostPlugins`
require `hosts` (they are FK children of `saved_hosts`), `snippets` forces
`snippetFolders`.

**AD-12 — Machine-local tables are never syncable.** `connection_history`,
`recent_paths`, `local_vault_metadata`, `local_vault_credentials`,
`vault_cleanup_queue`, and the `sync_*` tables themselves stay local: they are
either device telemetry or key material bound to one machine's master password.
`app_settings` has no `updated_at` column, so it syncs as **one synthetic record**
(whole key/value map, LWW on the record's `updatedAt` tracked in
`sync_record_state`) rather than per key; machine-specific keys
(`skippedUpdateVersion`, editor exec paths, window state) are excluded by an
explicit deny-list so a pull cannot point another machine at a nonexistent binary.

## Dependency Graph

```
migration 21: sync_datasets, sync_dataset_members,
sync_record_state, sync_conflicts, sync_tombstones          OMNISYNC container +
   │   (+ tombstone writes in delete_host/delete_group)      payload codec (pure Rust)
   │                                                                │
   ├──────────────────────────┬─────────────────────────────────────┘
   │                          │
   │                  sync::transport (ephemeral SSH+SFTP,
   │                  atomic put, lock, generation check)
   │                          │
   │                  sync_test_connection ── Settings ▸ Sync UI shell
   │                          │
   ├── push (scope → collect → seal → atomic put)
   │        │
   └── pull (get → open → merge vs base → apply → conflicts)
            │
            ├── auto-sync scheduler + status/error surface
            │
            ├── scope selection (groups/hosts per dataset)   [phase 2]
            │
            ├── owner signing / member verification / role UI [phase 2]
            │        │
            │        └── managed-host read-only + detach      [phase 2]
            │
            └── history + rollback, backup/factory-reset interop, docs [phase 3]
```

Build order follows the graph bottom-up; every task after T3 is a vertical slice
(schema → Rust → IPC → store → UI → verification).

## Task List

- [x] T1: Sync container + payload codec (`OMNISYNC\x01`)
- [x] T2: Migration 21 — sync tables + tombstones on delete
- [x] T3: Sync transport + `sync_test_connection` + Settings ▸ Sync shell
- [x] T4: Push — local dataset → encrypted remote bundle
- [x] T5: Pull + merge engine + conflict log
- [x] T6: Auto-sync, status surface, actionable errors

### Checkpoint A: Phase 1 (after T6)

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings` clean
- [ ] `pnpm test` and `pnpm build` clean
- [ ] `sshd-sync` E2E spec green: configure → push → `resetApp()` → configure → pull → identical host set incl. credentials
- [ ] Manual: remote path inspected over plain `sftp`; `dataset.bin` is opaque, `dataset.meta.json` contains no secret
- [ ] **Human review before phase 2**

### Phase 2: Multiple datasets, scopes, roles

- [ ] T7: Multiple datasets — list UI, per-dataset secrets, independent state
- [ ] T8: Dataset scope — membership by group / explicit hosts
- [ ] T9: Owner signing, member verification, pull-only enforcement, write probe
- [ ] T10: Managed-host read-only + detach

### Checkpoint B: Phase 2 (after T10)

- [ ] Two datasets on one endpoint sync independently (no cross-contamination)
- [ ] Member client cannot push; forged/unsigned metadata is rejected with a clear error
- [ ] Managed host is not editable; detach restores local ownership
- [ ] Full Rust + frontend gates clean; E2E multi-dataset + member specs green
- [ ] **Human review before phase 3**

### Phase 3: Recovery, interop, documentation

- [ ] T11: Remote history + rollback to a previous generation
- [ ] T12: Backup / factory-reset / snapshot interop + README, CHANGELOG, docs

### Checkpoint C: Complete

- [ ] Every acceptance criterion in `tasks/todo.md` met
- [ ] `make e2e` green
- [ ] No secret, host, path, or command in logs or telemetry (grep the new modules for `tracing` fields)
- [ ] Ready for review

## Parallelisation

Subagents, when used, run on the **OMP - command code implementer** profile
(`command-code/deepseek/deepseek-v4.1-flash`, `modeId: full`) per the session
instruction.

- **T1 and T2 are independent** (pure crypto/codec vs. schema) → safe to run in
  parallel; they share no file. Contract to fix up front: the payload struct
  names and the `sync_record_state` column set.
- **T4 and T5 both touch `src-tauri/src/sync/mod.rs`** → sequential, same owner.
- **T8, T9, T11 are independent slices** once T7 lands (scope, signing,
  history) → parallelisable with one integration owner for
  `SettingsPage.tsx`, which all three touch.
- **Migrations are never parallel.** One migration number per task, applied in
  order: T2 owns 21; only T8 may need 22 if membership storage changes shape.

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Concurrent pushes from two machines silently clobber a generation | High | `dataset.lock` via SFTP `CREATE\|EXCL` + optimistic `generation`/`payloadSha256` check; mismatch forces re-pull and re-merge. Unit-test the rejection path |
| `russh-sftp` rename-over-existing rejected by some servers | Medium | Write `.tmp-<uuid>` then rename; on failure delete target and retry once; assert both paths in the E2E matrix (linuxserver openssh + a busybox-ish target) |
| Credential push requires an unlocked App Vault; a locked vault could silently drop secrets | High | Preflight counts readable/unreadable secrets (same shape as `backup_preflight`) and blocks the push with "unlock the vault to include credentials" |
| Clock skew makes LWW pick the wrong winner | Medium | Compare `updated_at` with `revision` as tiebreak, log every conflict, expose the conflict list; never delete the losing record's data without a log entry |
| Pull replaces a host a user is actively editing | Medium | AD-9 read-only managed hosts + detach; pull applies inside one SQLite transaction and emits a `sync:applied` event so stores reload |
| Pulling a dataset from a newer app version | Medium | `formatVersion` checked before decrypt; newer → refuse with "update OmniSSH first", mirroring `import_db_snapshot` |
| Remote path is wrong/unwritable/non-empty foreign data | Low | `sync_test_connection` probes: connect, stat root, write+delete probe file, detect an existing dataset and report `datasetId`/generation instead of overwriting |
| New tables missed by backup/factory reset | Medium | T12 extends `COPYABLE_TABLES` and `ResetKeys` (`sync:*` keys) with a test that enumerates tables and fails on an unlisted one |
| E2E "second machine" fidelity | Low | `resetApp()` wipes `$XDG_DATA_HOME/com.macnev2013.anyscp` + keychain scope, which is exactly a fresh machine against the same remote |
| Scope creep into a hosted service | High | Non-goals above; transport stays "a directory on the user's SSH server" |

## Resolved Decisions (answered by the user, 2026-09-18)

1. **Separate per-dataset passphrase** — AD-3 stands. The App Vault master
   password is never the dataset key source; the UI may prefill it, nothing more.
2. **All content kinds syncable behind user toggles** — AD-11. Opt-in/opt-out per
   dataset, with the forced-dependency rules above; machine-local tables excluded
   per AD-12.
3. **Credentials default off for shared datasets, on for personal** — AD-6 plus
   `hostCredentials`/`s3Credentials` sub-toggles; a dataset created with role
   `member` or with more than one known consumer defaults both to off.
4. **Auto-sync: pull on app start + 10 s debounced push after local mutations +
   manual Sync button in Settings** — T6 unchanged.
5. **ProxyJump for the sync endpoint deferred past phase 2** (recommendation
   accepted). Phase 1-2 support password and private-key auth only; a jump-host
   endpoint is rejected with an explicit "not supported yet" error rather than a
   silent direct connect.
