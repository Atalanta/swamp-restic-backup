# Split the single-file model into modules with enforced boundaries

GitHub issue: #9

## What

Split the single `extensions/models/restic_backup.ts` file into separate
TypeScript modules whose boundaries are enforced by the import graph, so that
the model's distinct concerns can no longer reach into each other freely.

## Why

The whole `@atalanta/restic-backup/repository` model is implemented in one file
(~1599 lines). Its distinct concerns — argument/result schemas, secret handling,
the restic subprocess invoker, restore path-safety, the include/exclude policy,
and the eight methods that compose them — are separated only by comments, not by
module boundaries. Because they share one module scope, any region can call any
other, and the safety properties the extension relies on (secret values never
reaching argv; restore refusing dangerous targets; only the curated
include/exclude set being used) are conventional, not structural: same-file code
can bypass them. This is recorded as `finding-single-file-god-module` (severity
high) in the applied `restic-backup-review` audit KB, and is verifiable directly
from the file's size and its mixed responsibilities.

## Dependency status

This ticket is planned and executed against the **current** repository state. It
assumes nothing about, and requires nothing from, the sibling hardening tickets
(#4 secrets, #5 restore safety, #6 effect injection). Those tickets are future
*consumers* of the boundaries this refactor introduces, not prerequisites for it.
This work must not pull their behaviour changes in.

## Done

- Each concern lives in its own module; a concern's internals are not importable
  from outside its owning module. Specifically, after the split:
  - subprocess spawning (the code that constructs and runs the restic process)
    is reachable only from within the invoker module — no other module can spawn
    restic directly;
  - the resolved secret values are reachable only within the secret module — no
    other module can read a secret except through whatever that module exposes;
  - the default include/exclude paths are defined in, and readable only from, the
    policy module.
- The extension loads: `swamp doctor extensions` passes and
  `swamp model type search @atalanta/restic-backup/repository` finds the type.
- The existing test suite passes unchanged (`npm test`), and no test assertion is
  weakened to accommodate the move.

## Constraints

- No behaviour change. This is a structural refactor only: the public model type,
  its methods, their arguments, and their output resources (names, spec shapes)
  are all unchanged. The demo boundary is limited to "extension still loads, type
  still discoverable, existing tests still pass" — not new functionality.
- Respect the existing invariants unchanged: secrets never in argv/logs/results/
  backup; restore staged and refusing dangerous targets; `_catalog.db` and bundle
  caches excluded from the backup set.
- Do not prescribe the exact module names, file layout, export lists, or internal
  type shapes here — those are for the plan. This ticket fixes the required
  ownership boundaries, not the design that realises them.
