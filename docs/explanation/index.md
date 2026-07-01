# Explanation

Background and discussion of why `@atalanta/restic-backup` exists and how it
works. These pages are for reading away from the keyboard, when you want to
understand the reasoning rather than run a command.

[About protecting your swamp repo's evidence](about-protecting-runtime-evidence.md)
— read this to understand what runtime evidence the extension protects, why git
doesn't already protect it, why backup is a model rather than a datastore, and
why restore is deliberately careful.

[About how secrets flow through the vault](about-secrets-and-the-vault.md) —
read this to understand the two distinct secrets a B2 backup needs, how swamp
resolves them at runtime and the model passes them transiently to restic, and
why that keeps credentials out of the backup.
