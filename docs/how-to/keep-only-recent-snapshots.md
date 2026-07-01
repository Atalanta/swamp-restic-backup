# How to keep only recent snapshots

To stop a repository growing without bound, apply a retention policy with
`forget`, then reclaim the space with `prune`. Replace `my-backup` with your
instance name.

First, check what would be removed without removing anything:

```
swamp model @atalanta/restic-backup/repository method run forget my-backup \
  --input keepLast=7 --input dryRun=true --json
```

`forget` writes a timestamped record (`forget-<timestamp>`) named in the method
output under `dataArtifacts`. Read that record:

```
swamp data get my-backup forget-<timestamp> --json
```

Confirm `content.snapshotsRemoved` matches your expectation. If the dry run
removes the
expected snapshots, run `forget` without `dryRun`:

```
swamp model @atalanta/restic-backup/repository method run forget my-backup \
  --input keepLast=7
```

`forget` only removes snapshot references; the data still occupies storage. To
reclaim it, run `prune`:

```
swamp model @atalanta/restic-backup/repository method run prune my-backup
```

`prune` rewrites the repository and can be slow on large repositories. Run it
during a maintenance window after retention runs, not after every `forget`.

For the retention fields, see [Reference: forget](../reference.md#forget).
