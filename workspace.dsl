workspace "restic-backup" "C4 model of the @atalanta/restic-backup swamp model extension" {

    model {
        user = person "Swamp operator" "Runs backup methods against a swamp repo."

        swamp = softwareSystem "swamp runtime" "Loads the extension, resolves vault.get expressions, invokes model methods, stores result DataRecords." {
            vault = container "Vault" "Resolves vault.get(...) CEL expressions to secret strings at runtime; backend-abstracted."
            datastore = container "Datastore" "Stores versioned result DataRecords under .swamp/."
        }

        restic = softwareSystem "restic CLI" "External backup binary. Owns encryption, dedup, and B2 backend auth."
        b2 = softwareSystem "Backblaze B2" "Object store holding the restic repository."

        ext = softwareSystem "@atalanta/restic-backup" "Swamp model extension: typed methods over restic to back up .swamp/ runtime evidence to B2." {
            model = container "Model definition" "The @atalanta/restic-backup/repository model: a thin registration shell (restic_backup.ts) plus modules under _lib/, with boundaries enforced by the import graph." {
                entry = component "Entry (restic_backup.ts)" "Thin registration shell: imports, the public re-export block (four helpers/constants), model metadata, resources map, and model.methods wiring the eight method imports. No execute bodies inline."
                methodmodules = component "_lib/methods/* (8 method modules)" "One focused module per method: check-restic.ts, init.ts, backup.ts, snapshots.ts, check.ts, restore.ts, forget.ts, prune.ts. Each exports { description, arguments, execute } verbatim and imports only the _lib concern modules it needs."
                methodcontext = component "_lib/method-context.ts" "MethodContext type — the runtime port injected by swamp into every method execute. Internal _lib type; not re-exported."
                schemas = component "_lib/schemas.ts" "arg + result Zod schemas and their inferred types."
                secrets = component "_lib/secrets.ts" "resolveSecrets (sole producer of the branded, unforgeable ResolvedSecrets), redactSecrets — the type makes an unvalidated secret reaching restic unrepresentable."
                invoker = component "_lib/invoker.ts" "invokeRestic, invokeResticNoSecrets, probeResticCapability, parse helpers, ResticResult — sole owner of Deno.Command (spawnRestic is module-private)."
                pathsafety = component "_lib/path-safety.ts" "normalizePosixPath, resolvePathWithAncestor, checkRestoreTargetSafety, resolveRestoreTarget — sole producer of the branded, unforgeable SafeRestoreTarget (POSIX-only; refuses a non-POSIX absolute target). The restic restore call accepts only a SafeRestoreTarget, so an unchecked target cannot reach restic."
                policy = component "_lib/policy.ts" "DEFAULT_INCLUDE_PATHS, DEFAULT_EXCLUDE_PATTERNS, buildIncludeExcludeLists — sole source of the curated .swamp/ subset."
                preflight = component "_lib/preflight.ts" "runSecretPreflight — sole definition of the secret-bearing prologue (resolveSecrets → ResolvedSecrets, read cwd/resticPath/repository, probe --json) shared by the seven operational methods; composes secrets + invoker. checkRestic does not use it (no-secret probe)."
            }
            tests = container "Test suite" "restic_backup_test.ts — unit + local-repo integration + secret-leak canaries."
        }

        user -> swamp "runs method"
        swamp -> model "invokes execute(args, context)"
        vault -> secrets "supplies resolved secret strings via globalArgs"
        entry -> methodmodules "imports and wires"
        methodmodules -> preflight "runs the shared secret pre-flight"
        methodmodules -> secrets "redacts subprocess output"
        methodmodules -> invoker "runs restic commands"
        methodmodules -> policy "builds include/exclude"
        methodmodules -> pathsafety "resolves the safe restore target"
        methodmodules -> methodcontext "imports MethodContext type"
        invoker -> pathsafety "restore accepts only SafeRestoreTarget (type)"
        methodmodules -> schemas "validates args + result"
        preflight -> secrets "resolves (validate + brand)"
        preflight -> invoker "probes --json capability"
        invoker -> restic "spawns argv with --json, secrets in env"
        restic -> b2 "reads/writes repository"
        methodmodules -> datastore "writes result DataRecord"
        tests -> model "exercises methods + helpers"
    }

    views {
        systemContext ext "context" {
            include *
            autolayout lr
        }
        container ext "containers" {
            include *
            autolayout lr
        }
        component model "components" {
            include *
            autolayout lr
        }
    }
}
