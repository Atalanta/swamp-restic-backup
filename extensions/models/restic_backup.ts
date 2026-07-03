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
import {
  buildIncludeExcludeLists,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_PATHS,
} from "./_lib/policy.ts";
import {
  BackupArgsSchema,
  BackupResultSchema,
  CheckArgsSchema,
  CheckResticArgsSchema,
  CheckResultSchema,
  ForgetArgsSchema,
  ForgetResultSchema,
  GlobalArgsSchema,
  InitArgsSchema,
  PruneArgsSchema,
  PruneResultSchema,
  RepositoryStatusSchema,
  ResticBackupSummarySchema,
  ResticCheckSummarySchema,
  ResticForgetArraySchema,
  ResticInitOutputSchema,
  ResticRestoreSummarySchema,
  ResticSnapshotArraySchema,
  ResticStatusSchema,
  RestoreArgsSchema,
  RestoreResultSchema,
  SnapshotsArgsSchema,
  SnapshotsSchema,
} from "./_lib/schemas.ts";
import { checkRestoreTargetSafety } from "./_lib/path-safety.ts";
import { redactSecrets } from "./_lib/secrets.ts";
import {
  decodeResticCheckOutput,
  decodeResticOutput,
  decodeResticSummary,
  invokeRestic,
  parseResticJsonOutput,
  probeResticCapability,
} from "./_lib/invoker.ts";
import { runSecretPreflight } from "./_lib/preflight.ts";

// Re-export the public surface this module exposed before the _lib/ split, so
// the extension's public API is unchanged by the refactor.
export {
  checkRestoreTargetSafety,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_PATHS,
  parseResticJsonOutput,
};

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
        const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
          context.globalArgs,
        );

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
          // Decode and validate the whole-payload init result via the boundary decoder.
          // decodeResticOutput parses the stdout and validates it against the Zod schema
          // (message_type=="initialized" is a required literal — schema mismatch throws
          // a sanitized boundary error). No raw output is embedded in any error path.
          decodeResticOutput(result.stdout, ResticInitOutputSchema, "init");
          created = true;
          initialized = true;
          message = `Repository created at ${repository}`;
        } else {
          // init failed — surface the JSON error message if available, otherwise stderr.
          // We do NOT classify the error by message text; all non-zero exits are failures.
          // Apply redactSecrets before including any subprocess output in the thrown error
          // to prevent accidental secret reflection into logs or error messages.
          const errorJsonSource = result.stdout.trim() || result.stderr.trim();
          let errorDetail = redactSecrets(result.stderr.slice(0, 300), secrets);
          try {
            const errorParsed = JSON.parse(errorJsonSource) as Record<string, unknown>;
            errorDetail = redactSecrets(
              (errorParsed["message"] as string) ?? result.stderr.slice(0, 300),
              secrets,
            );
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
        const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
          context.globalArgs,
        );

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
          // Redact secrets from any subprocess-derived text before including in the error.
          const errorMsg = (() => {
            try {
              const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
              return redactSecrets(
                (parsed["message"] as string) ?? result.stderr.slice(0, 300),
                secrets,
              );
            } catch {
              return redactSecrets(result.stderr.slice(0, 300), secrets);
            }
          })();
          throw new Error(
            `restic backup failed (exit ${result.exitCode}): ${errorMsg}`,
          );
        }

        // Decode and validate the JSONL summary line via the boundary decoder.
        // decodeResticSummary locates the last message_type=='summary' line and
        // validates it against the Zod schema — fails with a sanitized error on
        // parse failure, schema mismatch, or missing summary line (all boundary errors).
        const summary = decodeResticSummary(
          result.stdout,
          ResticBackupSummarySchema,
          "backup",
        );

        const snapshotId = summary.snapshot_id;
        const startedAt = summary.backup_start;
        const completedAt = summary.backup_end;
        const fileCount = summary.total_files_processed;
        const byteCount = summary.total_bytes_processed;
        const durationMs = Math.round(summary.total_duration * 1000);

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
        const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
          context.globalArgs,
        );

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
            `restic snapshots failed (exit ${result.exitCode}): ${redactSecrets(result.stderr.slice(0, 200), secrets)}`,
          );
        }

        // Decode and validate the whole-payload JSON array via the boundary decoder.
        // decodeResticOutput parses the entire stdout and validates against the Zod
        // schema — a non-array payload fails at the boundary, not with a TypeError on .map.
        const snapshotArray = decodeResticOutput(
          result.stdout,
          ResticSnapshotArraySchema,
          "snapshots",
        );

        const snapshots = snapshotArray.map((snap) => ({
          id: snap.id,
          shortId: snap.short_id,
          time: snap.time,
          hostname: snap.hostname,
          paths: snap.paths,
          // username is OPTIONAL in the restic output schema (absent on older restic);
          // map absent → "" to preserve the public result-resource shape.
          tags: snap.tags ?? [],
          username: snap.username ?? "",
        }));

        // Select latest by chronological time comparison. Parse each timestamp to
        // epoch millis ONCE up front (Date.parse handles restic's RFC3339 output),
        // then sort on the precomputed value — NOT localeCompare, which is
        // locale-sensitive, and not reparsing inside the comparator.
        const withTimeMs = snapshots.map((snap) => ({ snap, timeMs: Date.parse(snap.time) }));
        withTimeMs.sort((a, b) => a.timeMs - b.timeMs);
        const latest = withTimeMs[withTimeMs.length - 1]?.snap;

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
        const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
          context.globalArgs,
        );

        const result = await invokeRestic(
          [resticPath, "check", "--json", "--repo", repository],
          secrets,
          cwd,
        );

        // check output is decoded by the invoker-owned, exit-code-aware boundary
        // helper: a valid summary is returned; an exit-0-without-valid-summary is a
        // boundary failure (throws); a non-zero exit with no summary returns null
        // (the check itself failed — recorded as ok:false below, not a shape
        // mismatch). A well-formed summary with num_errors>0 is a valid
        // integrity-failure result, not a shape mismatch.
        const checkSummary = decodeResticCheckOutput(
          result.stdout,
          result.success,
          ResticCheckSummarySchema,
        );

        const numErrors = checkSummary?.num_errors ?? 0;
        const ok = result.success && numErrors === 0;

        // Collect any error lines (message_type=error) from the JSONL output.
        // Defensively redact secrets from message text before persisting to resource.
        const errorLines = result.stdout
          .trim()
          .split("\n")
          .filter((line) => line.trim() !== "")
          .flatMap((line) => {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              if (parsed["message_type"] === "error") {
                const rawMsg = (parsed["message"] as string) ?? line;
                return [redactSecrets(rawMsg, secrets)];
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

        const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
          context.globalArgs,
        );

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
          // Redact secrets from any subprocess-derived text before including in the error.
          const errorMsg = (() => {
            try {
              const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
              return redactSecrets(
                (parsed["message"] as string) ?? result.stderr.slice(0, 300),
                secrets,
              );
            } catch {
              return redactSecrets(result.stderr.slice(0, 300), secrets);
            }
          })();
          throw new Error(
            `restic restore failed (exit ${result.exitCode}): ${errorMsg}`,
          );
        }

        // Decode and validate the JSONL summary line via the boundary decoder.
        // decodeResticSummary locates the last message_type=='summary' line and
        // validates it — fails with a sanitized error on parse failure, schema
        // mismatch, or missing summary line (all boundary errors).
        const restoreSummary = decodeResticSummary(
          result.stdout,
          ResticRestoreSummarySchema,
          "restore",
        );

        const filesRestored = restoreSummary.files_restored;
        const bytesRestored = restoreSummary.bytes_restored;

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
        const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
          context.globalArgs,
        );

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
            `restic forget failed (exit ${result.exitCode}): ${redactSecrets(result.stderr.slice(0, 200), secrets)}`,
          );
        }

        // Decode and validate the whole-payload JSON array via the boundary decoder.
        // decodeResticOutput parses the entire stdout and validates against the Zod
        // schema — fails with a sanitized error on parse failure or schema mismatch.
        const groups = decodeResticOutput(
          result.stdout,
          ResticForgetArraySchema,
          "forget",
        );

        let totalRemoved = 0;
        for (const group of groups) {
          const removeList = group.remove ?? [];
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
        const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
          context.globalArgs,
        );

        const startTime = performance.now();
        const result = await invokeRestic(
          [resticPath, "prune", "--json", "--repo", repository],
          secrets,
          cwd,
        );
        const durationMs = Math.round(performance.now() - startTime);

        if (!result.success) {
          // prune may exit non-zero even on partial success; check stderr.
          // Redact secrets defensively — restic reads them from env, not args,
          // but belt-and-suspenders for any accidental reflection in diagnostic output.
          throw new Error(
            `restic prune failed (exit ${result.exitCode}): ${redactSecrets(result.stderr.slice(0, 200), secrets)}`,
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

