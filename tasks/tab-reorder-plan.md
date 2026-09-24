# Implementation Plan: Drag-and-Drop Tab Reordering

Status: **awaiting human review**. No code has been written.
Task list: `tasks/tab-reorder-todo.md`. It lives apart from the unfinished Encrypted
Sync plan in `tasks/plan.md` / `tasks/todo.md`, which is untouched.

## Overview

Users can change the order of open tabs in the top tab bar (`UnifiedTabBar`)
by dragging a tab to a new position. Keyboard users get Cmd/Ctrl+Shift+[ and
Cmd/Ctrl+Shift+] to move the active tab left or right. The Hosts tab stays
pinned at position 0. Tab order is session state only. Tabs are not restored
across restarts today, so there is nothing to persist and no Rust, IPC, or
SQLite change.

Non-goals: dragging a tab out into a new window, reordering the inner
`SftpTabs` strip (a fallback surface with its own order derived from
`useSftpStore.sessions`), persisting tab order, and dragging panes between
terminal tabs.

## What already exists (verified)

| Building block | Location | Use |
| --- | --- | --- |
| Tab order state `tabOrder: string[]` + `tabs` map | `src/stores/tab-store.ts` | Add one `moveTab` action. The rest of the store is unchanged |
| Tab strip rendering `tabOrder.map(...)` inside a `role="tablist"` overflow scroller | `src/components/layout/UnifiedTabBar.tsx:165-298` | Wrap it in a `DndContext` + `SortableContext` and make each tab a sortable item |
| `@dnd-kit/core` 6.3, `@dnd-kit/sortable` 10, `@dnd-kit/utilities` 3 | `package.json` | Already installed. **No new dependency** (`@dnd-kit/modifiers` is *not* installed, so a 3-line inline axis-lock modifier is used instead) |
| Sensor convention: `MouseSensor {distance: 5}`, `TouchSensor {delay: 250, tolerance: 5}`, `closestCenter` | `HostsDashboard.tsx:660-664`, `GroupsSidebar.tsx:82-86` | Reuse the same constraints, so a plain click still activates and a 5 px move starts a drag |
| "spread dnd-kit `attributes` first so our role/aria wins" pattern | `GroupsSidebar.tsx:226-229` | Required so `role="tab"`, `tabIndex`, and `aria-selected` survive (dnd-kit sets `role="button"`) |
| Sortable visual feedback (opacity 0.5, zIndex 30 while dragging) | `dashboard/SortableCard.tsx` | Copy the same feedback |
| Tab shortcuts Cmd+1…9, Cmd+[ / Cmd+] reading `tabOrder` | `AppShell.tsx:199-230` | They follow visual order automatically after a reorder. New move shortcuts go in the same list |
| `ShortcutDef.shift` support | `src/hooks/use-keyboard-shortcuts.ts:8,39` | Already matches Shift exactly |
| E2E `dragOnto(source, target)` pointer gesture (exceeds 5 px, settles on target centre) | `tests/e2e/helpers/reorder.ts:74` | Reused as-is for tabs. `cmdShift(key)` exists in `helpers/keyboard.ts` |
| Highest E2E spec number | `96-sync-scopes-members.spec.ts` | New spec is `97-tab-reorder.spec.ts` |

Shortcut collision check: nothing in `src/` or `src-tauri/src/` binds
Cmd/Ctrl+Shift+[ or ].

## Architecture Decisions

**AD-1: One store action, `moveTab(id, toIndex)`, serves drag and keyboard.**
The drag handler resolves `toIndex = tabOrder.indexOf(over.id)`. The keyboard
handler passes `indexOf(activeTabId) ± 1`. The action owns every invariant, so
no caller can break them:
- Clamp `toIndex` to `[minIndex, tabOrder.length - 1]`, where `minIndex = 1`
  when `tabOrder[0]` is the Hosts tab, otherwise `0` (the Hosts pin).
- Moving the Hosts tab itself, an unknown id, or a same-index move returns the
  **same state object**, so Zustand skips re-rendering subscribers.
- It never touches `tabs`, `activeTabId`, or domain stores. Reordering is purely
  visual, and `syncDomainStores` is not called.

**AD-2: Hosts is pinned in two layers.** The Hosts item uses
`useSortable({ id, disabled: true })`, so it can't be picked up and isn't a drop
target. The store clamp (AD-1) backs this up for keyboard moves and any future
caller.

**AD-3: Pointer and touch sensors only. No dnd-kit `KeyboardSensor`.** Tabs
already use Enter/Space for activation (`UnifiedTabBar.tsx:216`), and
KeyboardSensor's Space/Enter pick-up would collide with that. Keyboard
reordering is Cmd/Ctrl+Shift+[ / ] instead (user decision). `DndContext` gets
custom `accessibility.screenReaderInstructions` that name the shortcut, so the
`aria-describedby` dnd-kit attaches doesn't describe a Space-to-lift gesture
that doesn't exist.

**AD-4: Register both `[`/`]` and `{`/`}` for the Shift variants.**
`useKeyboardShortcuts` compares `e.key`. On US layouts, Shift+[ reports
`e.key === "{"`, while synthetic WebDriver chords can report `"["`. Two
`ShortcutDef`s per direction cover both without changing the shared hook's
matching rules. Rejected alternative: switching the hook to `e.code`. It
touches every existing shortcut to fix one case.

**AD-5: Horizontal-only, width-safe transforms.** An inline modifier
`({ transform }) => ({ ...transform, y: 0 })` locks the drag to the strip's
axis. Item style uses `CSS.Translate.toString` (not `CSS.Transform`) because
tabs have variable widths (`max-w-[220px]`) and `horizontalListSortingStrategy`
would otherwise emit `scaleX` and stretch the label. Strategy is
`horizontalListSortingStrategy` and collision detection is `closestCenter`.

**AD-6: Extract a `SortableTab` component inside `UnifiedTabBar.tsx`.**
`useSortable` is a hook and can't be called inside `tabOrder.map`. The existing
per-tab JSX (status dot, split indicator, zoom indicator, close button, middle-
click close, keyboard activation) moves into it unchanged. It isn't exported and
it stays in the same file. Existing `data-testid`, `data-tab-type`, and
`data-tab-label` attributes are preserved exactly, because 90+ E2E specs select
on them.

**AD-7: Terminal content is unaffected.** `tabOrder` is read only by
`UnifiedTabBar` and the AppShell shortcuts. `TerminalTabContainer` doesn't
render by `tabOrder`, so no xterm/WebGL DOM node is moved or remounted when
tabs reorder.

## Dependency Graph

```
tab-store.moveTab(id, toIndex)   (Hosts pin + clamp + no-op identity)
   │
   ├── UnifiedTabBar: DndContext + SortableContext + SortableTab   ── T1 (pointer path)
   │        │
   │        └── E2E 97-tab-reorder: pointer drag                    ── T3
   │
   └── AppShell shortcuts Cmd/Ctrl+Shift+[ / ]                      ── T2 (keyboard path)
            │
            └── E2E 97-tab-reorder: keyboard move                   ── T3
                     │
                     └── CHANGELOG + theme/overflow manual pass      ── T4
```

T1 and T2 both depend only on `moveTab`. T1 introduces it, so T2 comes after T1
(same file, `tab-store.ts`). Everything is sequential. The whole feature is
about 6 files, so parallel agents would add coordination cost without saving
time.

## Task List

### Phase 1: Reorder works end to end
- [x] T1: Drag a tab to a new position (store action + sortable tab strip)
- [x] T2: Move the active tab with Cmd/Ctrl+Shift+[ / ]

### Checkpoint 1
- [x] `pnpm test` and `pnpm build` clean
- [x] Manual in `pnpm tauri dev`: drag reorder, Hosts pin, click/middle-click/close still work, keyboard move
- [x] Human review before Phase 2 (user verified in the running app)

### Phase 2: Real-app proof and release notes
- [x] T3: E2E spec `97-tab-reorder.spec.ts`
- [ ] T4: CHANGELOG entry + both-themes / overflow manual pass

### Checkpoint 2: Complete
- [ ] Every acceptance criterion in `tasks/tab-reorder-todo.md` met
- [x] `97-tab-reorder` green, and existing tab specs (`13`, `14`, `15`, `61-exit-overlay…`, `72-keyboard-navigation`) still green
- [ ] Ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| dnd-kit `attributes` overwrite `role="tab"`, `tabIndex`, or `aria-selected`, which breaks tablist semantics and the `[role="tab"][aria-selected="true"]` scroll-into-view query (`UnifiedTabBar.tsx:112`) | High | Spread `attributes` before our props (GroupsSidebar pattern). A component test asserts `role="tab"` + `aria-selected` on the rendered tab |
| The drag gesture swallows click-to-activate or middle-click-to-close | High | 5 px activation distance (same as the dashboard). Existing middle-click tests in `UnifiedTabBar.test.tsx` must stay green unchanged |
| The trailing `click` after a drop activates the dragged tab | Low | Matches browser tab behaviour and is acceptable. Tests assert order, not activation, after a drag |
| `activateRecentTabOfType` walks `tabOrder` from the end as "most recent" (`tab-store.ts:138-149`). After a reorder, "most recent" becomes "rightmost" | Med | Accepted and documented. Changing to true MRU tracking is separate scope. Listed in Open Questions |
| Dragging in an overflowing strip doesn't auto-scroll to off-screen positions | Med | dnd-kit `autoScroll` is on by default and finds the scrollable `role="tablist"` ancestor. Checked manually in T1 and T4 with ~12 tabs |
| Shift+[ reports `{` on real keyboards and `[` from WebDriver | Med | AD-4 dual registration. E2E T3 exercises the real chord via `cmdShift("[")` |
| Tauri's `dragDropEnabled` suppresses HTML5 drag events in the webview | Low | dnd-kit uses mouse/pointer events, not HTML5 DnD. The dashboard reorder (specs 63/64) already proves this in the real app |

## Open Questions

- Should `activateRecentTabOfType` (used when jumping to "the last terminal /
  SFTP / S3 tab") keep meaning "rightmost tab of that type" after reordering,
  or should it become true most-recently-activated? The plan keeps the current
  behaviour.
