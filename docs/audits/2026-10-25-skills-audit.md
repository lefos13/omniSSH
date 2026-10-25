# OmniSSH skills audit — 2026-10-25

## Scope and baseline

- Repository: OmniSSH desktop app, branch `skills-audit/2026-10-25`.
- Branch base: local `main` at `868cde0`, which is two local commits ahead of
  `origin/main` at `fdbc27b` (`v1.7.0`). `git fetch origin` on 2026-10-25 found
  no new `origin/main` commits, so no rebase was required.
- Primary scope: `src/` frontend. In `src-tauri/`, only clear security issues
  were changed. The `omnissh-web` site was inspected for SEO but not modified.
- Skills read: `create-design-md`, `make-interfaces-feel-better`, `break-ui`,
  `animation-performance`, `security-and-hardening`, `directory-submissions`,
  `seo-audit`, `schema`, `ai-seo`, `claude-md-improver`.

Baseline before edits: `pnpm test` 103 files / 765 tests passing; `pnpm build`
passing with a pre-existing 1.4 MB chunk warning.

## Findings ranked by impact

| # | Severity | Area | Finding | Action |
| --- | --- | --- | --- | --- |
| 1 | Critical | SSH security | `check_server_key` returned `Ok(true)` for every key, so every SSH transport (terminal, SFTP/SCP, port forward, sync) could be intercepted by any network attacker. | Fixed in `cbd3fd8`: verify against `~/.ssh/known_hosts`, learn unknown hosts, reject changes, keep health probes read-only. |
| 2 | High | Webview security | `tauri.conf.json` had `"csp": null`; injected markup had unrestricted access to the IPC bridge. | Fixed in `1b78d05`: production and dev CSP with only app origin, Tauri IPC, and Vite HMR. Follow-up `ee93e6b` allows the default 1420 HMR socket. |
| 3 | High | Explorer performance | The file table renders every entry; a directory with thousands of files creates thousands of rows and pays layout/paint for all of them. | Mitigated in `c11a00d` with `content-visibility: auto` + intrinsic row height. Full virtualization is deferred. |
| 4 | Medium | Explorer usability | A deep path's breadcrumb is clipped from the left, so the current folder (the last segment) is off-screen. | Fixed in `0c4a65d`, covered by `4b0ce1e`. |
| 5 | Medium | Explorer readability | A truncated filename had no `title`; long names were unreadable with no fallback. Non-Latin names also lacked bidi direction. | Fixed in `c11a00d`. |
| 6 | Medium | Host list | `charAt(0).toUpperCase()` split emoji labels into a replacement character; long subtitles could push the environment badge out of the row. | Fixed in `a0a6fa7`. |
| 7 | Medium | S3 | Long bucket names had no `min-w-0`/truncate and could overflow the list. | Fixed in `c11a00d`. |
| 8 | Medium | Errors | Explorer/S3 error banners used a single non-wrapping line; long recovery messages were clipped. | Fixed in `c11a00d`. |
| 9 | Medium | Motion | 24 files used `transition-all` on controls and cards, animating layout/paint properties that no state change needed. | Fixed in `a562640` with explicit properties. |
| 10 | High | Website SEO | No `/privacy` or `/terms`; no `/pricing`, `/alternatives/*`, or `/use-cases/*` page. This blocks directory submissions and leaves Tier 1 links with no destination. | Deferred (site not modified). |
| 11 | High | Website SEO | Canonical, Open Graph, sitemap, and JSON-LD all use `https://omnissh-web.vercel.app`, a deployment hostname. Moving later changes every emitted URL. | Deferred: choose the permanent domain first. |
| 12 | Medium | Website schema | `SoftwareApplication` has no `screenshot`, `license`, `sameAs`, `softwareHelp`, or `releaseNotes`; `softwareVersion` is hardcoded to `1.7.0`. | Deferred. |
| 13 | Medium | Launch assets | Screenshots are mostly 1304×962 (target 1920×1080); the demo video is 32.8 s (target 60–90 s); there is no SVG logo. | Deferred to the launch plan. |
| 14 | Low | Website SEO | Title is 74 characters and will truncate in SERPs; `sitemap.ts` uses build time as `lastModified`. | Deferred. |
| 15 | Low | Motion/accessibility | Some `animate-spin`/`animate-pulse` loaders and skeletons are not `motion-safe:`; only the connecting status and several spinners are gated. | Deferred. |
| 16 | Low | Build health | Vite emits a >500 kB chunk warning (1.4 MB main bundle); no ESLint/Prettier command is configured. | Pre-existing; not changed. |

## Fixes with commits

| Commit | Change |
| --- | --- |
| `cbd3fd8` | SSH host-key verification in `src-tauri/src/ssh/handler.rs`, handler wiring in `manager.rs` and `commands.rs`, actionable `ssh-keygen -R` error text. |
| `1b78d05` | CSP + dev CSP in `src-tauri/tauri.conf.json`. |
| `ee93e6b` | Allow the default Vite HMR socket (`ws://localhost:1420`) in the dev CSP. |
| `c11a00d` | Explorer row containment, filename tooltip + `dir="auto"`, S3 bucket truncation, wrapping error banners. |
| `0c4a65d` | Breadcrumb auto-scroll to the current folder. |
| `4b0ce1e` | Regression test for breadcrumb reveal. |
| `a0a6fa7` | Grapheme-aware host initials (helper moved to `src/utils/format.ts` with tests), bidi host text, subtitle shrink fix. |
| `a562640` | Explicit `transition-[…]` properties in place of `transition-all`. |
| `4115afb` | `DESIGN.md`. |
| `593a155` | `docs/launch/directory-plan.md`. |
| `62d6f07` | `AGENTS.md` security/submodule invariants. |

The report commit is the commit that adds this file. No frontend or Rust
behavior is changed by the report.

## Break-ui results

Worst realistic data was checked against the terminal tabs, host list, and the
shared SFTP/S3 explorer table.

| Field | Worst case | What happened | Resolution |
| --- | --- | --- | --- |
| File name | 255-character name with the version at the end | End-truncated; no way to read the full value | Added `title` and bidi direction (`c11a00d`). Middle truncation remains a design decision. |
| Breadcrumb | 5+ deep path in a narrow toolbar | Current segment off-screen to the right | Auto-scroll to the end (`0c4a65d`). |
| S3 bucket | 63-character bucket name | Pushed out of the row | `min-w-0 flex-1 truncate` + title (`c11a00d`). |
| Host label | Emoji or CJK label | Wrong/replacement avatar initial | First grapheme (`a0a6fa7`). |
| Host subtitle | Long `SSH, username · OS · last seen` | Badge could wrap or overflow | `min-w-0` on the text (`a0a6fa7`). |
| Directory size | 10,000 entries | Every row mounted and painted | Offscreen rows now skip layout/paint; virtualization still deferred. |
| Error text | 400-character connection/list error | Banner clipped or overflowed | Wrapping banners (`c11a00d`); the terminal pill still clamps and exposes `title`. |
| Empty folder / no search results | 0 entries | Dedicated empty state, create actions, clear-filter action | Held up. |
| Single item | 1 selected entry | Delete dialog says "File"/"Directory"; multi-select copy labels only appear for >1 | Held up. |
| Reduced motion | `prefers-reduced-motion` | Effect canvases pause; connecting pulse is gated | Held up for effect themes; some loaders remain ungated. |

Not verified visually: 320 px viewport, 200% zoom, and a full RTL locale. Those
need a running webview and are listed as deferred QA.

## Design system

`DESIGN.md` was created from `src/theme.css`, the shared components, and the
default settings. It records the dark default tokens, the light theme and each
effect theme's base/surface/accent, the type scale, layout constants, elevation,
and component rules.

Validation:

- `npx @google/design.md lint DESIGN.md`: 0 errors, 1 warning (`missing-primary`).
  The source token is `--color-accent`; adding a duplicate `primary` alias was
  rejected to keep one source name.
- `npx @google/design.md export --format css-tailwind DESIGN.md`: emitted
  `--color-*`, `--font-*`, `--text-*`, and spacing tokens. `rounded` and
  `components` are declared omitted because `theme.css` has no product token
  contract for them.

## Launch and directory plan

`docs/launch/directory-plan.md` is planning only. It records the hard blocks
(privacy/terms, destination pages), the applicable tiers, the week-by-week
submission order, per-tier positioning copy, the Product Hunt timeline, the
10-in-30 review protocol, weekly targets, and tracker columns. Nothing was
submitted and no account was created.

## Website SEO audit (`omnissh-web`)

The submodule was initialized at its pinned commit `49c59a9` only to inspect the
site. It was not modified, so the superproject gitlink is unchanged.

Strengths: one `<h1>`, sequential section headings, canonical + OG/Twitter
metadata, `SoftwareApplication`/`Organization`/`WebSite`/`FAQPage` JSON-LD,
`robots.ts`, `sitemap.ts`, and a manifest. The FAQ content is visible on the
page, so the FAQ markup matches content.

Issues, in order:

1. **No privacy policy or terms page.** Hard block for directories and many
   review sites.
2. **Canonical origin is a Vercel deployment hostname.** Choose the permanent
   domain before submitting; otherwise every canonical, OG URL, sitemap entry,
   and listing needs a second migration.
3. **No alternative/use-case pages.** Tier 1 links land on a single homepage;
   there is no page to rank for "Termius alternative", "MobaXterm alternative
   for macOS", or "SSH SFTP S3 desktop client".
4. **No `/pricing` page.** The free/MIT claim is only a section on the homepage.
5. **Schema gaps.** Add `screenshot`, `license`, `sameAs`, `softwareHelp`, and
   `releaseNotes`; source `softwareVersion` from `package.json` instead of
   hardcoding `1.7.0`. Do not add `aggregateRating` without real reviews.
6. **Title length.** 74 characters; aim for 50–60 while keeping "OmniSSH" and
   the category near the front.
7. **FAQ rich results are retired.** Google removed FAQ rich results in May 2026.
   Keep the markup only as machine-readable context for AI systems; do not
   promise a Google FAQ appearance.
8. **AI/agent discovery.** No `/llms.txt` and no `/pricing.md`; add both with the
   same facts as the visible pages. Keep AI search crawlers allowed unless there
   is a deliberate training policy.
9. **Launch assets.** Recapture screenshots at 1920×1080, edit the 32.8 s demo to
   60–90 s, and produce an SVG logo before flagship submissions.

## Security review notes

- **Credential storage:** reviewed `vault/`, `db/mod.rs`, `ssh/commands.rs`.
  Secrets are not stored in SQLite; the database comments and tests enforce this,
  and sync tables are checked for secret-shaped columns. `AuthMethod::Password`
  zeroizes its buffer on drop. No real secrets or `.env` files were found in
  tracked source (test fixtures contain placeholder key headers only).
- **Host keys:** fixed as above. Residual: first contact is trust-on-first-use,
  so a first-connection MITM is still possible without comparing fingerprints
  out of band. An unreadable/unparseable `known_hosts` is treated as
  unverifiable (connection proceeds with a warning) to avoid bricking users;
  a strict fail-closed mode is a follow-up.
- **Command injection:** SCP builders consistently use `shell_quote`; tests cover
  spaces, single quotes, and metacharacters. `ssh_exec_command` is an intentional
  feature, bounded to 64 KiB input and 1 MiB output; tracker commands come from
  an allowlist.
- **Path traversal:** SFTP validates every server-supplied entry name with
  `validate_remote_name` before joining it to a local path, including recursive
  downloads and relay staging. S3 download uses `file_name()` (basename). SCP
  downloads write to an explicit local path. No change needed.
- **Tauri capabilities:** `core:default` plus opener/dialog/updater/process and
  clipboard read/write. No broad filesystem or shell capability is exposed to
  the webview.
- **CSP:** `style-src 'unsafe-inline'` is required by React style props and
  xterm; `script-src` remains `'self'`. `connect-src` is limited to the app
  origin and Tauri IPC.
- **Dependencies:** `pnpm audit --prod` reported no known vulnerabilities.

## Verification

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Pass |
| `pnpm test` | Pass: 104 files, 768 tests |
| `pnpm exec tsc --noEmit` | Pass |
| `pnpm build` | Pass; only the pre-existing >500 kB chunk warning |
| `cargo fmt --all -- --check` | Pass |
| `cargo clippy --all-targets -- -D warnings` | Pass |
| `cargo test` | Pass: 558 tests |
| `cargo check --all-targets` | Pass with the SDK workaround below |
| `pnpm tauri dev` smoke | App launched, initialized the dev database, and stayed alive for 25 s; stopped afterward. Port 1420 and all dev processes were confirmed closed. |
| `pnpm audit --prod` | No known vulnerabilities |
| `npx @google/design.md lint` | 0 errors, 1 warning |
| `npx @google/design.md export --format css-tailwind` | Pass; all populated token categories emitted |

Pre-existing environment note: `cargo check` without `SDKROOT` fails inside
`aws-lc-sys` because CommandLineTools 27's `libSystem.tbd` contains an
architecture token the active linker does not understand. Setting
`SDKROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`
makes all Rust checks pass. This is not caused by the audit changes.

The Tauri smoke test proves startup and database initialization, not the visual
webview or its console. CSP correctness was checked structurally (production
HTML has one external module script, one stylesheet, and self-hosted fonts) and
by compiling the app with the config; a manual window inspection is still
recommended before release.

## Deferred recommendations

1. **Virtualize the explorer list** (and consider the host grid). Row containment
   reduces paint cost but does not stop 10,000 React elements or a 10,000-entry
   sort/filter from being created. Use a maintained virtualizer or a windowed
   slice, and keep keyboard selection, drag targets, and find-in-page working.
2. **Add host-key fingerprint confirmation.** Show the SHA-256 fingerprint on
   first contact and on mismatch, with explicit trust/abort choices. Add a
   strict mode that fails closed when `known_hosts` cannot be read or parsed.
3. **Unblock the website before launch.** Publish `/privacy`, `/terms`, and
   `/pricing`; build three alternative pages and one use-case page; choose the
   permanent domain and update `SITE_URL` once.
4. **Enrich website structured data and AI discovery.** Add the missing
   `SoftwareApplication` fields, source the version from `package.json`, shorten
   the title, add `/llms.txt` and `/pricing.md`, and recapture the launch assets.
5. **Audit remaining motion under terminal load.** Consider pausing or throttling
   effect canvases while a terminal tab is active, and gate the remaining
   `animate-spin`/`animate-pulse` loaders behind `motion-safe:`. Measure with the
   Performance panel; do not add `will-change` speculatively.
6. **Reduce the main bundle** or split the largest route chunk; 1.4 MB is a
   pre-existing warning, not a regression from this audit.
7. **Verify at 320 px, 200% zoom, and RTL.** The bidi direction fix is in place,
   but a full visual pass needs a running webview.

## Process hygiene

- No subagents were spawned; no sub-worktrees or temporary branches were created.
- The `omnissh-web` submodule was initialized at its pinned commit for
  inspection and left unchanged; `git submodule status` is clean.
- No directory, review site, Product Hunt page, or external service was
  submitted to or contacted.
- No push, release, PR, or signed bundle.
- The Tauri dev server started for the smoke test was stopped; no `anyscp`,
  `vite`, or `tauri dev` process and no listener on port 1420 remain.
- `CLAUDE.md` is gitignored in this repository, so no tracked CLAUDE.md exists to
  improve without changing the ignore policy. `AGENTS.md` was improved instead;
  a local pointer file was removed to avoid leaving personal scaffolding.
