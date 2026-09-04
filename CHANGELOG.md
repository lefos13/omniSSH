# Changelog

All notable changes to the OmniSSH (formerly anySCP) project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
