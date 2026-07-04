# About how secrets flow through the vault

A B2 backup needs two distinct secrets. The restic encryption password encrypts
the repository's contents. The B2 account credentials let restic authenticate to
the bucket. One protects the data, the other identifies you to Backblaze. They
are not interchangeable: losing the encryption password loses the data
permanently, whereas rotating a B2 key is routine. The extension treats them as
three separate values.

Configure the three secret fields as `vault.get(...)` CEL expressions, not
literal values. swamp resolves them when the model runs and passes the model the
resolved strings. A vault is a named, typed port over a secret manager. Behind
it can sit a local-encrypted store, AWS Secrets Manager, 1Password, or a custom
backend; the model only sees the resolved string, so swapping the backend
changes nothing in the model.

Where resolution happens keeps plaintext out of persisted state. `vault.get` is
a receiver on swamp's CEL surface, and extension authors get a sandboxed version
of that surface with no access to swamp internals. The expression stays raw in
the persisted evaluated definition and resolves only at runtime. Plaintext
secret values are never written to model definitions, swamp data, logs, git, or
the backup. The model holds each resolved credential only as a transient string
and injects it into the restic subprocess environment.

A local encrypted vault backend keeps its own encrypted key material under
`.swamp/secrets`. The default backup excludes that path, so vault material is
never copied into the remote backup.

The encryption password is swamp's to mint: generate a strong random value and
store it with `swamp vault put`, or choose your own. Either way the value goes
only into the vault, never the model definition — see
[How to generate the restic encryption password](../how-to/generate-the-encryption-password.md).
This respects the two-secret split: the encryption password is swamp's to
generate, but the B2 credentials are not — they belong to your Backblaze
account, so you always supply those yourself.
