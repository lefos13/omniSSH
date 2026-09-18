# Tasks: Encrypted Remote Host Dataset Sync

Plan and architecture decisions: `tasks/plan.md`.
Commands referenced below are this repo's real gates (`AGENTS.md`):
`pnpm exec vitest run <file>`, `pnpm test`, `pnpm build`,
`cargo test --manifest-path src-tauri/Cargo.toml`, `cargo fmt --all --check`,
`cargo clippy --all-targets -- -D warnings`, `make e2e`.
Build the frontend once before Rust commands on a clean checkout (`dist/` must exist).

---

## Phase 1: Single dataset, end to end

## Task 1: Sync container + payload codec (`OMNISYNC\x01`)

**Description:** Pure-Rust module that seals/opens the sync bundle and
serialises the record payload. No I/O, no DB, no Tauri — so it is fully
unit-testable and the transport/merge tasks build on a fixed contract.

**Acceptance criteria:**
- [x] `sync::codec` seals `(dataset_key, payload) → Vec<u8>` with magic
      `OMNISYNC\x01`, Argon2id params + salt + nonce in the header, header used as
      AEAD associated data, gzip before AES-256-GCM (same primitives as
      `backup::mod`), and opens the inverse; tampering with any header byte or
      ciphertext byte fails with a `Decrypt` error, truncation with `Format`.
- [x] Dataset key wrapping: `wrap_dataset_key(passphrase) → (salt, kdfParams, wrappedDk)`
      and `unwrap_dataset_key` round-trip; a wrong passphrase yields `Decrypt`;
      rewrapping under a new passphrase leaves the payload readable with the same DK.
- [x] `SyncPayload { format_version, dataset_id, generation, sections, tombstones }`
      with one optional section per content kind (`hosts`, `groups`, `snippets`,
      `snippet_folders`, `port_forwards`, `s3_connections`, `host_plugins`,
      `app_settings` — AD-11) serialises camelCase, round-trips with any subset of
      sections present, rejects `format_version` greater than the app's constant
      with an "update OmniSSH first" error, and accepts an older one.
- [x] Every record carries `id`, `revision`, `updated_at`, `deleted`; host and S3
      records additionally carry `credential: Option<StoredCredential>`; `Debug`
      never prints credential material and plaintext intermediates are zeroized.
- [x] `app_settings` is a single synthetic record (whole key/value map with one
      `updated_at`), and the machine-local deny-list (`skippedUpdateVersion`,
      editor `execPath`s) is applied at encode time — a test asserts denied keys
      never reach the payload.

**Verification:**
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml sync::codec`
- [ ] `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`
- [ ] Manual check: a sealed fixture byte-dump shows no host label, username, or
      hostname in plaintext.

**Dependencies:** None.

**Files likely touched:**
- `src-tauri/src/sync/mod.rs` (module decl)
- `src-tauri/src/sync/codec.rs`
- `src-tauri/src/lib.rs` (`mod sync;`)

**Estimated scope:** M (3 files)

---

## Task 2: Migration 21 — sync tables + tombstones on delete

**Description:** Schema foundation for multi-dataset sync and the change
tracking a correct merge needs. Multi-dataset from day one (AD-10) so phase 2
adds rows, not migrations.

**Acceptance criteria:**
- [x] Migration `20 → 21` creates `sync_datasets` (id, name, host, port, username,
      auth_type, remote_path, role, content_flags, scope_mode, auto_sync,
      owner_fingerprint, kdf/salt/wrapped-key columns, last_generation,
      last_synced_at, created_at, updated_at), `sync_dataset_members`
      (dataset_id, entity_type, entity_id), `sync_record_state` (dataset_id,
      entity_type, entity_id, remote_revision, base_hash, managed), `sync_conflicts`
      (dataset_id, entity_type, entity_id, resolution, winner_updated_at,
      loser_updated_at, detected_at), `sync_tombstones` (entity_type, entity_id,
      deleted_at); version marker bumped to 21 in the same batch.
- [x] Every delete path for a syncable entity records a tombstone in the same
      transaction as the delete: `delete_host`, `delete_group`,
      `delete_group_with_hosts` (host + group rows), `delete_snippet`,
      `delete_snippet_folder`, port-forward-rule delete, S3-connection delete, and
      `delete_plugin_config`; re-creating the same id clears its tombstone.
      Cascade deletes (port forwards and plugin rows removed with their host) are
      covered by the host tombstone, asserted by a test.
- [x] `HostDb` gains typed accessors (upsert/list/delete dataset, membership,
      record state, conflicts, tombstones since a timestamp) returning `DbError`.
- [x] No secret column: the server password, dataset passphrase, and owner signing
      key are never stored in SQLite — a test asserts the new tables have no
      column named like a secret and that writes reject non-empty secret payloads
      by construction (no such parameter exists).

**Verification:**
- [x] `cargo test --manifest-path src-tauri/Cargo.toml db::tests` (new migration +
      tombstone + accessor tests)
- [x] Manual check: open an app DB created at schema 20, launch, confirm migration
      to 21 applies once and is idempotent on relaunch.

**Dependencies:** None (parallel with Task 1).

**Files likely touched:**
- `src-tauri/src/db/mod.rs`
- `src-tauri/src/db/commands.rs` (delete paths)

**Estimated scope:** M (2 files, large diff in one)

---

## Task 3: Sync transport + `sync_test_connection` + Settings ▸ Sync shell

**Description:** First vertical slice: a Sync section in Settings where the user
enters host/port/user/secret/remote path and presses **Test connection**, which
opens a real ephemeral SSH+SFTP session, probes the path, and reports whether a
dataset already exists there.

**Acceptance criteria:**
- [x] `sync::transport` opens an ephemeral session via `SshManager::connect` with a
      `HostConfig` built from the dataset row (password or private-key
      `AuthMethod`), opens SFTP, and always disconnects — including on error; an
      SFTP-unavailable (SCP-only) remote is rejected with an actionable error like
      `relay` does.
- [x] Primitives: `get(path)`, `put_atomic(path, bytes)` (upload `.tmp-<uuid>` then
      rename; on rename-over-existing failure delete target and retry once),
      `lock(path)`/`unlock(path)` using SFTP `CREATE|EXCL` with a 60 s staleness
      override, `ensure_dir(root)`.
- [x] `sync_test_connection` command returns `{ reachable, pathExists, writable,
      existingDataset: Option<{ datasetId, generation, updatedAt, signed }> }`,
      writes and removes a probe file, never leaves residue, and is registered in
      `generate_handler!`.
- [x] Settings gains a `sync` section (`SectionId` union + `SECTIONS` entry +
      description) with the endpoint form, secret input, remote path, **Test
      connection** button, and result/error rendering; the secret stays in
      component state and is handed straight to the invoke — it never reaches the
      store, `app_settings`, or the DB. (Persisting an endpoint secret into
      keychain / App Vault under `sync:{datasetId}:server` lands with Task 4.)
- [x] Stable testids: `settings-sync-host`, `-port`, `-username`, `-password`,
      `-path`, `-key-path`, `-key-passphrase`, `-auth-password`, `-auth-key`,
      `-test`, `-test-result`, `-test-error`, `-existing-dataset`.

**Verification:**
- [x] `cargo test --lib sync::` — 33 passed (codec, meta, transport, commands),
      `cargo clippy --all-targets -- -D warnings` clean, `cargo test --lib` 399 passed.
- [x] `pnpm exec vitest run src/components/settings/SettingsPage.sync.test.tsx` —
      6 passed; `pnpm test` 470 passed; `pnpm build` clean.
- [x] Live transport check against a real SFTP server (linuxserver/openssh in
      Docker on :2299) via the opt-in `sync::transport::live` tests: ensure_root,
      publish + republish + read-back, missing-object `None`, lock contention,
      stale-lock steal, history archive/list/prune, and a wrong password reported
      as `Unreachable`. Remote directory inspected afterwards — no staging files,
      no leftover lock.
- [x] Real app boot: `pnpm tauri dev` applied migration 20→21 against the live
      database (`sync_datasets`, `sync_dataset_members`, `sync_record_state`,
      `sync_conflicts`, `sync_tombstones`; `schema_version = 21`).
- [ ] NOT DONE — clicking Test connection in the running desktop window. macOS
      denies screen capture to this process, so the UI was exercised through
      Testing Library against the real DOM plus an IPC payload-contract test
      (`deserializes_the_payload_the_settings_store_sends`) instead. The
      through-the-window path is covered by the Checkpoint A E2E spec.

**Dependencies:** Task 2 (dataset row), Task 1 (dataset detection reads the meta file).

**Files likely touched:**
- `src-tauri/src/sync/transport.rs`, `src-tauri/src/sync/commands.rs`
- `src-tauri/src/lib.rs`
- `src/components/settings/SettingsPage.tsx`
- `src/stores/sync-store.ts`, `src/types/sync.ts`

**Estimated scope:** L (5-6 files) — if the Settings form exceeds one session,
split the UI shell into T3a and the Rust probe into T3b.

---

## Task 4: Push — local dataset → encrypted remote bundle

**Description:** Collect the in-scope hosts/groups (+ credentials when enabled),
seal them, and publish atomically with a generation bump and history retention.

**Acceptance criteria:**
- [x] `sync_push(datasetId)` collects hosts + groups + tombstones, embeds
      credentials only when `include_credentials` is set, seals with the DK, and
      writes `dataset.bin`, `dataset.meta.json`, and `history/<generation>.bin`
      under the lock, keeping the newest 10 history entries.
- [x] A push whose base generation does not match the remote's current generation is
      rejected with `GenerationConflict` and the UI tells the user to pull first;
      no partial write survives (verified by asserting remote bytes unchanged).
- [x] `sync_push_preflight` reports readable vs unreadable credentials (shape
      mirrors `backup_preflight`) and a push with `include_credentials` on a locked
      App Vault fails before any remote write with "unlock the vault…".
- [x] After a successful push, `sync_record_state` (one upsert batch) and the
      dataset row's `last_generation` / `last_synced_at` are updated — and only
      after the remote accepted the bundle, so a failed publish leaves the base
      state describing what is actually on the server.
      DEVIATION: counts are returned from `sync_push` instead of broadcast on a
      `sync:status` event. A user-initiated push already has a caller waiting for
      the result; the event channel is only needed for the background scheduler
      and lands with Task 6.
- [x] UI: **Push now** button, last-sync line, per-run summary, error surface.

**Verification:**
- [x] `cargo test --lib sync::` (codec, meta, transport, commands, secrets,
      dataset, collect, push), `cargo test --lib` → 419 passed,
      `cargo clippy --all-targets -- -D warnings` clean, `cargo fmt` applied.
- [x] `pnpm exec vitest run src/components/settings/SettingsPage.sync.test.tsx` →
      13 passed; `pnpm test` → 477 passed; `pnpm build` clean.
- [x] Live push against a real SFTP server (`sync::push::live`, opt-in via
      `OMNISSH_SYNC_TEST_HOST`): temp DB + real keychain secrets + Docker
      openssh. Asserts generation 1 → 4 chaining, the published metadata's
      `payloadSha256` matching the bundle, the bundle decrypting with the
      passphrase into the expected hosts/groups, plaintext metadata containing
      neither a host label nor the passphrase, an unchanged record keeping its
      revision across a generation bump while an edited neighbour advances, a
      delete travelling as a tombstone, a rewound base generation rejected with
      `Conflict("…pull before pushing")` leaving the remote at generation 4, and
      the lock released afterwards.

**Dependencies:** Tasks 1, 2, 3.

**Files likely touched:**
- `src-tauri/src/sync/mod.rs`, `src-tauri/src/sync/push.rs`, `src-tauri/src/sync/commands.rs`
- `src/stores/sync-store.ts`, `src/components/settings/SettingsPage.tsx`

**Estimated scope:** L (5 files)

---

## Task 5: Pull + merge engine + conflict log

**Description:** Fetch, decrypt, classify each record against the stored base,
apply the merge in one transaction, and record conflicts.

**Acceptance criteria:**
- [x] `sync::merge` is a pure function over `(local, remote, base)` returning
      `{ to_apply, to_push, conflicts, tombstones_applied }`; unit tests cover
      unchanged, local-only, remote-only, both-changed (newer wins,
      `revision` then id as tiebreak), remote tombstone vs local edit, local
      tombstone vs remote edit, and new-record-on-both-sides.
- [x] `sync_pull(datasetId)` merges and applies hosts, groups, snippets + folders,
      port forwards, S3 connections, plugin rows, and app settings, then records
      base state and the conflict log; the store reloads hosts and groups so the
      dashboard reflects the pull without a restart.
      DEVIATION (two parts, both deliberate):
      1. Records are written through the existing per-entity accessors, so a pull
         is a sequence of small transactions, not one big one. A single
         transaction would mean re-implementing every upsert inside `pull`.
         Instead the operation is *idempotent*: base state is recorded only for
         records that actually landed, so re-running a partially applied pull
         converges. Proven by the live test's second, no-op pull.
      2. No `sync:applied` event — the outcome is returned from `sync_pull` and
         the store refreshes the entity stores. The event channel belongs to the
         background scheduler (Task 6), which has no caller to return to.
- [x] Pulling onto a fresh machine with an empty DB reproduces the pushed dataset
      exactly, including group assignments and working credentials. Credentials go
      **straight into their final store** (AD-6): App Vault ciphertext when this
      machine prefers the vault and it is unlocked, otherwise the OS keychain —
      no keychain-then-migrate hop, so the pulled plaintext never lands in a
      store the user did not ask for. Verified live on two receiving machines,
      one per backend.
- [x] Wrong passphrase → `Decrypt`, nothing written. A digest mismatch is reported
      as a transport problem rather than a wrong passphrase. A newer
      `formatVersion` (payload or metadata) is refused with "update OmniSSH first".
- [x] UI: **Pull now**, applied/conflict counts, conflict list showing which copy was
      kept and when.

**Verification:**
- [x] `cargo test --lib sync::merge` → 13 pure-merge cases (unchanged, remote-only,
      local-only, both-changed in both directions, revision tiebreak on equal
      timestamps, SQLite vs RFC3339 timestamp comparison, new remote record,
      tombstone vs untouched/edited local row in both orders, local delete vs
      remote edit in both orders, stale remote tombstone beaten by a live record,
      and "silence is scope, not a delete").
- [x] `cargo test --lib` → 435 passed; `cargo clippy --all-targets -- -D warnings`
      clean; `cargo fmt` applied.
- [x] `pnpm exec vitest run src/components/settings/SettingsPage.sync.test.tsx` →
      19 passed; `pnpm test` → 483 passed; `pnpm build` clean.
- [x] Live two-machine round trip (`sync::pull::live`, Docker openssh, two
      independent temp databases sharing one dataset): B pulls A's dataset from
      an empty DB (2 hosts + group, group membership intact); a second pull
      applies nothing; B's edit reaches A as a one-sided apply with no conflict;
      simultaneous edits to one host resolve to the newer copy with a logged
      conflict carrying the losing timestamp; A's newer local-only edit survives
      a pull; B's delete removes the host on A via tombstone; a host that was
      never in the dataset is never touched. Plus: pulling an unpublished dataset
      reports `NotFound("nothing has been published…")` and a wrong stored
      passphrase fails with `Decrypt` having written nothing.

**Dependencies:** Task 4.

**Files likely touched:**
- `src-tauri/src/sync/merge.rs`, `src-tauri/src/sync/pull.rs`, `src-tauri/src/sync/commands.rs`
- `src/stores/sync-store.ts`, `src/stores/hosts-store.ts`
- `src/components/settings/SettingsPage.tsx`

**Estimated scope:** L (6 files)

---

## Task 6: Auto-sync, status surface, actionable errors

**Description:** Make sync ambient instead of manual: pull on start, debounced
push after local mutations, visible status, and errors a user can act on.

**Acceptance criteria:**
- [x] Automatic sync is **off by default and opt-in per dataset** (user's rule):
      `auto_sync` defaults to 0 in migration 22, and both cadences default to 0.
      With the switch on, `pull_interval_secs` (0 = manual only, else 60–86400)
      and `push_debounce_secs` (0 = manual only, else 5–3600) are **separately
      user-configurable** in Settings; out-of-range values are rejected, not
      clamped. CHANGED FROM PLAN: the original "pull on start + fixed 10 s
      debounce" is replaced by user-set cadences; a pull still happens on the
      first tick after start because "never pulled" counts as due.
- [x] One run per dataset at a time (`Tracked::running` guard); a pull due at the
      same time as a push wins, because publishing first would hit the generation
      guard whenever the remote has moved. DB and crypto work runs in
      `spawn_blocking`; SSH I/O uses the existing async APIs.
- [x] Local changes are detected by **fingerprinting the database** (max
      `updated_at` + row counts + tombstone count per enabled content kind,
      volatile columns excluded) rather than by every store calling a
      "something changed" command — so imports, restores, and any future
      mutation path count, and none of them can forget to notify the scheduler.
- [x] Status is visible outside Settings (`status-bar-sync`): idle with last-synced
      time, syncing spinner, error with the failing dataset named, plus a
      "changes waiting to publish" hint. Phase changes stream over the
      `sync:status` event; `sync_status` gives the snapshot on mount.
- [x] An unreachable endpoint never blocks start or shows a modal: the phase
      becomes `error` with the mapped `kind`, a failed pull backs off a full
      interval instead of retrying every tick, and the loop keeps running.

**Verification:**
- [x] `cargo test --lib sync::scheduler` → 11 tests: cadence-zero means nothing
      runs, pull due on first run and then on interval, push waits for the
      debounce and does nothing when unchanged, pull beats push, fingerprint
      reacts to edits and deletes but **not** to `record_connection` usage or to
      deny-listed settings, fingerprint honours the dataset's content kinds,
      pending-changes only when auto-push is configured, snapshot field names,
      and every `SyncError` kind matching its serialized discriminant.
- [x] Live scheduler run against Docker openssh (`sync::scheduler::live`): the
      loop's `tick` driven directly (it takes its deps explicitly, so no Tauri
      app is needed) — first tick auto-pulls the publisher's dataset and emits
      `pulling → idle`; the next tick does nothing inside the interval; a local
      edit is NOT published immediately and reports `pendingLocalChanges`; after
      the 5 s window a tick publishes it (generation 1 → 2) and pending clears;
      a quiet tick emits nothing; and a dataset with the master switch **off**
      publishes nothing and emits nothing even with pending changes and an
      elapsed interval.
- [x] `cargo test --lib` → 453 passed; clippy `-D warnings` clean; `pnpm test` →
      494 passed; `pnpm build` clean.
- [ ] NOT DONE — watching the badge react in the running desktop window (macOS
      denies screen capture to this process). Covered by the StatusBar and
      Settings component tests plus the live scheduler run; the through-the-window
      path belongs to the Checkpoint A E2E spec.

**Dependencies:** Task 5.

**Files likely touched:**
- `src-tauri/src/sync/mod.rs` (scheduler), `src-tauri/src/lib.rs`
- `src/stores/sync-store.ts`, `src/components/layout/StatusBar.tsx`
- `src/components/settings/SettingsPage.tsx`

**Estimated scope:** M (5 files)

---

## Checkpoint A: Phase 1 complete (after Tasks 1-6)

- [ ] `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`,
      `cargo test --manifest-path src-tauri/Cargo.toml` all clean
- [ ] `pnpm test` and `pnpm build` clean
- [ ] New E2E target `sshd-sync` (linuxserver/openssh, full SFTP, `testuser/testpass`,
      dedicated dataset dir) added to `tests/e2e/docker-compose.yml` and the
      entrypoint's readiness wait
- [ ] New spec `tests/e2e/specs/95-sync-push-pull.spec.ts`: configure endpoint →
      create hosts → push → `resetApp()` → configure same endpoint + passphrase →
      pull → dashboard shows the same hosts; plus a wrong-passphrase failure case
- [ ] Manual: remote directory inspected over plain `sftp`; no plaintext host data
- [ ] Both themes checked for the new Settings section; keyboard/focus order sane
- [ ] **Stop for human review before Phase 2**

---

## Phase 2: Multiple datasets, scopes, roles

## Task 7: Multiple datasets — list UI, per-dataset secrets, independent state

**Description:** Turn the single-endpoint UI into a list of named datasets
(`NOVA`, `Bank of Cyprus`), each with its own endpoint, passphrase, and sync
state. Schema already supports it (Task 2).

**Acceptance criteria:**
- [ ] Settings ▸ Sync lists datasets with add/edit/remove; each row shows name,
      endpoint, role, last sync, and per-row Push/Pull actions.
- [ ] Secrets are namespaced per dataset (`sync:{datasetId}:server`,
      `sync:{datasetId}:passphrase`); removing a dataset deletes its secrets and its
      `sync_record_state` / `sync_conflicts` rows, and leaves local hosts intact.
- [ ] Two datasets pointing at the same endpoint but different remote paths sync
      independently: a push to one never mutates the other's remote objects or
      record state.
- [ ] Removing a dataset does not delete synced hosts locally (confirmed by a test).

**Verification:**
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml sync::datasets`
- [ ] `pnpm exec vitest run src/components/settings/__tests__/SettingsPage.sync.test.tsx`
- [ ] Manual check: two datasets against `sshd-sync` under `/config/ds-a` and
      `/config/ds-b`; push/pull each, verify isolation over `sftp`.

**Dependencies:** Task 6.

**Files likely touched:**
- `src-tauri/src/sync/commands.rs`, `src-tauri/src/sync/mod.rs`
- `src/stores/sync-store.ts`, `src/components/settings/SettingsPage.tsx`, `src/types/sync.ts`

**Estimated scope:** M-L (5 files)

---

## Task 8: Dataset scope — membership by group / explicit hosts

**Description:** A dataset carries a subset of the local hosts: all hosts, whole
groups, or an explicit host selection. Required for the "one dataset per
customer" workflow.

**Acceptance criteria:**
- [ ] `scope_mode` ∈ {`all`, `groups`, `hosts`} with membership rows in
      `sync_dataset_members`; the dataset editor offers group and host pickers with
      a live count of in-scope hosts.
- [ ] Push includes exactly the in-scope hosts plus the groups they reference (a
      referenced group is always carried so `group_id` never dangles after a pull).
- [ ] A host in two datasets is pushed to both and pulls without duplication (same
      id, LWW applies per dataset with independent `sync_record_state`).
- [ ] Removing a host from a dataset's scope emits a scope-removal record so other
      clients drop it from that dataset without deleting the local host, and this is
      distinguishable from a real delete (tombstone).

**Verification:**
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml sync::scope`
- [ ] `pnpm exec vitest run src/components/settings/__tests__/SettingsPage.sync.test.tsx`
- [ ] Manual check: group-scoped dataset pushes only that group's hosts, verified by
      pulling on a wiped profile.

**Dependencies:** Task 7.

**Files likely touched:**
- `src-tauri/src/sync/scope.rs`, `src-tauri/src/sync/push.rs`, `src-tauri/src/sync/pull.rs`
- `src/components/settings/SettingsPage.tsx`, `src/stores/sync-store.ts`

**Estimated scope:** L (5 files)

---

## Task 9: Owner signing, member verification, pull-only enforcement, write probe

**Description:** Make roles real: an owner signs dataset metadata, members
verify against a pinned fingerprint and cannot push, and the UI is honest that
write prevention belongs to the server.

**Acceptance criteria:**
- [ ] Owner role generates an ed25519 keypair stored in keychain/App Vault
      (`sync:{datasetId}:signing`); `dataset.meta.json` carries a detached signature
      over `(formatVersion, datasetId, generation, payloadSha256, updatedAt)`.
- [ ] Joining pins `ownerFingerprint` on first successful pull; a later bundle whose
      signature is absent, invalid, or signed by another key is **rejected** with
      "this dataset was signed by a different owner", and nothing is applied.
- [ ] Member role: `sync_push` returns a `RoleDenied` error and the UI offers no push
      affordance; a role change to owner requires the signing key to be present.
- [ ] Preflight write probe: when the role is member and the remote is writable, the
      UI warns that the server is not enforcing read-only, with the remote-side fix
      (read-only SSH account / `chmod`) stated in the panel text and README.
- [ ] Passphrase rotation by the owner rewraps DK and bumps generation; members
      pulling with the old passphrase get "wrong dataset passphrase", not a corrupt
      apply.

**Verification:**
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml sync::signing`
      (valid, tampered payload, foreign key, missing signature, rotation)
- [ ] `pnpm exec vitest run src/components/settings/__tests__/SettingsPage.sync.test.tsx`
- [ ] Manual check: owner profile pushes; member profile (same container, read-only
      account) pulls successfully and cannot push; hand-edited
      `dataset.meta.json` is rejected.

**Dependencies:** Task 7 (parallel with Task 8; both touch `SettingsPage.tsx` —
one integration owner).

**Files likely touched:**
- `src-tauri/src/sync/signing.rs`, `src-tauri/src/sync/{push,pull,commands}.rs`
- `src/components/settings/SettingsPage.tsx`, `src/types/sync.ts`

**Estimated scope:** L (5-6 files)

---

## Task 10: Managed-host read-only + detach

**Description:** Prevent silent loss of local edits to dataset-managed hosts
(AD-9) and give an explicit escape hatch.

**Acceptance criteria:**
- [ ] Hosts with `sync_record_state.managed = 1` for a member-role dataset show a
      "managed by <dataset>" badge and their editor fields are disabled, with a
      visible reason.
- [ ] A save attempt on a managed host is blocked in the backend too
      (`save_host` returns a typed error), not only in the UI.
- [ ] **Detach from dataset** clears the managed flag and the record's sync state
      after a confirm dialog, leaving the host locally editable; a later pull does
      not silently re-manage it without the user re-adding it.
- [ ] Owner-role datasets do not mark hosts read-only (the owner is the source of
      truth).

**Verification:**
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml db::tests` (managed-host save rejection)
- [ ] `pnpm exec vitest run src/components/dashboard/HostEditModal.managed.test.tsx`
- [ ] Manual check: member profile cannot edit a pulled host, detach restores editing.

**Dependencies:** Task 9.

**Files likely touched:**
- `src-tauri/src/db/mod.rs`, `src-tauri/src/db/commands.rs`
- `src/components/dashboard/HostEditModal.tsx`, `src/components/dashboard/HostListRow.tsx`
- `src/stores/hosts-store.ts`

**Estimated scope:** M-L (5 files)

---

## Checkpoint B: Phase 2 complete (after Tasks 7-10)

- [ ] Two datasets sync independently; no cross-contamination of records or remotes
- [ ] Member cannot push; unsigned/foreign-signed metadata rejected with a clear error
- [ ] Managed hosts not editable; detach works
- [ ] Full Rust gates + `pnpm test` + `pnpm build` clean
- [ ] E2E: `96-sync-multi-dataset.spec.ts` (two scoped datasets) and
      `97-sync-member-pull-only.spec.ts` (read-only account, push denied) green
- [ ] **Stop for human review before Phase 3**

---

## Phase 3: Recovery, interop, documentation

## Task 11: Remote history + rollback

**Description:** Let a user recover from a bad push using the retained
`history/` generations.

**Acceptance criteria:**
- [ ] `sync_list_history(datasetId)` lists retained generations with timestamp,
      writer client id, and record counts (metadata only, no decrypt required for
      the listing).
- [ ] `sync_rollback(datasetId, generation)` pulls that generation, applies it as a
      normal merge (so local-only records survive), and publishes a **new** generation
      rather than rewriting history.
- [ ] Rollback is owner-only and refuses when the passphrase does not match the
      target generation's wrap.
- [ ] UI lists history under the dataset with a confirm dialog naming what will change.

**Verification:**
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml sync::history`
- [ ] Manual check: push A, push B, roll back to A, verify a new generation exists
      and hosts match A.

**Dependencies:** Task 7 (parallel with Tasks 8-10).

**Files likely touched:**
- `src-tauri/src/sync/history.rs`, `src-tauri/src/sync/commands.rs`
- `src/components/settings/SettingsPage.tsx`, `src/stores/sync-store.ts`

**Estimated scope:** M (4 files)

---

## Task 12: Backup / factory-reset interop + documentation

**Description:** Make sync a first-class citizen of the existing data-management
surfaces and document the feature, including the remote-side permission model.

**Acceptance criteria:**
- [ ] `COPYABLE_TABLES` includes every `sync_*` table, with a test that enumerates
      the live schema and fails when a table is missing from the list.
- [ ] `factory_reset` / `ResetKeys` purge every `sync:{datasetId}:*` secret; a test
      asserts no sync secret namespace survives a reset.
- [ ] Restoring a backup on another machine restores dataset rows without secrets
      and the UI prompts for the server secret and passphrase instead of failing
      opaquely.
- [ ] README (feature + comparison table note that sync is self-hosted and
      zero-cloud), `CHANGELOG.md` entry, and `docs/sync-datasets.md` covering remote
      layout, key hierarchy, role model, the server-side read-only requirement, and
      recovery steps.
- [ ] Scaffolding, probe files, and throwaway scripts from earlier tasks removed.

**Verification:**
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml db::tests backup::tests`
- [ ] `pnpm test`, `pnpm build`, `make e2e`
- [ ] Manual check: `grep` the new modules to confirm no `tracing` field carries a
      secret, hostname, path, or command.

**Dependencies:** Tasks 10, 11.

**Files likely touched:**
- `src-tauri/src/db/mod.rs`, `src-tauri/src/backup/mod.rs`
- `README.md`, `CHANGELOG.md`, `docs/sync-datasets.md`

**Estimated scope:** M (5 files)

---

## Checkpoint C: Complete

- [ ] Every acceptance criterion above met
- [ ] `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`,
      `cargo test --manifest-path src-tauri/Cargo.toml`, `pnpm test`, `pnpm build`,
      `make e2e` all green
- [ ] No secret, host, path, or command in logs/telemetry
- [ ] Ready for review
