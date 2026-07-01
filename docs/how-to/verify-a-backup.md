# How to check repository integrity

A successful `backup` does not by itself prove the repository is sound. Run
`check` to test the whole repository for integrity errors — it checks the
repository, not one snapshot. Replace `my-backup` with your instance name:

```
swamp model @atalanta/restic-backup/repository method run check my-backup --json
```

`check` writes a dated record (`check-<YYYY-MM-DD>`), named in the method output.
Read it:

```
swamp data get my-backup check-<YYYY-MM-DD> --json
```

`content.ok` must be `true` and `content.errors` must be empty. Treat a non-empty
`errors` list as a repository you cannot rely on for restore.

`check` verifies repository structure and metadata; it does not read every data
blob (restic's `--read-data`). Run it periodically — on a schedule, or before
you depend on a restore.

For the result fields, see [Reference: check](../reference.md#check).
