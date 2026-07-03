/**
 * Typed per-command restic invoker entries and capability probe.
 *
 * Each entry assembles the exact restic argv (matching the canonical flag order)
 * and delegates to the MODULE-PRIVATE invokeResticInternal below — which builds
 * the secret env (reads Deno.env) and calls realSpawn from spawn.ts (the sole
 * Deno.Command owner, which injects no secrets itself). Method modules import
 * from here so:
 *   - No method module can construct a raw argv for secret-bearing execution.
 *   - The type system statically enforces typed inputs (no string[] escape hatch).
 *   - Flag order is captured ONCE here, not scattered across method bodies.
 *
 * An optional `spawn: SpawnEffect` parameter on each typed entry enables test
 * injection of a fake spawn without launching a real process (PLAN-1). Production
 * callers omit it; the real Deno.Command-backed default is used instead.
 *
 * invokeResticRestore is the ONLY restore path — it requires a branded
 * SafeRestoreTarget from resolveRestoreTarget (ISSUE-11/ARCH-1).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import type { ResolvedSecrets } from "./secrets.ts";
import { assertSafeRestoreTarget, type SafeRestoreTarget } from "./path-safety.ts";
import { realSpawn, invokeResticNoSecrets, type SpawnEffect } from "./spawn.ts";
import type { ResticResult } from "./decode.ts";

// invokeRestic (generic string[] argv + runtime restore guard) has been retired.
// All method modules now call typed per-command entries (invokeResticCheck,
// invokeResticPrune, invokeResticSnapshots, invokeResticForget, invokeResticBackup,
// invokeResticInit, invokeResticCatConfig). Restore is reachable only via
// invokeResticRestore (SafeRestoreTarget). No generic secret-injecting argv:string[]
// entry is exported — the type surface is the enforcement boundary (ISSUE-11/ARCH-1).

// MODULE-PRIVATE secret-injecting spawn: the single place secrets enter a restic
// subprocess env. NOT exported — a raw secret-bearing argv:string[] escape hatch
// would let a future caller run `restore` without a SafeRestoreTarget, which is
// exactly the #5/#11 boundary this keeps structural. The only ways to reach it
// are the typed per-command entries below and invokeResticRestore. spawn.ts owns
// Deno.Command via realSpawn (which takes a fully-built env and injects nothing);
// this function builds the secret env and hands it to realSpawn.
function invokeResticInternal(
  argv: string[],
  secrets: ResolvedSecrets,
  cwd: string,
  spawn: SpawnEffect = realSpawn,
): Promise<ResticResult> {
  // Inherit current env then inject secrets, overwriting any pre-existing
  // RESTIC_PASSWORD/B2_* values to prevent ambient leakage.
  const subprocessEnv: Record<string, string> = { ...Deno.env.toObject() };
  subprocessEnv["RESTIC_PASSWORD"] = secrets.resticPassword;
  subprocessEnv["B2_ACCOUNT_ID"] = secrets.b2AccountId;
  subprocessEnv["B2_ACCOUNT_KEY"] = secrets.b2AccountKey;
  return spawn(argv, subprocessEnv, cwd, /* clearEnv= */ false);
}

/**
 * Invoke `restic check --json --repo <repository>`.
 * No additional flags — check takes no per-call options beyond the repo.
 */
export function invokeResticCheck(
  repository: string,
  secrets: ResolvedSecrets,
  resticPath: string,
  cwd: string,
  spawn?: SpawnEffect,
): Promise<ResticResult> {
  const argv = [resticPath, "check", "--json", "--repo", repository];
  return invokeResticInternal(argv, secrets, cwd, spawn);
}

/**
 * Invoke `restic prune --json --repo <repository>`.
 * No additional flags — prune takes no per-call options beyond the repo.
 */
export function invokeResticPrune(
  repository: string,
  secrets: ResolvedSecrets,
  resticPath: string,
  cwd: string,
  spawn?: SpawnEffect,
): Promise<ResticResult> {
  const argv = [resticPath, "prune", "--json", "--repo", repository];
  return invokeResticInternal(argv, secrets, cwd, spawn);
}

/** Typed inputs for the snapshots command. */
export type SnapshotsInputs = {
  host?: string;
  tags: readonly string[];
  path?: string;
};

/**
 * Invoke `restic snapshots --json --repo <repository> [--host <host>] [--tag <tag>...] [--path <path>]`.
 * Flag order: --host (if present), then one --tag per tag, then --path (if present).
 */
export function invokeResticSnapshots(
  inputs: SnapshotsInputs,
  repository: string,
  secrets: ResolvedSecrets,
  resticPath: string,
  cwd: string,
  spawn?: SpawnEffect,
): Promise<ResticResult> {
  const argv: string[] = [resticPath, "snapshots", "--json", "--repo", repository];
  if (inputs.host) {
    argv.push("--host", inputs.host);
  }
  for (const tag of inputs.tags) {
    argv.push("--tag", tag);
  }
  if (inputs.path) {
    argv.push("--path", inputs.path);
  }
  return invokeResticInternal(argv, secrets, cwd, spawn);
}

/** Typed inputs for the forget command. */
export type ForgetInputs = {
  keepLast?: number;
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
  dryRun: boolean;
  host?: string;
};

/**
 * Invoke `restic forget --json --repo <repository> [retention flags...] [--dry-run] [--host <host>]`.
 * Flag order: --keep-last, --keep-daily, --keep-weekly, --keep-monthly, --dry-run, --host.
 */
export function invokeResticForget(
  inputs: ForgetInputs,
  repository: string,
  secrets: ResolvedSecrets,
  resticPath: string,
  cwd: string,
  spawn?: SpawnEffect,
): Promise<ResticResult> {
  const argv: string[] = [resticPath, "forget", "--json", "--repo", repository];
  if (inputs.keepLast !== undefined) argv.push("--keep-last", String(inputs.keepLast));
  if (inputs.keepDaily !== undefined) argv.push("--keep-daily", String(inputs.keepDaily));
  if (inputs.keepWeekly !== undefined) argv.push("--keep-weekly", String(inputs.keepWeekly));
  if (inputs.keepMonthly !== undefined) argv.push("--keep-monthly", String(inputs.keepMonthly));
  if (inputs.dryRun) argv.push("--dry-run");
  if (inputs.host) argv.push("--host", inputs.host);
  return invokeResticInternal(argv, secrets, cwd, spawn);
}

/** Typed inputs for the backup command. */
export type BackupInputs = {
  excludePatterns: readonly string[];
  tags: readonly string[];
  includePaths: readonly string[];
};

/**
 * Invoke `restic backup --json --repo <repository> [--exclude <pattern>...] [--tag <tag>...] <paths...>`.
 * Flag order (MUST match today's method exactly):
 *   1. --exclude per excludePattern
 *   2. --tag per tag
 *   3. positional includePaths (last)
 */
export function invokeResticBackup(
  inputs: BackupInputs,
  repository: string,
  secrets: ResolvedSecrets,
  resticPath: string,
  cwd: string,
  spawn?: SpawnEffect,
): Promise<ResticResult> {
  const argv: string[] = [resticPath, "backup", "--json", "--repo", repository];
  for (const pattern of inputs.excludePatterns) {
    argv.push("--exclude", pattern);
  }
  for (const tag of inputs.tags) {
    argv.push("--tag", tag);
  }
  // Include paths come last as positional args
  argv.push(...inputs.includePaths);
  return invokeResticInternal(argv, secrets, cwd, spawn);
}

/**
 * Invoke `restic init --json --repo <repository>`.
 * Creates a new repository at the configured location.
 */
export function invokeResticInit(
  repository: string,
  secrets: ResolvedSecrets,
  resticPath: string,
  cwd: string,
  spawn?: SpawnEffect,
): Promise<ResticResult> {
  const argv = [resticPath, "init", "--json", "--repo", repository];
  return invokeResticInternal(argv, secrets, cwd, spawn);
}

/**
 * Invoke `restic cat config --json --repo <repository>`.
 * Used by the init idempotency probe: exit 0 means the repo already exists
 * and is openable with the current credentials; non-zero means it does not
 * exist or cannot be opened.
 */
export function invokeResticCatConfig(
  repository: string,
  secrets: ResolvedSecrets,
  resticPath: string,
  cwd: string,
  spawn?: SpawnEffect,
): Promise<ResticResult> {
  const argv = [resticPath, "cat", "config", "--json", "--repo", repository];
  return invokeResticInternal(argv, secrets, cwd, spawn);
}

/**
 * Run a restic `restore`. This is the ONLY way to invoke a restore, and it is
 * the sole reader of the target path — its parameter is a SafeRestoreTarget, so
 * a restore cannot be launched with a raw, unchecked targetDir without a
 * compile error. The target must have come from resolveRestoreTarget (in
 * path-safety.ts), which enforces the restore-safety guard. Calls the private
 * secret-injecting spawn directly via invokeResticInternal.
 */
export function invokeResticRestore(
  safeTarget: SafeRestoreTarget,
  snapshot: string,
  repository: string,
  secrets: ResolvedSecrets,
  resticPath: string,
  cwd: string,
  spawn?: SpawnEffect,
): Promise<ResticResult> {
  // Runtime brand check: the SafeRestoreTarget type is erased at runtime, so a
  // forged/cast object could otherwise reach the restore subprocess. Refuse any
  // target not produced by resolveRestoreTarget before building argv.
  assertSafeRestoreTarget(safeTarget);
  const argv = [
    resticPath,
    "restore",
    snapshot,
    "--json",
    "--repo",
    repository,
    "--target",
    safeTarget.path,
  ];
  return invokeResticInternal(argv, secrets, cwd, spawn);
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
export async function probeResticCapability(
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
