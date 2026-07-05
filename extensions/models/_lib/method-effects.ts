/**
 * Shared injectable side-effect seams for method executes that need a
 * deterministic clock or working directory in tests.
 *
 * The swamp runtime calls execute(args, context) with two arguments; effects
 * defaults to {} so production always uses the real Deno side effects. Tests
 * call execute(args, context, { now: () => fixedDate, cwd: () => fixedDir })
 * to get deterministic timestamps and cwd anchors without real subprocess
 * state or wall-clock non-determinism.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

/**
 * Injectable side-effect seams.
 *
 * Record names are static per method, so the clock no longer feeds any record
 * name. The remaining consumers are:
 *
 * - `now`: returns the current wall-clock Date. Defaults to `() => new Date()`.
 *   Used by `check` for the `checkedAt` timestamp in its result payload.
 * - `cwd`: returns the current working directory string. Defaults to
 *   `() => Deno.cwd()`. Used by `restore` to anchor resolveRestoreTarget.
 *
 * `forget` and `prune` no longer take effects — their output is fully static.
 * Production callers omit effects (defaults to `{}`); tests inject fakes.
 */
export type MethodEffects = {
  now?: () => Date;
  cwd?: () => string;
};
