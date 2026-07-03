/**
 * checkRestic method — check whether the restic binary is installed and return its version.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { CheckResticArgsSchema } from "../schemas.ts";
import { probeResticCapability } from "../commands.ts";
import type { MethodContext } from "../method-context.ts";

export const checkRestic = {
  description:
    "Check whether the restic binary is installed and return its version",
  arguments: CheckResticArgsSchema,
  execute: async (
    _args: z.infer<typeof CheckResticArgsSchema>,
    context: MethodContext,
  ) => {
    const cwd = context.globalArgs.repoDir;
    const resticPath = context.globalArgs.resticPath;

    // check_restic only probes the binary via `restic version --json`.
    // That command requires no repository credentials, so NO secrets are
    // injected here. This is the only method that does not validate or use
    // secrets — it is explicitly a binary-availability check, not a repo op.
    const probe = await probeResticCapability(resticPath, cwd);

    const statusData = {
      available: probe.supported,
      version: probe.version ?? undefined,
      binary: resticPath,
      message: probe.message,
    };

    const handle = await context.writeResource(
      "resticStatus",
      "current",
      statusData as unknown as Record<string, unknown>,
    );

    context.logger.info(
      "check_restic: {available} — {message}",
      {
        available: probe.supported,
        message: probe.message,
      },
    );

    return { dataHandles: [handle] };
  },
};
