# Make restore safety structural, not a bypassable flag

GitHub issue: #5

## What

Make restore-target safety a property of the value the restore method passes to
restic, not a runtime boolean the caller can unset: the restic `restore`
invocation should accept only a target that has been through the safety check
(or an explicit, recorded override), so the invoking path cannot be reached with
an unchecked target. The extension is POSIX-path-only: a non-POSIX absolute
target (e.g. a Windows `C:\...` path) is refused with a clear message rather than
silently misjudged, and this is documented.

## Why

Two confirmed audit findings. `finding-restore-safety-conventional`:
`checkRestoreTargetSafety` still runs, but `confirm: true` bypasses
*enforcement* — `if (safetyError !== null && !args.confirm)` skips the refusal
of a non-null result — and the same `invokeRestic(... --target args.targetDir
...)` path is reached whether the check passed, its result was overridden, or
(structurally) nothing consulted the check at all; safety rests on the method
body remembering to branch on a boolean. `finding-path-safety-posix-only`: the
checks are POSIX-only (`startsWith("/")`, split on `/`, `normalizePosixPath`), so
a Windows absolute target (e.g. `C:\...`) is absolutized wrong and misjudged.

The `#4` branded-secret work established the pattern this should follow: a value
that exists only after a guard has passed, so "reach restic with an unchecked
target" becomes unrepresentable rather than merely discouraged.

## Scope

In scope: (1) introduce a checked restore-target value produced only by the
safety guard — either the target is safe, or the operator supplies an explicit
override that the guard records as an override; the restic restore call accepts
only that value. (2) The override must be distinguishable in the written
`restoreResult` and/or logs from a routine restore (an `overridden`/`forced`
marker), so an audit can tell a forced restore from a safe one. (3) Enforce the POSIX-only
platform contract: `checkRestoreTargetSafety` refuses a non-POSIX absolute
target (e.g. `C:\...` / a backslash-drive path) with a clear message instead of
absolutizing it wrong, and the module documents POSIX-only. A full cross-platform
path implementation is out of scope.

Out of scope: changing restic's own `--target` semantics; the include/exclude
policy; any secret-layer change (done in `#4`).

## Done

- The restore method cannot invoke restic with a target that has not been
  through `checkRestoreTargetSafety`: a dangerous target is refused by default,
  and reaching the restic call requires either a safe target or an explicit
  override — the "unchecked target reaches restic" path does not exist.
- An override is explicit and visibly recorded: the written `restoreResult`
  (and/or the log line) distinguishes a forced/overridden restore from a routine
  one, so the override is auditable after the fact.
- The extension documents POSIX-only and refuses a non-POSIX absolute target
  with a clear message rather than silently misjudging it; POSIX targets are
  judged correctly as today.
- A staged restore to a safe directory outside the repo works unchanged: same
  restic call, same `restoreResult` shape, no override marker.
- Restore stays non-destructive by default; the default path never overwrites a
  live `.swamp/`.

## Constraints

- Restore must stay non-destructive by default; the default path never
  overwrites a live `.swamp/`.
- No public change to the model type, method names, argument schemas, or the
  `restoreResult` spec beyond any additive, backward-compatible override marker
  needed to make an override auditable — call out any schema addition explicitly.
- Behaviour unchanged for a safe staged restore and for a refused dangerous
  restore without override (same refusal message).
- Acceptance is proven through the real `model.methods.restore.execute`
  entrypoint: a dangerous target is refused; a safe target restores; an explicit
  override both proceeds and is recorded as an override; the existing suite stays
  green.
