/**
 * backup method — back up the .swamp/ runtime evidence tree to the restic repository.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { BackupArgsSchema, ResticBackupSummarySchema } from "../schemas.ts";
import { invokeResticBackup } from "../commands.ts";
import { decodeResticSummary } from "../decode.ts";
import { runSecretPreflight } from "../preflight.ts";
import { buildIncludeExcludeLists } from "../policy.ts";
import { redactSecrets } from "../secrets.ts";
import type { MethodContext } from "../method-context.ts";

export const backup = {
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

    const allTags = [
      ...(context.globalArgs.hostTag ? [context.globalArgs.hostTag] : []),
      ...context.globalArgs.extraTags,
      ...args.tags,
    ];

    // Pass typed inputs to the invoker; it assembles argv internally.
    // Exclude-then-tag-then-positional-paths order is enforced inside invokeResticBackup.
    const result = await invokeResticBackup(
      { excludePatterns, tags: allTags, includePaths },
      repository,
      secrets,
      resticPath,
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
};
