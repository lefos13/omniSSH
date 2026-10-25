# OmniSSH launch and directory plan

Status: planning only. No account was created, no form was submitted, and no
listing was published while preparing this document.

Product: OmniSSH 1.7.0 — free, MIT-licensed desktop client for SSH terminals,
SFTP/SCP, and S3-compatible storage. Local-first, no account, no telemetry.
Primary links: <https://github.com/lefos13/omniSSH> and
<https://github.com/lefos13/omniSSH/releases>. Marketing site:
<https://omnissh-web.vercel.app>.

## 1. Readiness assessment

| # | Requirement | State | Evidence / gap |
| --- | --- | --- | --- |
| 1 | Public product, no password wall | Pass | GitHub repository and release binaries are public. |
| 2 | Pricing page | Partial | The landing page says "100% free, MIT open-source", but there is no `/pricing` page. Several Tier 1 directories ask for a pricing URL. |
| 3 | Privacy policy + terms | **Block** | The website has no `/privacy` or `/terms` route. This is a hard block for most directories and review sites. |
| 4 | Logo assets (PNG + SVG + 1024 square + favicon) | Partial | `logo-v2.png`, `app-icon.png`, `favicon.png`, and `apple-touch-icon.png` exist. No SVG wordmark/mark. |
| 5 | 5–8 real screenshots at 1920×1080 | Partial | Seven still captures exist, but most are 1304×962; one is 3840×2100. Recapture at 1920×1080 for directory galleries. |
| 6 | 60–90 second demo video | Partial | `public/screens/omnissh.mp4` is 32.8 seconds. A 60–90 second edit needs a scripted walkthrough (connect → terminal → linked explorer → transfer → S3). |
| 7 | GEO-ready landing page | Pass | One `<h1>`, sequential `<h2>` sections, canonical URL, Open Graph/Twitter images, `SoftwareApplication` + `Organization` + `WebSite` + `FAQPage` JSON-LD, `robots.ts`, `sitemap.ts`, and a web manifest. |
| 8 | Destination pages (alternatives, use cases) | **Block** | Only `/` exists. No `/alternatives/*`, `/use-cases/*`, `/vs/*`, or `/security` pages. Tier 1 links would land on the homepage. |
| 9 | 20 beta users who can review | Unknown | No review roster is recorded in the repository. Needed for the 10-in-30 review protocol. |

Hard blocks before any submission: privacy policy, terms, and at least three
alternative pages plus one use-case page. Soft blocks: dedicated pricing page,
1920×1080 screenshots, 60–90 second video, SVG logo.

The marketing canonical origin is `https://omnissh-web.vercel.app`, a
deployment hostname. Decide whether that is the permanent domain before
submitting: every canonical, Open Graph URL, sitemap entry, and directory
listing will otherwise need to change later.

## 2. Tier selection

| Tier | Use it? | Why |
| --- | --- | --- |
| 1 — Flagship launch (Product Hunt, Show HN, BetaList, Fazier, DevHunt, indie launch sites) | Yes, after hard blocks | The product is a developer desktop tool with a clear demo and a free/open-source story. |
| 2 — Startup/SaaS directories (AlternativeTo, SaaSHub, SourceForge, Slashdot, F6S) | Yes, after alternative pages | "[competitor] alternative" is the highest-intent query class for this product. |
| 3 — AI directories (TAAFT, Futurepedia, Toolify) | No | OmniSSH is not an AI product. A listing would be miscategorised and rejected or ignored. |
| 4 — Agent/MCP registries | No | No MCP server, plugin, or agent-facing API ships today. |
| 5 — No-code directories | No | Wrong audience. |
| 6 — "Best of" listicles | Yes, rolling | Target "best SSH client", "Termius alternative", "MobaXterm alternative on macOS", "open source SFTP client". |
| 7 — Integration marketplaces | No | No integrations with Zapier/HubSpot/Slack. |
| 8 — Profile/content platforms (GitHub, Dev.to, Hashnode) | Yes | Technical architecture posts (Tauri + Rust, host-key verification, OSC 7) earn developer links and AI citations. |
| 9 — Local business | No | Not a local product. |
| 10 — Forums/communities (Indie Hackers, r/SideProject, r/selfhosted, HN) | Yes, participation first | A privacy-first, self-hosted-sync tool fits r/selfhosted and r/commandline when shared as a build story, not an ad. |
| 11 — Press release sites | No | Low value for an open-source desktop tool. |
| 12 — Social bookmarking | Low priority | Only if part of an existing workflow. |
| 13 — Niche vertical directories (dev-tool lists, awesome-* repos) | Yes | Highest fit-to-effort ratio after Tier 1/2. |

## 3. Submission order

### Week 0 — unblock (before any directory)

1. Publish `/privacy` and `/terms` for the website and link both in the footer.
2. Publish `/pricing` stating the free MIT terms, no account, no telemetry.
3. Publish `/security` describing the credential model (OS keychain / encrypted
   app vault), host-key verification, and the self-hosted sync threat model.
4. Build three alternative pages: Termius, MobaXterm, WinSCP.
5. Build one use-case page: "SSH + SFTP + S3 in one desktop window for DevOps".
6. Recapture screenshots at 1920×1080 and edit a 60–90 second demo video.
7. Add `/llms.txt` and `/pricing.md` with the same facts as the visible pages.
8. Decide the permanent domain and update `SITE_URL` once.

### Week 1 — flagship

- Product Hunt (anchor; full 3-week prep in section 6)
- BetaList, Fazier, DevHunt, Twelve Tools, Turbo0, Tinyshelf
- Hacker News Show HN only with a technical angle: "Show HN: A Tauri/Rust SSH
  client that verifies host keys and keeps credentials in the OS keychain"
- Dev.to/Hashnode architecture post with a canonical link back to `/`

### Week 2 — high-intent directories

- AlternativeTo (three competitor pages as the destination)
- SaaSHub, SourceForge, Slashdot, F6S
- Awesome lists: SSH, Tauri, self-hosted, terminal tooling (follow each list's
  contribution rules; open a PR, do not paste a listing into an issue)

### Week 3 — reviews and long tail

- G2 and Capterra only if 10 reviews are realistically reachable; a zero-review
  listing is dead weight.
- "Best of" outreach to DR 40+ posts that already rank for SSH/SFTP client
  queries.
- Continue community participation; no repeat submissions to the same directory.

## 4. Destination pages to build first

| Path | Target intent | Required content |
| --- | --- | --- |
| `/alternatives/termius` | "Termius alternative" | Honest comparison table (price, offline, self-hosted sync, S3, platform), "choose OmniSSH when", "choose Termius when", FAQ, screenshot. |
| `/alternatives/mobaxterm` | "MobaXterm alternative for macOS/Linux" | Platform availability, X11 caveat, SSH/SFTP/S3 comparison, migration importer. |
| `/alternatives/winscp` | "WinSCP alternative for macOS" | Dual-pane SFTP/SCP, S3, terminal integration, scriptability differences. |
| `/use-cases/devops` | "SSH SFTP S3 desktop client" | One workflow narrative with screenshots: connect, tail logs, edit remote file, move objects. |
| `/security` | "is OmniSSH safe / where are credentials stored" | Keychain/vault model, host-key verification, no telemetry, sync encryption and signatures. |
| `/pricing` | "OmniSSH pricing" | Free, MIT, no account, no paid tier. |
| `/privacy`, `/terms` | Trust and directory eligibility | Plain-language data handling and license terms. |
| `/llms.txt`, `/pricing.md` | AI/agent retrieval | Same facts as the visible pages; do not create a second positioning. |

Keep one `<h1>` per page, a self-referencing canonical, and the same
`SoftwareApplication` entity `@id` as the homepage. Do not add `FAQPage` markup
expecting Google FAQ rich results: Google retired that appearance in May 2026.
The markup still helps AI systems parse visible Q&A, so keep it only where the
questions are actually on the page.

## 5. Positioning variants

Do not paste one description everywhere. Vary the opening sentence and the
audience framing per tier.

### Startup/indie directories (outcome)

- Tagline: `SSH, SFTP, and S3 in one offline desktop window`
- 60 chars: `Free, offline SSH + SFTP + S3 desktop client for macOS, Windows, Linux.`
- 150 words: Open with the workflow outcome — one window for terminals, files,
  and buckets; no account, no telemetry. Mention the OS keychain and the
  self-hosted encrypted sync as the trust differentiators. Close with the MIT
  license and the GitHub release link. Avoid a feature list longer than five
  items; link to `/` for the rest.

### SaaS/directory alternative framing

- Tagline: `The open-source Termius and MobaXterm alternative`
- Lead with the migration path: import OpenSSH config, MobaXterm sessions, or
  Termius data locally. Then the capabilities that survive comparison: split
  panes, OSC 7 linked explorer, dual-pane SFTP/SCP, S3 browser, port forwarding.
- Link to the specific alternative page, not the homepage.

### Developer directories and HN

- Tagline: `Tauri v2 + Rust SSH workspace with host-key verification`
- Lead with architecture: Rust owns SSH/SFTP/SCP/S3 and SQLite; React owns the
  view; xterm.js renders terminals. Name one non-obvious decision — host keys are
  checked against `~/.ssh/known_hosts`, health probes never write to it, and the
  webview runs under a strict CSP. Link the source file, not a marketing claim.

### Review sites (ROI and use case)

- Lead with the job: replacing three desktop apps for a small ops team while
  keeping credentials local.
- Ask reviewers to describe their previous tool, the migration, and one concrete
  time saver. Do not script the rating.

## 6. Product Hunt three-week prep

Launch day is not set; map these offsets to the chosen Tuesday, Wednesday, or
Thursday. Launch at 12:01 AM Pacific.

| Offset | Action |
| --- | --- |
| Day −21 to −14 | Warm the maker account: follow 100+ active makers, leave three thoughtful comments per day. |
| Day −14 | Publish the "Upcoming" page; drive existing users to the notify list. |
| Day −10 | Optional hunter outreach; trade a feature or intro, never cash. |
| Day −7 | Final gallery assets: 1270×760 images, tagline under 10 words, 260-character description, first maker comment, one customer comment. |
| Day −3 | Email the list with what to expect; ask for feedback, not upvotes. |
| Day −1 | Incognito test: product downloads, video autoplays, CTA reaches the release page. |
| Day 0 | Post the first comment (why built, what is different, what to try first). Reply to every comment within 30 minutes. |
| Day +1 | Publish an honest launch recap with numbers and lessons; cross-post to Indie Hackers and r/SideProject. |

Never ask for upvotes. Ask for feedback. A post with 50 upvotes and 30 real
comments outranks one with 200 upvotes and five comments.

## 7. Reviews: 10-in-30

1. On launch day, identify 20 users who completed a meaningful action (connected
   a host, transferred a file, imported a config).
2. Send each a direct review URL in a personal message; no form in between.
3. Offer a small permitted thank-you (for example a $25 gift card where the
   platform allows it).
4. Follow up once after five days, never twice.
5. Target 50% conversion: 10 reviews from 20 asks. If fewer than 10 are
   reachable, defer G2/Capterra rather than publishing a dead listing.

## 8. Weekly targets

| Metric | Day 0 | Day 30 | Day 90 |
| --- | --- | --- | --- |
| Referencing domains | 0 | 30 | 80 |
| Directory listings live | 0 | 50 | 70 |
| Indexed marketing pages | 1 | 10 | 30 |
| G2/Capterra reviews | 0 | 10 | 25 |
| Signups from directory referrals | 0 | 50 | 300 |

Track AI citations separately with five runs per prompt and report a rate with
its sample size (`cited 3/5, n=5`); a single answer is an anecdote.

## 9. Tracker columns

Use one row per submission: `date`, `directory`, `tier`, `listing_url`,
`status`, `moderator_notes`, `destination_url`, `link_rel` (observed `nofollow`
/ `sponsored` / `ugc` / unqualified), `checked_at`, `recheck_due` (quarterly).
Verify the live anchor in the rendered page or fetched HTML; a header-only
`curl -I` cannot confirm a backlink. Record `unverified` when the listing is
behind a login or blocked, and `missing` when no destination anchor exists.

## 10. What not to do

- Do not submit before `/privacy`, `/terms`, and the destination pages exist.
- Do not copy the same 150-word description into every directory.
- Do not list in AI, no-code, or MCP directories where the product does not fit.
- Do not buy directory submission packages or paid G2 placement in year one.
- Do not ask for upvotes on Product Hunt or post the same link to every
  subreddit; both are filtered quickly.
- Do not claim a comparison feature you cannot demonstrate on the competitor's
  current version.
