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

```mermaid
C4Component
    Container_Boundary(model, "Model definition") {
        Component(entry, "Entry (restic_backup.ts)", "module", "Thin registration shell: imports, public re-export block (four helpers/constants), model metadata, resources map, and model.methods wiring the eight method imports. No execute bodies.")
        Component(methodmodules, "_lib/methods/* (8 modules)", "module", "One focused module per method: check-restic.ts, init.ts, backup.ts, snapshots.ts, check.ts, restore.ts, forget.ts, prune.ts. Each exports { description, arguments, execute } and imports only the _lib concern modules it needs. The six rewired methods pass typed inputs to per-command invoker entries; restore uses invokeResticRestore(SafeRestoreTarget).")
        Component(methodcontext, "_lib/method-context.ts", "module", "MethodContext type — the runtime port injected by swamp into every method execute. Internal _lib type; not re-exported.")
        Component(preflight, "_lib/preflight.ts", "module", "runSecretPreflight — sole definition of the secret-bearing prologue (resolveSecrets → ResolvedSecrets, read args, probe --json) shared by the seven operational methods; composes secrets + invoker")
        Component(secrets, "_lib/secrets.ts", "module", "resolveSecrets (sole producer of the branded, unforgeable ResolvedSecrets), redactSecrets — a secret cannot reach restic without passing validation")
        Component(invoker, "_lib/invoker.ts", "module", "Typed per-command invokers (invokeResticCheck, invokeResticPrune, invokeResticSnapshots, invokeResticForget, invokeResticBackup, invokeResticInit, invokeResticCatConfig) plus invokeResticRestore(SafeRestoreTarget), invokeResticNoSecrets, probeResticCapability, parse helpers, ResticResult. Sole owner of Deno.Command (spawnRestic is module-private). No generic argv:string[] export — method modules pass typed inputs.")
        Component(pathsafety, "_lib/path-safety.ts", "module", "normalizePosixPath, resolvePathWithAncestor, checkRestoreTargetSafety, resolveRestoreTarget — sole producer of the branded SafeRestoreTarget (POSIX-only); the restic restore call accepts only that value")
        Component(policy, "_lib/policy.ts", "module", "DEFAULT_INCLUDE_PATHS, DEFAULT_EXCLUDE_PATTERNS, buildIncludeExcludeLists — sole source of the backup policy")
        Component(schemas, "_lib/schemas.ts", "module", "arg + result Zod schemas and their inferred types")
    }

    Rel(entry, methodmodules, "imports and wires")
    Rel(methodmodules, methodcontext, "imports MethodContext type")
    Rel(methodmodules, preflight, "imports")
    Rel(methodmodules, secrets, "imports (redactSecrets)")
    Rel(methodmodules, invoker, "passes typed inputs to per-command entries")
    Rel(methodmodules, pathsafety, "imports")
    Rel(invoker, pathsafety, "imports SafeRestoreTarget (type)")
    Rel(methodmodules, policy, "imports")
    Rel(methodmodules, schemas, "imports")
    Rel(preflight, secrets, "imports")
    Rel(preflight, invoker, "imports")
```

The seven operational methods (`init`, `backup`, `snapshots`, `check`,
`restore`, `forget`, `prune`) obtain their secrets and repo inputs from
`runSecretPreflight`; `checkRestic` runs its `--json` probe without secrets and
does not use the pre-flight. The six rewired methods (`init`, `backup`,
`snapshots`, `check`, `forget`, `prune`) pass typed inputs to per-command
invoker entries; `restore` uses `invokeResticRestore(SafeRestoreTarget)`.
No method module builds a raw argv array or imports a generic secret-injecting
invoker — the invoker's type surface is the enforcement boundary.

## Trust boundaries and invariants

- Secrets (restic password + two B2 credentials) enter only as `vault.get`
  references resolved by swamp; the Secret layer keeps resolved values out of
  argv, result resources, logs, and the backup.
- The restic invoker exposes typed per-command entries (no generic `argv: string[]` export). Method modules pass typed inputs; the invoker assembles argv internally, always passing `--json`.
- Restore path safety refuses targets at the repo root, `.swamp/`, an ancestor
  of `.swamp/`, or inside `.swamp/`. The guard is structural: `resolveRestoreTarget`
  produces a branded `SafeRestoreTarget` only for a safe target or an explicit
  `confirm: true` override (recorded as `overridden` in the result), and the
  restic restore call accepts only that value — so an unchecked target cannot
  reach restic. Non-POSIX absolute targets are refused (POSIX-only).
- `_catalog.db` and bundle caches are excluded from the backup set.
