# Termius manual validation gate

Use this gate for the macOS Termius 9.43.1 import path. It is user-assisted and must be run against a disposable or otherwise approved test profile.

## Prerequisites and handling

- Confirm Termius is fully closed before beginning (including background/menu-bar processes).
- Record only the app version, Termius version, and sanitized item counts/schema. Never capture plaintext secrets, decrypted contents, local paths, host addresses, commands, key material, screenshots, or logs containing them.
- Use metadata-only import validation: names may be replaced with stable labels, and values must remain redacted.
- Credential validation requires an explicit opt-in confirmation immediately before testing. Do not copy, display, or record the password or private-key material.

## Procedure and acceptance criteria

1. Record the anySCP version and `Termius 9.43.1`, plus sanitized source/schema counts.
2. Run the import and compare only sanitized counts and schema/field presence. Confirm expected hosts, identity metadata, and linked bindings are represented without exposing their values.
3. With explicit opt-in, use the imported password-backed connection and private-key-backed connection against approved test targets. Confirm each succeeds; report only pass/fail and sanitized counts.
4. Exercise linked bindings and remove the imported parent/linked records as applicable. Confirm cleanup is transport-aware and leaves no orphaned linked bindings or stale lifecycle state.
5. Inspect the approved SQLite database, application logs, and temporary files for plaintext credentials, decrypted contents, key material, host addresses, commands, or other sensitive artifacts. Record only whether the check passed or failed; do not retain excerpts.
6. If any check fails, stop, revoke/delete test credentials as appropriate, and do not distribute the result. Roll back imported records and temporary test data using the supported application flow; preserve only sanitized evidence needed to reproduce the failure.

## Result record

Record only:

- anySCP version:
- Termius version (expected `9.43.1`):
- sanitized source/schema counts:
- metadata-only import: pass/fail
- password connection (opt-in): pass/fail/not run
- private-key connection (opt-in): pass/fail/not run
- linked-binding and transport-aware cleanup: pass/fail
- SQLite/log/temp plaintext-artifact check: pass/fail
- rollback: pass/fail/not applicable
