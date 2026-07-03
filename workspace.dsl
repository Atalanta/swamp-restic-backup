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
            model = container "Model definition" "The @atalanta/restic-backup/repository model: the entry file restic_backup.ts plus five sibling modules under _lib/, with boundaries enforced by the import graph." {
                methods = component "Entry (restic_backup.ts)" "8 method execute bodies, the MethodContext port, and composition of the _lib modules; re-exports the public helpers/constants."
                schemas = component "_lib/schemas.ts" "arg + result Zod schemas and their inferred types."
                secrets = component "_lib/secrets.ts" "validateSecrets, extractSecrets, redactSecrets, ResticSecrets — sole producer of resolved secret values (a structural secret TYPE is deferred to a later ticket)."
                invoker = component "_lib/invoker.ts" "invokeRestic, invokeResticNoSecrets, probeResticCapability, parse helpers, ResticResult — sole owner of Deno.Command (spawnRestic is module-private)."
                pathsafety = component "_lib/path-safety.ts" "normalizePosixPath, resolvePathWithAncestor, checkRestoreTargetSafety — refuses dangerous restore targets."
                policy = component "_lib/policy.ts" "DEFAULT_INCLUDE_PATHS, DEFAULT_EXCLUDE_PATTERNS, buildIncludeExcludeLists — sole source of the curated .swamp/ subset."
            }
            tests = container "Test suite" "restic_backup_test.ts — unit + local-repo integration + secret-leak canaries."
        }

        user -> swamp "runs method"
        swamp -> model "invokes execute(args, context)"
        vault -> secrets "supplies resolved secret strings via globalArgs"
        methods -> secrets "validates + extracts"
        methods -> invoker "runs restic commands"
        methods -> policy "builds include/exclude"
        methods -> pathsafety "checks restore targets"
        methods -> schemas "validates args + result"
        invoker -> restic "spawns argv with --json, secrets in env"
        restic -> b2 "reads/writes repository"
        methods -> datastore "writes result DataRecord"
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
