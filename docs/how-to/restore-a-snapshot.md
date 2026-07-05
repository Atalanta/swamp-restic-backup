# How to restore a snapshot

Restore to a fresh staging directory, never over your live `.swamp/`. Replace
`my-backup` with your instance name.

Pick a target outside the repo and restore the latest snapshot:

```
swamp model @atalanta/restic-backup/repository method run restore my-backup \
  --input snapshot=latest --input targetDir=/tmp/swamp-restore --json
```

`restore` writes its result to the stable record `restore-latest`. Read the
latest for the counts:

```
swamp data get my-backup restore-latest --json
```

`content.filesRestored` and `content.bytesRestored` report what was written.
Inspect `/tmp/swamp-restore` and copy back what you need.

To restore an older snapshot, pass its full `id` (from the `snapshots` method)
instead of `latest`:

```
swamp model @atalanta/restic-backup/repository method run restore my-backup \
  --input snapshot=107d25e3323b755de9a23296afcaa1daf3647c4503ddcafa63761f81da25fa56 \
  --input targetDir=/tmp/swamp-restore
```

The model refuses a `targetDir` that is the repo root, is `.swamp/`, is an
ancestor of the live `.swamp/`, or is inside the live `.swamp/`, unless you pass
`--input confirm=true`. Set it only when you have accepted that the restore may
overwrite live runtime data. For why this is restricted, see
[About protecting your swamp repo's evidence](../explanation/about-protecting-runtime-evidence.md).
