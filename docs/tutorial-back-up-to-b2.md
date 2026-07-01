# Back up a swamp repo to Backblaze B2

In this tutorial we will create an encrypted restic backup of a swamp repo's
`.swamp/` directory in Backblaze B2, then list the snapshot and verify it. We
will store three secrets in a vault, configure a backup model, and run it.

Before we start, you need:

- `restic` on your `PATH`
- A Backblaze B2 bucket and an application key for it (an Application Key ID and
  an Application Key)
- swamp, with the extension pulled:

  ```
  swamp extension pull @atalanta/restic-backup
  ```

## Step 1: Create a vault

We store credentials in a vault, never in model files. Create one:

```
swamp vault create local_encryption swamp-backup
```

## Step 2: Store the three secrets

Store the two B2 credentials. Each command prompts you to paste the value:

```
swamp vault put swamp-backup B2_ACCOUNT_ID
swamp vault put swamp-backup B2_ACCOUNT_KEY
```

Now store a restic encryption password. Type a strong passphrase when prompted.
restic cannot recover this passphrase if you lose it, so keep a copy somewhere
safe before continuing:

```
swamp vault put swamp-backup RESTIC_PASSWORD
```

Check that all three are stored:

```
swamp vault list-keys swamp-backup --json
```

We see the three keys, never their values:

```json
{
  "vaultName": "swamp-backup",
  "vaultType": "local_encryption",
  "secretKeys": [
    "B2_ACCOUNT_ID",
    "B2_ACCOUNT_KEY",
    "RESTIC_PASSWORD"
  ],
  "count": 3
}
```

## Step 3: Create and configure the model

Create a backup model instance:

```
swamp model create @atalanta/restic-backup/repository my-backup
```

Open the instance file the command reports, and set its `globalArguments`.
Replace `<bucket>` with your bucket name and `<path>` with a prefix inside it:

```yaml
globalArguments:
  repository: "b2:<bucket>:<path>"
  hostTag: "my-backup"
  resticPassword: "${{ vault.get('swamp-backup', 'RESTIC_PASSWORD') }}"
  b2AccountId: "${{ vault.get('swamp-backup', 'B2_ACCOUNT_ID') }}"
  b2AccountKey: "${{ vault.get('swamp-backup', 'B2_ACCOUNT_KEY') }}"
```

The `vault.get(...)` references are resolved when the model runs. To understand
how, see [About secrets and the vault](explanation/about-secrets-and-the-vault.md).

## Step 4: Confirm restic is available

```
swamp model @atalanta/restic-backup/repository method run checkRestic my-backup
```

`checkRestic` writes its result to the data record named `current`. Read it:

```
swamp data get my-backup current --json
```

The result payload sits under `content`:

```json
{
  "name": "current",
  "content": {
    "available": true,
    "version": "0.18.1",
    "binary": "restic",
    "message": "restic 0.18.1 detected; --json output confirmed"
  }
}
```

We see `content.available` is `true`. If it is `false`, install restic or set
`resticPath` in `globalArguments` to the binary's full path.

## Step 5: Initialize the repository

```
swamp model @atalanta/restic-backup/repository method run init my-backup
swamp data get my-backup current --json
```

The first run reports `created: true`:

```json
{
  "name": "current",
  "content": {
    "repository": "b2:<bucket>:<path>",
    "initialized": true,
    "created": true,
    "message": "Repository created at b2:<bucket>:<path>"
  }
}
```

Run `init` again and it reports `created: false` — it is safe to run more than
once.

## Step 6: Run the backup

```
swamp model @atalanta/restic-backup/repository method run backup my-backup --json
```

Unlike the earlier methods, `backup` writes to a record named after the snapshot
(`backup-<snapshot id prefix>`), not `current`. The method output reports the
record it wrote under `dataArtifacts`:

```json
{
  "status": "succeeded",
  "dataArtifacts": [{ "name": "backup-8da3bc6f9a08" }]
}
```

Read that record — substitute the name from your own output:

```
swamp data get my-backup backup-8da3bc6f9a08 --json
```

```json
{
  "content": {
    "snapshotId": "8da3bc6f9a08...",
    "fileCount": 1881,
    "includedPaths": [
      ".swamp/data",
      ".swamp/outputs",
      ".swamp/workflow-runs",
      ".swamp/definitions-evaluated",
      ".swamp/workflows-evaluated"
    ]
  }
}
```

Notice that `.swamp/secrets`, `.swamp/logs`, and the bundle caches are not in
`includedPaths`. The default policy leaves them out — see
[Reference: include and exclude defaults](reference.md#include-and-exclude-defaults).

## Step 7: List the snapshots

```
swamp model @atalanta/restic-backup/repository method run snapshots my-backup
swamp data get my-backup current --json
```

`snapshots` writes to `current`. The count and `latestSnapshotId` are under
`content`:

```json
{
  "name": "current",
  "content": {
    "count": 1,
    "latestSnapshotId": "8da3bc6f9a08..."
  }
}
```

## Step 8: Verify the repository

```
swamp model @atalanta/restic-backup/repository method run check my-backup --json
```

Like `backup`, `check` writes a dated record (`check-<YYYY-MM-DD>`) named in the
method output. Read it:

```
swamp data get my-backup check-2026-07-01 --json
```

```json
{
  "content": {
    "ok": true,
    "errors": [],
    "warnings": []
  }
}
```

`content.ok` is `true` with no errors.

We have created an encrypted restic repository in B2, backed up the repo's
`.swamp/` directory to it, listed the snapshots, and confirmed the repository
passes an integrity check.
