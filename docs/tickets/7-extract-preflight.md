# Extract the shared method pre-flight

GitHub issue: #7

## What

Extract the repeated per-method preamble — validate secrets, extract secrets,
read `cwd`/`resticPath`/`repository` from globalArgs, and probe restic's `--json`
capability — into one shared step that the operational methods call, so the
sequence is defined once instead of copy-pasted across every method.

## Why

The same prologue is duplicated across the seven secret-bearing operational
methods (`init`, `backup`, `snapshots`, `check`, `restore`, `forget`, `prune`):
each re-implements `validateSecrets` → throw, `extractSecrets`, read three
globalArgs fields, `probeResticCapability` → throw. A change to the pre-flight
sequence must be applied in seven places, and a newly-added method can silently
omit a step (e.g. skip the secret check or the probe). Recorded as
`finding-method-prologue-duplicated` (confirmed) in the applied
`restic-backup-review` audit KB.

`checkRestic` is a deliberate exception: it runs the capability probe *without*
secrets (it must work when no vault is configured) and has its own probe-failure
handling. The shared step must not force secrets on that path.

## Scope

In scope: the secret-bearing prologue shared by all seven operational methods —
`init`, `backup`, `snapshots`, `check`, `restore`, `forget`, `prune` — i.e. the
validate → extract → read-args → probe sequence and the two failure branches it
owns (missing/invalid secrets; restic without `--json` support).

Out of scope: `checkRestic`'s reduced no-secret probe path is left as-is unless
the shared step can accommodate it without changing its observable behaviour.
Method bodies *after* the prologue (the per-method restic invocation and result
mapping) are unchanged.

## Done

- The validate → extract → read-args → probe pre-flight is defined in exactly
  one place; each of the seven secret-bearing operational methods obtains its
  `secrets`/`cwd`/`resticPath`/`repository` from that step rather than
  re-implementing the sequence.
- Adding a new secret-bearing operational method that calls the shared step gets
  the full pre-flight; a method that forgets to call it is visibly missing the
  prologue rather than partially duplicating it. (This ticket requires the
  behaviour, not a specific enforcement mechanism.)
- The observable behaviour of every method is unchanged: on well-formed input
  the same restic calls run with the same arguments; the failure messages for
  missing/invalid secrets (`Secret validation failed before calling restic: …`)
  and for restic without `--json` (`restic does not support --json: …`, with
  `probe.message` redacted) are byte-identical to today.
- `checkRestic` still runs its probe without requiring secrets and keeps its
  current failure behaviour.
- Acceptance is proven through the real method entrypoints, not internal unit
  tests alone: at least one representative secret-bearing method is exercised via
  `model.methods.<name>.execute(...)` to show the missing-secrets and
  `--json`-unsupported failures still fire with the same messages, and the
  existing suite (which drives methods through `execute`) stays green.

## Constraints

- Secret-hygiene is unchanged: secrets are still validated before any restic
  call, still injected only into the subprocess env, and probe-failure messages
  are still passed through `redactSecrets`.
- Secrets are still validated before restic runs in every secret-bearing method;
  the refactor must not create a path where an operational restic call with
  secrets runs without having gone through validate → extract → probe.
- No public change: the model type, method names, argument schemas, and
  result-resource shapes are identical. `_catalog.db`/bundles exclusion, staged
  restore, and the no-human-text-parser invariant are untouched.
