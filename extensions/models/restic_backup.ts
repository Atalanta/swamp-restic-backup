/**
 * Restic Backup Model — thin registration shell.
 *
 * Imports the eight method definitions from _lib/methods/* and wires them into
 * the model. All execute bodies live in their own focused modules; this file
 * contains only: imports, the public re-export block (four helpers/constants),
 * model metadata, the resources map, and model.methods referencing the imports.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_PATHS,
} from "./_lib/policy.ts";
import {
  BackupResultSchema,
  CheckResultSchema,
  ForgetResultSchema,
  GlobalArgsSchema,
  PruneResultSchema,
  RepositoryStatusSchema,
  ResticStatusSchema,
  RestoreResultSchema,
  SnapshotsSchema,
} from "./_lib/schemas.ts";
import {
  checkRestoreTargetSafety,
} from "./_lib/path-safety.ts";
import {
  parseResticJsonOutput,
} from "./_lib/decode.ts";

import { checkRestic } from "./_lib/methods/check-restic.ts";
import { init } from "./_lib/methods/init.ts";
import { backup } from "./_lib/methods/backup.ts";
import { snapshots } from "./_lib/methods/snapshots.ts";
import { check } from "./_lib/methods/check.ts";
import { restore } from "./_lib/methods/restore.ts";
import { forget } from "./_lib/methods/forget.ts";
import { prune } from "./_lib/methods/prune.ts";

// Re-export the public surface this module exposed before the _lib/ split, so
// the extension's public API is unchanged by the refactor.
export {
  checkRestoreTargetSafety,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_PATHS,
  parseResticJsonOutput,
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
    checkRestic,
    init,
    backup,
    snapshots,
    check,
    restore,
    forget,
    prune,
  },
};
