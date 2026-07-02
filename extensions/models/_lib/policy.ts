/**
 * Default backup policy — include/exclude path lists and the builder function
 * that merges them with per-invocation overrides.
 *
 * These are the only definitions of DEFAULT_INCLUDE_PATHS and
 * DEFAULT_EXCLUDE_PATTERNS in the entire extension; importing modules must
 * not redefine them.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

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

// Inline the minimal schema shape needed here to avoid a circular dependency
// on schemas.ts (which doesn't exist yet at S1). At S2 schemas.ts is created
// and restic_backup.ts re-exports GlobalArgsSchema; this module only needs the
// include/exclude fields, so we keep the type narrow.
type IncludeExcludeArgs = {
  include: string[];
  exclude: string[];
};

/**
 * Build the final include paths and exclude patterns by merging defaults
 * with any overrides from globalArgs.
 */
export function buildIncludeExcludeLists(
  globalArgs: IncludeExcludeArgs,
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

