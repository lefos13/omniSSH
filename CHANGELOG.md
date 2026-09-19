# Changelog

All notable changes to the OmniSSH (formerly anySCP) project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [1.6.0] - 2026-09-19

### 🚀 Highlights & New Features

#### 1. Self-Hosted Encrypted Dataset Sync
* **Your Own Server, Zero Cloud**: Settings ▸ Dataset Sync publishes a named dataset to a directory on any SSH server you own. No OmniSSH-hosted service, no account system, no telemetry — a new machine joins with the endpoint and the dataset passphrase and pulls the identical host set.
* **End-to-End Encrypted Bundle**: A random 32-byte dataset key seals a gzipped record document with AES-256-GCM; that key is wrapped by an Argon2id key derived from a per-dataset passphrase, so the remote holds ciphertext plus a key wrap that is useless without the passphrase. Rotating the passphrase rewraps 32 bytes instead of re-publishing the dataset.
* **Scoped Content Kinds**: Per-dataset toggles for hosts (with an optional credentials sub-toggle), groups, snippets and folders, port-forward rules, S3 connections (with credentials), per-host plugin config, and app settings. Scope a dataset to all hosts, to selected groups, or to explicit hosts; machine-local tables (connection history, recent paths, the App Vault) are never synced.
* **Owner / Member Roles**: The owner signs each published generation with an ed25519 key; members pin the fingerprint on join and reject unsigned or foreign-signed metadata. Members are pull-only, and Settings warns when the server still lets a member account write to the dataset path.
* **Record-Level Merge With a Conflict Log**: Pulls classify every record against the last agreed state, apply remote-only changes, keep local-only edits, and resolve both-changed records by newest `updatedAt` — logging the losing copy instead of merging silently. Two machines editing different records both keep their work.
* **Generation History and Rollback**: Every publish archives the generation it replaces (the last 10 are kept). Settings lists them and can roll back to one, applying it as a merge and publishing the result as a new generation rather than rewriting history.
* **Opt-In Automatic Sync**: Per-dataset pull interval and push debounce, both off by default, plus a live status line for in-flight work.

### 🚀 Improvements

#### 1. Dataset Sync Meets Backup, Restore, and Factory Reset
* **Backups Include Datasets, Secrets Never Do**: A backup restores dataset rows with their scope, merge base, conflict log, pending deletes, and detach opt-outs, but never a dataset's server credential, passphrase, or signing key — those live in the OS keychain. A dataset restored on another machine now says exactly which secret it is missing and prompts for it instead of failing on the next push.
* **Factory Reset Purges Every Dataset Secret**: A reset removes the dataset's keychain entries by enumerating the keys the sync layer owns, so a future per-dataset secret is covered without touching the reset code. A reset records no tombstones, so it can never publish a wipe to a shared dataset.

### 📚 Documentation
* **`docs/sync-datasets.md`**: The remote layout, the passphrase → wrapped dataset key → payload key hierarchy, the owner/member model including signing and fingerprint pinning, the server-side read-only requirement for members, and recovery steps for a lost passphrase, a lost owner signing key, a bad push, a retired machine, a restored backup, and a factory reset.

### 🐛 Fixes

#### 1. SSH Connections on IPv6-Only / NAT64 Networks
* **Literal IPv4 Hosts Connect Through NAT64**: Hosts stored as raw IPv4 addresses failed outright behind phone tethering and carrier NAT64, while hostnames worked — a confusing split. The direct connection now falls back to an RFC 7050-discovered NAT64 prefix only when the failure is an address-family error, so dual-stack machines take exactly the path they always did.
* **Health Check Follows the Same Fallback**: The dashboard health probe reports what a terminal connection would do instead of contradicting a working session.

#### 2. Managed Hosts Stay Editable Where It Matters
* **Dataset-Managed Badge and Editor Lock**: Hosts claimed read-only by a member dataset show who manages them; the editor locks synced fields while keeping the local credential editable, and detaching drops one dataset's claim without deleting the host.

---

## [1.5.0] - 2026-09-18

### 🚀 Improvements

#### 1. Refreshed Application Branding
* **Consistent Icons Everywhere**: Updated the app icon, favicon, and all Tauri, Android, and iOS icon sizes to the current OmniSSH branding.
* **Live Session Walkthrough**: The README gains a live demo (`screens/omnissh.gif` / `screens/omnissh.mp4`) showing split terminals, real-time OSC 7 directory sync, and docked host plugins. The screenshot pipeline now emits `omnissh.gif` (keeping `anyscp.gif` as a legacy copy).

### 🐛 Fixes

#### 1. Imported Groups Now Appear Immediately
* **Concurrent Reload After Import**: The hosts dashboard reloads hosts and groups together once an SSH config import commits, so newly imported groups show up without a manual refresh.

---

## [1.4.0] - 2026-09-17

### 🚀 Highlights & New Features

#### 1. Host Plugins & Trackers Dock
* **Live Monitoring Beside The Terminal**: A new plugins side panel docks next to the active terminal (alongside the linked explorer) and renders one collapsible card per enabled tracker for that host: Server Health (CPU/memory/disk/uptime), Docker, PM2, systemd services, Log Viewer, HTTP health probe, Kubernetes, SSL & Ports, Database Ping, and Cron & Timers.
* **Per-Host Assignment**: Trackers are enabled per host in a new tab of the host editor, each with its own small config form (ports, paths, contexts). Config values are opaque JSON and never carry secrets.
* **Polling Over The Existing Session**: Cards poll read-only commands on their own interval through hidden execs on the already-open SSH session — no extra connection, with an in-flight guard and cleanup on disconnect or unmount. The panel follows pane focus in split tabs.
* **Every Action Is Verified First**: State-changing actions (restart/stop/start, kill, rollout restart, delete pod) open a verification modal showing the exact fully-interpolated command. Confirm runs precisely that string; Cancel invokes nothing.
* **Tail A Log From The Explorer**: The explorer's file context menu gained "Tail log in Plugins", which opens the panel on the owning tab with the log viewer primed for that path.
* **Global Switch**: Plugins have their own Settings section and can be turned off entirely.

#### 2. Terminal Keyword Highlighting
* **Rules For Words Or Regex**: Define highlight rules in Settings — plain keyword or regular expression, case-sensitivity, whole-word matching, and either colored text or a background fill.
* **Global Or Per-Host Scope**: A rule applies everywhere or only to selected saved hosts.
* **Live On Output And Scroll**: Matches are decorated in the visible viewport as output arrives and while scrolling, with correct Unicode and wide-character cell offsets and per-line deduplication so decorations are not registered twice.

#### 3. Grouped Hosts View
* **Collapsible Group Sections**: The Hosts dashboard gained a third view mode that renders one collapsible section per group — hosts and S3 connections together — plus a trailing Ungrouped section. Host rows keep full action parity with the list view.
* **Sidebar Navigates Instead Of Filtering**: In grouped mode the groups sidebar scroll-navigates to a section rather than filtering the page.
* **Resizable Groups Sidebar**: The sidebar is drag-resizable with its width persisted locally, matching the linked-panel handles.

### 🐛 Fixes

#### 1. Updated Vault Passwords Were Not Re-Encrypted
* **New Password Now Overwrites The Ciphertext**: Typing a new password for a host already migrated to the App Vault staged it to the keychain, but migration skipped hosts that already had vault ciphertext — so the old encrypted password kept being used. Migration no longer short-circuits on an existing blob, so the updated password replaces it and the keychain copy is cleared.

---

## [1.3.0] - 2026-09-17

### 🚀 Highlights & New Features

#### 1. Split Terminals Across Different Hosts
* **Split With Any Saved Host**: A terminal pane can now be split horizontally or vertically against a *different* saved host. The new split picker offers instant search, recent-host ordering, direction toggling, and full keyboard navigation, and is reachable from the pane header, the host card/list context menus, and `⌘⌥D`.
* **Parallel Input Synchronization**: Split panes can be linked so typed input is broadcast to every pane in the tab — one command, many servers. The link state is per tab and survives pane focus changes.
* **Split Global Header**: Tab-level actions (linked explorer, pane sync) moved into a single header for split sessions instead of being repeated on every pane, and `⌘⌥[` / `⌘⌥]` cycle pane focus.

#### 2. Server-to-Server Transfers
* **Direct Remote → Remote Copies**: The explorer can copy files and directories straight from one server to another, streaming bytes between the two SFTP sessions without staging anything on the local disk.
* **Same Queue, Same Progress**: Relay copies reuse the existing transfer queue, concurrency limits, cancellation, retry, and bounded history, and report progress on the shared transfers popover alongside SFTP/SCP/S3 transfers.
* **Honest Transport Limits**: A relay is rejected with an actionable error when either side fell back to SCP, which has no random-access file stream, rather than half-working.

#### 3. Dual-Host Explorer Panes
* **Pick The Left Pane Source**: The host explorer's left pane can show the local machine (default) or another saved server, so two remote hosts can be browsed and copied between side by side.
* **Automatic Transport Selection**: Opening a host for the explorer connects a no-PTY session and prefers SFTP, transparently falling back to SCP when the subsystem is disabled. Rust owns that connection's lifetime and releases it with the final channel.

#### 4. Per-Host Recent Paths
* **Shared MRU History**: The five most-recently-visited directories are remembered per host and shared by the explorer toolbar (navigate the pane) and the terminal pane header (`cd` in the shell).
* **Fills In By Itself**: The OSC 7 working-directory hook is now installed automatically once per session, so plain terminal sessions populate the history without discovering the manual "Sync CWD" control. Paths are persisted in SQLite and deliberately excluded from all logs and telemetry.

#### 5. Per-Host Terminal Color Schemes
* **Bundled Palettes**: A saved host can pin a terminal color scheme in the host editor. Only the scheme id is persisted, so the database and Rust layer stay theme-agnostic, and a pinned palette stays fixed in both app themes. Hosts without a scheme keep the app-derived look.

### 🚀 Improvements

#### 1. Hosts Dashboard Group Sidebar
* **Persistent Group Rail**: The group cards grid was replaced by a persistent sidebar listing every group, so switching groups no longer requires scrolling the host grid back to the top. Drag-to-reorder and right-click group actions are preserved.

#### 2. Explorer & Terminal Polish
* **Reworked Select Control**: The shared select control was rebuilt for keyboard and screen-reader use and is now portal-rendered so menus are never clipped by their container.
* **Linked Explorer Cleanup**: The linked explorer panel follows the focused pane correctly in split sessions and prunes its state when tabs or panes go away.

---

## [1.2.1] - 2026-09-11

### 🐛 Fixes

#### 1. Imported Hosts Could Never Authenticate via the App Vault
* **Password Stranded in the Keychain**: Importing with "Encrypted App Vault" selected stores the storage marker before any password exists. A password entered afterwards was written to the System Keychain, but the migration into the vault saw the marker and exited early, so no encrypted credential was ever written. Connecting then sent an empty password and failed no matter how correct the password was.
* **Migration Now Checks the Ciphertext**: The migration skips only when the encrypted credential is actually present, so a marker-only host still migrates. Opening an affected host and saving it moves the existing keychain password into the vault — no need to re-import or retype it.

### 🚀 Improvements

#### 1. Credential Visibility Warnings
* **Missing Credential Notice**: The host editor now warns when no credential is stored for a host, instead of silently attempting an empty password. It stays advisory, since a host may legitimately need no password.
* **Accurate Vault Credential State**: App Vault hosts report credential presence from the database rather than assuming the marker implies a stored secret, still without any Keychain prompt.
* **Import Expectations**: OpenSSH and MobaXterm imports now state up front that the file carries no passwords, and the result screen reminds you to add a password to each imported host before connecting.

---

## [1.2.0] - 2026-09-10

### 🚀 Highlights & New Features

#### 1. Secure Stored Password Reveal
* **Master Password Gated**: Reveal stored host passwords from the Encrypted App Vault directly in the Host Edit modal after verifying your App Vault master password.
* **Ephemeral & Masked by Default**: Revealed passwords exist only in temporary dialog memory, remain masked until toggled with the eye icon, and are immediately cleared from memory when closing the dialog.
* **Keychain Boundary & Migration**: Passwords stored in the System Keychain cannot be revealed with an app master password; a direct migration action transfers credentials into the Encrypted App Vault where they can be unlocked securely.
* **Password Input Visibility Toggle**: Added an Eye toggle to view manual password inputs when editing or entering new host credentials.

#### 2. MobaXterm Import Username Correction
* **Preserve Unspecified Usernames**: MobaXterm bookmark entries with empty or default logins are no longer silently rewritten to "root".
* **Preview Badging & Guidance**: Import previews flag sessions that require a username check before committing, preventing authentication failures caused by unintended user substitutions.

---


## [1.1.0] - 2026-09-05

### 🚀 Highlights & New Features

#### 1. Dual-Pane Host Explorer (SFTP / SCP)
* **Side-by-Side Local & Remote Browsing**: Standalone host explorer tabs render a dual-pane layout with the local filesystem on the left and the connected host filesystem on the right.
* **Bidirectional Selected Transfers**: Copy files and recursive folder hierarchies between the local and remote current directories using dedicated action buttons on the center rail ("Copy selected to remote" and "Copy selected to local").
* **Queue & Conflict Integration**: Seamlessly routes transfers through the existing SFTP/SCP transfer queue with real-time progress indicators, cancellation, and destination conflict prompts before overwriting.
* **Transport Fallback & Pane Scoping**: Fully compatible with both SFTP and transparent SCP fallback sessions; keyboard navigation, search, and action shortcuts are isolated to the focused pane.

---

## [1.0.4] - 2026-09-02

### 🚀 Highlights & New Features

#### 1. Import Credential Storage Selection
* **Storage Target Choice**: You can now choose whether imported credentials are saved to the macOS System Keychain or the encrypted App Vault during import. The choice appears for all import sources and is prefilled from your "default password storage" setting.
* **Termius Passwords to Vault**: When importing from Termius, password credentials are moved into the encrypted App Vault if selected. Private keys and key passphrases remain in the System Keychain (as the App Vault is password-only). The import wizard shows this split before you commit and reports it in the summary.
* **MobaXterm & SSH Config Support**: Because these files contain no secrets, the selection determines where any password you enter later for these hosts will be stored.
* **Missing Vault Credential Fix**: Fixed a bug where a host marked for App Vault storage with no stored credential yet would fail to connect entirely. It now falls back to a password prompt like a Keychain host does (while still refusing to connect if the vault is locked).
* **Consent Copy Correction**: Fixed the import wizard consent text which previously incorrectly stated that credentials were saved to the "secure vault" while actually writing them to the System Keychain.

---

## [1.0.3] - 2026-09-02

### 🚀 Highlights & New Features

#### 1. Encrypted App Vault Management
* **Master Password Controls**: Added Security & Vault settings to change the encrypted App Vault master password and lock/unlock the vault for the current session.
* **Live Vault Status**: Settings now surfaces whether the vault is configured, locked, or unlocked, alongside session access controls.

#### 2. Backup Credential Scope
* **Preflight Credential Counts**: Backup export inspects credential sources up front and reports how many System Keychain reads (and prompts) a full backup requires.
* **Opt-In Keychain Export**: Choose to skip System Keychain credentials during export to avoid repeated macOS authorization prompts, while App Vault credentials stay protected inside the encrypted snapshot.

#### 3. Bulk Keychain → App Vault Migration
* **One-Click Migration**: Move all System Keychain password credentials into the encrypted App Vault in a single pass, eliminating repeated Keychain prompts during backups and daily use.
* **Resilient Per-Host Sweep**: Migration continues past individual host failures and reports skipped/failed hosts; a keychain entry is removed only after its encrypted vault copy is persisted.
* **Default Password Storage**: Added a setting to choose where new password-authenticated hosts store their credential by default (System Keychain or Encrypted App Vault).

---

## [1.0.1] - 2026-09-01

### 🚀 Highlights & New Features

#### 1. File Explorer Search & Real-Time Filtering
* **Search Filter Bar**: Added an interactive search and filter input to the SFTP, SCP, and S3 file explorer toolbars, allowing users to filter files and folders in real time.
* **Case-Insensitive Substring Match**: Easily locate files across large directories with instant, case-insensitive substring matching.
* **Keyboard Shortcuts & Clear Control**: Quick-focus the filter using `Cmd+F` / `Ctrl+F`, clear filter via the `Escape` key or the clear `X` button, and navigate filtered results with keyboard arrow keys.
* **Filtered Empty State**: Shows a clean empty match state with a `"Clear filter"` action when no files match the current query.

#### 2. Development App Naming (`OmniSSH-dev`)
* **Local Dev Window Title**: Local development runs and debug builds now explicitly name the window `"OmniSSH-dev"` and update the document title so developers can easily distinguish running dev instances from installed production releases.
* **Settings & About Section**: Displays `"OmniSSH-dev"` in the About card during local development mode.

---

## [1.0.0] - 2026-09-01

### 🚀 Highlights & New Features

#### 1. Unified Connection Import Engine
* **Multi-Source Import Wizard**: Introduced a unified import modal supporting connections from **OpenSSH** (`~/.ssh/config`), **MobaXterm** (`.ini`, `.mxtsessions`, `.mxtpro`), and **Termius** local offline databases.
* **Granular Selective Preview**: Live inspection and selection of candidate hosts with group path preservation, startup commands, port settings, proxy jump hops, and notes before committing.
* **Atomic Import Commits**: All imported hosts, custom groups, and credentials commit transactionally with rollback protection to prevent partial or corrupted configurations.

#### 2. Secure Offline Termius Import Pipeline
* **Zero-Cloud Local Reader**: Reads on-disk Termius IndexedDB/LevelDB storage directly via Rust without requiring Termius cloud accounts or runtime APIs.
* **Authenticated Decryption & Keychain Migration**: Extracts and decrypts Termius v8 encrypted entities (using PBKDF2, AES-GCM, and XSalsa20-Poly1305) and seamlessly securely saves private keys and credentials directly into the OS keychain/vault.
* **Safe Concurrency & Lock Probing**: Detects running Termius processes and probes POSIX record locks on LevelDB directories to prevent database contention or corruption.
* **Metadata vs. Full Credential Import**: Flexible user-selectable import modes with strict validation gates and confirmation workflows.

#### 3. MobaXterm Session Importer
* **Comprehensive INI & Registry Parsing**: Supports MobaXterm exported session files, bookmarks, and raw configuration formats.
* **Portable Path Resolution**: Automatically resolves portable drive markers (`_MobaXterm_Drive_...`) to local absolute paths for private keys and identities.
* **Hierarchical Folders**: Preserves MobaXterm nested bookmark folder structures and translates them into anySCP host groups.

#### 4. Linked Terminal Explorer & OSC 7 CWD Synchronization
* **Side-by-Side Linked Explorer Panel**: Added a collapsible remote filesystem panel docked directly beside active terminal panes (`LinkedExplorerPanel`).
* **Real-time Shell CWD Tracking via OSC 7**: Parses terminal OSC 7 escape sequences (`\x1b]7;file://hostname/path\x07`) to synchronize directory changes between the shell and the linked explorer automatically.
* **Shell Integration Helper**: Built-in shell snippet injector (`enableShellSync`) supporting Bash, Zsh, and Fish to easily enable OSC 7 directory emission.
* **Independent Generation Invalidation**: Dedicated `useLinkedExplorerStore` with monotonic generation counters and tab/split-pane rebind tracking to prevent race conditions across active/inactive tabs.

#### 5. Multi-Channel SSH Multiplexing & Lifecycle Isolation
* **Channel-Level Isolation**: Terminals, linked explorers, and standalone SFTP/SCP tabs communicate over isolated SSH subsystem channels without cross-session interference.
* **Automatic Disconnect & Drop Lifecycle Handling**: Automatic cleanup and invalidation of linked explorer state when an SSH connection drops or a terminal split pane is closed.

#### 6. Dashboard Views & Host Management Enhancements
* **Grid vs. List View Toggle**: Added a switcher on the Hosts Dashboard allowing users to switch between the spacious `HostCard` grid and a compact `HostListRow` table layout.
* **Persistent Layout Preferences**: Saved view mode preferences persisted via `useSettingsStore`.
* **Enhanced Host Cards & Status**: Health status checks, environment badges (`PROD`, `STAGE`, `DEV`, `TEST`), quick action buttons, duplicate host actions, and context menus.

#### 7. Modernized Explorer Architecture
* **Unified Explorer UI**: Deprecated legacy `SftpPage` and `SftpSessionPicker` in favor of a unified `ExplorerPage` and `ExplorerView`.
* **Multi-Tab File Management**: Robust tabbed browsing in `SftpTabs` supporting multiple concurrent remote connections and paths.
* **Conflict Resolution**: Added `DropOverwriteDialog` for managing file collision policies during drag-and-drop operations.
* **Transport Abstraction**: Seamless fallback and unified capabilities between SFTP and SCP protocols.

---

### 🛠 Improvements & Hardening
* **Race-Safe State Guards**: Protected async state in modals and explorer panels against unmounting and fast tab-switching races.
* **Group Validation**: Rejects unknown host groups atomically during imports.
* **Keyboard Navigation & Accessibility**: Improved keyboard navigation across tab bars, modals, dialogs, and terminal split separators.
* **Agent & Developer Documentation**: Added `AGENTS.md` and `docs/termius-manual-validation.md` for codebase architecture guidance and security validation.

---

### 🧪 Testing & Quality Assurance
* **8 New End-to-End Test Specs** (`tests/e2e/specs/`):
  * `66-two-independent-explorers.spec.ts`: Validates concurrent independent explorer sessions.
  * `67-ssh-protocol-channels.spec.ts`: Tests multi-channel SSH multiplexing.
  * `68-linked-standalone-coexistence.spec.ts`: Verifies coexistence between linked and standalone explorers.
  * `69-terminal-split-cleanup.spec.ts`: Validates resource cleanup on split-pane closing.
  * `70-osc7-cwd-follow.spec.ts`: Tests OSC 7 directory tracking and synchronization.
  * `71-sftp-scp-fallback-ui.spec.ts`: Tests protocol fallback and transport switching.
  * `72-keyboard-navigation.spec.ts`: Tests accessibility and keyboard shortcut traversal.
  * `73-theme-narrow-layout.spec.ts`: Verifies responsive behavior in narrow layouts across dark/light themes.
* **Extensive Unit & Integration Coverage**:
  * New Vitest suites for `osc7`, `shell-sync`, `linked-explorer-store`, `sftp-tabs`, and `ImportSshConfigModal`.
  * Comprehensive Rust unit tests for Termius decryption, envelope parsing, LevelDB reading, and MobaXterm parsing.
