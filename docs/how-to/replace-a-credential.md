# How to replace a credential

To rotate a B2 application key, overwrite the affected secrets in the vault. A
new B2 key usually has both a new key ID and a new key, so update both:

```
swamp vault put swamp-backup B2_ACCOUNT_ID
swamp vault put swamp-backup B2_ACCOUNT_KEY
```

If only the key changed and the ID is unchanged, you can update `B2_ACCOUNT_KEY`
alone. The model resolves the new values on its next run, with no config change.

Verify the new credential works with a non-destructive method:

```
swamp model @atalanta/restic-backup/repository method run snapshots my-backup
swamp data get my-backup snapshots-latest --json
```

`snapshots` writes to `snapshots-latest`. A non-empty `content.snapshots` list
confirms restic authenticated to B2 with the new credential.

Changing `RESTIC_PASSWORD` is different. restic encrypts each repository with
its password, so a new password does not open an existing repository. Set it
only for a new repository — see
[How to generate the restic encryption password](generate-the-encryption-password.md)
— or follow restic's own key-change procedure for an existing one.

For how secrets flow from the vault into restic, see
[About how secrets flow through the vault](../explanation/about-secrets-and-the-vault.md).
