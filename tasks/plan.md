# Implementation Plan: Subtle Support / Sponsor Section in the Desktop App

Status: **awaiting human review** — no code has been written.
Task list: `tasks/todo.md`.
Commit prefix: `[v1.6.9]` (`v1.6.8` is already released; confirm tag with `git tag -l v1.6.8` before committing).

## Overview

`omnissh-web` already promotes support: `SponsorSection.tsx` (GitHub Sponsors) and
`Footer.tsx` (Buy me a coffee `https://buymeacoffee.com/lefterisev2`, GitHub Sponsors
`https://github.com/sponsors/lefos13`). The desktop app has no equivalent. Add a quiet
"Support OmniSSH" card to **Settings → About & Updates** with two link buttons.

## Decisions

- **D1 Placement:** a new `SettingsGroup label="Support"` inside `AboutSettings`, directly
  after the About card and before Updates. No popups, banners, badges, nag toasts or
  sidebar items — "subtle" means the user finds it only by visiting About.
- **D2 Reuse:** mirror the existing `AboutCard` row pattern (label + `DESC_CLASS` text +
  secondary button with `ExternalLink`/lucide icon) and open links with the existing
  dynamic `import("@tauri-apps/plugin-opener")` `openUrl` pattern. No new dependency.
  `opener:default` already permits https URLs, so no capability change is expected
  (verify in Task 1).
- **D3 URLs:** module-level constants beside `REPO_URL` in `SettingsPage.tsx`
  (`SPONSOR_URL`, `COFFEE_URL`), copied from the web footer.
- **D4 Copy:** one line, e.g. "OmniSSH is free and open source. If it saves you time,
  you can support its development." Tone matches the web ("zero telemetry" stays true:
  links only open the system browser, nothing is sent).
- **D5 Icons:** lucide `Heart` and `Coffee` (both already used on the web, lucide is
  already a desktop dependency). Muted styling; no pink/amber accent so runtime accent
  overrides and both themes are respected via tokens in `src/theme.css`.
- **D6 Scope:** frontend only. No Rust, store, or IPC changes.
- **D7 Testids:** `about-sponsor`, `about-coffee`.

## Dependency graph

```
SettingsPage.tsx constants + SupportCard  ──► unit test ──► E2E smoke (optional)
```
Single component, single file; no cross-layer dependencies.

## Phase 1: Support card (one vertical slice)

### Task 1: Support group with both links
Add constants, a `SupportCard` (or inline rows in `AboutSettings`), and the two buttons.
Acceptance:
- About & Updates shows a "Support" group between About and Updates.
- Each button calls `openUrl` with the exact URL; failures are swallowed like `openRepo`.
- Keyboard focusable, visible focus ring, labelled buttons; legible in dark and light.
Verify: manual `pnpm tauri dev`, both themes, Tab navigation; confirm links open the browser.

### Task 2: Unit test
Add `SettingsPage.about.test.tsx` beside other SettingsPage tests, mocking
`@tauri-apps/plugin-opener`; assert both buttons render and call `openUrl` with the right URLs.
Verify: `pnpm exec vitest run src/components/settings/SettingsPage.about.test.tsx`.

### Checkpoint
`pnpm test` and `pnpm build` green; review diff touches only `SettingsPage.tsx` + the test.

## Phase 2: Wrap-up (optional)
- Task 3: add a short mention in README/docs only if the web README already lists it.
  Skip `make screenshots` (marketing captures unchanged) and E2E (no workflow change)
  unless the user requests it.

## Risks
- `opener:default` scope might not cover the https hosts → check at Task 1 and, only if
  needed, add an explicit `opener:allow-open-url` scope entry.
- `SettingsPage.tsx` is ~3,300 lines; keep the change a small contiguous block to avoid
  merge noise.

## Open questions
- Confirm the target version (patch `v1.6.9` assumed).
- Any wish for a one-time dismissible hint elsewhere? Default: no (stay subtle).
