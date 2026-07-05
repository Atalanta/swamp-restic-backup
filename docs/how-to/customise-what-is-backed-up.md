# How to customise what is backed up

The default policy covers the runtime evidence under `.swamp/`. To adjust it, add
to the `include` and `exclude` arrays in your instance's `globalArguments`. Both
merge with the defaults.

To protect additional paths, add them to `include`:

```yaml
include:
  - .swamp/audit
```

To leave more out, add restic exclude patterns to `exclude`:

```yaml
exclude:
  - .swamp/data/large-cache
```

Run a `backup` and read `includedPaths` and `excludedPatterns` to confirm the
effective set:

```
swamp model @atalanta/restic-backup/repository method run backup my-backup --json
```

`backup` writes its result to the stable record `backup-latest` (and a copy
addressed by snapshot id, `backup-<snapshot id prefix>`). Read the latest and
check `content.includedPaths` and `content.excludedPatterns`:

```
swamp data get my-backup backup-latest --json
```

For the default sets these merge with, see
[Reference: include and exclude defaults](../reference.md#include-and-exclude-defaults).
