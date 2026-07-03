# Extract method orchestration out of the entry module

GitHub issue: #10

## What

Move the eight per-method `execute` bodies (argv assembly, decode-and-map,
logging, resource writes) out of the ~813-line `extensions/models/restic_backup.ts`
entry into focused method modules under `extensions/models/_lib/methods/`, and
move the shared `MethodContext` type into a small shared module. The entry
becomes a thin registration shell: imports, public re-exports, model metadata,
the `resources` map, and a `methods` map that references the extracted method
definitions.

## Why

The #9 split moved distinct *concerns* into `_lib/` (secrets, invoker,
path-safety, policy, schemas, preflight), but every method *body* still lives in
the entry — argv building, decode-and-map, logging, and `writeResource` for
`checkRestic`, `init`, `backup`, `snapshots`, `check`, `restore`, `forget`,
`prune` sit side by side in one file. A change to one method, or a new method,
happens in a broad shared module where raw `invokeRestic` calls for every
operation coexist. Recorded as ARCH-2 in the #5 code review and scoped out of #5
as a separate refactor.

## Scope

In scope: relocating the eight method definitions and the `MethodContext` type
into `_lib/`, and rewiring the entry to compose them. The move is
behaviour-preserving — each method's logic, argv, messages, and written
resources are unchanged; only their file location and the wiring change.

Out of scope: changing what any method does; the `invokeRestic` argv contract or
the restore guard (#11 covers the typed-command idea); the `resources` map and
model metadata (these stay in the entry as the registration shell); the `_lib/`
concern modules (secrets, invoker, path-safety, policy, schemas, preflight) —
they are consumed, not moved.

## Done

- Each method's `{ description, arguments, execute }` lives in its own focused
  module under `_lib/methods/` (one module per method), not in the entry.
- `MethodContext` lives in a shared `_lib/` module imported by the method
  modules (and re-used wherever the entry needs it).
- `extensions/models/restic_backup.ts` is a thin shell: imports, public
  re-exports (`model`, `checkRestoreTargetSafety`, `parseResticJsonOutput`,
  `DEFAULT_INCLUDE_PATHS`, `DEFAULT_EXCLUDE_PATTERNS`), model metadata, the
  `resources` map, and a `methods` map wiring the extracted definitions — with
  no `execute` bodies inline.
- No behaviour change: the public model type, method names, argument schemas,
  and result-resource shapes are identical; on well-formed input every method
  runs the same restic calls with the same arguments and writes the same
  resources; all failure messages are byte-identical.
- The existing suite stays green, driven through the real
  `model.methods.<name>.execute` entrypoints; no test assertion is weakened to
  accommodate the move.

## Constraints

- No public surface change: model type, method names, argument/result schemas,
  and the five public exports are unchanged.
- Follow the established `_lib/` boundary conventions: no import cycles; invoker
  stays the sole owner of `Deno.Command`; path-safety the sole producer of
  `SafeRestoreTarget`; secrets the sole producer of `ResolvedSecrets`. Method
  modules compose these; they do not re-implement or bypass them.
- Secret-hygiene, restore-safety (the `SafeRestoreTarget` / `invokeResticRestore`
  path), and the no-human-text-parser invariants are unchanged.
- Behaviour is identical on well-formed input; failure paths and messages are
  byte-identical.
