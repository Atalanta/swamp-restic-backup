/**
 * Shared injectable side-effect seams for record-naming method executes.
 *
 * The swamp runtime calls execute(args, context) with two arguments; effects
 * defaults to {} so production always uses the real Deno side effects. Tests
 * call execute(args, context, { now: () => fixedDate, cwd: () => fixedDir })
 * to get deterministic record names and cwd anchors without real subprocess
 * state or wall-clock non-determinism.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

/**
 * Injectable side-effect seams for the four record-naming method executes
 * (check, forget, prune, restore).
 *
 * - `now`: returns the current wall-clock Date. Defaults to `() => new Date()`.
 *   Used for checkedAt timestamps and record name suffixes (`check-<date>`,
 *   `forget-<ts>`, `prune-<ts>`, `restore-<ts>`).
 * - `cwd`: returns the current working directory string. Defaults to
 *   `() => Deno.cwd()`. Used by restore to anchor resolveRestoreTarget.
 *
 * Production callers omit effects (defaults to `{}`); tests inject fakes.
 */
export type MethodEffects = {
  now?: () => Date;
  cwd?: () => string;
};
