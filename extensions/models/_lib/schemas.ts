/**
 * All Zod schemas and their inferred TypeScript types for the restic backup
 * model. Pure module — no IO, no subprocess, no secrets.
 *
 * Includes:
 *   - Resource result schemas (ResticStatus, RepositoryStatus, etc.)
 *   - GlobalArgsSchema (global model arguments)
 *   - Per-method argument schemas
 *
 * Does NOT include:
 *   - ResticResult (owned by invoker.ts — not schema-derived)
 *   - ResticSecrets (owned by secrets.ts — not schema-derived)
 *   - MethodContext (owned by restic_backup.ts — runtime-injected port)
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";

// =============================================================================
// Resource Schemas
// =============================================================================

export const ResticStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  binary: z.string().optional(),
  message: z.string(),
});

export const RepositoryStatusSchema = z.object({
  repository: z.string(),
  initialized: z.boolean(),
  created: z.boolean(),
  message: z.string(),
});

export const BackupResultSchema = z.object({
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

export const SnapshotsSchema = z.object({
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

export const CheckResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  checkedAt: z.string(),
});

export const RestoreResultSchema = z.object({
  snapshotId: z.string(),
  targetDir: z.string(),
  filesRestored: z.number(),
  bytesRestored: z.number(),
  message: z.string(),
});

export const ForgetResultSchema = z.object({
  policy: z.object({
    keepLast: z.number().optional(),
    keepDaily: z.number().optional(),
    keepWeekly: z.number().optional(),
    keepMonthly: z.number().optional(),
  }),
  snapshotsRemoved: z.number(),
  dryRun: z.boolean(),
});

export const PruneResultSchema = z.object({
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

export const GlobalArgsSchema = z.object({
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

/** The resolved global arguments a model method receives (schema-inferred). */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// =============================================================================
// Method Argument Schemas
// =============================================================================

export const CheckResticArgsSchema = z.object({});

export const InitArgsSchema = z.object({});

export const BackupArgsSchema = z.object({
  tags: z.array(z.string()).default([]),
});

export const SnapshotsArgsSchema = z.object({
  host: z.string().optional(),
  tags: z.array(z.string()).default([]),
  path: z.string().optional(),
});

export const CheckArgsSchema = z.object({});

export const RestoreArgsSchema = z.object({
  snapshot: z.string().default("latest"),
  targetDir: z.string().describe(
    "Directory to restore into — required",
  ),
  confirm: z.boolean().default(false).describe(
    "Set to true to allow restoring over dangerous targets (repo root, .swamp/)",
  ),
});

export const ForgetArgsSchema = z.object({
  keepLast: z.number().optional(),
  keepDaily: z.number().optional(),
  keepWeekly: z.number().optional(),
  keepMonthly: z.number().optional(),
  dryRun: z.boolean().default(false),
  host: z.string().optional(),
});

export const PruneArgsSchema = z.object({});

// =============================================================================
// Restic OUTPUT Schemas (validate raw restic --json output at the boundary)
// =============================================================================
// These are DISTINCT from the written-result schemas above. They represent the
// shapes that restic itself emits, not the shapes we store in swamp resources.
// All fields are verified verbatim against restic 0.18.1 output captured in
// docs/tickets/3-recon-restic-shapes.md.

/**
 * Shape of `restic init --json` stdout (whole-payload, single object).
 * Required: message_type ("initialized"), id, repository.
 */
export const ResticInitOutputSchema = z.object({
  message_type: z.literal("initialized"),
  id: z.string(),
  repository: z.string(),
}).passthrough();

/**
 * Shape of the last `message_type=="summary"` JSONL line from `restic backup --json`.
 * Required (consumed): message_type, snapshot_id, backup_start, backup_end,
 *   total_files_processed, total_bytes_processed, total_duration.
 * Passthrough: files_new, files_changed, files_unmodified, dirs_*, data_blobs,
 *   tree_blobs, data_added, data_added_packed (present in real output; not consumed).
 */
export const ResticBackupSummarySchema = z.object({
  message_type: z.literal("summary"),
  snapshot_id: z.string(),
  backup_start: z.string(),
  backup_end: z.string(),
  total_files_processed: z.number(),
  total_bytes_processed: z.number(),
  total_duration: z.number(),
}).passthrough();

/**
 * A restic RFC3339 timestamp string. Validated as a string that MUST parse to a
 * finite epoch time — snapshot `time` is consumed as a Date.parse sort key when
 * selecting the latest snapshot, so a drifted value like "not-a-date" (which
 * Date.parse turns into NaN and would silently mis-order the sort) must fail at
 * the boundary rather than produce a wrong latestSnapshotId.
 */
const ResticTimestamp = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "not a parseable timestamp" },
);

/**
 * Shape of a single snapshot object (used in snapshots[], forget keep[], remove[]).
 * Required (consumed by code): id, short_id, time, hostname, paths.
 * Optional: username (absent on older restic — map absent → ""),
 *   tags (absent when untagged), parent (absent on root snapshots), excludes.
 * Passthrough: tree, uid, gid, program_version, summary (object).
 */
export const ResticSnapshotSchema = z.object({
  id: z.string(),
  short_id: z.string(),
  time: ResticTimestamp,
  hostname: z.string(),
  paths: z.array(z.string()),
  username: z.string().optional(),
  tags: z.array(z.string()).optional(),
  parent: z.string().optional(),
  excludes: z.array(z.string()).optional(),
}).passthrough();

/** Array of ResticSnapshotSchema — shape of `restic snapshots --json` whole-payload. */
export const ResticSnapshotArraySchema = z.array(ResticSnapshotSchema);

/**
 * Shape of `restic check --json` stdout (whole-payload, single object).
 * A well-formed summary with num_errors > 0 (non-zero exit) is a VALID
 * integrity-failure result — NOT a shape mismatch.
 */
export const ResticCheckSummarySchema = z.object({
  message_type: z.literal("summary"),
  num_errors: z.number(),
  broken_packs: z.array(z.unknown()).nullable(),
  suggest_repair_index: z.boolean(),
  suggest_prune: z.boolean(),
}).passthrough();

/**
 * Shape of a single group in `restic forget --json` output (whole-payload, array).
 * Per group: tags (null|string[]), host, paths, keep (snapshot[]), remove
 *   (snapshot[]|null), reasons (passthrough — not consumed by code).
 */
export const ResticForgetGroupSchema = z.object({
  tags: z.array(z.string()).nullable(),
  host: z.string(),
  paths: z.array(z.string()),
  keep: z.array(ResticSnapshotSchema),
  remove: z.array(ResticSnapshotSchema).nullable(),
}).passthrough();

/** Array of ResticForgetGroupSchema — shape of `restic forget --json` whole-payload. */
export const ResticForgetArraySchema = z.array(ResticForgetGroupSchema);

/**
 * Shape of the last `message_type=="summary"` JSONL line from `restic restore --json`.
 * All fields required: message_type, total_files, files_restored,
 *   total_bytes, bytes_restored.
 */
export const ResticRestoreSummarySchema = z.object({
  message_type: z.literal("summary"),
  total_files: z.number(),
  files_restored: z.number(),
  total_bytes: z.number(),
  bytes_restored: z.number(),
}).passthrough();
