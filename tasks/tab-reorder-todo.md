# Tasks: Drag-and-Drop Tab Reordering

Plan and architecture decisions: `tasks/tab-reorder-plan.md`.
Gates (`AGENTS.md`): `pnpm exec vitest run <file>`, `pnpm test`, `pnpm build`, `make e2e`.
Frontend-only feature: no Rust, IPC, or SQLite change, so the Cargo gates don't apply.

---

## Phase 1: Reorder works end to end

## Task 1: Drag a tab to a new position

**Description:** The pointer path, complete. A `moveTab(id, toIndex)` store
action owns the ordering invariants (AD-1). `UnifiedTabBar` wraps the strip in
a `DndContext` + `SortableContext` and renders each tab through a file-local
`SortableTab` component (AD-6), so dragging a tab and dropping it on another
tab reorders the strip.

**Acceptance criteria:**
- [x] `useTabStore.moveTab(id, toIndex)` moves `id` to the clamped index and
      leaves `tabs`, `activeTabId`, and the domain stores untouched. Moving the
      Hosts tab, an unknown id, or a same-index move returns the identical state
      object. When Hosts is at index 0, nothing can be moved to index 0.
- [x] Dragging a non-Hosts tab (MouseSensor `distance: 5`, TouchSensor
      `delay: 250, tolerance: 5`, `closestCenter`,
      `horizontalListSortingStrategy`, inline y-lock modifier,
      `CSS.Translate`) reorders `tabOrder`. The Hosts tab is
      `useSortable({ disabled: true })`: it can't be dragged and isn't a drop
      target.
- [x] No regression: a plain click still activates, middle-click still closes,
      the close button still closes, Enter/Space still activate, overflow
      chevrons and active-tab scroll-into-view still work, and each tab keeps
      `role="tab"`, `aria-selected`, `tabIndex=0`, `data-testid="tab-<id>"`,
      `data-tab-type`, and `data-tab-label` (dnd-kit `attributes` spread first).
      `DndContext` `accessibility.screenReaderInstructions` names the
      Cmd/Ctrl+Shift+[ / ] shortcut instead of the default Space-to-lift text.
      While dragging, the tab uses the `SortableCard` feedback (opacity 0.5,
      zIndex 30).

**Verification:**
- [x] `pnpm exec vitest run src/stores/__tests__/tab-store.test.ts` (new):
      move right, move left, clamp past both ends, Hosts pin (can't move Hosts,
      can't displace it from index 0), unknown id and same-index return the same
      state reference, `activeTabId` unchanged.
- [x] `pnpm exec vitest run src/components/layout/__tests__/UnifiedTabBar.test.tsx`:
      existing middle-click/chevron cases pass unchanged, plus one new case
      asserting a rendered tab still exposes `role="tab"` with `aria-selected`
      after the sortable wrapper.
- [x] `pnpm test`, `pnpm build` clean.
- [x] Manual in `pnpm tauri dev`: open Snippets, History, and Settings plus one
      terminal. Drag the terminal to the far left (it lands at index 1, after
      Hosts) and then back. Hosts can't be dragged. Cmd+1…9 follow the new
      order. With ~12 tabs, dragging towards the strip edge auto-scrolls it.
      The terminal keeps its scrollback (no remount).

**Dependencies:** None.

**Files likely touched:**
- `src/stores/tab-store.ts`
- `src/stores/__tests__/tab-store.test.ts` (new)
- `src/components/layout/UnifiedTabBar.tsx`
- `src/components/layout/__tests__/UnifiedTabBar.test.tsx`

**Estimated scope:** M (4 files)

---

## Task 2: Move the active tab with Cmd/Ctrl+Shift+[ / ]

**Description:** The keyboard path. Four `ShortcutDef`s in AppShell (`[`, `{`
for left and `]`, `}` for right, all `meta: true, shift: true`, per AD-4) call
`moveTab(activeTabId, idx ∓ 1)`. The store clamp enforces the Hosts pin and
the ends of the strip.

**Acceptance criteria:**
- [x] Cmd/Ctrl+Shift+] moves the active tab one position right, and
      Cmd/Ctrl+Shift+[ moves it one position left. The active tab stays active
      and stays scrolled into view.
- [x] At either end, or when the active tab is Hosts, the shortcut does nothing
      (no wrap-around, unlike Cmd+[ / ] tab switching).
- [x] Existing Cmd+[ / Cmd+] (switch tab, no Shift) behaviour is unchanged,
      because the hook's exact Shift match keeps the two sets apart.

**Verification:**
- [x] `pnpm exec vitest run src/components/layout/__tests__/AppShell.test.tsx`:
      new cases dispatch `keydown` with `metaKey + shiftKey` for both `"]"`/`"}"`
      and `"["`/`"{"`, assert `tabOrder` changes and `activeTabId` doesn't,
      assert no move at the right edge or next to Hosts, and confirm that plain
      Cmd+] still switches tabs.
- [x] `pnpm test`, `pnpm build` clean.
- [x] Manual in `pnpm tauri dev` on the real keyboard: both chords move the
      active tab, including while focus is inside a terminal.

**Dependencies:** T1 (`moveTab`).

**Files likely touched:**
- `src/components/layout/AppShell.tsx`
- `src/components/layout/__tests__/AppShell.test.tsx`

**Estimated scope:** S (2 files)

---

## Checkpoint 1: After Tasks 1–2
- [x] `pnpm test` and `pnpm build` clean
- [x] Manual: drag reorder, Hosts pin, click/middle-click/close/Enter still work, keyboard move in both directions
- [x] **Human review before Phase 2** (user verified in the running app)

---

## Phase 2: Real-app proof and release notes

## Task 3: E2E spec `97-tab-reorder.spec.ts`

**Description:** Drive the real Tauri app. Page tabs (Snippets, History,
Settings) avoid an SSH dependency, so the spec is cheap and deterministic.
It reuses `dragOnto` from `helpers/reorder.ts` and `cmdShift` from
`helpers/keyboard.ts`.

**Acceptance criteria:**
- [x] After `resetApp()`, open three page tabs. `dragOnto(first non-Hosts
      tab, last tab)` produces the expected DOM order, read from
      `[data-tab-type]` → `data-tab-label` via a new `domTabOrder()` helper in
      `helpers/tabs.ts`.
- [x] Dragging a tab onto Hosts leaves Hosts first. Dragging Hosts itself
      changes nothing.
- [x] `cmdShift("]")` / `cmdShift("[")` move the active tab one position and
      keep it active.

**Verification:**
- [x] `make e2e` with the spec filter for `97-tab-reorder` green (3/3, two runs).
- [x] Existing tab specs `13-multiple-tabs`, `14-tab-switching-keys`,
      `15-cmd-w-close`, `61-exit-overlay-close-removes-tab`, and
      `72-keyboard-navigation` still green.

**Dependencies:** T1, T2.

**Files likely touched:**
- `tests/e2e/specs/97-tab-reorder.spec.ts` (new)
- `tests/e2e/helpers/tabs.ts`

**Estimated scope:** S (2 files)

---

## Task 4: CHANGELOG entry + theme/overflow manual pass

**Description:** Record the user-visible feature, then do the UI checks
`AGENTS.md` requires for UI changes.

**Acceptance criteria:**
- [x] `CHANGELOG.md` `[Unreleased]` notes drag-to-reorder tabs, the Hosts pin,
      and the Cmd/Ctrl+Shift+[ / ] shortcut, in the file's existing style.
- [ ] Drag feedback (dimmed lifted tab, neighbours sliding) reads clearly in
      both dark and light themes and under a custom accent.
- [x] No regenerated screenshots (the captured UI doesn't change at rest).

**Verification:**
- [ ] Manual in `pnpm tauri dev`: dark and light themes, with a mid-drag
      screenshot of each. Overflowing strip auto-scrolls during a drag.
      Keyboard focus ring still shows on Tab navigation.
- [x] `pnpm build` clean.

**Dependencies:** T3.

**Files likely touched:**
- `CHANGELOG.md`

**Estimated scope:** XS (1 file)

---

## Checkpoint 2: Complete
- [ ] Every acceptance criterion above met
- [x] `pnpm test`, `pnpm build`, and `97-tab-reorder` + the existing tab E2E specs green
- [ ] Ready for review
