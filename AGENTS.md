# anySCP Agent Guide

## Project overview

anySCP is a cross-platform Tauri v2 desktop client for SSH terminals, SFTP/SCP file management, S3-compatible storage, port forwarding, and reusable command snippets.

- `src/`: React 19 + strict TypeScript frontend.
- `src/components/`: feature UI and shared components.
- `src/stores/`: Zustand stores; most Tauri command calls originate here or in feature components.
- `src/providers/` and `src/types/explorer.ts`: shared filesystem abstraction used by SFTP and S3 views.
- `src-tauri/src/`: Rust backend for network protocols, persistence, credentials, transfers, and native integrations.
- `tests/e2e/`: Docker-backed WebdriverIO tests that drive the real Tauri application.
- `screens/`: generated product screenshots and demo GIF, except `screens/header.png`, which is hand-made.

The main architectural rule is that React is the view/state layer while Rust owns SSH, SFTP, SCP, S3, SQLite, keychain access, native file I/O, and other privileged work. Tauri commands provide request/response IPC and namespaced Tauri events provide backend-to-frontend updates.

## Setup and common commands

Use pnpm; do not generate npm or Yarn lockfiles.

```bash
pnpm install --frozen-lockfile
pnpm tauri dev
pnpm build
pnpm test
```

`pnpm build` runs the strict TypeScript check before the Vite production build. There is no configured ESLint or Prettier command, so do not invent one as a required gate.

Rust checks:

```bash
cd src-tauri
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The Tauri build script expects `dist/` to exist. Run `pnpm build` at the repository root before Rust commands that compile the crate on a clean checkout.

Useful focused test commands:

```bash
pnpm exec vitest run src/path/to/file.test.ts
cargo test --manifest-path src-tauri/Cargo.toml test_name
```

The full E2E suite is containerized and comparatively expensive:

```bash
make e2e
make e2e-shell
make e2e-logs
```

Read `tests/e2e/README.md` before changing or debugging E2E coverage. Avoid `make e2e-clean` unless a genuinely clean Docker/cache rebuild is needed.

## Change guidelines

- Preserve the frontend/backend separation. Do not move privileged protocol, credential, database, or native filesystem logic into React.
- Never persist credentials in SQLite, expose saved secrets back to frontend state, or include secrets, host contents, paths, or commands in logs or telemetry. Use the Rust vault/keychain APIs.
- Treat Tauri command names, argument keys, serialized result shapes, and event payloads as contracts. When one changes, update Rust, TypeScript, registration in `src-tauri/src/lib.rs`, and relevant tests together.
- Keep long-running or blocking work off async executor threads. Follow existing `tokio::task::spawn_blocking`, manager, cancellation, and transfer-queue patterns.
- Keep SFTP and SCP command surfaces mirrored where they intentionally provide the same explorer behavior. Route transport differences through `src/lib/explorer-transport.ts` rather than branching throughout the UI.
- Extend the shared `FileSystemProvider` and capability flags for behavior common to SFTP and S3 instead of duplicating explorer components.
- Use existing Zustand stores for shared application state. Preserve optimistic-update rollback behavior where stores already use it.
- Reuse components from `src/components/shared/` and feature barrel exports before adding another variant.
- Use the design tokens in `src/theme.css` and existing Tailwind v4 utilities. Preserve dark/light theme support and runtime accent/font overrides.
- Maintain stable `data-testid` attributes for E2E flows. New IDs follow the `<component>-<element>` convention.
- Do not add or upgrade dependencies without a concrete need and an assessment of desktop bundle/build impact.
- Do not edit generated outputs such as `dist/`, `src-tauri/target/`, E2E reports/videos, or raw screenshot artifacts.

For a substantial added or modified code block, place a concise multi-line block comment (`/* ... */`) at its top explaining the logic. Do not replace a multi-line explanation with a run of `//` comments, and do not include meta phrases such as “why this changed.” Keep comments focused and avoid narrating obvious code.

## Frontend conventions

- TypeScript is strict and rejects unused locals, unused parameters, and switch fallthrough.
- Prefer explicit types at IPC and feature boundaries; use `import type` for type-only imports.
- Follow the export style of the surrounding module. Feature components generally use named exports and `index.ts` barrels, while application entry points use defaults.
- Tauri calls are commonly loaded with dynamic `import("@tauri-apps/api/core")`; preserve this pattern where it enables Vitest module mocking or E2E hooks.
- Convert unknown failures deliberately instead of assuming caught values are `Error` instances.
- Keep component and store tests beside their source as `*.test.ts` or `*.test.tsx`. Use Vitest, Testing Library, and existing Tauri mocks.
- Preserve accessibility behavior: labels, keyboard navigation, focus management, and semantic controls are part of the feature, not optional polish.

## Rust conventions

- Format with rustfmt and keep Clippy warning-free under `-D warnings`.
- Tauri commands live in the relevant feature module and must be added to the `generate_handler!` list in `src-tauri/src/lib.rs`.
- Serialize errors and events into stable, actionable frontend contracts. Add contract tests when a serialized error kind or wire shape matters.
- Prefer typed errors and propagated `Result` values over panics. Reserve `expect` for startup invariants where the process cannot reasonably recover.
- Reuse the managed SSH/SFTP/SCP/S3/transfer manager state rather than creating uncoordinated global state.
- Preserve cancellation, progress throttling, bounded completed-transfer history, and cleanup behavior when changing transfer code.
- Add focused `#[cfg(test)]` unit tests near pure Rust logic and edge cases, especially protocol parsing and platform-specific behavior.

## Testing expectations

Run the smallest relevant checks while iterating, then expand based on the change:

- Frontend logic or component: focused Vitest test, then `pnpm test` and `pnpm build`.
- Rust-only logic: focused `cargo test`, then rustfmt, Clippy, and the Rust suite. Build the frontend first if `dist/` is absent.
- IPC or cross-layer behavior: both frontend and Rust checks.
- User-visible workflow, persistence, credentials, protocol fallback, or transfer behavior: add or update an E2E spec when unit tests cannot cover the real integration.
- UI changes: verify both themes and relevant keyboard/focus behavior. Regenerate marketing assets with `make screenshots` only when the user-facing captures intentionally changed; leave `screens/header.png` untouched.

New E2E specs belong in `tests/e2e/specs/NN-name.spec.ts`, use helpers from `tests/e2e/helpers/`, and retain lexical numbering. Every test normally relies on `resetApp()` isolation; persistence tests should use the established relaunch helper instead.

## Working practices

- Check for more-specific `AGENTS.md` files before editing a subdirectory; nearer instructions override this file.
- Inspect nearby implementation and tests before introducing a new pattern.
- Preserve unrelated working-tree changes and keep edits scoped to the request.
- Do not commit, push, publish a release, run destructive cleanup, or regenerate large assets unless explicitly requested.
- Summarize changed files, explain why each change was necessary, and report the exact verification performed. If a check was skipped, state the reason.
