/**
 * forget method — apply a retention policy and remove old snapshots.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { ForgetArgsSchema, ResticForgetArraySchema } from "../schemas.ts";
import { invokeRestic, decodeResticOutput } from "../invoker.ts";
import { runSecretPreflight } from "../preflight.ts";
import { redactSecrets } from "../secrets.ts";
import type { MethodContext } from "../method-context.ts";

export const forget = {
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
};
