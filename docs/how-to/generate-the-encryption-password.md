# How to generate the restic encryption password

restic encrypts every repository with a password, read from `RESTIC_PASSWORD`.
Rather than typing a passphrase, generate a cryptographically strong random
value and store it in the vault the model reads. Do this once, before you
initialise a new repository.

restic cannot recover this password if you lose it. Keep a copy somewhere safe
(a password manager) before you back up anything to the repository.

## Generate and store the password

Store the value under the same vault and key the model reads —
`swamp-backup` / `RESTIC_PASSWORD` in these docs. Use an input path that does
not expose the value: the no-echo prompt for interactive use, or stdin for a
script. Never pass the value as an inline `KEY=VALUE` argument — that leaks it
into your shell history and the process list.

For a script or one-liner, pipe a strong random value straight into the vault
so it never appears on screen or in history:

```
openssl rand -base64 48 | swamp vault put swamp-backup RESTIC_PASSWORD
```

`openssl rand` draws from a cryptographically secure generator; `/dev/urandom`
works too:

```
head -c 32 /dev/urandom | base64 | swamp vault put swamp-backup RESTIC_PASSWORD
```

If you would rather paste a value you generated elsewhere, run `swamp vault put`
with no value and it prompts without echoing:

```
swamp vault put swamp-backup RESTIC_PASSWORD
```

Confirm the key is stored (the value is never shown):

```
swamp vault list-keys swamp-backup --json
```

## Wire it to the model

The model reads the password through a `vault.get` reference, so no value ever
appears in the model definition:

```
resticPassword: "${{ vault.get('swamp-backup', 'RESTIC_PASSWORD') }}"
```

swamp resolves this to `RESTIC_PASSWORD` at run time. With the key stored, the
model can now initialise and back up a repository.

## Keep the value out of everything else

The password belongs only in the vault. It must never be written into the model
definition YAML, swamp data, logs, or a backup. Generating it locally and piping
it straight into `swamp vault put` keeps it on the path from your generator to
the vault backend and nowhere else — which is why the inline `KEY=VALUE` form is
off limits.

To change the password on a repository that already exists, see
[How to replace a credential](replace-a-credential.md) — a new password does not
open an existing restic repository. For how secrets flow from the vault into
restic, see
[About how secrets flow through the vault](../explanation/about-secrets-and-the-vault.md).
