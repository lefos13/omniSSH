# Tasks: Local Start Folder (per host + global default)

Plan and architecture decisions: `tasks/plan.md` (D1–D12).
Gates (`AGENTS.md`): `pnpm exec vitest run <file>`, `pnpm test`, `pnpm build`, `make e2e`.
No Rust changes are expected. If one becomes necessary, also run `cargo fmt --all --check`,
`cargo clippy --all-targets -- -D warnings` and `cargo test` in `src-tauri/`.
Commit prefix: `[v1.6.8]`.

---

## Phase 1: Core behaviour

## Task 1: Global default local folder works end to end

**Description:** Add `explorer_default_local_dir` to `settings-store` (state, setter
using `persist`, hydration in `loadSettings`). Add a "Default local folder" row
to Settings → Explorer: a read-only path display with Browse… (`plugin-dialog`
`open({ directory: true })`) and Clear. Add `src/lib/local-start-dir.ts` with
the pure `resolveLocalStartCandidates(hostId, settings)`. Change
`LocalExplorerPane` init to try the configured candidates in order, falling back
to `local_home_dir`. If a configured candidate fails, show a toast. Home is never
listed before the resolved folder.

**Acceptance criteria:**
- [x] When a default folder is set, a new Explorer tab's local pane opens in it. When it is cleared, the pane opens at home.
- [x] If the default folder is missing or unreadable, the pane opens at home and shows a toast naming the fallback.
- [x] The setting survives an app restart. The field can only be set through Browse…, and Clear empties it.

**Verification:**
- [x] `pnpm exec vitest run src/lib/local-start-dir.test.ts`. Covers ordering, empty values and invalid map JSON.
- [x] `pnpm exec vitest run src/components/sftp/LocalExplorerPane` (existing test file if present, else new). Covers success, fall-through with toast and the no-config path.
- [x] `pnpm exec vitest run src/stores/settings-store.test.ts src/components/sftp/ExplorerPage.test.tsx`
- [x] `pnpm build`
- [ ] Manual (`pnpm tauri dev`): set, open, clear and delete the folder on disk, then reopen. Check dark and light themes, plus keyboard focus on Browse…/Clear.

**Dependencies:** None

**Files likely touched:**
- `src/stores/settings-store.ts` (+ `settings-store.test.ts`)
- `src/lib/local-start-dir.ts` (+ `.test.ts`)
- `src/components/sftp/LocalExplorerPane.tsx` (+ test)
- `src/components/settings/SettingsPage.tsx` (`ExplorerSettings`)

**Estimated scope:** Medium

---

## Task 2: Per-host local start folder overrides the global default

**Description:** Add `explorer_host_local_dirs` (a JSON map `{ [hostId]: path }`)
to `settings-store` with `setHostLocalDir(hostId, path | null)`. In
`HostEditModal`, rename the remote label to "Remote start folder" (keep the
`host-modal-start-directory` test id) and add a "Local start folder" row with a
read-only display, Browse… and Clear (`data-testid="host-modal-local-start-folder"`
plus `-browse` / `-clear`). It is held in form state and written on Save
(`buildHost().id`) and discarded on Cancel. It is not affected by `fieldsLocked`.
`ExplorerPage` passes the session's `savedHostId` to `LocalExplorerPane`, and the
resolver puts the host folder first.

**Acceptance criteria:**
- [x] A host with a local folder opens the Explorer's local pane there. A host without one uses the global default, then home. Quick connect uses the global default.
- [x] Switching the left pane from a remote host back to "Local" reopens at the host's local folder.
- [x] Saving the host persists the folder (new and existing hosts). Cancel discards changes. Managed/locked hosts can still set it.

**Verification:**
- [x] `pnpm exec vitest run src/components/dashboard/HostEditModal` covers Browse (mocked dialog), Clear, Save, Cancel and the locked-host case.
- [x] `pnpm exec vitest run src/components/sftp/ExplorerPage.test.tsx src/lib/local-start-dir.test.ts`
- [x] `pnpm build`
- [ ] Manual: two hosts with different folders, one without. Open each and check the precedence. Check both themes.

**Dependencies:** Task 1

**Files likely touched:**
- `src/stores/settings-store.ts`
- `src/components/dashboard/HostEditModal.tsx` (+ new/updated test)
- `src/components/sftp/ExplorerPage.tsx`
- `src/components/sftp/LocalExplorerPane.tsx`

**Estimated scope:** Medium

---

## Task 3: Host delete/duplicate keep the folder map consistent

**Description:** In `hosts-store`, `deleteHost` removes the host's entry from
`explorer_host_local_dirs`, and `duplicateHost` copies the entry to the new id.

**Acceptance criteria:**
- [x] After a host is deleted, its id is gone from the map.
- [x] A duplicated host opens its local pane in the same folder as the original. Changing one does not change the other.

**Verification:**
- [x] `pnpm exec vitest run src/stores/hosts-store` (new or existing test file)
- [x] `pnpm test`

**Dependencies:** Task 2

**Files likely touched:**
- `src/stores/hosts-store.ts` (+ test)

**Estimated scope:** Small

---

## Checkpoint: Core behaviour
- [x] `pnpm test` passes
- [x] `pnpm build` passes
- [ ] Manual end-to-end in `pnpm tauri dev`: host folder → global → home, missing-folder toast, both themes
- [ ] Review with human before Phase 2

---

## Phase 2: Integration coverage and docs

## Task 4: E2E spec `98-local-start-folder.spec.ts`

**Description:** Add `__e2e` hooks to `settings-store`
(`__e2eSetDefaultLocalDir`, `__e2eSetHostLocalDir`). Using the
`tests/e2e/helpers/` (`host.ts`, `sftp-ops.ts`, `reset.ts`), create local
folders in the container, then cover these cases: the host folder wins, the
global fallback applies when the host has none, a deleted folder falls back to
home with a toast, and both values survive a relaunch (established relaunch
helper).

**Acceptance criteria:**
- [x] Spec 98 passes (focused Docker run, 4/4). Specs 59, 66 and 94 (remote start dir, two explorers, dual-pane transfer) still pass (focused runs).
- [x] Every test relies on `resetApp()` isolation. The persistence test uses the relaunch helper.

**Verification:**
- [x] Focused-spec invocation documented in `tests/e2e/README.md`, plus full `make e2e` (83/83)

**Dependencies:** Tasks 1–3

**Files likely touched:**
- `tests/e2e/specs/98-local-start-folder.spec.ts`
- `src/stores/settings-store.ts` (e2e hooks)
- `tests/e2e/helpers/sftp-ops.ts` (only if a local-pane path reader is missing)

**Estimated scope:** Small–Medium

---

## Task 5: CHANGELOG / README

**Description:** Add an Unreleased/`1.6.8` CHANGELOG entry. Update the README
feature list if it describes the Explorer start directory.

**Acceptance criteria:**
- [x] The CHANGELOG describes the per-host local start folder, the global default and the fallback toast.

**Verification:**
- [x] Read-through. No generated assets (`screens/`) are regenerated.

**Dependencies:** Task 4

**Files likely touched:**
- `CHANGELOG.md`
- `README.md` (conditional)

**Estimated scope:** XS

---

## Checkpoint: Complete
- [x] `pnpm test` (102 files / 760 tests), `pnpm build`, `make e2e` (83/83 spec files) green
- [x] All acceptance criteria above checked
- [ ] Ready for human review / commit (`[v1.6.8] feat(explorer): …`)
