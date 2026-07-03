# How-to guides

Task-focused guides for working with an existing `@atalanta/restic-backup`
setup. Each assumes a configured model instance. For a first working setup, use
[Back up a swamp repo to Backblaze B2](../tutorial-back-up-to-b2.md).

[How to keep only recent snapshots](keep-only-recent-snapshots.md) applies a
retention policy with `forget` and reclaims storage with `prune`.

[How to restore a snapshot](restore-a-snapshot.md) recovers a snapshot into a
staging directory.

[How to customise what is backed up](customise-what-is-backed-up.md) adds extra
include paths or exclude patterns on top of the defaults.

[How to generate the restic encryption password](generate-the-encryption-password.md)
creates a strong random `RESTIC_PASSWORD` and stores it in the vault, for a new
repository (a setup-time step).

[How to replace a credential](replace-a-credential.md) rotates a B2 key or
changes the restic password through the vault.

[How to check repository integrity](verify-a-backup.md) runs `check` to test the
repository for integrity errors.
