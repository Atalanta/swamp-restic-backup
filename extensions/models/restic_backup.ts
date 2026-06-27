/**
 * Restic Backup Model
 *
 * Manages restic backups of the .swamp/ runtime evidence tree to a
 * Backblaze B2 repository. Provides a typed interface for the full
 * restic lifecycle: init, backup, snapshots, check, restore, forget, and
 * prune. Secrets are injected via swamp vault references and are NEVER
 * logged or passed as argv.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Constants
// =============================================================================

// Default include/exclude policy — controls which parts of the .swamp/ tree
// are backed up. Outputs, workflow runs, and evaluated definitions are the
// primary evidence artifacts. Bundles, telemetry, and secrets are excluded
// because they are either reproducible, too large, or must not be stored
// in a remote repository.
export const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  ".swamp/data",
  ".swamp/outputs",
  ".swamp/workflow-runs",
  ".swamp/definitions-evaluated",
  ".swamp/workflows-evaluated",
];

export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  ".swamp/data/_catalog.db",
  ".swamp/bundles",
  ".swamp/datastore-bundles",
  ".swamp/driver-bundles",
  ".swamp/report-bundles",
  ".swamp/vault-bundles",
  ".swamp/telemetry",
  ".swamp/logs",
  ".swamp/secrets",
];

// =============================================================================
// Resource Schemas
// =============================================================================

const ResticStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  binary: z.string().optional(),
  message: z.string(),
});

const RepositoryStatusSchema = z.object({
  repository: z.string(),
  initialized: z.boolean(),
  created: z.boolean(),
  message: z.string(),
});

const BackupResultSchema = z.object({
  snapshotId: z.string(),
  repository: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  includedPaths: z.array(z.string()),
  excludedPatterns: z.array(z.string()),
  fileCount: z.number(),
  byteCount: z.number(),
  tags: z.array(z.string()),
  host: z.string(),
});

const SnapshotsSchema = z.object({
  snapshots: z.array(z.object({
    id: z.string(),
    shortId: z.string(),
    time: z.string(),
    hostname: z.string(),
    paths: z.array(z.string()),
    tags: z.array(z.string()),
    username: z.string(),
  })),
  latestSnapshotId: z.string().optional(),
  latestTime: z.string().optional(),
  count: z.number(),
});

const CheckResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  checkedAt: z.string(),
});

const RestoreResultSchema = z.object({
  snapshotId: z.string(),
  targetDir: z.string(),
  filesRestored: z.number(),
  bytesRestored: z.number(),
  message: z.string(),
});

const ForgetResultSchema = z.object({
  policy: z.object({
    keepLast: z.number().optional(),
    keepDaily: z.number().optional(),
    keepWeekly: z.number().optional(),
    keepMonthly: z.number().optional(),
  }),
  snapshotsRemoved: z.number(),
  dryRun: z.boolean(),
});

const PruneResultSchema = z.object({
  durationMs: z.number(),
  rawOutput: z.string(),
  // TODO: restic prune emits no JSON in any released version (upstream gap);
  // populate freed-bytes/packs-removed from JSON once restic adds prune JSON
  // support. Stats omitted by design — they were unused and scraping human text
  // violates the no-human-text-parser invariant.
});

// =============================================================================
// Global Arguments Schema
// =============================================================================

const GlobalArgsSchema = z.object({
  repository: z.string().describe(
    "Restic repository URL (e.g. b2:bucket-name:path/prefix)",
  ),
  repoDir: z.string().default(".").describe(
    "Local repo root directory (default: current working directory)",
  ),
  include: z.array(z.string()).default([]).describe(
    "Additional paths to include (merged with defaults)",
  ),
  exclude: z.array(z.string()).default([]).describe(
    "Additional patterns to exclude (merged with defaults)",
  ),
  hostTag: z.string().optional().describe("Host tag for snapshots"),
  extraTags: z.array(z.string()).default([]).describe(
    "Additional tags for snapshots",
  ),
  retention: z.object({
    keepLast: z.number().optional(),
    keepDaily: z.number().optional(),
    keepWeekly: z.number().optional(),
    keepMonthly: z.number().optional(),
  }).default({}).describe("Retention policy for forget"),
  resticPath: z.string().default("restic").describe(
    "Path to the restic binary",
  ),
  // Vault references — CEL vault.get expressions resolved by swamp at runtime.
  // These fields receive the RESOLVED secret values at execution time; the
  // vault.get expression syntax is the user-facing interface only.
  resticPassword: z.string().describe(
    "vault.get expression for RESTIC_PASSWORD (e.g. vault.get('my-vault', 'restic_password'))",
  ),
  b2AccountId: z.string().describe(
    "vault.get expression for B2_ACCOUNT_ID (e.g. vault.get('my-vault', 'b2_account_id'))",
  ),
  b2AccountKey: z.string().describe(
    "vault.get expression for B2_ACCOUNT_KEY (e.g. vault.get('my-vault', 'b2_account_key'))",
  ),
});

// =============================================================================
// Method Argument Schemas
// =============================================================================

const CheckResticArgsSchema = z.object({});

const InitArgsSchema = z.object({});

const BackupArgsSchema = z.object({
  tags: z.array(z.string()).default([]),
});

const SnapshotsArgsSchema = z.object({
  host: z.string().optional(),
  tags: z.array(z.string()).default([]),
  path: z.string().optional(),
});

const CheckArgsSchema = z.object({});

const RestoreArgsSchema = z.object({
  snapshot: z.string().default("latest"),
  targetDir: z.string().describe(
    "Directory to restore into — required",
  ),
  confirm: z.boolean().default(false).describe(
    "Set to true to allow restoring over dangerous targets (repo root, .swamp/)",
  ),
});

const ForgetArgsSchema = z.object({
  keepLast: z.number().optional(),
  keepDaily: z.number().optional(),
  keepWeekly: z.number().optional(),
  keepMonthly: z.number().optional(),
  dryRun: z.boolean().default(false),
  host: z.string().optional(),
});

const PruneArgsSchema = z.object({});

// =============================================================================
// Type Definitions
// =============================================================================

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warning: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<{
    name: string;
    specName: string;
    kind: string;
    dataId: string;
    version: number;
    size: number;
  }>;
  readResource: (instanceName: string) => Promise<Record<string, unknown> | null>;
};

/** Structured result from running a restic subprocess. */
type ResticResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
};

/** Resolved secret values for injection into restic subprocess env. */
type ResticSecrets = {
  resticPassword: string;
  b2AccountId: string;
  b2AccountKey: string;
};

// =============================================================================
// Secret Validation and Extraction
// =============================================================================

/**
 * Validate that all three required secrets are present and non-empty.
 * Called BEFORE the restic invoker is ever constructed, so the invoker
 * is never called when secrets are missing or empty.
 * Returns a structured error message string if validation fails, null if ok.
 */
function validateSecrets(globalArgs: z.infer<typeof GlobalArgsSchema>): string | null {
  if (!globalArgs.resticPassword || globalArgs.resticPassword.trim() === "") {
    return "Secret 'resticPassword' is missing or empty — provide a vault.get expression that resolves to the restic encryption password";
  }
  if (!globalArgs.b2AccountId || globalArgs.b2AccountId.trim() === "") {
    return "Secret 'b2AccountId' is missing or empty — provide a vault.get expression that resolves to the B2 account ID";
  }
  if (!globalArgs.b2AccountKey || globalArgs.b2AccountKey.trim() === "") {
    return "Secret 'b2AccountKey' is missing or empty — provide a vault.get expression that resolves to the B2 account key";
  }
  return null;
}

/**
 * Extract resolved secret values from globalArgs for subprocess env injection.
 * Must only be called AFTER validateSecrets returns null.
 */
function extractSecrets(globalArgs: z.infer<typeof GlobalArgsSchema>): ResticSecrets {
  return {
    resticPassword: globalArgs.resticPassword,
    b2AccountId: globalArgs.b2AccountId,
    b2AccountKey: globalArgs.b2AccountKey,
  };
}

// =============================================================================
// Restic Invoker
// =============================================================================

/**
 * Invoke a restic command with --json always present in argv.
 * Secrets are injected ONLY via subprocess env (RESTIC_PASSWORD, B2_ACCOUNT_ID,
 * B2_ACCOUNT_KEY) — never as argv or in any logged output.
 * Returns the raw stdout/stderr/exitCode without parsing.
 */
async function invokeRestic(
  argv: string[],
  secrets: ResticSecrets,
  cwd: string,
): Promise<ResticResult> {
  const startTime = performance.now();

  // Build subprocess env: inherit current env but inject secrets and remove
  // any pre-existing RESTIC_PASSWORD/B2_* to prevent accidental leakage
  const subprocessEnv: Record<string, string> = { ...Deno.env.toObject() };
  subprocessEnv["RESTIC_PASSWORD"] = secrets.resticPassword;
  subprocessEnv["B2_ACCOUNT_ID"] = secrets.b2AccountId;
  subprocessEnv["B2_ACCOUNT_KEY"] = secrets.b2AccountKey;

  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
    cwd,
    env: subprocessEnv,
  });

  // Deno.Command.output() throws a NotFound error when the binary doesn't exist.
  // We catch it here and return a structured failure so callers (especially
  // probeResticCapability) can surface a clean "binary not found" message
  // rather than an unhandled exception.
  let output: Deno.CommandOutput;
  try {
    output = await command.output();
  } catch (spawnError) {
    const durationMs = Math.round(performance.now() - startTime);
    const errorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
    return {
      stdout: "",
      stderr: errorMessage,
      exitCode: 127,
      success: false,
      durationMs,
    };
  }
  const durationMs = Math.round(performance.now() - startTime);

  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  return {
    stdout,
    stderr,
    exitCode: output.code,
    success: output.success,
    durationMs,
  };
}

// =============================================================================
// JSON Parsing Helpers
// =============================================================================

/**
 * Parse the JSON output from a restic command.
 * Restic with --json emits one JSON object per line (JSONL) for streaming
 * commands, or a single JSON array/object for listing commands.
 * This function throws a SyntaxError if the last non-empty line is not valid JSON,
 * which is the intended behavior — there is NO human-text fallback path.
 */
function parseResticJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return null;
  }

  // Try parsing as a complete JSON value first (arrays, objects)
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to JSONL parsing
  }

  // Parse as JSONL — return all lines as an array
  const lines = trimmed.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line) => JSON.parse(line));
}

/**
 * Find the last JSONL line matching a message_type predicate.
 * Used to extract specific event types from restic's streaming output.
 * Throws SyntaxError if any non-empty line is not valid JSON.
 */
function findJsonlMessage(
  stdout: string,
  messageType: string,
): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").filter((line) => line.trim() !== "");
  let found: Record<string, unknown> | null = null;
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed["message_type"] === messageType) {
      found = parsed;
    }
  }
  return found;
}

// =============================================================================
// Capability Probe
// =============================================================================

/**
 * Verify that the installed restic binary supports --json for all required commands.
 * This is a structural check: if it fails, all operational methods must refuse to run.
 * restic 0.17+ supports --json for all required commands; this probe verifies
 * the binary is present and responsive.
 */
async function probeResticCapability(
  resticPath: string,
  secrets: ResticSecrets,
  cwd: string,
): Promise<{ supported: boolean; version: string | null; message: string }> {
  const result = await invokeRestic(
    [resticPath, "version", "--json"],
    secrets,
    cwd,
  );

  if (!result.success && result.exitCode !== 0) {
    // Check if the binary exists at all
    return {
      supported: false,
      version: null,
      message: `restic binary not found or not executable at '${resticPath}': ${result.stderr.slice(0, 200)}`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    if (parsed["message_type"] !== "version") {
      return {
        supported: false,
        version: null,
        message: `restic version output did not include --json support (message_type='${parsed["message_type"]}', expected 'version')`,
      };
    }
    return {
      supported: true,
      version: (parsed["version"] as string) ?? null,
      message: `restic ${parsed["version"]} is available with --json support`,
    };
  } catch (parseError) {
    return {
      supported: false,
      version: null,
      message: `restic version --json did not emit valid JSON (no --json support?): ${String(parseError)}`,
    };
  }
}

// =============================================================================
// Restore Safety Checker
// =============================================================================

/**
 * Check whether a proposed restore target directory is dangerous.
 *
 * Refuses (returns an error message string) when the resolved, symlink-normalized
 * targetDir:
 *   (a) equals repo root
 *   (b) equals .swamp/ within the repo
 *   (c) is an ancestor/parent containing a live .swamp/
 *   (d) resolves into .swamp/ via symlink
 *
 * Returns null if the target is safe, or an error message string if it is dangerous.
 */
async function checkRestoreTargetSafety(
  targetDir: string,
  repoDir: string,
): Promise<string | null> {
  if (!targetDir || targetDir.trim() === "") {
    return "targetDir is required for restore — specify an explicit directory to restore into";
  }

  // Resolve both paths to their real, symlink-normalized absolute paths
  let resolvedTarget: string;
  let resolvedRepo: string;

  try {
    resolvedTarget = await Deno.realPath(targetDir);
  } catch {
    // Target doesn't exist yet — check if its ancestor is dangerous
    // Resolve as far as we can
    resolvedTarget = targetDir.startsWith("/") ? targetDir : `${repoDir}/${targetDir}`;
  }

  try {
    resolvedRepo = await Deno.realPath(repoDir);
  } catch {
    resolvedRepo = repoDir;
  }

  const resolvedSwampDir = `${resolvedRepo}/.swamp`;

  // (a) equals repo root
  if (resolvedTarget === resolvedRepo) {
    return `Refusing to restore into the repo root (${resolvedTarget}). Use a staging directory and move files manually.`;
  }

  // (b) equals .swamp/ directory
  if (resolvedTarget === resolvedSwampDir) {
    return `Refusing to restore into .swamp/ directly (${resolvedTarget}). Use a staging directory outside the repo.`;
  }

  // (c) is an ancestor/parent that contains .swamp/ — i.e. target is a prefix of .swamp/
  // This catches restoring to the parent of repoDir, which would clobber .swamp/
  if (resolvedSwampDir.startsWith(resolvedTarget + "/")) {
    return `Refusing to restore into ${resolvedTarget} — it is an ancestor of .swamp/ (${resolvedSwampDir}). Use a staging directory outside the repo.`;
  }

  // (d) resolves into .swamp/ via symlink — i.e. target is inside .swamp/
  if (
    resolvedTarget.startsWith(resolvedSwampDir + "/") ||
    resolvedTarget === resolvedSwampDir
  ) {
    return `Refusing to restore into a path inside .swamp/ (${resolvedTarget}). Use a staging directory outside the repo.`;
  }

  return null;
}

// =============================================================================
// Include/Exclude List Builder
// =============================================================================

/**
 * Build the final include paths and exclude patterns by merging defaults
 * with any overrides from globalArgs.
 */
function buildIncludeExcludeLists(
  globalArgs: z.infer<typeof GlobalArgsSchema>,
): { includePaths: string[]; excludePatterns: string[] } {
  const includePaths = [
    ...DEFAULT_INCLUDE_PATHS,
    ...globalArgs.include,
  ];
  const excludePatterns = [
    ...DEFAULT_EXCLUDE_PATTERNS,
    ...globalArgs.exclude,
  ];
  return { includePaths, excludePatterns };
}

// =============================================================================
// Model Definition
// =============================================================================

/** Restic backup model — manages restic backups of .swamp/ to a Backblaze B2 repository. */
export const model = {
  type: "@atalanta/restic-backup/repository",
  version: "2026.06.27.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    resticStatus: {
      description: "Availability and version of the restic binary",
      schema: ResticStatusSchema,
      lifetime: "7d" as const,
      garbageCollection: 5,
    },
    repositoryStatus: {
      description: "Initialization state of the configured restic repository",
      schema: RepositoryStatusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    backupResult: {
      description:
        "Result of a restic backup run including snapshot ID and transfer statistics",
      schema: BackupResultSchema,
      lifetime: "90d" as const,
      garbageCollection: 100,
    },
    snapshots: {
      description: "List of snapshots in the restic repository",
      schema: SnapshotsSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    checkResult: {
      description: "Result of a restic repository integrity check",
      schema: CheckResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 30,
    },
    restoreResult: {
      description: "Result of a restic restore operation",
      schema: RestoreResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    forgetResult: {
      description:
        "Result of a restic forget operation with retention policy applied",
      schema: ForgetResultSchema,
      lifetime: "90d" as const,
      garbageCollection: 50,
    },
    pruneResult: {
      description:
        "Result of a restic prune operation (expensive — run separately from forget)",
      schema: PruneResultSchema,
      lifetime: "90d" as const,
      garbageCollection: 50,
    },
  },

  methods: {
    checkRestic: {
      description:
        "Check whether the restic binary is installed and return its version",
      arguments: CheckResticArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckResticArgsSchema>,
        context: MethodContext,
      ) => {
        const cwd = context.globalArgs.repoDir;
        const resticPath = context.globalArgs.resticPath;

        // For check_restic, we create dummy secrets since we just need the
        // binary check but invokeRestic always requires secrets. Real secrets
        // are used when available; placeholder values are used when vault refs
        // are not yet configured, allowing binary detection before full setup.
        const secretError = validateSecrets(context.globalArgs);

        let secrets: ResticSecrets;
        if (secretError !== null) {
          // Use placeholder secrets just to check the binary — these won't be
          // used for any actual restic repo operation, just `restic version`
          secrets = {
            resticPassword: "probe",
            b2AccountId: "probe",
            b2AccountKey: "probe",
          };
        } else {
          secrets = extractSecrets(context.globalArgs);
        }

        const probe = await probeResticCapability(resticPath, secrets, cwd);

        const statusData = {
          available: probe.supported,
          version: probe.version ?? undefined,
          binary: resticPath,
          message: probe.message,
        };

        const handle = await context.writeResource(
          "resticStatus",
          "current",
          statusData as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "check_restic: {available} — {message}",
          {
            available: probe.supported,
            message: probe.message,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    init: {
      description:
        "Initialize the configured restic repository (idempotent — safe to run if already initialized)",
      arguments: InitArgsSchema,
      execute: async (
        _args: z.infer<typeof InitArgsSchema>,
        context: MethodContext,
      ) => {
        const secretError = validateSecrets(context.globalArgs);
        if (secretError !== null) {
          throw new Error(
            `Secret validation failed before calling restic: ${secretError}`,
          );
        }

        const secrets = extractSecrets(context.globalArgs);
        const cwd = context.globalArgs.repoDir;
        const resticPath = context.globalArgs.resticPath;
        const repository = context.globalArgs.repository;

        // Verify --json capability before any operational call
        const probe = await probeResticCapability(resticPath, secrets, cwd);
        if (!probe.supported) {
          throw new Error(
            `restic does not support --json: ${probe.message}`,
          );
        }

        const result = await invokeRestic(
          [resticPath, "init", "--json", "--repo", repository],
          secrets,
          cwd,
        );

        // exit code 0 with message_type=initialized → newly created
        // exit code 1 with "config file already exists" in the JSON error → already initialized
        // Both are success states; we distinguish via --json/exit semantics, NOT human text
        let initialized = false;
        let created = false;
        let message = "";

        if (result.success) {
          const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
          if (parsed["message_type"] === "initialized") {
            created = true;
            initialized = true;
            message = `Repository created at ${repository}`;
          }
        } else {
          // Check for already-initialized by looking at the exit_error JSON.
          // restic exits 1 with a JSON exit_error when repo already exists.
          // The JSON may appear on stdout OR stderr depending on restic version
          // and the specific error — check both channels.
          const errorJsonSource = result.stdout.trim() || result.stderr.trim();
          try {
            const errorParsed = JSON.parse(errorJsonSource) as Record<string, unknown>;
            const errorMessage = (errorParsed["message"] as string) ?? "";
            if (
              errorParsed["message_type"] === "exit_error" &&
              (errorMessage.includes("config file already exists") ||
                errorMessage.includes("unable to open repository"))
            ) {
              // Already initialized — this is idempotent, not an error
              initialized = true;
              created = false;
              message = `Repository already initialized at ${repository}`;
            } else {
              throw new Error(
                `restic init failed (exit ${result.exitCode}): ${errorMessage || result.stderr.slice(0, 200)}`,
              );
            }
          } catch (parseError) {
            if (parseError instanceof SyntaxError) {
              throw new Error(
                `restic init --json did not return valid JSON (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
              );
            }
            throw parseError;
          }
        }

        const statusData = { repository, initialized, created, message };
        const handle = await context.writeResource(
          "repositoryStatus",
          "current",
          statusData as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "init: initialized={initialized} created={created}",
          { initialized, created, repository },
        );

        return { dataHandles: [handle] };
      },
    },

    backup: {
      description:
        "Back up the .swamp/ runtime evidence tree to the restic repository",
      arguments: BackupArgsSchema,
      execute: async (
        args: z.infer<typeof BackupArgsSchema>,
        context: MethodContext,
      ) => {
        const secretError = validateSecrets(context.globalArgs);
        if (secretError !== null) {
          throw new Error(
            `Secret validation failed before calling restic: ${secretError}`,
          );
        }

        const secrets = extractSecrets(context.globalArgs);
        const cwd = context.globalArgs.repoDir;
        const resticPath = context.globalArgs.resticPath;
        const repository = context.globalArgs.repository;

        const probe = await probeResticCapability(resticPath, secrets, cwd);
        if (!probe.supported) {
          throw new Error(
            `restic does not support --json: ${probe.message}`,
          );
        }

        const { includePaths, excludePatterns } = buildIncludeExcludeLists(
          context.globalArgs,
        );

        // Build argv array — NEVER a shell string to prevent injection
        const argv: string[] = [resticPath, "backup", "--json", "--repo", repository];
        for (const pattern of excludePatterns) {
          argv.push("--exclude", pattern);
        }
        const allTags = [
          ...(context.globalArgs.hostTag ? [context.globalArgs.hostTag] : []),
          ...context.globalArgs.extraTags,
          ...args.tags,
        ];
        for (const tag of allTags) {
          argv.push("--tag", tag);
        }
        // Include paths come last as positional args
        argv.push(...includePaths);

        const result = await invokeRestic(argv, secrets, cwd);

        if (!result.success) {
          const errorMsg = (() => {
            try {
              const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
              return (parsed["message"] as string) ?? result.stderr.slice(0, 300);
            } catch {
              return result.stderr.slice(0, 300);
            }
          })();
          throw new Error(
            `restic backup failed (exit ${result.exitCode}): ${errorMsg}`,
          );
        }

        // The summary message is the last JSONL line with message_type=summary
        const summary = findJsonlMessage(result.stdout, "summary");
        if (summary === null) {
          throw new Error(
            "restic backup --json did not emit a summary message — cannot parse result",
          );
        }

        const snapshotId = (summary["snapshot_id"] as string) ?? "";
        const startedAt = (summary["backup_start"] as string) ?? new Date().toISOString();
        const completedAt = (summary["backup_end"] as string) ?? new Date().toISOString();
        const fileCount = (summary["total_files_processed"] as number) ?? 0;
        const byteCount = (summary["total_bytes_processed"] as number) ?? 0;
        const durationMs = Math.round(
          ((summary["total_duration"] as number) ?? 0) * 1000,
        );

        const backupData = {
          snapshotId,
          repository,
          startedAt,
          completedAt,
          durationMs,
          includedPaths: includePaths,
          excludedPatterns: excludePatterns,
          fileCount,
          byteCount,
          tags: allTags,
          host: context.globalArgs.hostTag ?? "",
        };

        const handle = await context.writeResource(
          "backupResult",
          `backup-${snapshotId.slice(0, 12)}`,
          backupData as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "backup: snapshot {snapshotId} — {fileCount} files, {byteCount} bytes ({durationMs}ms)",
          {
            snapshotId: snapshotId.slice(0, 12),
            fileCount,
            byteCount,
            durationMs,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    snapshots: {
      description: "List snapshots in the restic repository",
      arguments: SnapshotsArgsSchema,
      execute: async (
        args: z.infer<typeof SnapshotsArgsSchema>,
        context: MethodContext,
      ) => {
        const secretError = validateSecrets(context.globalArgs);
        if (secretError !== null) {
          throw new Error(
            `Secret validation failed before calling restic: ${secretError}`,
          );
        }

        const secrets = extractSecrets(context.globalArgs);
        const cwd = context.globalArgs.repoDir;
        const resticPath = context.globalArgs.resticPath;
        const repository = context.globalArgs.repository;

        const probe = await probeResticCapability(resticPath, secrets, cwd);
        if (!probe.supported) {
          throw new Error(
            `restic does not support --json: ${probe.message}`,
          );
        }

        const argv: string[] = [resticPath, "snapshots", "--json", "--repo", repository];
        if (args.host) {
          argv.push("--host", args.host);
        }
        for (const tag of args.tags) {
          argv.push("--tag", tag);
        }
        if (args.path) {
          argv.push("--path", args.path);
        }

        const result = await invokeRestic(argv, secrets, cwd);

        if (!result.success) {
          throw new Error(
            `restic snapshots failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
          );
        }

        // snapshots --json returns a JSON array
        const snapshotArray = JSON.parse(result.stdout.trim()) as Array<
          Record<string, unknown>
        >;

        const snapshots = snapshotArray.map((snap) => ({
          id: (snap["id"] as string) ?? "",
          shortId: (snap["short_id"] as string) ?? "",
          time: (snap["time"] as string) ?? "",
          hostname: (snap["hostname"] as string) ?? "",
          paths: (snap["paths"] as string[]) ?? [],
          tags: (snap["tags"] as string[]) ?? [],
          username: (snap["username"] as string) ?? "",
        }));

        const sortedByTime = [...snapshots].sort((a, b) =>
          a.time.localeCompare(b.time)
        );
        const latest = sortedByTime[sortedByTime.length - 1];

        const snapshotsData = {
          snapshots,
          latestSnapshotId: latest?.id ?? undefined,
          latestTime: latest?.time ?? undefined,
          count: snapshots.length,
        };

        const handle = await context.writeResource(
          "snapshots",
          "current",
          snapshotsData as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "snapshots: {count} snapshots, latest={latest}",
          {
            count: snapshots.length,
            latest: latest?.id?.slice(0, 12) ?? "none",
          },
        );

        return { dataHandles: [handle] };
      },
    },

    check: {
      description: "Check the restic repository for integrity errors",
      arguments: CheckArgsSchema,
      execute: async (
        _args: z.infer<typeof CheckArgsSchema>,
        context: MethodContext,
      ) => {
        const secretError = validateSecrets(context.globalArgs);
        if (secretError !== null) {
          throw new Error(
            `Secret validation failed before calling restic: ${secretError}`,
          );
        }

        const secrets = extractSecrets(context.globalArgs);
        const cwd = context.globalArgs.repoDir;
        const resticPath = context.globalArgs.resticPath;
        const repository = context.globalArgs.repository;

        const probe = await probeResticCapability(resticPath, secrets, cwd);
        if (!probe.supported) {
          throw new Error(
            `restic does not support --json: ${probe.message}`,
          );
        }

        const result = await invokeRestic(
          [resticPath, "check", "--json", "--repo", repository],
          secrets,
          cwd,
        );

        // check --json emits a summary JSONL line
        // exit 0 = ok, exit non-zero = errors found
        const summary = findJsonlMessage(result.stdout, "summary");

        const numErrors = (summary?.["num_errors"] as number) ?? 0;
        const ok = result.success && numErrors === 0;

        // Collect any error lines (message_type=error) from the JSONL output
        const errorLines = result.stdout
          .trim()
          .split("\n")
          .filter((line) => line.trim() !== "")
          .flatMap((line) => {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed["message_type"] === "error") {
                return [(parsed["message"] as string) ?? line];
              }
              return [];
            } catch {
              return [];
            }
          });

        const checkData = {
          ok,
          errors: errorLines,
          warnings: [],
          checkedAt: new Date().toISOString(),
        };

        const handle = await context.writeResource(
          "checkResult",
          `check-${new Date().toISOString().slice(0, 10)}`,
          checkData as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "check: ok={ok}, errors={errorCount}",
          {
            ok,
            errorCount: errorLines.length,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    restore: {
      description:
        "Restore a snapshot to a target directory. Refuses to restore into repo root, .swamp/, or ancestor directories without explicit confirm:true",
      arguments: RestoreArgsSchema,
      execute: async (
        args: z.infer<typeof RestoreArgsSchema>,
        context: MethodContext,
      ) => {
        if (!args.targetDir || args.targetDir.trim() === "") {
          throw new Error(
            "targetDir is required for restore — specify an explicit directory to restore into",
          );
        }

        // Check restore safety BEFORE any secret validation or restic invocation
        const safetyError = await checkRestoreTargetSafety(
          args.targetDir,
          context.globalArgs.repoDir,
        );
        if (safetyError !== null && !args.confirm) {
          throw new Error(
            `Restore refused (dangerous target): ${safetyError}. Set confirm:true to override.`,
          );
        }

        const secretError = validateSecrets(context.globalArgs);
        if (secretError !== null) {
          throw new Error(
            `Secret validation failed before calling restic: ${secretError}`,
          );
        }

        const secrets = extractSecrets(context.globalArgs);
        const cwd = context.globalArgs.repoDir;
        const resticPath = context.globalArgs.resticPath;
        const repository = context.globalArgs.repository;

        const probe = await probeResticCapability(resticPath, secrets, cwd);
        if (!probe.supported) {
          throw new Error(
            `restic does not support --json: ${probe.message}`,
          );
        }

        const result = await invokeRestic(
          [
            resticPath,
            "restore",
            args.snapshot,
            "--json",
            "--repo",
            repository,
            "--target",
            args.targetDir,
          ],
          secrets,
          cwd,
        );

        if (!result.success) {
          const errorMsg = (() => {
            try {
              const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
              return (parsed["message"] as string) ?? result.stderr.slice(0, 300);
            } catch {
              return result.stderr.slice(0, 300);
            }
          })();
          throw new Error(
            `restic restore failed (exit ${result.exitCode}): ${errorMsg}`,
          );
        }

        const summary = findJsonlMessage(result.stdout, "summary");

        const filesRestored = (summary?.["files_restored"] as number) ?? 0;
        const bytesRestored = (summary?.["bytes_restored"] as number) ?? 0;

        const restoreData = {
          snapshotId: args.snapshot,
          targetDir: args.targetDir,
          filesRestored,
          bytesRestored,
          message: `Restored snapshot ${args.snapshot} to ${args.targetDir}`,
        };

        const handle = await context.writeResource(
          "restoreResult",
          `restore-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
          restoreData as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "restore: {files} files, {bytes} bytes restored to {target}",
          {
            files: filesRestored,
            bytes: bytesRestored,
            target: args.targetDir,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    forget: {
      description:
        "Apply a retention policy and remove old snapshots. Does NOT run prune — use the prune method separately to free disk space",
      arguments: ForgetArgsSchema,
      execute: async (
        args: z.infer<typeof ForgetArgsSchema>,
        context: MethodContext,
      ) => {
        const secretError = validateSecrets(context.globalArgs);
        if (secretError !== null) {
          throw new Error(
            `Secret validation failed before calling restic: ${secretError}`,
          );
        }

        const secrets = extractSecrets(context.globalArgs);
        const cwd = context.globalArgs.repoDir;
        const resticPath = context.globalArgs.resticPath;
        const repository = context.globalArgs.repository;

        const probe = await probeResticCapability(resticPath, secrets, cwd);
        if (!probe.supported) {
          throw new Error(
            `restic does not support --json: ${probe.message}`,
          );
        }

        // Merge method-level retention args with globalArgs defaults —
        // method-level args take precedence, then fall back to global retention policy
        const keepLast = args.keepLast ?? context.globalArgs.retention.keepLast;
        const keepDaily = args.keepDaily ?? context.globalArgs.retention.keepDaily;
        const keepWeekly = args.keepWeekly ?? context.globalArgs.retention.keepWeekly;
        const keepMonthly = args.keepMonthly ?? context.globalArgs.retention.keepMonthly;

        const argv: string[] = [resticPath, "forget", "--json", "--repo", repository];
        if (keepLast !== undefined) argv.push("--keep-last", String(keepLast));
        if (keepDaily !== undefined) argv.push("--keep-daily", String(keepDaily));
        if (keepWeekly !== undefined) argv.push("--keep-weekly", String(keepWeekly));
        if (keepMonthly !== undefined) argv.push("--keep-monthly", String(keepMonthly));
        if (args.dryRun) argv.push("--dry-run");
        if (args.host) argv.push("--host", args.host);

        const result = await invokeRestic(argv, secrets, cwd);

        if (!result.success) {
          throw new Error(
            `restic forget failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
          );
        }

        // forget --json returns an array of group objects
        const groups = JSON.parse(result.stdout.trim()) as Array<
          Record<string, unknown>
        >;

        let totalRemoved = 0;
        for (const group of groups) {
          const removeList = (group["remove"] as unknown[]) ?? [];
          totalRemoved += removeList.length;
        }

        const policy = { keepLast, keepDaily, keepWeekly, keepMonthly };

        const forgetData = {
          policy,
          snapshotsRemoved: totalRemoved,
          dryRun: args.dryRun,
        };

        const handle = await context.writeResource(
          "forgetResult",
          `forget-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
          forgetData as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "forget: {removed} snapshots removed (dryRun={dryRun})",
          {
            removed: totalRemoved,
            dryRun: args.dryRun,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    prune: {
      description:
        "Free disk space by removing unreferenced data packs. Expensive operation — run after forget, not on every backup cycle",
      arguments: PruneArgsSchema,
      execute: async (
        _args: z.infer<typeof PruneArgsSchema>,
        context: MethodContext,
      ) => {
        const secretError = validateSecrets(context.globalArgs);
        if (secretError !== null) {
          throw new Error(
            `Secret validation failed before calling restic: ${secretError}`,
          );
        }

        const secrets = extractSecrets(context.globalArgs);
        const cwd = context.globalArgs.repoDir;
        const resticPath = context.globalArgs.resticPath;
        const repository = context.globalArgs.repository;

        const probe = await probeResticCapability(resticPath, secrets, cwd);
        if (!probe.supported) {
          throw new Error(
            `restic does not support --json: ${probe.message}`,
          );
        }

        const startTime = performance.now();
        const result = await invokeRestic(
          [resticPath, "prune", "--json", "--repo", repository],
          secrets,
          cwd,
        );
        const durationMs = Math.round(performance.now() - startTime);

        if (!result.success) {
          // prune may exit non-zero even on partial success; check stderr
          throw new Error(
            `restic prune failed (exit ${result.exitCode}): ${result.stderr.slice(0, 200)}`,
          );
        }

        // restic prune --json emits no JSON in any released version (upstream gap).
        // Success is determined solely by exit code above. Raw output is preserved
        // for audit purposes. bytesFreed/packsRemoved are intentionally omitted —
        // they were unused and scraping human text would violate the
        // no-human-text-parser invariant. Populate from JSON once restic adds
        // prune JSON support.
        const rawOutput = (result.stdout + result.stderr).slice(0, 2000);

        const pruneData = {
          durationMs,
          rawOutput,
        };

        const handle = await context.writeResource(
          "pruneResult",
          `prune-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
          pruneData as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "prune: completed in {durationMs}ms",
          { durationMs },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};

// parseResticJsonOutput is not called by the model methods directly (they use
// findJsonlMessage or inline JSON.parse for their specific shapes), but it is
// exported for use in tests that verify the no-human-text-parser invariant.
export { parseResticJsonOutput };
