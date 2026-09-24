# Tasks: MobaXterm Password File Import

Plan and architecture decisions: `tasks/moba-passwords-plan.md`.
Gates (from `AGENTS.md`): `pnpm exec vitest run <file>`, `pnpm test`, `pnpm build`,
`cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (in `src-tauri/`).
Run `pnpm build` first on a clean checkout so `dist/` exists for Rust compilation.

---

## Task 1: Password-file parser

**Description:** Add a pure parser that turns MobaXterm password-export bytes into
`user@host → Zeroizing<String>` entries plus diagnostics (malformed line numbers, conflicting keys).
No IPC, no DB.

**Acceptance criteria:**
- [x] `weblogic@10.94.97.29 = pass1` parses to user `weblogic`, host `10.94.97.29`, value `pass1`. Values
      containing `=`, inner and trailing spaces, and `@` in the password all survive intact. The key
      splits on the last `@` of the key segment only.
- [x] Blank lines and `#`/`;` comments are ignored. Malformed lines are reported by line number only.
      Exact duplicates collapse. Same key with different values → `conflict`, and neither value is
      returned. CRLF, a missing trailing newline on the last line, and a UTF-8 BOM are handled.
      CP-1252 input decodes through the shared `decode_mobaxterm_bytes`.
- [x] A fixture test reproduces the user's real export bytes (4 `weblogic@10.94.97.2x = passN` lines,
      CRLF, no trailing newline) and yields exactly 4 entries with values `pass4`…`pass1`.
- [x] Input over 1 MiB is rejected with a stable `SshError::IoError("MobaXterm password file is too large")`.
      No error or `Debug` output includes a password.

**Verification:**
- [x] `cargo test --manifest-path src-tauri/Cargo.toml mobaxterm_passwords`
- [x] `cargo fmt --all --check` and `cargo clippy --all-targets -- -D warnings`

**Dependencies:** None

**Files likely touched:**
- `src-tauri/src/import/mobaxterm_passwords.rs` (new, with `#[cfg(test)]` module)
- `src-tauri/src/import/mobaxterm.rs` (`decode_mobaxterm_bytes` → `pub(super)`)
- `src-tauri/src/import/mod.rs` (`pub mod mobaxterm_passwords;`)

**Estimated scope:** Small

---

## Checkpoint A: Parser
- [x] Parser tests green, fmt and clippy clean
- [x] Parser fixture matches the real export format (confirmed from the user's sample)

---

## Task 2: Preview which hosts a password file matches

**Description:** Add `import_preview_mobaxterm_passwords(path)`. It reads the file in Rust
(`spawn_blocking`), matches entries against `db.list_hosts()` by case-insensitive host plus exact
username, and returns per-host rows with **no secrets**. In the MobaXterm result view, add the
"Import passwords (optional)" card: Browse (native dialog, `.txt` filter) → preview list.

**Acceptance criteria:**
- [x] The response shape is
      `{ matches: [{ host_id, host_label, username, host, port, storage: "keychain"|"localVault", status: "new"|"replaces"|"keyAuth" }], unmatched_entries, conflicts, malformed_lines }`.
      `replaces` uses prompt-free presence checks: `vault::credential_exists` for keychain hosts,
      `db.get_local_vault_credential(..).is_some()` for vault hosts. One key maps to every host with
      the same `(host, user)` on any port.
- [x] The card appears only for `source === "mobaxterm"` after a finished import. Each matched host is a
      row with a checkbox, a "replaces saved password" badge where relevant, and a storage label. Rows
      start ticked, except `keyAuth` rows, which are disabled with a "key login" badge. All/None
      controls are included. Unmatched/conflict/malformed counts are shown. A stale response is dropped
      via `sourceGeneration`. Skipping still leaves the existing Done button working.
- [x] The command is registered in `lib.rs` `generate_handler!`, and TS types are added in `src/types/ssh.ts`
      and exported from `src/types/index.ts`. A Rust contract test asserts the serialized preview contains
      no password value.

**Verification:**
- [x] `cargo test --manifest-path src-tauri/Cargo.toml import_preview_mobaxterm_passwords`
- [x] `pnpm exec vitest run src/components/dashboard/ImportSshConfigModal.test.tsx` (new cases: dialog
      filter, invoke contract `{ path }`, badges rendered, keyAuth row disabled, untick/All/None
      updates the count, card absent for `ssh`/`termius` sources)
- [x] `pnpm build`
- [x] Manual: `pnpm tauri dev`, import a `.mxtsessions`, pick the password file, see correct matches

**Dependencies:** T1

**Files likely touched:**
- `src-tauri/src/import/commands.rs`
- `src-tauri/src/lib.rs`
- `src/types/ssh.ts`, `src/types/index.ts`
- `src/components/dashboard/ImportSshConfigModal.tsx` (+ `.test.tsx`)

**Estimated scope:** Medium

---

## Task 3: Save matched passwords to Keychain-configured hosts

**Description:** Add `import_save_mobaxterm_passwords(path, hostIds)`. It re-parses the file, keeps only
`hostIds` that still match a password-auth host, and writes `StoredCredential::Password` to the
keychain for `Keychain` hosts, overwriting any existing entry. The UI sends exactly the ticked rows as
`hostIds`. It adds a confirm checkbox (required when any *ticked* row is `replaces`), a
"Save N passwords" button (N = ticked count, disabled at 0), and a result summary.

**Acceptance criteria:**
- [x] The result shape is `{ stored_in_keychain, stored_in_vault, skipped, failed: [{ host_id, host_label, error }] }`.
      Key-auth hosts, ids that no longer match, and conflicts count as `skipped`. A single host failure
      doesn't abort the others.
- [x] After commit, a keychain host's `vault::get_credential(id)` returns the file's password, including
      when a different password existed before. The `credential_storage` marker is unchanged.
- [x] The summary replaces the "No passwords were imported" reminder when ≥1 password was stored, and
      lists failures with host labels. After ≥1 password is stored, it suggests deleting the plaintext
      `MobaXterm Stored Passwords.txt` export (copy only; nothing is deleted). Unticked hosts are never
      written. Keyboard focus moves to the summary (`role="status"`).

**Verification:**
- [x] `cargo test --manifest-path src-tauri/Cargo.toml import_save_mobaxterm_passwords`
      (uses `crate::vault::test_keychain::install()`: new write, overwrite, key-auth skip,
      conflict skip, partial failure, a matching host whose id is absent from `hostIds` stays untouched)
- [x] `pnpm exec vitest run src/components/dashboard/ImportSshConfigModal.test.tsx` (invoke payload
      `{ path, hostIds }` equals the ticked set after unticking one row, confirm gating only for ticked
      overwrites, summary text including the delete-file suggestion)
- [x] `pnpm build`
- [x] Manual: import with "System Keychain", apply the password file, connect to the `sshd-pass`
      container host without being prompted

**Dependencies:** T2

**Files likely touched:**
- `src-tauri/src/import/commands.rs`
- `src-tauri/src/lib.rs`
- `src/types/ssh.ts`
- `src/components/dashboard/ImportSshConfigModal.tsx` (+ `.test.tsx`)

**Estimated scope:** Medium

---

## Task 4: Save matched passwords to App Vault-configured hosts

**Description:** Extend the save command so `LocalVault` hosts go through
`vault::store_host_credential_in_vault` (ciphertext upsert, no keychain detour), using the managed
`Arc<LocalVault>`. In the UI, run `checkVault` before commit when any selected match has
`storage === "localVault"`.

**Acceptance criteria:**
- [x] With the vault unlocked, a vault host's `resolve_host_credential(.., LocalVault)` returns the file's
      password. An existing blob is replaced. There's no keychain entry for that host afterward.
- [x] With the vault locked, vault hosts appear in `failed` with the `LocalVaultLocked` message, and
      keychain hosts in the same run still succeed. Nothing is ever written to the keychain as a fallback.
- [x] The UI shows the vault unlock/setup dialog before committing when vault targets exist. It doesn't
      when all targets are keychain. Cancelling the unlock leaves the preview intact.

**Verification:**
- [x] `cargo test --manifest-path src-tauri/Cargo.toml import_save_mobaxterm_passwords`
      (vault unlocked via `set_session_key`, vault locked, mixed-storage run)
- [x] `pnpm exec vitest run src/components/dashboard/ImportSshConfigModal.test.tsx` (guard invoked only
      for vault targets)
- [x] `pnpm build`
- [x] Manual: import with "Encrypted App Vault", apply the file, lock/unlock, and connect without a prompt

**Dependencies:** T3

**Files likely touched:**
- `src-tauri/src/import/commands.rs`
- `src/components/dashboard/ImportSshConfigModal.tsx` (+ `.test.tsx`)

**Estimated scope:** Small

---

## Checkpoint B: Core flow
- [x] `pnpm test`, `pnpm build`, `cargo fmt --all --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` all green
- [x] Manual end-to-end in `pnpm tauri dev` for both storages, including one overwrite
- [x] Review with human before polish

---

## Task 5: Copy, changelog, accessibility/theme pass

**Description:** Update the pre-import notice ("No passwords are included…") so it mentions the optional
password step for MobaXterm. Add a CHANGELOG entry. Verify keyboard, focus, and both themes.

**Acceptance criteria:**
- [x] The MobaXterm notice mentions the optional password-file step. The OpenSSH notice is unchanged.
- [x] A CHANGELOG entry covers the step, the overwrite behavior, and the per-host storage routing.
- [x] The step is fully keyboard operable (Browse → confirm → Save → Done). Text is legible in dark and
      light themes and uses tokens from `src/theme.css` only.

**Verification:**
- [x] `pnpm exec vitest run src/components/dashboard/ImportSshConfigModal.test.tsx`
- [x] `pnpm build`
- [ ] Manual: tab through the step in both themes

**Dependencies:** T4

**Files likely touched:**
- `src/components/dashboard/ImportSshConfigModal.tsx` (+ `.test.tsx`)
- `CHANGELOG.md`

**Estimated scope:** Small

---

## Checkpoint C: Complete
- [x] All task acceptance criteria checked
- [x] Full frontend and Rust gates green
- [x] No E2E spec added. The MobaXterm flow depends on the native file dialog, and no MobaXterm E2E
      exists today. Persistence is covered by Rust integration tests plus manual validation. Reported
      as a known gap.
- [ ] Ready for human review

---

# Phase 4: Generic password-file import

## Task G1: Generic backend contract (rename, no behavior change)

**Description:** Make the password-file parser and the preview/save commands source-neutral. This is a
clean cutover with no aliases and no old command names left behind.

**Acceptance criteria:**
- [x] Module `src-tauri/src/import/password_file.rs` replaces `mobaxterm_passwords.rs`.
- [x] Commands `import_preview_password_file(path)` and `import_save_password_file(path, hostIds)` are
      registered in `lib.rs`. The old names are gone from Rust, TS, and tests.
- [x] Types `PasswordFilePreview`, `PasswordFileMatch`, `PasswordFileStatus`, `PasswordFileSaveResult`,
      and `PasswordFileFailure` exist in Rust and TS with the same wire shape.
- [x] Error strings read "Cannot read password file" and "Password file is too large". Code comments
      describe the app's password-file format (MobaXterm's export is one producer of it).

**Verification:** `cargo test password_file`, `cargo fmt --check`, `cargo clippy -D warnings`,
`cargo test`, `pnpm test`, `pnpm build`.

**Dependencies:** T1–T5

**Files:** `src-tauri/src/import/{password_file.rs,commands.rs,mod.rs}`, `src-tauri/src/lib.rs`,
`src/types/{ssh.ts,index.ts}`, `src/components/dashboard/ImportSshConfigModal.tsx` (+ test)

**Scope:** Medium

## Task G2: Shared component + standalone "Import Passwords"

**Description:** Extract the step-2 card into a reusable `PasswordFileImport` component. The MobaXterm
result view uses it, and so does a new `ImportPasswordsModal` opened from the Hosts dashboard.

**Acceptance criteria:**
- [x] `PasswordFileImport` owns browse, preview, per-host selection, All/None, overwrite confirm, the
      vault guard, save, the summary, and the delete-file hint. Test ids are `password-file-import-*`.
      It takes `onSaved(result)` and an optional heading.
- [x] The MobaXterm step 2 renders `PasswordFileImport` with identical behavior. The existing
      "No passwords were imported" reminder still hides after a successful save.
- [x] The Hosts toolbar has an "Import Passwords" button (`import-passwords-button`, KeyRound icon)
      that opens `ImportPasswordsModal` (`ModalShell`, title "Import Passwords"). The modal shows the
      format inline (`user@host = password`, one per line, `#` comments), and says each password goes
      to that host's configured storage and that all saved hosts are matched. With no saved hosts, it
      shows an explanatory empty state. The dashboard reloads hosts after a save.
- [x] The CHANGELOG 1.6.5 entry is rewritten as the generic feature, with MobaXterm step 2 as one
      entry point.

**Verification:** `pnpm exec vitest run src/components/dashboard/PasswordFileImport.test.tsx
src/components/dashboard/ImportSshConfigModal.test.tsx src/components/dashboard/HostView.test.tsx`,
`pnpm test`, `pnpm build`. Manual: standalone import on hand-added hosts (both storages).

**Dependencies:** G1

**Files:** `src/components/dashboard/{PasswordFileImport.tsx,PasswordFileImport.test.tsx,ImportPasswordsModal.tsx,ImportSshConfigModal.tsx,ImportSshConfigModal.test.tsx,HostsDashboard.tsx,index.ts}`, `CHANGELOG.md`

**Scope:** Medium–Large (component move is the bulk)

## Checkpoint D
- [x] All gates green (`cargo fmt/clippy/test`, `pnpm test`, `pnpm build`)
- [ ] Manual: standalone import on manually-added hosts, both storages; MobaXterm step 2 unchanged
