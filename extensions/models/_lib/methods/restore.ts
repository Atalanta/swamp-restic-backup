/**
 * restore method — restore a snapshot to a target directory.
 *
 * Guard ordering (must not be changed):
 *   1. empty-targetDir throw
 *   2. resolveRestoreTarget (safety, BEFORE preflight)
 *   3. runSecretPreflight
 *   4. invokeResticRestore(safeTarget, ...)
 *   5. decodeResticSummary
 *   6. restoreResult including the `overridden` field
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { RestoreArgsSchema, ResticRestoreSummarySchema } from "../schemas.ts";
import { invokeResticRestore } from "../commands.ts";
import { decodeResticSummary } from "../decode.ts";
import { runSecretPreflight } from "../preflight.ts";
import { resolveRestoreTarget } from "../path-safety.ts";
import { redactSecrets } from "../secrets.ts";
import type { MethodContext } from "../method-context.ts";
import type { MethodEffects } from "../method-effects.ts";

export const restore = {
  description:
    "Restore a snapshot to a target directory. Refuses a dangerous target (repo root, .swamp/, an ancestor of .swamp/, or inside .swamp/) unless confirm:true explicitly overrides it; an override is recorded in the result. POSIX paths only.",
  arguments: RestoreArgsSchema,
  execute: async (
    args: z.infer<typeof RestoreArgsSchema>,
    context: MethodContext,
    effects: MethodEffects = {},
  ) => {
    // cwdAnchor injectable seam: production uses Deno.cwd(), tests inject a fixed dir.
    // Only used for resolveRestoreTarget's cwdAnchor parameter — the subprocess cwd
    // comes from runSecretPreflight (repoDir) as before.
    const getCwdAnchor = effects.cwd ?? (() => Deno.cwd());
    if (!args.targetDir || args.targetDir.trim() === "") {
      throw new Error(
        "targetDir is required for restore — specify an explicit directory to restore into",
      );
    }

    // Resolve the restore target through the safety guard BEFORE any secret
    // validation or restic invocation (preserving error precedence: a
    // dangerous target is refused before secrets are touched). resolveRestoreTarget
    // returns a branded SafeRestoreTarget only for a safe target or an
    // explicit confirm override; a dangerous target without confirm, or a
    // non-POSIX absolute target, throws here. confirm is now an input to the
    // resolver, not an enforcement-skipping boolean in this method body.
    // Always pass an explicit cwdAnchor (from the injectable cwd seam) so
    // resolveRestoreTarget never relies on its own Deno.cwd() default here.
    const safeTarget = await resolveRestoreTarget(
      args.targetDir,
      context.globalArgs.repoDir,
      args.confirm,
      getCwdAnchor(),
    );

    const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
      context.globalArgs,
    );

    // invokeResticRestore accepts only a SafeRestoreTarget — the restic
    // restore subprocess cannot be reached with a raw, unchecked target.
    const result = await invokeResticRestore(
      safeTarget,
      args.snapshot,
      repository,
      secrets,
      resticPath,
      cwd,
    );

    if (!result.success) {
      // Redact secrets from any subprocess-derived text before including in the error.
      const errorMsg = (() => {
        try {
          const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
          return redactSecrets(
            (parsed["message"] as string) ?? result.stderr.slice(0, 300),
            secrets,
          );
        } catch {
          return redactSecrets(result.stderr.slice(0, 300), secrets);
        }
      })();
      throw new Error(
        `restic restore failed (exit ${result.exitCode}): ${errorMsg}`,
      );
    }

    // Decode and validate the JSONL summary line via the boundary decoder.
    // decodeResticSummary locates the last message_type=='summary' line and
    // validates it — fails with a sanitized error on parse failure, schema
    // mismatch, or missing summary line (all boundary errors).
    const restoreSummary = decodeResticSummary(
      result.stdout,
      ResticRestoreSummarySchema,
      "restore",
    );

    const filesRestored = restoreSummary.files_restored;
    const bytesRestored = restoreSummary.bytes_restored;

    const restoreData = {
      snapshotId: args.snapshot,
      targetDir: args.targetDir,
      filesRestored,
      bytesRestored,
      message: `Restored snapshot ${args.snapshot} to ${args.targetDir}`,
      // Records whether this restore was into a dangerous target allowed only
      // by an explicit confirm override — so an audit can distinguish a forced
      // restore from a routine one.
      overridden: safeTarget.overridden,
    };

    const handle = await context.writeResource(
      "restoreResult",
      "restore-latest",
      restoreData as unknown as Record<string, unknown>,
    );

    context.logger.info(
      "restore: {files} files, {bytes} bytes restored to {target} (overridden={overridden})",
      {
        files: filesRestored,
        bytes: bytesRestored,
        target: args.targetDir,
        overridden: safeTarget.overridden,
      },
    );

    return { dataHandles: [handle] };
  },
};
