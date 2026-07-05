/**
 * prune method — free disk space by removing unreferenced data packs.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { PruneArgsSchema } from "../schemas.ts";
import { invokeResticPrune } from "../commands.ts";
import { runSecretPreflight } from "../preflight.ts";
import { redactSecrets } from "../secrets.ts";
import type { MethodContext } from "../method-context.ts";

export const prune = {
  description:
    "Free disk space by removing unreferenced data packs. Expensive operation — run after forget, not on every backup cycle",
  arguments: PruneArgsSchema,
  execute: async (
    _args: z.infer<typeof PruneArgsSchema>,
    context: MethodContext,
  ) => {
    const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
      context.globalArgs,
    );

    const startTime = performance.now();
    const result = await invokeResticPrune(repository, secrets, resticPath, cwd);
    const durationMs = Math.round(performance.now() - startTime);

    if (!result.success) {
      // prune may exit non-zero even on partial success; check stderr.
      // Redact secrets defensively — restic reads them from env, not args,
      // but belt-and-suspenders for any accidental reflection in diagnostic output.
      throw new Error(
        `restic prune failed (exit ${result.exitCode}): ${redactSecrets(result.stderr.slice(0, 200), secrets)}`,
      );
    }

    // restic prune --json emits no JSON in any released version (upstream gap).
    // Success is determined solely by exit code above. Raw output is preserved
    // for audit purposes. bytesFreed/packsRemoved are intentionally omitted —
    // they were unused and scraping human text would violate the
    // no-human-text-parser invariant. Populate from JSON once restic adds
    // prune JSON support.
    //
    // Defensively redact the three secret values from rawOutput even though
    // restic reads them from env (not args) and should never echo them back.
    // Belt-and-suspenders: any accidental secret reflection in diagnostic
    // output must not be persisted to the resource store.
    const rawOutputUnredacted = (result.stdout + result.stderr).slice(0, 2000);
    const rawOutput = redactSecrets(rawOutputUnredacted, secrets);

    const pruneData = {
      durationMs,
      rawOutput,
    };

    const handle = await context.writeResource(
      "pruneResult",
      "prune-latest",
      pruneData as unknown as Record<string, unknown>,
    );

    context.logger.info(
      "prune: completed in {durationMs}ms",
      { durationMs },
    );

    return { dataHandles: [handle] };
  },
};
