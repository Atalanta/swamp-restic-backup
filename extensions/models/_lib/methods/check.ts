/**
 * check method — check the restic repository for integrity errors.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { CheckArgsSchema, ResticCheckSummarySchema } from "../schemas.ts";
import { invokeResticCheck, decodeResticCheckOutput } from "../invoker.ts";
import { runSecretPreflight } from "../preflight.ts";
import { redactSecrets } from "../secrets.ts";
import type { MethodContext } from "../method-context.ts";

export const check = {
  description: "Check the restic repository for integrity errors",
  arguments: CheckArgsSchema,
  execute: async (
    _args: z.infer<typeof CheckArgsSchema>,
    context: MethodContext,
  ) => {
    const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
      context.globalArgs,
    );

    const result = await invokeResticCheck(repository, secrets, resticPath, cwd);

    // check output is decoded by the invoker-owned, exit-code-aware boundary
    // helper: a valid summary is returned; an exit-0-without-valid-summary is a
    // boundary failure (throws); a non-zero exit with no summary returns null
    // (the check itself failed — recorded as ok:false below, not a shape
    // mismatch). A well-formed summary with num_errors>0 is a valid
    // integrity-failure result, not a shape mismatch.
    const checkSummary = decodeResticCheckOutput(
      result.stdout,
      result.success,
      ResticCheckSummarySchema,
    );

    const numErrors = checkSummary?.num_errors ?? 0;
    const ok = result.success && numErrors === 0;

    // Collect any error lines (message_type=error) from the JSONL output.
    // Defensively redact secrets from message text before persisting to resource.
    const errorLines = result.stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed["message_type"] === "error") {
            const rawMsg = (parsed["message"] as string) ?? line;
            return [redactSecrets(rawMsg, secrets)];
          }
          return [];
        } catch {
          return [];
        }
      });

    const checkData = {
      ok,
      errors: errorLines,
      warnings: [],
      checkedAt: new Date().toISOString(),
    };

    const handle = await context.writeResource(
      "checkResult",
      `check-${new Date().toISOString().slice(0, 10)}`,
      checkData as unknown as Record<string, unknown>,
    );

    context.logger.info(
      "check: ok={ok}, errors={errorCount}",
      {
        ok,
        errorCount: errorLines.length,
      },
    );

    return { dataHandles: [handle] };
  },
};
