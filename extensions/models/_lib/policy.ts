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

// This module needs only the include/exclude fields, so it declares a narrow
// local type rather than importing GlobalArgsSchema from schemas.ts — keeping
// policy.ts free of a dependency on the schema module.
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

