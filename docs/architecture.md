# Architecture (C4)

C4 model of the `@atalanta/restic-backup` swamp model extension. Findings from an
audit anchor to the elements named here.

## Context

The extension is a swamp model that turns operator method calls into `restic`
commands against a Backblaze B2 repository. swamp resolves the vault-sourced
secrets and stores results; restic owns encryption and B2 authentication.

```mermaid
C4Context
    Person(user, "Swamp operator", "Runs backup methods")
    System(ext, "@atalanta/restic-backup", "Typed methods over restic to back up .swamp/ evidence")
    System(swamp, "swamp runtime", "Resolves vault.get, invokes methods, stores results")
    System_Ext(restic, "restic CLI", "Encryption, dedup, B2 auth")
    System_Ext(b2, "Backblaze B2", "Object store for the restic repository")

    Rel(user, swamp, "runs method")
    Rel(swamp, ext, "invokes execute")
    Rel(ext, restic, "spawns argv with --json")
    Rel(restic, b2, "reads/writes repository")
```

## Containers

```mermaid
C4Container
    System_Boundary(ext, "@atalanta/restic-backup") {
        Container(model, "Model definition", "Deno TS", "@atalanta/restic-backup/repository: thin registration shell + _lib/ concern modules")
        Container(tests, "Test suite", "Deno test", "Unit + local-repo integration + secret-leak canaries")
    }
    System_Boundary(swamp, "swamp runtime") {
        Container(vault, "Vault", "", "Resolves vault.get to secret strings")
        Container(datastore, "Datastore", "", "Stores versioned result DataRecords")
    }
    System_Ext(restic, "restic CLI", "")

    Rel(vault, model, "supplies resolved secrets via globalArgs")
    Rel(model, restic, "runs restic commands")
    Rel(model, datastore, "writes result DataRecord")
    Rel(tests, model, "exercises methods + helpers")
```

## Components (Model definition)

The "Model definition" container is a thin registration shell
`extensions/models/restic_backup.ts` (the manifest's model entry) plus modules
under `extensions/models/_lib/`. The entry imports the eight method definitions
from `_lib/methods/*` and wires them into `model.methods`; it contains no
`execute` bodies. Each method lives in its own focused module. All concern
modules are shared only through imports — boundaries are enforced by the
import graph.

The original single `_lib/invoker.ts` has been split into three modules with
distinct responsibilities, plus an effects seam:
- `_lib/spawn.ts` — sole owner of `Deno.Command` and `Deno.env`; exports the
  `SpawnEffect` injectable seam so tests can inject a fake spawn without
  launching a real process.
- `_lib/commands.ts` — typed per-command invoker entries; each accepts an
  optional `spawn: SpawnEffect` for test injection. No generic `argv: string[]`
  export.
- `_lib/decode.ts` — `ResticResult` type and all boundary decoders; no
  subprocess concerns.
- `_lib/method-effects.ts` — `MethodEffects { now?: () => Date; cwd?: () => string }`
  injectable seam for the four record-naming method executes (check, forget,
  prune, restore); defaults to `{}` so production uses real `Deno`.

```mermaid
C4Component
    Container_Boundary(model, "Model definition") {
        Component(entry, "Entry (restic_backup.ts)", "module", "Thin registration shell: imports, public re-export block (four helpers/constants), model metadata, resources map, and model.methods wiring the eight method imports. No execute bodies.")
        Component(methodmodules, "_lib/methods/* (8 modules)", "module", "One focused module per method: check-restic.ts, init.ts, backup.ts, snapshots.ts, check.ts, restore.ts, forget.ts, prune.ts. Each exports { description, arguments, execute } and imports only the _lib concern modules it needs. The six rewired methods pass typed inputs to per-command invoker entries; restore uses invokeResticRestore(SafeRestoreTarget).")
        Component(methodcontext, "_lib/method-context.ts", "module", "MethodContext type — the runtime port injected by swamp into every method execute. Internal _lib type; not re-exported.")
        Component(preflight, "_lib/preflight.ts", "module", "runSecretPreflight — sole definition of the secret-bearing prologue (resolveSecrets → ResolvedSecrets, read args, probe --json) shared by the seven operational methods; composes secrets + commands")
        Component(secrets, "_lib/secrets.ts", "module", "resolveSecrets (sole producer of the branded, unforgeable ResolvedSecrets), redactSecrets — a secret cannot reach restic without passing validation")
        Component(spawn, "_lib/spawn.ts", "module", "Sole owner of Deno.Command. Exports SpawnEffect (injectable seam), realSpawn (the real Deno.Command-backed SpawnEffect — takes a fully-built env, injects no secrets), and invokeResticNoSecrets (no-secrets PATH-only probe). No secret-bearing raw-argv entry here.")
        Component(commands, "_lib/commands.ts", "module", "Typed per-command invoker entries (invokeResticCheck, invokeResticPrune, invokeResticSnapshots, invokeResticForget, invokeResticBackup, invokeResticInit, invokeResticCatConfig, invokeResticRestore) and probeResticCapability. Owns the MODULE-PRIVATE secret-injecting invokeResticInternal (builds the secret env, reads Deno.env, calls realSpawn) — not exported. Each entry accepts an optional spawn:SpawnEffect for test injection. No generic argv:string[] export — method modules pass typed inputs. invokeResticRestore requires SafeRestoreTarget.")
        Component(decode, "_lib/decode.ts", "module", "ResticResult type; parseResticJsonOutput, findJsonlMessage, decodeResticOutput, decodeResticCheckOutput, decodeResticSummary — all boundary decoders. No Deno.Command or subprocess concerns.")
        Component(methodeffects, "_lib/method-effects.ts", "module", "MethodEffects { now?: () => Date; cwd?: () => string } — injectable seams for the four record-naming method executes (check, forget, prune, restore). Defaults to {} so production uses real Deno; tests inject fixed clock/cwd.")
        Component(pathsafety, "_lib/path-safety.ts", "module", "normalizePosixPath, resolvePathWithAncestor, checkRestoreTargetSafety, resolveRestoreTarget — sole producer of the branded SafeRestoreTarget (POSIX-only); the restic restore call accepts only that value")
        Component(policy, "_lib/policy.ts", "module", "DEFAULT_INCLUDE_PATHS, DEFAULT_EXCLUDE_PATTERNS, buildIncludeExcludeLists — sole source of the backup policy")
        Component(schemas, "_lib/schemas.ts", "module", "arg + result Zod schemas and their inferred types")
    }

    Rel(entry, methodmodules, "imports and wires")
    Rel(methodmodules, methodcontext, "imports MethodContext type")
    Rel(methodmodules, preflight, "imports")
    Rel(methodmodules, secrets, "imports (redactSecrets)")
    Rel(methodmodules, commands, "passes typed inputs to per-command entries")
    Rel(methodmodules, decode, "decodes restic JSON output")
    Rel(methodmodules, pathsafety, "imports")
    Rel(methodmodules, methodeffects, "imports MethodEffects for clock/cwd seams")
    Rel(commands, pathsafety, "imports SafeRestoreTarget (type)")
    Rel(commands, spawn, "delegates to invokeResticInternal / invokeResticNoSecrets")
    Rel(methodmodules, policy, "imports")
    Rel(methodmodules, schemas, "imports")
    Rel(preflight, secrets, "imports")
    Rel(preflight, commands, "imports probeResticCapability")
```

The seven operational methods (`init`, `backup`, `snapshots`, `check`,
`restore`, `forget`, `prune`) obtain their secrets and repo inputs from
`runSecretPreflight`; `checkRestic` runs its `--json` probe without secrets and
does not use the pre-flight. The six rewired methods (`init`, `backup`,
`snapshots`, `check`, `forget`, `prune`) pass typed inputs to per-command
entries in `commands.ts`; `restore` uses `invokeResticRestore(SafeRestoreTarget)`.
No method module builds a raw argv array or imports a generic secret-injecting
invoker — `commands.ts`'s type surface is the enforcement boundary.

The four record-naming methods (`check`, `forget`, `prune`, `restore`) accept
an optional `effects: MethodEffects` third parameter for clock and cwd
injection. The swamp runtime never supplies this parameter; it is only used by
tests to inject a fixed `now` or `cwd` for deterministic record name assertions.

## Trust boundaries and invariants

- Secrets (restic password + two B2 credentials) enter only as `vault.get`
  references resolved by swamp; the Secret layer keeps resolved values out of
  argv, result resources, logs, and the backup.
- `commands.ts` exposes typed per-command entries (no generic `argv: string[]` export). Method modules pass typed inputs; the command entry assembles argv internally, always including `--json`. `spawn.ts` is the sole owner of `Deno.Command` and `Deno.env`.
- Restore path safety refuses targets at the repo root, `.swamp/`, an ancestor
  of `.swamp/`, or inside `.swamp/`. The guard is structural: `resolveRestoreTarget`
  produces a branded `SafeRestoreTarget` only for a safe target or an explicit
  `confirm: true` override (recorded as `overridden` in the result), and the
  restic restore call accepts only that value — so an unchecked target cannot
  reach restic. Non-POSIX absolute targets are refused (POSIX-only).
- `_catalog.db` and bundle caches are excluded from the backup set.
