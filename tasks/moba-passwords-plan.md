# Implementation Plan: MobaXterm Password File Import (optional step 2)

Status: **T1–T4 implemented and verified. Checkpoint B was manually validated by the user. T5 done; only the both-themes tab-through remains for the user.**
Task list: `tasks/moba-passwords-todo.md` (checklist target; this repo has no external tracker).
The unfinished Dataset Sync plan in `tasks/plan.md` / `tasks/todo.md` is separate and untouched.

## Overview

MobaXterm session exports (`.mxtsessions` / `MobaXterm.ini`) don't include secrets. MobaXterm has a
separate plaintext password export with one `user@host = password` line per entry:

```
weblogic@10.94.97.29 = pass1
weblogic@10.94.97.28 = pass1
```

After a MobaXterm session import finishes, the import modal offers an **optional second step**: pick the
password file, see which saved hosts match, then confirm. Each matched password goes to **the storage
that host is already configured for**: `LocalVault` hosts get App Vault ciphertext, `Keychain` hosts get
a System Keychain entry. Skipping this step leaves today's behavior unchanged.

## Decisions (confirmed with user)

- **Plan location:** prefixed files (`tasks/moba-passwords-*.md`), following the `tab-reorder-*` precedent.
- **Target hosts:** *all* saved hosts that match, **overwriting** any existing password. This covers
  hosts created by this run and hosts skipped as "exists" by an earlier import.
  - Risk: a stale export can silently replace a working password. Mitigation (in scope): the preview
    marks every row that **will replace a saved password**. Every row has a checkbox, so the user can
    untick any host. Commit needs one explicit confirmation when any *ticked* row overwrites.
- **Multi-port matches:** one `user@host` line writes to every saved host with that host and user,
  on any port (confirmed).
- **Per-host untick:** yes. Rows start ticked except `keyAuth` rows, which can't be ticked. The Save
  button counts only ticked rows, and `hostIds` sent to commit is exactly the ticked set.
- **Plaintext file hygiene:** after a successful save, the summary suggests deleting the plaintext
  export file. This is copy only; the app never deletes user files.
- **Real export format (confirmed from the user's sample `MobaXterm Stored Passwords.txt`):** ASCII/UTF-8,
  no BOM, `\r\n` line endings, **no trailing newline on the last line**, one `user@host = password` per
  line, no protocol/port prefixes, no `[section]` headers. The dialog filter is `txt`.
- **Delegation:** subagents. T1 ran on Antigravity Opus 4.6. Antigravity returned 503 twice on T2, so
  T2–T5 use the "OMP - command code implementer" profile (user's choice). The user prefers Antigravity
  Gemini 3.8 Flash when it is available.

## Architecture Decisions

1. **Rust owns the file and the secrets.** React sends only a path and gets back a preview with
   host ids, labels, and statuses. Passwords never appear in IPC responses, React state, logs, or
   `tracing` spans (`#[instrument(skip(path, ...))]`). This matches the Termius rule ("decrypted
   credentials never enter React state") and the AGENTS.md credential rules.
2. **Stateless two-call contract, re-parse on commit.** The two calls are
   `import_preview_mobaxterm_passwords(path)` and `import_save_mobaxterm_passwords(path, hostIds)`.
   Commit re-reads and re-parses the file, then writes only to the host ids the user ticked that
   still match. There is no server-side preview state, token, or TTL.
   Alternative: the Termius preview-token pattern. It keeps plaintext passwords in managed memory
   between calls and needs expiry and cleanup code. Given a small local file, re-parsing is simpler.
   If the file changes between calls, the commit reflects the new contents, and the returned counts
   show what was actually written.
3. **Storage follows each host's persisted `credential_storage` marker.** There is no new selector.
   For a freshly imported host, the marker is the step-1 "Future Credential Storage" choice, so the
   user's selection carries through.
   - `LocalVault` → `vault::store_host_credential_in_vault` (`vault/local.rs`). It encrypts in memory,
     upserts the blob (`ON CONFLICT DO UPDATE`), sets the marker with rollback, and purges any stale
     keychain copy. The plaintext is never written to the keychain.
   - `Keychain` → `vault::save_credential(host_id, StoredCredential::Password)`, which overwrites the
     existing entry.
   - Hosts with `auth_type != "password"` (key auth) are **skipped** and reported. Moba's value isn't
     assumed to be a key passphrase.
4. **Vault gating happens in the frontend and is fail-closed in Rust.** If any ticked match targets
   `LocalVault`, the modal calls the existing `useVaultGuard().checkVault` before committing. Rust
   still returns `LocalVaultLocked` per host if the vault is locked mid-run. It never falls back to
   the keychain.
5. **Best-effort per host, not atomic.** Hosts already exist at this point, so writes are independent.
   The result is `{ stored_in_vault, stored_in_keychain, skipped, failed: [{host_id, host_label, error}] }`,
   mirroring `BulkMigrationResult`. Error strings come from `VaultError` display text and never
   contain secrets.
6. **Parser rules.** `src-tauri/src/import/mobaxterm_passwords.rs` (pure):
   - Bounded read (1 MiB cap). Decoding reuses `decode_mobaxterm_bytes` (UTF-8 with BOM → CP-1252
     fallback), made `pub(super)`.
   - Split each line on the first `" = "`. Fall back to the first `=` if there's no spaced form.
     The key is trimmed. The value keeps all inner and trailing spaces and loses only the line
     terminator (`\r\n` / `\n`). Passwords can contain `=`, `@`, and spaces.
   - The key must be `user@host`, split on the **last** `@`, both sides non-empty, no whitespace.
     Blank lines and `#`/`;` comments are ignored. Malformed lines are counted with their line number
     only, never their content.
   - Host match is case-insensitive and user match is case-sensitive. The file has no port, so one
     key matches **every** saved host with that `(host, username)`, whatever the port.
   - A key that appears twice with **different** passwords is marked **conflict** and never written.
     Exact duplicates collapse into one entry.
   - Values are held in `zeroize::Zeroizing<String>`, and `Debug` redacts them. No `Serialize` on
     secret-bearing types.
7. **UI slots into the existing result view.** For `source === "mobaxterm"` after a finished import,
   the result view shows an "Import passwords (optional)" card, labeled "Step 2 of 2 · optional", with
   `import-mobaxterm-passwords-*` test ids. Stale-response protection uses a generation guard.

## Dependency Graph

```
decode_mobaxterm_bytes (existing) ──► password-file parser (T1, pure)
                                          │
HostDb.list_hosts + credential presence ──┤
                                          ▼
                     preview command + TS types + step-2 preview UI (T2)
                                          │
                                          ▼
               save command: keychain path + confirm UI + summary (T3)
                                          │
useVaultGuard + store_host_credential_in_vault ──► vault path + locked handling (T4)
                                          │
                                          ▼
                       docs / changelog / manual validation (T5)
```

## Task List

### Phase 1: Foundation
- [x] T1: Password-file parser (pure Rust, unit-tested)

### Checkpoint A
- [x] `cargo test mobaxterm_passwords` green; fmt + clippy clean

### Phase 2: Vertical slices
- [x] T2: User previews which hosts a password file matches
- [x] T3: User saves matched passwords to Keychain-configured hosts
- [x] T4: User saves matched passwords to App Vault-configured hosts

### Checkpoint B
- [x] Full Vitest + Rust suites, `pnpm build`, manual end-to-end in `pnpm tauri dev` (both storages; user-verified)

### Phase 3: Polish
- [x] T5: Copy, changelog, accessibility/theme pass

### Checkpoint C: Complete
- [ ] All acceptance criteria met; human review

### Phase 4: Generic password-file import (user request after Checkpoint C)
The `user@host = password` format becomes the app's own **password file** format, no longer tied to
MobaXterm. Users can import passwords at any time, for all saved hosts or any subset. That covers hosts
from any import source and hosts added by hand.
- [x] G1: Generic backend contract. Clean cutover of names, no aliases:
  - Rust: `import/mobaxterm_passwords.rs` → `import/password_file.rs`.
  - Commands: `import_preview_mobaxterm_passwords` → `import_preview_password_file`, and
    `import_save_mobaxterm_passwords` → `import_save_password_file`.
  - Types: `MobaXtermPassword*` → `PasswordFile*`.
  - Error text becomes "Cannot read password file" / "Password file is too large".
  - Behavior is unchanged.
- [x] G2: Shared UI plus a standalone entry point:
  - Extract the step-2 card into `src/components/dashboard/PasswordFileImport.tsx`, with
    `password-file-import-*` test ids.
  - Reuse it as MobaXterm step 2.
  - Add `ImportPasswordsModal`, opened from a new Hosts-dashboard toolbar button "Import Passwords"
    (`import-passwords-button`).
  - The modal shows the file format inline.
  - Rewrite the 1.6.5 changelog entry, which is still unreleased, as a generic feature.

### Checkpoint D
- [ ] Full Rust + frontend gates green; manual: standalone import on manually-added hosts (both storages), MobaXterm step 2 still works

**Phase 4 decisions**
- The entry point is a dashboard toolbar button next to Import, with its own modal. The Import modal is
  about connection sources, and passwords apply to hosts that already exist.
- "Part of them" is handled by the existing per-host checkboxes and All/None. No scoping inputs are
  added to the preview command, because it always matches against every saved host.
- The format is documented in-app (modal help text) and in the changelog. The parser stays lenient
  (`" = "` or `=`, comments `#`/`;`).

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Overwrite replaces a working password with a stale one | High | Preview marks "replaces saved password" per row. The user can untick any row. One explicit confirm checkbox is required when any ticked row overwrites. The summary counts what was written. |
| Plaintext secrets leak to logs/IPC/React | High | Parser and commands never serialize values. `#[instrument(skip(...))]` is on all args. Contract tests assert the preview and save JSON contain no password values. Malformed-line diagnostics use line numbers only. |
| Other Moba versions encode differently (UTF-16, prefixes) | Low | The sample confirms the plain `user@host = pw` + CRLF form. The parser still fails soft: unknown lines go to the "unrecognized" count shown in the preview. UTF-16 is out of scope unless a sample turns up. |
| Keychain existence probe triggers macOS prompts per host | Med | Use `vault::credential_exists`, a prompt-free probe. Vault presence reads `db.get_local_vault_credential`. |
| Vault locks between preview and commit | Low | Rust fails closed per host with `LocalVaultLocked`. The UI shows failures, and Save stays enabled for a retry after unlocking. |
| Native file dialog can't be driven in E2E; no MobaXterm E2E exists today | Med | Rust tests cover real persistence (`test_keychain` + `LocalVault` with session key). Vitest covers the modal. The user manually validated both storages. |

## Open Questions

None. All four were answered by the user; the answers are recorded under Decisions.
