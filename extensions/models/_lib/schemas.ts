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
