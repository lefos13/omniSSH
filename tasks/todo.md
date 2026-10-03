# Tasks: Subtle Support / Sponsor Section (desktop app)

Plan: `tasks/plan.md` (D1–D7). Commit prefix: `[v1.6.9]` (confirm tag state first).
Gates: `pnpm exec vitest run <file>`, `pnpm test`, `pnpm build`.

## Phase 1: Support card
- [x] Task 1: Add `SPONSOR_URL`/`COFFEE_URL` and a "Support" `SettingsGroup` with two buttons
      (`about-sponsor`, `about-coffee`) in `AboutSettings`, after the About card
  - [ ] Opens via dynamic `plugin-opener` `openUrl`, errors swallowed
  - [ ] Accessible, both themes OK, no new deps
  - [ ] Confirm `opener:default` covers https (no capability change unless needed)
- [x] Task 2: `SettingsPage.about.test.tsx` — render + `openUrl` called with each URL
- [x] Checkpoint: `pnpm test` and `pnpm build` pass; diff limited to SettingsPage.tsx + test

## Phase 2: Optional
- [ ] Task 3: README mention only if consistent with the web README
