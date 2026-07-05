# Reference

Technical description of the `@atalanta/restic-backup/repository` model: its
configuration, methods, and output resources.

## Configuration (globalArguments)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `repository` | string | — (required) | Restic repository URL, e.g. `b2:bucket-name:path/prefix`. |
| `repoDir` | string | `.` | Local repo root directory. |
| `include` | string[] | `[]` | Paths added to the default include set. |
| `exclude` | string[] | `[]` | Patterns added to the default exclude set. |
| `hostTag` | string | — | Host tag applied to snapshots. When unset, a snapshot's `host` is the empty string. |
| `extraTags` | string[] | `[]` | Additional tags applied to snapshots. |
| `retention` | object | `{}` | Retention policy for `forget`: `keepLast`, `keepDaily`, `keepWeekly`, `keepMonthly` (each an optional number). |
| `resticPath` | string | `restic` | Path to the restic binary. |
| `resticPassword` | string | — (required) | A `vault.get('vault-name','key')` CEL expression. Resolved to `RESTIC_PASSWORD` at runtime. |
| `b2AccountId` | string | — (required) | A `vault.get('vault-name','key')` CEL expression. Resolved to `B2_ACCOUNT_ID` at runtime. |
| `b2AccountKey` | string | — (required) | A `vault.get('vault-name','key')` CEL expression. Resolved to `B2_ACCOUNT_KEY` at runtime. |

The three secret fields take `vault.get(...)` expressions in `${{ }}` delimiters.
See [About secrets and the vault](explanation/about-secrets-and-the-vault.md).

`include` and `exclude` are additive. Their values append to the default sets
below; they cannot remove a default entry.

## Include and exclude defaults

Included by default:

```
.swamp/data
.swamp/outputs
.swamp/workflow-runs
.swamp/definitions-evaluated
.swamp/workflows-evaluated
```

Excluded by default:

```
.swamp/data/_catalog.db
.swamp/bundles
.swamp/datastore-bundles
.swamp/driver-bundles
.swamp/report-bundles
.swamp/vault-bundles
.swamp/telemetry
.swamp/logs
.swamp/secrets
```

## Output resources

Each method writes a versioned data record under a **stable, method-specific
name**. Re-running a method adds a new version of that record; older versions
remain until garbage-collected. `backup` additionally writes a
snapshot-id-addressed record so a specific historical snapshot can be fetched by
id.

| Method | Spec | Data record name | Lifetime | GC versions |
| --- | --- | --- | --- | --- |
| `checkRestic` | `resticStatus` | `restic-status` | 7d | 5 |
| `init` | `repositoryStatus` | `repository-status` | infinite | 10 |
| `backup` | `backupResult` | `backup-latest` (+ `backup-<snapshotId[:12]>`) | 90d | 100 |
| `snapshots` | `snapshots` | `snapshots-latest` | 7d | 20 |
| `check` | `checkResult` | `check-latest` | 30d | 30 |
| `restore` | `restoreResult` | `restore-latest` | 30d | 20 |
| `forget` | `forgetResult` | `forget-latest` | 90d | 50 |
| `prune` | `pruneResult` | `prune-latest` | 90d | 50 |

## Reading a result

Read the latest result of a method by its stable name — this returns the most
recent version:

```
swamp data get <instance> <record-name> --json
```

For example, the latest backup and integrity-check results:

```
swamp data get my-backup backup-latest --json
swamp data get my-backup check-latest --json
```

To read a specific historical backup by snapshot id, use the id-addressed
record:

```
swamp data get my-backup backup-<snapshotId[:12]> --json
```

In a CEL expression, `data.latest("<instance>", "<record-name>")` resolves the
same latest version. Earlier versions are reachable with
`swamp data versions <instance> <record-name> --json`.

Records written by an earlier version of this extension under the old names
(`current`, `check-<date>`, `forget-<timestamp>`, and so on) are not migrated;
they remain until they age out under garbage collection. New runs write only the
stable names above.

## Methods

Method invocation syntax:

```
swamp model @atalanta/restic-backup/repository method run <method> <instance>
```

### checkRestic

Inputs: none. Uses no secrets.

Spec `resticStatus`:

| Field | Type | Optional |
| --- | --- | --- |
| `available` | boolean | |
| `version` | string | yes |
| `binary` | string | yes |
| `message` | string | |

### init

Inputs: none. Idempotent.

Spec `repositoryStatus`:

| Field | Type |
| --- | --- |
| `repository` | string |
| `initialized` | boolean |
| `created` | boolean |
| `message` | string |

### backup

| Input | Type | Default |
| --- | --- | --- |
| `tags` | string[] | `[]` |

Spec `backupResult`:

| Field | Type |
| --- | --- |
| `snapshotId` | string |
| `repository` | string |
| `startedAt` | string |
| `completedAt` | string |
| `durationMs` | number |
| `includedPaths` | string[] |
| `excludedPatterns` | string[] |
| `fileCount` | number |
| `byteCount` | number |
| `tags` | string[] |
| `host` | string |

### snapshots

| Input | Type | Default |
| --- | --- | --- |
| `host` | string | — |
| `tags` | string[] | `[]` |
| `path` | string | — |

Spec `snapshots`:

| Field | Type | Optional |
| --- | --- | --- |
| `snapshots` | object[] | |
| `latestSnapshotId` | string | yes |
| `latestTime` | string | yes |
| `count` | number | |

Each `snapshots[]` entry: `id`, `shortId`, `time`, `hostname`, `paths`
(string[]), `tags` (string[]), `username`.

### check

Inputs: none. Runs `restic check` without `--read-data`: it verifies repository
structure and metadata, not the content of every data blob.

Spec `checkResult`:

| Field | Type |
| --- | --- |
| `ok` | boolean |
| `errors` | string[] |
| `warnings` | string[] |
| `checkedAt` | string |

### restore

| Input | Type | Default |
| --- | --- | --- |
| `snapshot` | string | `latest` |
| `targetDir` | string | — (required) |
| `confirm` | boolean | `false` |

Without `confirm: true`, `restore` refuses a `targetDir` that is the repo root,
is `.swamp/`, is an ancestor of the live `.swamp/`, or resolves to a path inside
the live `.swamp/`. Spec `restoreResult`:

| Field | Type |
| --- | --- |
| `snapshotId` | string |
| `targetDir` | string |
| `filesRestored` | number |
| `bytesRestored` | number |
| `message` | string |

### forget

| Input | Type | Default |
| --- | --- | --- |
| `keepLast` | number | — |
| `keepDaily` | number | — |
| `keepWeekly` | number | — |
| `keepMonthly` | number | — |
| `dryRun` | boolean | `false` |
| `host` | string | — |

`forget` removes snapshot references only; it does not prune. Spec
`forgetResult`:

| Field | Type |
| --- | --- |
| `policy.keepLast` | number (optional) |
| `policy.keepDaily` | number (optional) |
| `policy.keepWeekly` | number (optional) |
| `policy.keepMonthly` | number (optional) |
| `snapshotsRemoved` | number |
| `dryRun` | boolean |

### prune

Inputs: none. Reclaims storage; separate from `forget`.

Spec `pruneResult`:

| Field | Type |
| --- | --- |
| `durationMs` | number |
| `rawOutput` | string |

restic emits no JSON for `prune`, so `pruneResult` carries the raw restic output
rather than parsed fields.
