# Implementation Plan: Local Start Folder (per host + global default)

Status: **awaiting human review** — no code has been written.
Task list: `tasks/todo.md` (checklist target; this repo has no external tracker).
Commit prefix: `[v1.6.8]` (`v1.6.7` is already tagged).

## Overview

When the dual-pane Explorer opens for a server, the **local** (left) pane opens
in a folder the user chose instead of always `$HOME`. Resolution order:

1. The host's own local start folder (if set for this saved host on this machine).
2. The global "Default local folder" (Settings → Explorer).
3. The OS home directory (`local_home_dir`), which is today's behaviour.

A configured folder that no longer exists or cannot be listed is skipped. The
pane falls through to the next step and shows a non-blocking toast.

## Current State (evidence)

- The local pane always opens at home: `LocalExplorerPane.tsx:165-200` calls
  `local_home_dir`, then `local_list_dir`. The `initialPath` prop exists
  (line 23/80), but `ExplorerPage.tsx:590` never passes it.
- The remote pane already has an equivalent chain: `ExplorerView.tsx:533-551`
  (start dir → home → `/`), backed by `saved_hosts.start_directory`.
- Settings persist as key/value through `persist()` → `save_setting` and are
  hydrated in `settings-store.loadSettings` (`load_all_settings`, line 506+). JSON
  values follow the `editors_config` / `terminal_highlight_rules` pattern.
- Settings → Explorer section already exists (`SettingsPage.tsx:910`,
  `ExplorerSettings`).
- Hosts get their id in `HostEditModal.buildHost` (`crypto.randomUUID()`, line
  561), so the id exists at Save time, new hosts included.
- `hosts-store` owns `deleteHost` (line 69) and `duplicateHost` (line 49).
- Sessions carry `savedHostId` (`sftp-store.openSession`).
- `@tauri-apps/plugin-dialog` `open({ directory: true })` is already used in
  `ExplorerView.tsx:561`.

## Architecture Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Store per-host local folders **machine-local** in `settings` key `explorer_host_local_dirs` as a JSON map `{ [hostId]: path }`. Do **not** add a `saved_hosts` column. | A local path belongs to one machine. Host-dataset Sync must not spread one user's `/Users/x/...` to teammates or other OSes. No migration and no Rust schema change. |
| D2 | Global fallback in `settings` key `explorer_default_local_dir` (string; empty = home). | Reuses the existing settings persistence path. |
| D3 | Both values are set **only through a folder picker** (Browse…) plus Clear. The displayed field is read-only, and the value is the absolute OS-native path returned by the dialog. | Paths are always well-formed. There is no `~` or env-var parsing on the local side. |
| D4 | A single pure resolver `resolveLocalStartCandidates(hostId, settings)` returns the ordered candidate list. `LocalExplorerPane` tries each candidate with `local_list_dir` and falls through on failure. | Testable without Tauri. It mirrors the remote fallback-chain shape. |
| D5 | When a configured folder fails, show a toast ("Local start folder not found, opened … instead"). Remote behaviour stays silent and unchanged. | Stale local paths are user-actionable. |
| D6 | The same rule applies on **every mount** of the local pane, including switching the left pane from a remote host back to "Local" (`handleSelectLocalSource`). | One rule and no special cases. The local pane is conditionally rendered, so a switch back already remounts it. |
| D7 | Sessions without `savedHostId` (quick connect / ad-hoc) use the global default. | Same chain with an empty step 1. |
| D8 | The host editor writes the per-host folder on **Save** (Cancel discards). | Consistent with every other host-form field. |
| D9 | Host delete removes the map entry. Host duplicate copies it to the new id. | No orphaned entries. A duplicate lives on the same machine. |
| D10 | Rename the remote field label "Start Directory" → "Remote start folder" and add "Local start folder" next to it. Keep `data-testid="host-modal-start-directory"`. | The two fields need to be told apart. Specs 59 and 66 select by test id, so they stay valid. |
| D11 | The local folder field is **not** locked by `fieldsLocked` (managed/synced hosts). | It is machine-local data, not part of the shared host record. |
| D12 | Backup/restore carries both settings keys (backup restores all settings). The fall-through in D5 covers restores onto another machine. | Accepted per review. |

Non-goals: remembering the last-visited local folder per host, env-var or `~`
expansion, typed paths, any change to the remote start directory behaviour,
importer changes (MobaXterm/Termius/ssh_config have no local-folder field).

## Dependency Graph

```
settings-store keys + setters + __e2e hooks
        │
        ├── resolveLocalStartCandidates (src/lib/local-start-dir.ts)
        │          │
        │          └── LocalExplorerPane fallback chain + toast
        │                     │
        │                     └── ExplorerPage passes savedHostId
        │
        ├── Settings → Explorer "Default local folder" UI      (Task 1)
        ├── HostEditModal "Local start folder" UI + Save        (Task 2)
        └── hosts-store delete/duplicate map maintenance        (Task 3)
                                                                │
                                         E2E spec 98 (Task 4) ──┘
```

## Task List

### Phase 1: Core behaviour
- [ ] Task 1: Global default local folder works end to end
- [ ] Task 2: Per-host local start folder overrides the global default
- [ ] Task 3: Host delete/duplicate keep the folder map consistent

### Checkpoint: Core behaviour
- [ ] `pnpm test` and `pnpm build` pass
- [ ] Manual: host folder → global → home chain works in `pnpm tauri dev`, both themes

### Phase 2: Integration coverage and docs
- [ ] Task 4: E2E spec `98-local-start-folder.spec.ts`
- [ ] Task 5: CHANGELOG / README

### Checkpoint: Complete
- [ ] All acceptance criteria met, `make e2e` (spec 98 + 59 + 66 + 94) green
- [ ] Ready for review

Details, acceptance criteria and verification per task: `tasks/todo.md`.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Save is disabled entirely for locked/managed hosts, so D11 has nowhere to save. | Med | Check during Task 2. If Save is blocked, persist the local folder independently of the host record on that path and cover it with a test. |
| The local pane flashes `$HOME` before the resolved folder loads. | Low | Resolve candidates before the first `local_list_dir`. Never list home first. |
| Windows paths (`C:\…`) or UNC/network shares are slow or unreachable. | Med | Each candidate is a single `local_list_dir`. Failure falls through with a toast. A share that hangs is bounded by the existing command behaviour. Note it in the manual check. |
| The settings JSON map is corrupted or hand-edited. | Low | Parse defensively and treat invalid JSON as an empty map, as with `terminal_highlight_rules`. |
| WebdriverIO cannot drive the native folder dialog. | Low | E2E sets values through `__e2e` settings hooks. Dialog behaviour is covered by Vitest with a mocked `plugin-dialog`. |

## Open Questions

None. All design questions were resolved in the review round (Q1–Q14).
