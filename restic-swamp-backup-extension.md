# Proposal: @atalanta/restic-backup

## Summary

Build a swamp model extension that uses restic to back up a repo's `.swamp/`
runtime data.

The core pitch:

> Your swamp repo source lives in git, but your `.swamp/` runtime evidence does
> not. Back it up.

This should be a **model extension**, not a datastore extension. The first goal
is durable backup and portability for personal swamp experimentation, not a live
multi-writer shared datastore.

## Why This Exists

Swamp deliberately separates source-of-truth files from runtime data. Model and
workflow definitions live in git-tracked top-level directories, while runtime
data lives in the datastore and is not part of git. The `swamp-internals` KB
records this as a first-class design decision: source files are reviewed and
versioned in git; runtime data is mutable automation output that needs datastore
access to recover history. Source: `decision-source-runtime-split`, citing
`design/datastores.md`.

Swamp also treats runtime data as evidence, not disposable logs. Every method run
can produce immutable, versioned, queryable data records with provenance. Source:
`decision-knowledge-substrate`, citing `design/high-level.md`.

That creates a practical problem for early swamp users:

- They are likely experimenting locally.
- Their `.swamp/` directory accumulates useful evidence: data outputs, workflow
  runs, execution outputs, evaluated definitions, reports, logs and audit
  material.
- They should not commit `.swamp/` into git.
- They still need confidence that laptop loss, disk failure, or moving machines
  will not destroy the useful runtime history.

Restic already solves this class of problem: encrypted, deduplicated snapshots
to local, SFTP, REST, S3-compatible, Backblaze B2, Azure Blob, Google Cloud
Storage and rclone-backed repositories. Source:
`https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html`.

## Positioning

This is not a replacement for `@swamp/s3-datastore`, `@swamp/gcs-datastore`, or a
future live remote datastore.

Position it as:

> Encrypted restic backups for swamp runtime data, so local experimental state
> survives disk failure, laptop loss and machine moves.

Better phrasing than "backup only":

> A safety layer for personal swamp repos.

The extension should explicitly say it is **not** a multi-user coordination
backend and does not make concurrent agents safe.

## Non-Goals

- Do not implement a custom swamp datastore.
- Do not provide multi-writer distributed locking.
- Do not claim live team coordination.
- Do not silently restore over an active `.swamp/` directory.
- Do not store the restic password only inside the `.swamp/` data being backed
  up.
- Do not wrap external storage APIs directly; restic owns backend details.

## Swamp Concepts to Preserve

These facts should guide the implementation.

The source knowledge base for these facts is in the local repo:

- KB repo path:
  `/Users/stephen.nelsonsmith/Developer/swamp-kb`
- Operating manual:
  `/Users/stephen.nelsonsmith/Developer/swamp-kb/KNOWLEDGE-BASE.md`
- Model YAML:
  `/Users/stephen.nelsonsmith/Developer/swamp-kb/models/@stateless/sourced-kb/63d957b5-7df5-465a-9ca7-48d47328d1e8.yaml`
- Model name: `swamp-internals`
- Resource spec: `entry`

Before implementing, mine the local KB rather than re-reading swamp source from
scratch. If you are working in a different extension repo, run these commands
from `/Users/stephen.nelsonsmith/Developer/swamp-kb` or pass that as the command
working directory:

```bash
cd /Users/stephen.nelsonsmith/Developer/swamp-kb

# List available KBs in this repo
swamp model list --json

# List all swamp-internals entries
swamp data query 'modelName == "swamp-internals" && specName == "entry"' \
  --select '{"id": attributes.id, "kind": attributes.kind, "name": attributes.name}' --json

# Pull the concepts this proposal depends on
swamp data query 'modelName == "swamp-internals" && specName == "entry" && attributes.id in ["concept-datastore", "decision-source-runtime-split", "decision-knowledge-substrate", "concept-data", "concept-model", "concept-method", "concept-extension", "concept-report"]' \
  --select '{"id": attributes.id, "name": attributes.name, "summary": attributes.summary, "claims": attributes.claims}' --json

# Look up a single entry by stable slug
swamp data query 'modelName == "swamp-internals" && attributes.id == "concept-datastore"' \
  --select '{"name": attributes.name, "summary": attributes.summary, "claims": attributes.claims}' --json
```

Remember the non-obvious query gotcha from `KNOWLEDGE-BASE.md`: the stable slug
lives in `attributes.id`, not the top-level result `id`.

- A swamp `Model` is a typed representation of an external system or tool.
  Source: `concept-model`, citing `design/models.md`.
- A model `Method` should be named, typed and schema-validated, and should have
  one purpose. Source: `concept-method`, citing
  `src/domain/models/model.ts:583-613`.
- Runtime `Data` is immutable, versioned and queryable. Source:
  `concept-data`, citing `design/models.md:392-453`.
- The datastore stores runtime data; default storage is local filesystem under
  `{repo}/.swamp/`. Source: `concept-datastore`.
- Extension types should be used according to intent: model extensions for
  external tools and automation, datastore extensions for custom storage
  backends. Source: swamp extension guide.
- Do not use `command/shell` to wrap integrations as a substitute for a
  dedicated model. Source: swamp extension guide.

## Proposed Extension

Name:

```text
@atalanta/restic-backup
```

Possible shorter name:

```text
@atalanta/restic
```

Recommended export type:

```text
model
```

Suggested model type:

```text
@atalanta/restic-backup/repository
```

The model represents one restic backup configuration for a swamp repo.

## Configuration

Global arguments should describe the stable backup configuration:

- `repository`: restic repository URL, e.g. `b2:bucket:path`,
  `s3:s3.amazonaws.com/bucket/path`, `rclone:remote:path`, or local path.
- `repoDir`: swamp repo path, default current repo.
- `include`: list of paths relative to repo root.
- `exclude`: list of restic exclude patterns.
- `passwordEnv`: environment variable name that contains the restic password,
  default `RESTIC_PASSWORD`.
- `resticBinary`: command path, default `restic`.
- `hostTag`: optional tag value to identify machine/host.
- `extraTags`: optional list of restic tags.
- `retention`: optional policy, e.g. keep last/daily/weekly/monthly.

Do not put secret values directly in model YAML. Prefer environment variables,
OS keychain, 1Password, Azure Key Vault, HashiCorp Vault, or another swamp vault.

## Default Include/Exclude Policy

MVP default includes:

- `.swamp/data`
- `.swamp/outputs`
- `.swamp/workflow-runs`
- `.swamp/definitions-evaluated`
- `.swamp/workflows-evaluated`

Consider including:

- `.swamp/audit`

MVP default excludes:

- `.swamp/telemetry`
- `.swamp/logs`
- `.swamp/bundles`
- `.swamp/datastore-bundles`
- `.swamp/driver-bundles`
- `.swamp/report-bundles`
- `.swamp/vault-bundles`

Bundle caches are usually reconstructable. Data, outputs and workflow history
are the valuable runtime evidence.

## Proposed Methods

### `check_restic`

Verify restic is installed and report its version.

Output resource:

- `restic-status`

Fields:

- `available`
- `version`
- `binary`
- `message`

### `init`

Initialize the configured restic repository.

This should be idempotent where restic behavior allows it. If the repository is
already initialized, return a structured status rather than failing opaquely.

Output resource:

- `repository-status`

Fields:

- `repository`
- `initialized`
- `created`
- `message`

### `backup`

Run a restic backup over the configured include/exclude set.

This is the main method.

Output resource:

- `backup-result`

Suggested fields:

- `snapshotId`
- `repository`
- `startedAt`
- `completedAt`
- `durationMs`
- `includedPaths`
- `excludedPatterns`
- `filesNew`
- `filesChanged`
- `filesUnmodified`
- `bytesAdded`
- `totalFilesProcessed`
- `totalBytesProcessed`
- `tags`
- `host`

Also consider a file output:

- `backup-log`

### `snapshots`

List restic snapshots for this repository, optionally filtered by host, tag or
path.

Output resource:

- `snapshots`

Fields:

- `snapshots[]`
- `latestSnapshotId`
- `latestTime`
- `count`

### `check`

Run `restic check` against the configured repository.

Output resource:

- `check-result`

Fields:

- `ok`
- `errors`
- `warnings`
- `checkedAt`

### `restore`

Restore a selected snapshot into an explicit target directory.

Safety rules:

- Require `targetDir`; do not default to repo root.
- Refuse to restore directly over `.swamp/` unless `confirm` is provided.
- Prefer restore to a staging directory, then let the user inspect and move.

Output resource:

- `restore-result`

Fields:

- `snapshotId`
- `targetDir`
- `filesRestored`
- `bytesRestored`
- `message`

### `forget`

Apply retention policy without pruning by default.

Output resource:

- `forget-result`

Fields:

- `policy`
- `snapshotsRemoved`
- `dryRun`

### `prune`

Run `restic prune`. Keep this separate from `forget` because prune performs
repository cleanup and can be expensive.

Output resource:

- `prune-result`

Fields:

- `bytesFreed`
- `packsRemoved`
- `durationMs`

## Reports

A report extension would be useful but does not need to be in the first cut.

Useful future report:

```text
@atalanta/restic-backup/backup-health
```

Report answers:

- When was `.swamp/` last backed up?
- Is the latest backup older than the configured threshold?
- Which paths are protected?
- Which paths are excluded?
- How many snapshots exist?
- Did the last `check` pass?

This fits swamp's report concept: reusable analysis of model output that
persists as data. Source: `concept-report`, citing `design/reports.md`.

## Example User Flow

```bash
swamp extension pull @atalanta/restic-backup

swamp model create @atalanta/restic-backup/repository swamp-restic \
  --global-arg repository=b2:my-bucket:swamp/my-repo \
  --global-arg passwordEnv=RESTIC_PASSWORD

swamp model method run swamp-restic check_restic
swamp model method run swamp-restic init
swamp model method run swamp-restic backup
swamp model method run swamp-restic snapshots
swamp model method run swamp-restic check
```

Restore should be explicit:

```bash
swamp model method run swamp-restic restore \
  --input snapshotId=latest \
  --input targetDir=/tmp/swamp-restore
```

## Documentation Use Case

Primary doc:

```text
Back up your .swamp directory
```

Opening explanation:

> Git protects your swamp definitions. Restic protects the runtime evidence that
> swamp writes under `.swamp/`.

Suggested tutorial outline:

1. Install restic.
2. Create a restic repository in Backblaze B2, S3-compatible storage or a local
   path.
3. Set `RESTIC_PASSWORD`.
4. Create the swamp backup model.
5. Run `backup`.
6. Query `backup-result`.
7. List snapshots.
8. Restore to `/tmp/swamp-restore`.

## Security Notes

- Never persist restic passwords in model YAML or swamp data.
- Prefer `RESTIC_PASSWORD`, `RESTIC_PASSWORD_FILE`, or a swamp vault reference
  resolved at runtime.
- Warn if backing up `.swamp/secrets`; users may want it, but it should be
  explicit.
- Restic repositories are encrypted, but credentials and repository URLs still
  need careful handling.
- Restore should be staged, not destructive by default.

## Implementation Notes

Use restic's JSON output modes wherever available and map them into structured
swamp resources. Do not scrape human output unless restic lacks JSON for a
specific command.

Use one method per purpose. Avoid a single "run arbitrary restic command" method
for the core API.

If the implementation shells out to the restic binary, treat restic as the
external system being modelled. This is acceptable for a model extension because
the extension is not wrapping a cloud provider directly as an ad-hoc shell
integration; it is providing a typed model over a mature backup tool.

Pin npm dependencies explicitly if any are used. Swamp extension dependencies
are bundled, not lockfile-tracked. Source: `concept-extension`, citing
`CLAUDE.md (rule 7)`.

## Validation and Tests

Suggested test coverage:

- Missing restic binary produces structured `available: false`.
- Default include/exclude set is correct.
- Password is never emitted in outputs.
- `backup` writes a structured `backup-result`.
- `snapshots` parses JSON into stable fields.
- `restore` refuses unsafe target without confirmation.
- `forget` dry-run does not prune.

Integration tests can use a temporary local restic repository first. Remote
backend tests should be optional and environment-gated.

## Open Questions

- Should `.swamp/secrets` be included by default, excluded by default, or require
  an explicit opt-in?
- Should the model default to the current repo or require `repoDir` explicitly?
- Should `forget` and `prune` be separate methods or one method with a
  `prune=true` input?
- Should the extension ship a workflow for "backup then check"?
- Should there be a report in v1, or should the first release only provide
  model methods?
- Should there be a helper skill that tells agents when to suggest this backup
  model for a repo?

## Sources

- `concept-datastore` in `swamp-internals`, citing `design/datastores.md:1-27`.
- `decision-source-runtime-split` in `swamp-internals`, citing
  `design/datastores.md`.
- `decision-knowledge-substrate` in `swamp-internals`, citing
  `design/high-level.md`.
- `concept-data` in `swamp-internals`, citing `design/models.md:392-453`.
- `concept-model` in `swamp-internals`, citing `design/models.md`.
- `concept-method` in `swamp-internals`, citing
  `src/domain/models/model.ts:583-613`.
- `concept-extension` in `swamp-internals`, citing
  `src/domain/models/model.ts:741-1095` and `CLAUDE.md (rule 7)`.
- `concept-report` in `swamp-internals`, citing `design/reports.md`.
- Restic repository/backend documentation:
  `https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html`.
