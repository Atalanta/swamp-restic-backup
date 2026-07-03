# Model restic commands as a typed command, not a bare string[] argv

GitHub issue: #11

## What

Stop having method modules hand-assemble a `string[]` argv and pass it to a
generic `invokeRestic(argv: string[], ...)`. Give the invoker a typed command
surface so a method module supplies typed, per-command inputs and the invoker
assembles the argv internally — the generic free-form `invokeRestic(string[])`
is no longer part of the surface method modules use, so no caller assembles a
raw restic argv, and `restore` remains expressible only via its
`SafeRestoreTarget`-bearing entry. The exact shape of the typed surface (a
discriminated `ResticCommand` union decoded by one internal function, or a
builder/entry per command mirroring the existing `invokeResticRestore`) is an
implementation decision for the plan; both satisfy the requirement.

## Why

`invokeRestic(argv: string[], ...)` models every restic command as an untyped
string array: the type system cannot tell a `restore` argv from a `backup` argv.
That is exactly why #5 had to add a runtime `argv[1]`-is-subcommand guard to keep
`restore` reserved for `invokeResticRestore` — a type-level gap patched at
runtime. `restore` already has a typed entry (`invokeResticRestore(safeTarget:
SafeRestoreTarget, ...)`); extending that pattern to the other commands makes the
"only a checked target reaches a restore" guarantee structural and lets the
runtime `argv[1]` guard be retired (or kept only as annotated defence-in-depth).
Recorded as IDIOM-1 in the #5 code review; #10 (method modules) is now merged, so
the call sites are already isolated per method.

## Scope

In scope: introduce a typed command surface in `_lib/invoker.ts` covering the
restic commands the method modules run — the six that currently call the generic
`invokeRestic` and assemble argv (`init` and its `cat config` idempotency probe,
`backup`, `snapshots`, `check`, `forget`, `prune`) plus the already-typed
`restore` (`invokeResticRestore`, unchanged). The typed surface takes each
command's typed inputs (repository, secrets, resticPath, cwd, and the
command-specific options the method builds today — backup: include/exclude/tags;
snapshots: host/tags/path; forget: retention/host/dry-run; etc.) and assembles
`--json`/`--repo`/flags internally. Rewire those six method modules to use the
typed surface instead of building argv. `check-restic` is NOT in scope: it uses
`probeResticCapability` (no repo argv, no `invokeRestic` call) and is unchanged.
Make the generic `invokeRestic(string[])` module-private (or remove it if
unused), and retire the `argv[1]` restore guard, or keep it only as a documented
internal defence-in-depth.

Out of scope: changing what any command does — same restic subcommand, same
flags, same order, same `--json`, same secret injection, byte-identical messages
and written resources; the decode/boundary helpers (`decodeResticOutput`,
`decodeResticSummary`, `decodeResticCheckOutput`, parse helpers) and
`probeResticCapability` are unchanged; secrets/path-safety/schemas/policy/
preflight modules are unchanged.

## Done

- Each restic command a method runs has a typed invoker entry that assembles the
  argv internally; the method modules pass typed inputs, not a `string[]` argv.
- `restore` is expressible only via the `SafeRestoreTarget`-bearing entry
  (`invokeResticRestore`), unchanged.
- The generic `invokeRestic(string[])` is not exported for method use (private or
  removed); a raw restic argv cannot be assembled and run by a method module.
- The runtime `argv[1]` restore guard is retired, or retained only as annotated
  internal defence-in-depth — the type system now prevents a raw restore.
- No behaviour change: every command runs the same argv with the same flags and
  order, injects secrets identically, and writes identical resources with
  byte-identical messages. The existing suite stays green, driven through the
  real `model.methods.<name>.execute` entrypoints.

## Constraints

- No public surface change: model type, method names, argument/result schemas,
  and the four re-exports + `model` are unchanged. The typed invoker entries are
  internal `_lib` surface.
- `_lib/invoker.ts` stays the sole owner of `Deno.Command` and the sole
  secret-injecting spawn; the typed entries delegate to the existing private
  spawn (as `invokeResticRestore` does).
- No import cycle; the `SafeRestoreTarget` / `ResolvedSecrets` boundaries (#5,
  #4) are unchanged.
- Behaviour is identical on well-formed input; failure paths and messages are
  byte-identical.
