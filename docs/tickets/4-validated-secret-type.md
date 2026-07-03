# Enforce secrets through a validated type

GitHub issue: #4

## What

Make the three resolved secrets (restic password, B2 account id, B2 account
key) reach restic only through a value that exists **only after validation has
passed** — a distinct, opaque secret type produced by a single validate-and-
extract step — so code cannot construct or pass an unvalidated or empty secret
to the restic invoker. This replaces the current split where `validateSecrets`
and `extractSecrets` are independent and `extractSecrets`'s safety rests on a
comment-only "call only after validateSecrets returns null" precondition.

## Why

`ResticSecrets` is a plain `{ resticPassword; b2AccountId; b2AccountKey }` of
unconstrained strings, and `validateSecrets`/`extractSecrets` are separate
functions. The type system does not prevent an "extract without validate" call,
so the C4 invariant "secrets are validated before any restic call" rests on
calling discipline (now centralised in `runSecretPreflight`, but still
conventional) rather than on a structural guard. Recorded as
`finding-secret-boundary-conventional` (confirmed, severity medium) in the
applied `restic-backup-review` audit KB; its recommendation is to model secrets as a
branded type returned only by a single validated resolution step, so
"unvalidated but extracted" is unrepresentable.

## Scope

In scope: the secret value type and its production. Introduce an opaque/branded
resolved-secret type (e.g. `ResolvedSecrets`) that can only be produced by a
single validated resolution function in `_lib/secrets.ts`; make `invokeRestic`
and `redactSecrets` accept that type; route the one call site
(`runSecretPreflight` in `_lib/preflight.ts`) through it. The three current
per-secret validation messages (one each for `resticPassword`, `b2AccountId`,
`b2AccountKey`, wrapped by `runSecretPreflight`'s `Secret validation failed
before calling restic:` prefix) are preserved byte-for-byte.

Out of scope: rejecting a literal secret value at runtime. swamp resolves
`vault.get` references to plain strings before the model runs, so at runtime a
resolved secret is indistinguishable from a typed literal — the model cannot
detect "was this a vault reference or a literal?" and must not try. Documenting
that the fields must be vault references (schema `.describe` text) is the only
literal-related change in scope. `finding-include-can-smuggle-secrets` is a
separate concern and is not addressed here.

## Done

- The resolved secrets consumed by `invokeRestic` exist only as a value produced
  by the validated resolution step; there is no exported way to construct that
  value without going through validation, so "extract an unvalidated/empty
  secret" is a compile-time impossibility rather than a discouraged call order.
- A missing or empty resolved secret fails before restic is invoked, naming
  which of the three secrets is missing — the existing failure messages are
  byte-identical.
- Acceptance is proven through a real model method entrypoint, not internal unit
  tests alone: at least one secret-bearing method is exercised via
  `model.methods.<name>.execute(...)` to show a missing/empty secret still fails
  before any restic spawn with the same message, and the existing suite (which
  drives methods through `execute`) stays green.
- The secret configuration surface documents that the three fields must be
  `vault.get` references (schema description), without changing how an operator
  supplies them.
- No secret value appears in argv, result resources, logs, or the backup
  (unchanged invariant); `redactSecrets` still scrubs all three from any
  subprocess-derived text.

## Constraints

- swamp resolves `vault.get` references before the model runs; the model
  receives resolved strings — do not attempt in-model vault access.
- Do not change how an operator configures secrets beyond documentation needed
  to communicate the boundary.
- No public change to the model type, method names, argument schemas, or
  result-resource shapes. The secret type is an internal `_lib` concern; the
  operator-facing globalArgs fields (`resticPassword`, `b2AccountId`,
  `b2AccountKey`) keep their names and string form.
- Behaviour is unchanged on well-formed input: the same restic calls run with
  the same secrets injected only into subprocess env.
