# @atalanta/restic-backup

A swamp model extension that backs up a repo's `.swamp/` runtime evidence to a
Backblaze B2 restic repository. swamp keeps that runtime data out of git; this
extension lets it survive disk failure, laptop loss, and machine moves.

Pull it with `swamp extension pull @atalanta/restic-backup`.

## Documentation

**[Back up a swamp repo to Backblaze B2](docs/tutorial-back-up-to-b2.md)** — a
guided lesson that creates and verifies a backup in B2. Start here; it lists the
prerequisites.

**[How-to guides](docs/how-to/index.md)** — solve a specific task: apply
retention, restore a snapshot, customise what's backed up, rotate a credential,
check repository integrity.

**[Reference](docs/reference.md)** — every configuration field, method, and
output resource.

**[Explanation](docs/explanation/index.md)** — two background discussions: what
runtime evidence the extension protects and how, and how secrets flow through
the vault.
