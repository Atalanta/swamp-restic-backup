# Inject side effects and split the invoker module

GitHub issues: #6 (inject side effects) and #12 (split the invoker) — merged.

## What

Two refactors that touch the same code, done as one work item:

1. **Split `_lib/invoker.ts`** (~620 lines) into focused modules along its
   responsibilities: (a) subprocess spawning + secret env injection (sole owner
   of the spawn effect), (b) the typed per-command entries, (c) JSON/JSONL
   parsing + boundary decoders, plus `probeResticCapability`.
2. **Inject the model's side effects** — subprocess spawn, environment access,
   current time (clock), and current working directory — through seams rather
   than calling `Deno.Command`, `Deno.env`, `new Date()`, and `Deno.cwd()`
   directly, so logic can be exercised without a real subprocess or ambient
   state and result-record names/timestamps are deterministic under test.

Merged because #12's new spawn module is the exact place #6's injectable
spawn/env seam belongs — splitting first and re-shaping the same code second
would be wasted motion. The spawn module is born with the injected seam.

## Why

`invoker.ts` carries several unrelated concerns in one ~620-line module
(spawn, secret injection, no-secret probe, per-command argv, `ResticResult`,
JSON/JSONL parse+decode) — recorded as ARCH-1 in the #11 review (#12). Separately,
the model's effects are hard-wired: `Deno.Command`/`Deno.env` in the invoker,
`new Date()` in four method modules' result-record naming, and `Deno.cwd()` as
the restore-safety anchor default — recorded as `finding-purity-seam-collapsed`
(confirmed) (#6). Hard-wired effects force real subprocesses and temp dirs to
test pure logic, make result names non-deterministic (wall-clock), and leave the
restore anchor dependent on the process cwd at call time.

## Scope

In scope: (1) the invoker split into spawn / typed-command / decode modules with
import-graph-enforced boundaries; (2) an injected effects seam — spawn, env,
clock, cwd — with the real `Deno.*` effects as the production defaults, threaded
to where each is used (spawn+env in the spawn module; clock into the four method
modules that name records / stamp `checkedAt`; cwd into `path-safety`'s
`cwdAnchor`, already a parameter). The exact shape of the seam (an injected
`effects`/`clock` object vs per-effect default parameters) is left to the plan.

The "clock" effect here means WALL-CLOCK time (`new Date()`) used for
result-record naming and timestamps. The monotonic duration timer
(`performance.now()`, used for the invoker's spawn `durationMs` and prune's
`durationMs`) is explicitly OUT of scope: it measures real elapsed time, is not
part of a record's identity or a stamped timestamp, and making it deterministic
would mean faking elapsed-time measurement — outside this ticket's determinism
goal. Those `durationMs` values stay real elapsed times; tests assert them as
non-negative numbers, not fixed values.

Out of scope: changing what any command does; the argv contents/flag order (#11);
the `SafeRestoreTarget` runtime brand check or the secret-injection boundary; the
public model surface; `performance.now()` duration measurement (see above).

## Done

- **Invoker split:** the spawn/secret-injection, typed-command, and parse/decode
  concerns each live in their own focused module; `invoker.ts` is no longer a
  catch-all. The sole-owner-of-`Deno.Command` invariant is preserved and confined
  to the spawn module; the typed entries and decoders import it, not vice versa;
  no import cycle.
- **Effects injected:** subprocess spawn, environment, clock, and cwd are supplied
  to the model rather than reached for directly, so argv-building, parsing, and
  path logic can be exercised without launching a real subprocess or depending on
  ambient state. In production the injected defaults are the real `Deno` effects.
- **Deterministic under test:** result-record naming and timestamps
  (`check-`/`forget-`/`restore-`/`prune-` names, `checkedAt`) are deterministic
  when a fixed wall-clock is injected; the restore-safety anchor is deterministic
  when cwd is injected (no reliance on the ambient process cwd). `durationMs`
  fields (spawn/prune, measured by the monotonic `performance.now()` timer) stay
  real elapsed times and are asserted as non-negative numbers, not fixed values.
- **restore** stays reachable only via `invokeResticRestore` with its runtime
  `SafeRestoreTarget` brand check.
- No behaviour change against a real restic + real B2: same argv, flags, secret
  injection, decode, and — with the real clock/cwd defaults — the same
  observable result names and timestamps. The existing suite stays green through
  `model.methods.<name>.execute`; new tests exercise logic with injected fakes
  and assert deterministic naming.

## Constraints

- Production defaults are the real `Deno` effects; this is a
  testability/structure change, not a behaviour change.
- No public surface change: model type, method names, argument/result schemas,
  and the public re-exports are unchanged. The effects seam and the split modules
  are internal `_lib` surface.
- Follow the established `_lib` boundary conventions: no import cycles; the spawn
  module is the sole owner of `Deno.Command`; path-safety the sole producer of
  `SafeRestoreTarget`; secrets the sole producer of `ResolvedSecrets`.
- Acceptance proven through the real `model.methods.<name>.execute` entrypoints,
  plus injected-fake unit tests demonstrating deterministic naming and
  subprocess-free logic exercise.
