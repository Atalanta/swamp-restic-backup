# About protecting your swamp repo's evidence

swamp's data layer is a versioned evidence store. Every method run writes
immutable `DataRecord`s with provenance, indexed for query, so the datastore
holds the history of what a repo actually did. The default datastore backend is
the local filesystem under `{repo}/.swamp/`.

swamp splits a repo in two. Definitions — models, workflows, vaults — are source:
humans write them and git tracks them. Runtime data — the records, workflow
runs, outputs, and audit logs that automation produces — lives in the datastore
and is not tracked in git. The split is deliberate: source belongs in source
control, machine output does not, and keeping them apart lets the datastore
backend change without touching definitions.

With the default local filesystem datastore, git does not protect that runtime
data. Clone a repo elsewhere and you get the definitions but none of the
history — it was never in git. It exists only on the disk that produced it, so a
disk failure, a lost laptop, or a new machine destroys it. For local
experimentation that history is often the most valuable runtime evidence in the
repo. (swamp also offers pluggable and syncing datastore backends; this
extension addresses the default local case.)

This extension backs up a selected subset of that data. It is a model, not a
datastore. A datastore is a live store swamp coordinates against while running;
backup is a point-in-time copy of what the datastore already holds. Modelling
backup as a datastore would conflate the two, so the extension instead
represents one restic backup configuration and exposes methods over it. It is
not a datastore, not a multi-writer coordination layer, and does not make
concurrent agents safe.

It backs up only the records that cannot be regenerated: `.swamp/data`,
`.swamp/outputs`, `.swamp/workflow-runs`, and the evaluated model definitions
and evaluated workflows. It excludes `_catalog.db` — the SQLite
query index, which is repo-local, never synced, and self-healing from the data
tree on cold start. Backing it up is redundant, and restoring a stale catalog
over a newer data tree would corrupt swamp's view of its records. It excludes
bundle caches, telemetry, and logs for the same reason: reconstructable or
low-value.

Restore is deliberately restricted. swamp's data model lets a record be
rewritten only by a model from the definition that wrote it, which is what makes
`data.latest()` a reliable current-state lookup. Restoring over a live `.swamp/`
would break that. So restore requires an explicit target directory and refuses,
without explicit confirmation, to write into the repo root or any directory
containing the live `.swamp/`. Restore to a staging directory and copy back by
hand.

v1 supports Backblaze B2 only. restic supports many backends and the credential
handling is backend-agnostic, so other backends are additive, but B2 is what
this release tests. How credentials reach restic without entering a snapshot is
covered in [About how secrets flow through the vault](about-secrets-and-the-vault.md).
