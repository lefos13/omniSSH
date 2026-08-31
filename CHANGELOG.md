# Changelog

All notable changes to the anySCP project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] - `feature/imports-and-linked-explorer`

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
