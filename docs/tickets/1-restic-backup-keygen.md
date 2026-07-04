# RESTIC-BACKUP-KEYGEN — generate/hold the restic encryption password in a vault

GitHub issue: #1

## What

Make it ergonomic to obtain the restic **encryption password**
(`RESTIC_PASSWORD`) without hand-crafting a secret: generate a
cryptographically strong random value and store it in a named swamp vault, so
the model's existing `resticPassword = vault.get(...)` reference resolves it.
This is a convenience layer over the existing vault-backed secret model — it
does not change how secrets are consumed.

## Decision: documentation, not an extension method

The issue's open design question offered three forms for the generator: (1) an
extension method, (2) a helper skill scripting `swamp vault put`, or (3)
documentation of the one-time step. Option (3) is chosen, forced by a runtime
constraint established by investigation (see Evidence): **a model method cannot
write to a vault.** Options (1) and (2) are therefore either impossible within
the stated security boundary or a rule-1 violation:

- **(1) Extension method — infeasible within the security boundary.** The swamp
  runtime injects a `MethodContext` exposing only `globalArgs`, `logger`,
  `writeResource`, `readResource` — no vault-write port. The extension-author
  CEL surface registers `data.latest`, `file.contents`, `vault.get` — read
  receivers only; no `vault.put`. Vault `get` expressions are resolved into
  `globalArgs` *before* `execute` runs, so a method has no write path. The only
  sinks a method controls are a data record (`writeResource`) or its logs —
  both of which the issue explicitly forbids for the secret value ("must never
  land in model YAML, swamp data, logs, or a backup"). Building the method would
  require shelling out to the `swamp vault put` CLI from inside `execute`, which
  the repo's rule 1 reserves for one-off ad-hoc commands, never for wrapping the
  CLI.
- **(2) Helper skill — same shell-out, thinner ergonomics.** A skill that pipes
  `openssl rand` into `swamp vault put` is the same one-time CLI operation with
  no durable benefit over documenting it, and it normalises wrapping the CLI.
- **(3) Documentation — correct.** swamp legitimately owns only the *read* path
  for this secret (`vault.get`). Generating a strong value and storing it is a
  one-time operator step the `swamp vault put` CLI already serves. Documenting
  it (a) is the issue's stated lowest-risk default, (b) keeps the secret out of
  YAML/data/logs/backups by construction (the value only ever transits stdin →
  vault backend), and (c) adds no model surface, no code, no new dependency.

## Why

Operators currently have no guidance on producing the `RESTIC_PASSWORD` the
model requires; the schema docstring says it "MUST be a `vault.get(...)`
expression" but nothing tells the operator how to populate that vault key with a
strong value, safely. A short how-to closes that gap without inventing a code
path that cannot satisfy the security invariant.

## Scope

In scope (docs only):

- A how-to (in `docs/` and/or the extension README) covering the one-time step:
  generate a cryptographically strong random value and store it under the vault
  key the model reads, using `swamp vault put <vault> <key>` with the value
  supplied by a non-leaking input path — either **stdin** (the scriptable form,
  `… | swamp vault put <vault> <key>`) or the **interactive prompt** (`swamp
  vault put <vault> <key>` with no value, which reads without echo). Never the
  inline `KEY=VALUE` argument form, which the vault guide flags as insecure and
  which leaks into shell history / process args.
- A worked example wiring the stored key to the model's
  `resticPassword = vault.get('<vault>','<key>')` reference.
- An explicit security note: the value must never be placed in model YAML,
  swamp data, logs, or a backup; it is generated locally, piped to the vault
  backend, and never echoed. Recommend a generator whose output does not persist
  to shell history.

Out of scope:

- Any production/`_lib`/model-surface change, and any new method (a keygen
  method is infeasible per the Evidence — a method cannot write a vault).
- Minting B2 (or any cloud) account credentials — an explicit non-goal in the
  issue; those keys stay user-provided.
- Changing how secrets are consumed (`vault.get` resolution is unchanged).

## Evidence (why a method cannot write a vault)

- `extensions/models/_lib/method-context.ts` — the injected `MethodContext`
  exposes `globalArgs`, `logger`, `writeResource`, `readResource`; no vault
  port.
- swamp-kb `concept-cel` (source `design/expressions.md`): the registered CEL
  domain receivers are `data.latest`, `file.contents`, `vault.get` — no
  `vault.put`; the extension-author CEL surface is "sandboxed, no swamp
  internals".
- swamp-kb `concept-vault` (source `design/vaults.md`): secrets "are never
  persisted to the datastore"; vault expressions are resolved only at runtime.
- `swamp help vault`: `vault put` exists only as a CLI verb.
- No precedent: zero examples of a method writing a vault across the extension
  or the KB.

## Done

- A how-to documents generating a strong random `RESTIC_PASSWORD` and storing it
  via `swamp vault put <vault> <key>` from stdin, plus wiring it to
  `resticPassword = vault.get(...)`.
- The doc states the security invariant (value never in YAML/data/logs/backup)
  and the no-inline-argument rule (use stdin or the no-echo interactive prompt,
  never `KEY=VALUE`), with rationale.
- No production, `_lib`, model-surface, or dependency change; the only files
  touched are documentation.

## Constraints

- Do not implement a keygen method or a CLI-wrapping skill (infeasible / rule-1
  violation per Evidence).
- Do not have swamp mint cloud account credentials.
- The secret value must never land in model YAML, swamp data, logs, or a backup.
