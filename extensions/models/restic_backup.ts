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
  // Vault references — set these to CEL vault.get() expressions in your swamp
  // definition. swamp resolves them at runtime before calling execute, so the
  // model receives plain resolved strings. The vault backend (local encrypted,
  // AWS Secrets Manager, 1Password, etc.) is abstracted by swamp; the model
  // is agnostic because it only sees resolved strings.
  //
  // Example (B2 credentials stored in a vault named "backup-vault"):
  //   resticPassword: vault.get('backup-vault', 'restic_password')
  //   b2AccountId:    vault.get('backup-vault', 'b2_account_id')
  //   b2AccountKey:   vault.get('backup-vault', 'b2_account_key')
  //
  // Missing or empty values cause a structured error before restic is called.
  resticPassword: z.string().describe(
    "MUST be a vault.get('vault-name','key') CEL expression — swamp resolves this to RESTIC_PASSWORD at runtime. Example: vault.get('backup-vault','restic_password')",
  ),
  b2AccountId: z.string().describe(
    "MUST be a vault.get('vault-name','key') CEL expression — swamp resolves this to B2_ACCOUNT_ID at runtime. Example: vault.get('backup-vault','b2_account_id')",
  ),
  b2AccountKey: z.string().describe(
    "MUST be a vault.get('vault-name','key') CEL expression — swamp resolves this to B2_ACCOUNT_KEY at runtime. Example: vault.get('backup-vault','b2_account_key')",
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

/**
 * Defensively replace all occurrences of known secret values in a string with
 * the placeholder "[REDACTED]". Used before persisting any subprocess output to
 * the resource store. Belt-and-suspenders: restic reads secrets from env and
 * should never echo them back, but this guards against unexpected reflection in
 * diagnostic or error output.
 */
function redactSecrets(text: string, secrets: ResticSecrets): string {
  let redacted = text;
  // Replace each secret value; skip empty strings to avoid corrupting all output.
  if (secrets.resticPassword) {
    redacted = redacted.replaceAll(secrets.resticPassword, "[REDACTED]");
  }
  if (secrets.b2AccountId) {
    redacted = redacted.replaceAll(secrets.b2AccountId, "[REDACTED]");
  }
  if (secrets.b2AccountKey) {
    redacted = redacted.replaceAll(secrets.b2AccountKey, "[REDACTED]");
  }
  return redacted;
}

// =============================================================================
// Restic Invoker
// =============================================================================

/**
 * Invoke a restic command.
 * argv[0] is the binary; all subsequent elements are arguments.
 * env overrides the full subprocess environment — callers must supply the
 * complete env they want (see invokeRestic and invokeResticNoSecrets below).
 * Returns the raw stdout/stderr/exitCode without parsing.
 */
async function spawnRestic(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<ResticResult> {
  const startTime = performance.now();

  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
    cwd,
    env,
  });

  // Deno.Command.output() throws a NotFound error when the binary doesn't exist.
  // Catch and return a structured failure so callers can surface a clean message.
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

/**
 * Invoke a restic command that requires repo access.
 * Secrets are injected ONLY via subprocess env (RESTIC_PASSWORD, B2_ACCOUNT_ID,
 * B2_ACCOUNT_KEY) — never as argv or in any logged output.
 * Must only be called AFTER validateSecrets returns null.
 */
async function invokeRestic(
  argv: string[],
  secrets: ResticSecrets,
  cwd: string,
): Promise<ResticResult> {
  // Build subprocess env: inherit current env then inject secrets, overwriting
  // any pre-existing RESTIC_PASSWORD/B2_* values to prevent ambient leakage.
  const subprocessEnv: Record<string, string> = { ...Deno.env.toObject() };
  subprocessEnv["RESTIC_PASSWORD"] = secrets.resticPassword;
  subprocessEnv["B2_ACCOUNT_ID"] = secrets.b2AccountId;
  subprocessEnv["B2_ACCOUNT_KEY"] = secrets.b2AccountKey;
  return spawnRestic(argv, subprocessEnv, cwd);
}

/**
 * Invoke a restic command that does NOT touch the repository (e.g. `restic version`).
 * No secrets are injected. Used by the capability probe so that check_restic can
 * verify binary presence without requiring vault secrets to be configured.
 */
async function invokeResticNoSecrets(
  argv: string[],
  cwd: string,
): Promise<ResticResult> {
  // Inherit the ambient env without adding any secret keys.
  const subprocessEnv: Record<string, string> = { ...Deno.env.toObject() };
  return spawnRestic(argv, subprocessEnv, cwd);
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
 * Probe whether the restic binary is present and supports `--json` output.
 *
 * This checks only what it can verify without touching the repository: it runs
 * `restic version --json` (no repo credentials needed) and confirms the output
 * is valid JSON with message_type="version". It does NOT verify every command's
 * --json behaviour individually — that is guaranteed by restic >= 0.9.6 for all
 * commands this model uses. The probe is a structural binary-present + JSON-capable
 * check; if it fails, all operational methods refuse to run.
 *
 * No secrets are injected — `restic version` requires no repo access.
 */
async function probeResticCapability(
  resticPath: string,
  cwd: string,
): Promise<{ supported: boolean; version: string | null; message: string }> {
  const result = await invokeResticNoSecrets(
    [resticPath, "version", "--json"],
    cwd,
  );

  if (!result.success && result.exitCode !== 0) {
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
        message: `restic version --json did not emit message_type="version" (got '${parsed["message_type"]}') — binary may not support --json`,
      };
    }
    return {
      supported: true,
      version: (parsed["version"] as string) ?? null,
      message: `restic ${parsed["version"]} detected; --json output confirmed`,
    };
  } catch (parseError) {
    return {
      supported: false,
      version: null,
      message: `restic version --json did not emit valid JSON — binary may not support --json: ${String(parseError)}`,
    };
  }
}

// =============================================================================
// Restore Safety Checker
// =============================================================================

/**
 * Normalize an absolute path by collapsing `.` and `..` segments without
 * touching the filesystem. This is a pure string operation applied BEFORE
 * any existence checks, ensuring that paths like `/a/b/../.swamp` are
 * collapsed to `/a/.swamp` even when `/a/b` does not exist.
 */
function normalizePosixPath(absPath: string): string {
  const segments = absPath.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      // Skip empty and current-dir segments; preserve leading empty for root.
      if (normalized.length === 0) normalized.push("");
      continue;
    }
    if (segment === "..") {
      // Pop the last real segment, but never go above root.
      if (normalized.length > 1) normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/") || "/";
}

/**
 * Resolve a path to its real, symlink-normalized absolute path even when the
 * target doesn't fully exist yet.
 *
 * Algorithm:
 *   1. Make the path absolute.
 *   2. Collapse all `.` and `..` segments via string normalization first — this
 *      handles traversal attacks even for non-existent paths.
 *   3. Try Deno.realPath on the normalized path (handles symlinks if it exists).
 *   4. If that fails, walk up the normalized path to find the deepest existing
 *      ancestor, resolve that via Deno.realPath (handles symlinks in the
 *      existing portion), then re-append the non-existing tail.
 *
 * This prevents both `../` traversal and symlink-parent-with-missing-child
 * bypasses of the safety checker.
 */
async function resolvePathWithAncestor(rawPath: string, cwd: string): Promise<string> {
  // Make the path absolute and collapse all `.` / `..` segments.
  const absPath = rawPath.startsWith("/") ? rawPath : `${cwd}/${rawPath}`;
  const normalizedPath = normalizePosixPath(absPath);

  // Try the full normalized path first (common case: target already exists).
  try {
    return await Deno.realPath(normalizedPath);
  } catch { /* target doesn't exist — walk up */ }

  // Split the already-normalized path into segments.
  const segments = normalizedPath.split("/").filter((s) => s !== "");
  let existingAncestor = "/";
  let lastExistingIndex = -1;

  for (let i = 0; i < segments.length; i++) {
    const candidate = "/" + segments.slice(0, i + 1).join("/");
    try {
      await Deno.lstat(candidate);
      lastExistingIndex = i;
      existingAncestor = candidate;
    } catch {
      // This segment doesn't exist — stop searching further.
      break;
    }
  }

  // Resolve the existing ancestor through any symlinks.
  let resolvedAncestor: string;
  try {
    resolvedAncestor = await Deno.realPath(existingAncestor);
  } catch {
    resolvedAncestor = existingAncestor;
  }

  // Re-append the non-existing tail segments (already free of `.`/`..`).
  const remainingSegments = segments.slice(lastExistingIndex + 1);
  if (remainingSegments.length === 0) {
    return resolvedAncestor;
  }
  return `${resolvedAncestor}/${remainingSegments.join("/")}`;
}

/**
 * Check whether a proposed restore target directory is dangerous.
 *
 * Refuses (returns an error message string) when the resolved, symlink-normalized
 * targetDir:
 *   (a) equals repo root
 *   (b) equals .swamp/ within the repo
 *   (c) is an ancestor/parent containing a live .swamp/
 *   (d) resolves into .swamp/ via symlink (including when the final segment doesn't exist)
 *
 * Uses resolvePathWithAncestor to handle `../` traversal and symlink-parent-with-
 * missing-child cases that Deno.realPath alone would miss.
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

  // Resolve both paths fully, including through symlinks and ../  segments.
  const resolvedTarget = await resolvePathWithAncestor(targetDir, repoDir);
  const resolvedRepo = await resolvePathWithAncestor(repoDir, repoDir);
  const resolvedSwampDir = `${resolvedRepo}/.swamp`;

  // (a) equals repo root
  if (resolvedTarget === resolvedRepo) {
    return `Refusing to restore into the repo root (${resolvedTarget}). Use a staging directory and move files manually.`;
  }

  // (b) equals .swamp/ directory
  if (resolvedTarget === resolvedSwampDir) {
    return `Refusing to restore into .swamp/ directly (${resolvedTarget}). Use a staging directory outside the repo.`;
  }

  // (c) is an ancestor/parent that contains .swamp/ — i.e. the .swamp/ path starts with target
  if (resolvedSwampDir.startsWith(resolvedTarget + "/")) {
    return `Refusing to restore into ${resolvedTarget} — it is an ancestor of .swamp/ (${resolvedSwampDir}). Use a staging directory outside the repo.`;
  }

  // (d) resolves into .swamp/ (including via symlink or missing-child traversal)
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

        // check_restic only probes the binary via `restic version --json`.
        // That command requires no repository credentials, so NO secrets are
        // injected here. This is the only method that does not validate or use
        // secrets — it is explicitly a binary-availability check, not a repo op.
        const probe = await probeResticCapability(resticPath, cwd);

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
        const probe = await probeResticCapability(resticPath, cwd);
        if (!probe.supported) {
          throw new Error(
            `restic does not support --json: ${probe.message}`,
          );
        }

        // Idempotency probe: check whether the repository is already accessible
        // by running `restic cat config --json` before attempting init.
        // This gives a machine-readable yes/no answer based on exit code alone,
        // without classifying error messages by free-form text. Exit 0 → repo
        // exists and is openable with these credentials. Non-zero → repo does
        // not exist OR cannot be opened (bad creds, corrupt repo, backend error).
        // We only treat exit 0 as "already initialized"; everything else proceeds
        // to `restic init` and lets restic itself report any real failure.
        const catConfigResult = await invokeRestic(
          [resticPath, "cat", "config", "--json", "--repo", repository],
          secrets,
          cwd,
        );

        if (catConfigResult.success) {
          // Repository already exists and is openable — report initialized, not created.
          const statusData = {
            repository,
            initialized: true,
            created: false,
            message: `Repository already initialized at ${repository}`,
          };
          const handle = await context.writeResource(
            "repositoryStatus",
            "current",
            statusData as unknown as Record<string, unknown>,
          );
          context.logger.info(
            "init: repository already exists, skipping init",
            { repository },
          );
          return { dataHandles: [handle] };
        }

        // Repository is not yet openable — attempt to create it.
        const result = await invokeRestic(
          [resticPath, "init", "--json", "--repo", repository],
          secrets,
          cwd,
        );

        let initialized = false;
        let created = false;
        let message = "";

        if (result.success) {
          const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
          if (parsed["message_type"] === "initialized") {
            created = true;
            initialized = true;
            message = `Repository created at ${repository}`;
          } else {
            throw new Error(
              `restic init --json returned unexpected message_type='${parsed["message_type"]}' (expected 'initialized')`,
            );
          }
        } else {
          // init failed — surface the JSON error message if available, otherwise stderr.
          // We do NOT classify the error by message text; all non-zero exits are failures.
          const errorJsonSource = result.stdout.trim() || result.stderr.trim();
          let errorDetail = result.stderr.slice(0, 300);
          try {
            const errorParsed = JSON.parse(errorJsonSource) as Record<string, unknown>;
            errorDetail = (errorParsed["message"] as string) ?? errorDetail;
          } catch { /* keep stderr fallback */ }
          throw new Error(
            `restic init failed (exit ${result.exitCode}): ${errorDetail}`,
          );
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

        const probe = await probeResticCapability(resticPath, cwd);
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

        const probe = await probeResticCapability(resticPath, cwd);
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

        const probe = await probeResticCapability(resticPath, cwd);
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

        const probe = await probeResticCapability(resticPath, cwd);
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

        const probe = await probeResticCapability(resticPath, cwd);
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

        const probe = await probeResticCapability(resticPath, cwd);
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
        //
        // Defensively redact the three secret values from rawOutput even though
        // restic reads them from env (not args) and should never echo them back.
        // Belt-and-suspenders: any accidental secret reflection in diagnostic
        // output must not be persisted to the resource store.
        const rawOutputUnredacted = (result.stdout + result.stderr).slice(0, 2000);
        const rawOutput = redactSecrets(rawOutputUnredacted, secrets);

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
