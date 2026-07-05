# RESTIC-BACKUP-STABLE-RESULT-NAMES — deterministic retrieval for method results

GitHub issue: #2

## What

Give each method a **stable, deterministic data-record name** so the latest
result of any method can be read with one correct command, and so no two methods
share a record name. Today the record `name` is either shared (`current`) or
timestamped, and neither supports a reliable "latest result of method X" read.

## Problem (verified against the live datastore)

Swamp keys a data record by its **name**, not by `(spec, instance)` — the
`specName` is a tag, not part of the identity. Consequences, confirmed on the
`swamp-backup-demo` instance:

1. **`current` collision (correctness bug).** `checkRestic` (spec
   `resticStatus`), `init` (spec `repositoryStatus`), and `snapshots` (spec
   `snapshots`) all write the record name `current`. There is exactly **one**
   `current` record (observed at version 18), whose `tags.specName` is whichever
   method ran last (observed: `snapshots`). Each write overwrites the previous
   spec's result at that name. Worse, `current` inherits the lifetime/GC of the
   last writer: `init`'s `repositoryStatus` is declared `lifetime: infinite`,
   but when `snapshots` (`7d`) writes `current` after it, the repository-init
   evidence becomes subject to a 7-day expiry. Two of the three results are not
   durably retrievable by name.
2. **Timestamped names have no stable handle.** `backup` (`backup-<snapshotId
   [:12]>`), `check` (`check-<YYYY-MM-DD>`), `forget`/`prune`/`restore`
   (`<method>-<timestamp>`) each write a unique name per run. Reading "the latest
   backup" requires knowing the exact name, obtainable only by scraping the
   run's `--json` `dataArtifacts[].name`.
3. **No query ordering.** `swamp data query` exposes only `--limit` (no
   `--order`/`--sort`); results come back **oldest-first** (verified: four
   `backupResult` records returned 06-27 → 07-03). So `--limit 1` returns the
   **oldest** matching record, not the newest — the pattern
   `docs/reference.md` currently recommends for reading a result is wrong.

## Why

The extension's purpose is durable, queryable **evidence** of backup operations.
The core operations (backup/restore/retention) work — none of them read these
records back, so the collision does not break a backup. But the evidence layer
is partly self-corrupting (the `current` collision silently drops and
mis-expires results) and awkward to read (no deterministic latest handle),
which undermines the model's reason to exist. A stable per-spec name plus
swamp's versioning (which preserves history) fixes both.

## Desired behaviour

- Each method writes to a **fixed, spec-specific record name** that never
  collides with another method's, so each spec keeps its own declared
  lifetime/GC.
- The **latest** result of any method is readable with a single deterministic
  command — `swamp data get <instance> <name> --json` (resolves the latest
  version) or the `data.latest("<instance>","<name>")` CEL accessor — with **no
  timestamp scraping and no reliance on query ordering**.
- **History is preserved** via swamp's immutable versioning (each run is a new
  version of the stable-named record; older versions remain reachable per
  swamp's version selection and each spec's GC retention).
- For `backup` specifically, the snapshot-id-addressed record MAY be retained in
  addition to the stable name, because addressing a specific historical snapshot
  by id is genuinely useful; this is the one method where a per-run addressable
  copy earns its keep. For all other methods, the stable name + versions is the
  single record (no separate timestamped copy).
- The `current` name is retired; `checkRestic`, `init`, and `snapshots` each get
  their own name.
- `docs/reference.md` (the output-resources table and the "Reading a result"
  section) and any tutorial reference to reading `current` are corrected to the
  stable names and a read command that returns the **latest**, not the oldest.

## Scope

In scope:

- The instance-name argument each method passes to `context.writeResource` in
  the eight `_lib/methods/*.ts` modules (and, for `backup`, the optional
  additional snapshot-id-addressed write).
- Test assertions in `restic_backup_test.ts` that lock in the new record names
  (the suite currently asserts `specName` but not the instance name — add
  instance-name assertions so the naming contract is covered).
- `docs/reference.md` output-resources table + "Reading a result" section, and
  the tutorial's `current`-read steps.

Out of scope:

- The result **payload schemas**, the resource **spec** names/definitions, the
  method **arguments**, method behaviour against restic, and the secret path —
  all unchanged. Only the record **name** each method writes changes (plus the
  optional extra `backup` copy).
- Any change to swamp itself (no new CLI flag, no ordering feature) — the fix
  lives entirely in how the extension names records.
- Migrating or renaming existing `current`/timestamped records already on disk
  in a user's datastore (they age out under GC; a note MAY mention this).

## Done

- No two methods write the same record name; `current` is no longer used.
- For each of the eight methods, a single documented command returns its **most
  recent** result deterministically (verified by running the method and reading
  it back by the stable name), without scraping run output or depending on query
  ordering.
- Each spec's result is retrievable by name and retains that spec's own declared
  lifetime/GC (the repository-init evidence is no longer subject to `snapshots`'
  7-day expiry).
- History remains available: an earlier result of a method is still reachable
  via swamp's version selection.
- `restic_backup_test.ts` asserts the new stable record name for each method and
  stays green; the full suite passes on this machine and skips (not fails)
  integration tests where restic is absent.
- `docs/reference.md` and the tutorial show the correct stable names and a
  latest-returning read command; no doc recommends `--limit 1` for "latest".

## Constraints

- This changes the model's **observable output contract** (record names are part
  of what downstream CEL/consumers reference) — treat it as behaviour-changing,
  not a pure refactor. Do not change result payloads or spec definitions.
- Do not weaken any existing assertion; add to them.
- Use a stable name that is not the swamp-reserved data name `latest` (which
  collides with the on-disk `latest` version symlink). Prefer a descriptive
  per-spec name (e.g. `restic-status`, `repository-status`, `snapshots`,
  `backup-latest`, `check-latest`, `forget-latest`, `prune-latest`,
  `restore-latest`).
- No secret value may appear in a record name, log, or payload (unchanged
  invariant).
