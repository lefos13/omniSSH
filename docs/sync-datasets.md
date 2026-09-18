# Encrypted dataset sync (self-hosted)

Dataset sync keeps the same hosts, groups, snippets, port-forward rules, S3
connections, per-host plugin config, and selected app settings on several
machines. It is **self-hosted and zero-cloud**: a dataset is a directory on an
SSH server *you* own, reached with credentials you enter, and the payload is
end-to-end encrypted before it leaves your machine. OmniSSH runs no service for
this feature, has no account system, sends no telemetry, and cannot read your
dataset — the key material never leaves your machines.

Everything is driven from **Settings ▸ Dataset Sync**.

## 1. What a dataset is

A dataset is a named row holding:

| Field | Meaning |
| --- | --- |
| Endpoint | SSH host, port, username, and password or private key |
| Remote path | The directory that holds the published bundle |
| Role | `owner` (publishes) or `member` (pulls only) |
| Scope | All hosts, or an explicit selection of groups / hosts |
| Content kinds | Any subset of the syncable kinds below |
| Cadences | Optional automatic pull interval and push debounce |

Syncable kinds: `hosts` (with an optional `hostCredentials` sub-toggle),
`groups`, `snippets` (with `snippetFolders`), `portForwards`, `s3Connections`
(with `s3Credentials`), `hostPlugins`, and `appSettings`. Enabling `hosts`
forces `groups` for the groups its hosts reference; `portForwards` and
`hostPlugins` require `hosts`; `snippets` requires `snippetFolders`.

Deliberately **not** syncable — these describe one machine, not the dataset:

- `connection_history`, `recent_paths` — this device's telemetry.
- `local_vault_metadata`, `local_vault_credentials`, `vault_cleanup_queue` — the
  App Vault's key material is bound to this machine's master password.
- The `sync_*` tables themselves, plus this installation's stable identity
  (`sync_client_id`).

Machine-specific `app_settings` keys (window state, editor executable paths,
skipped update version) are excluded by an explicit deny-list, so a pull cannot
point another machine at a binary that does not exist there. `appSettings`
travels as one synthetic record, not one record per key.

Records a dataset manages are **read-only locally**: an edit would be dropped by
the next pull. The host editor blocks them and offers *Detach from dataset*,
which returns the record to local ownership without deleting it remotely.

## 2. Remote layout

```text
<remote path>/
  dataset.meta.json          plaintext, non-secret: generation, digest, key wrap, signature
  dataset.bin                OMNISYNC container: the encrypted record document
  dataset.lock               advisory writer lock (client id + timestamp)
  history/
    6.bin                    the generation this one replaced, cached
    6.meta.json              the metadata as it was published then
    7.bin
    7.meta.json
```

| Object | Purpose |
| --- | --- |
| `dataset.bin` | Gzipped JSON record document, sealed with the dataset key. Opaque: an operator reading it over `sftp` learns nothing about the hosts inside. |
| `dataset.meta.json` | Everything a client needs *before* decrypting: format version, dataset id, generation, `payloadSha256` of the bundle, the passphrase-wrapped dataset key, publisher client id, and the optional owner fingerprint / public key / signature. Contains no secret — the wrap is useless without the passphrase. |
| `dataset.lock` | Created with `CREATE\|EXCL`, holds a client id and a timestamp; a lock older than 60 s is treated as abandoned. |
| `history/<generation>.*` | The previous bundle and its metadata, so a bad publish can be undone. The last 10 generations are kept; older ones are pruned on each publish. |

Publishing is atomic: bytes are written to `.tmp-<uuid>` in the same directory
and renamed over the target (with one remove-then-rename retry for servers that
refuse rename-over-existing), so a reader never sees a half-written bundle.

Concurrency is optimistic. A push states the generation it based itself on; if
the server's current generation differs, the push is refused with a conflict,
the client pulls and re-merges, and only then publishes. Two machines editing
different records both keep their edits; the same record edited on both sides
resolves by newest `updatedAt` (ties: higher revision), and the losing copy is
listed in the dataset's conflict log rather than merged field by field.

Requirements and limits:

- **SFTP only.** SCP-only remotes are rejected with an actionable error rather
  than half-working.
- Objects larger than 64 MiB are refused; a dataset is host metadata, not file
  content.
- A dataset published by a newer app version (`formatVersion`) is refused with
  "update OmniSSH first" instead of being misread.

## 3. Key hierarchy

```text
passphrase ──Argon2id(salt, m = 64 MiB, t = 3, p = 1)──▶ wrapping key   (32 B, never stored)
wrapping key ──AES-256-GCM, fixed AAD──▶ wrapped dataset key            (stored in dataset.meta.json)
dataset key  ──AES-256-GCM, container header as AAD──▶ dataset.bin      (gzipped record document)
```

- The **dataset key** is 32 random bytes, generated once per dataset. It is the
  only key that encrypts host data.
- The **wrapping key** is derived from the dataset passphrase and re-derived on
  every use; it is never written anywhere.
- The bundle container is `magic "OMNISYNC\x01" | payload format | compression |
  nonce | ciphertext`. The plaintext header is also the AEAD associated data, so
  editing a header byte fails the tag check instead of silently reframing the
  payload.

Consequences of the two-level design, all intended:

- Rotating the passphrase rewraps 32 bytes instead of re-encrypting the dataset.
- A teammate joins with the passphrase alone; no key file has to be shipped.
- One user's App Vault master password stays machine-local. A shared dataset must
  not depend on it, and rotating that master password must not invalidate remote
  data.

The passphrase is a **separate secret** from the App Vault master password and
is never derived from it — the editor deliberately does not prefill it, and it
asks for the secrets again on every save.

Host and S3 credentials are opt-in per dataset (`hostCredentials`,
`s3Credentials`) and, when enabled, are embedded **inside the encrypted
payload** — never as plaintext on the remote. Both sub-toggles start off for
every new dataset, so a dataset published to a shared server cannot leak secrets
by accident. On pull, a credential is written straight into its final store: the
App Vault when this machine prefers it and it is unlocked, otherwise the OS
keychain.

## 4. Roles, signing, and the server-side read-only requirement

- **Owner** — holds an ed25519 signing key whose 32-byte seed lives in this
  machine's credential store under `sync:{datasetId}:signing`. Every publish is
  signed over a preimage of `formatVersion`, `datasetId`, `generation`,
  `payloadSha256`, and `updatedAt`, and the metadata carries the signature, the
  public key, and the fingerprint (lowercase hex SHA-256 of the public key).
- **Member** — pins the owner fingerprint on join (the first pull that carries
  one) and rejects metadata that is unsigned, signed by a different key, or whose
  published public key does not hash to the pinned fingerprint. A member cannot
  publish. A dataset with no signature and no pin — a single-user dataset — keeps
  working unsigned.
- Because the preimage excludes the key wrap, rotating the passphrase does not
  invalidate a signature.

Client-side roles are **advisory**. Nothing stops a determined member from
writing to the directory with their own tools, so write prevention must be
enforced by the server:

- Give members a **read-only** account, for example OpenSSH's read-only SFTP
  (`Match User <member>`, then `ForceCommand internal-sftp -R`), or
- keep the dataset directory owned by the owner account with mode `0755` (files
  `0644`) and give members no write permission on it.

Settings reports what it finds rather than assuming: *Test connection* probes the
path (exists, writable, contains a dataset), and a member dataset whose account
can still write to the remote path shows a warning on its card. Members only need
read access: pull reads the bundle, and rollback and passphrase rotation are
owner-only.

The remote is also where the accountability lives — the metadata records which
client id published each generation, including the history copies.

## 5. Recovery

| Situation | What to do |
| --- | --- |
| Lost the dataset passphrase | The dataset key exists only as a wrap made with that passphrase, so a lost passphrase means the published bundle cannot be decrypted — **there is no recovery backdoor**. If another machine still holds the passphrase, pull there and publish under a new passphrase (rotate it, or create a new dataset and push). Otherwise create a new dataset with a fresh passphrase and push the data from a machine that still holds the hosts locally, or restore a local backup that included credentials and push from there. |
| Lost the owner signing key | **Unrecoverable.** The seed lives only in that machine's credential store, and dataset secrets are not part of any backup. Members keep the pinned fingerprint and will reject a different key, and an owner row cannot be created from a machine that does not hold the key. Existing machines: publish from the one that still holds the seed. If it is gone, re-create the dataset under a new owner key and have every client delete its dataset row and join again, which re-pins the new fingerprint on the first pull. |
| A bad push | Open **Generation history** on the dataset card and roll back to an earlier generation. Rollback is owner-only, applies the chosen generation here as a normal merge (local-only records survive), and publishes the result as a **new** generation — nothing already on the server is rewritten, and other clients converge by pulling. A generation published under a *previous* passphrase cannot be rolled back: the retained copy is sealed with the key that passphrase wrapped, and rollback only ever uses the passphrase stored on this machine. |
| Retiring a machine or a teammate | Rotate the dataset passphrase. Already-published bundles are not re-encrypted, so the retired machine keeps whatever it already pulled locally and cannot read generations published after the rotation; if you suspect the dataset *key* leaked (not just the passphrase), create a new dataset, because rotation keeps the same key. |
| Restoring a backup (including on another machine) | The backup restores the dataset rows with their scope, merge base, conflict log, pending deletes, and detach opt-outs — but never the dataset secrets, which live in the OS keychain and are not written into a backup. Each restored dataset shows "this machine is missing …" on its card; open Edit, re-enter the server credential and the dataset passphrase, save, then pull (or push, if it is an owner). Host and S3 credentials are restored only when the backup was exported with credentials. |
| Factory reset | A reset deletes every row with raw SQL, so it records **no tombstones** and cannot publish a wipe: it also clears this machine's merge base and purges every `sync:{datasetId}:*` secret. A reset followed by a pull re-receives the dataset instead of erasing it for everyone else. |
| Lost a device | Nothing on the remote is usable without the passphrase; the local database holds only the wrapped dataset key. Treat the device as a lost credential and follow the rotation guidance above. |

## 6. What is deliberately out of scope

No OmniSSH-hosted service, no account system, no telemetry, no plaintext secrets
on the remote, no interactive three-way merge UI, and no SCP-only remote support.
Transport uses password or private-key authentication; a ProxyJump endpoint is
not supported for sync yet.
