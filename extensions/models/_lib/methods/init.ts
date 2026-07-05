/**
 * init method — initialize the configured restic repository (idempotent).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { InitArgsSchema, ResticInitOutputSchema } from "../schemas.ts";
import { invokeResticCatConfig, invokeResticInit } from "../commands.ts";
import { decodeResticOutput } from "../decode.ts";
import { runSecretPreflight } from "../preflight.ts";
import { redactSecrets } from "../secrets.ts";
import type { MethodContext } from "../method-context.ts";

export const init = {
  description:
    "Initialize the configured restic repository (idempotent — safe to run if already initialized)",
  arguments: InitArgsSchema,
  execute: async (
    _args: z.infer<typeof InitArgsSchema>,
    context: MethodContext,
  ) => {
    const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
      context.globalArgs,
    );

    // Idempotency probe: check whether the repository is already accessible
    // by running `restic cat config --json` before attempting init.
    // This gives a machine-readable yes/no answer based on exit code alone,
    // without classifying error messages by free-form text. Exit 0 → repo
    // exists and is openable with these credentials. Non-zero → repo does
    // not exist OR cannot be opened (bad creds, corrupt repo, backend error).
    // We only treat exit 0 as "already initialized"; everything else proceeds
    // to `restic init` and lets restic itself report any real failure.
    const catConfigResult = await invokeResticCatConfig(repository, secrets, resticPath, cwd);

    if (catConfigResult.success) {
      // Repository already exists and is openable — report initialized, not created.
      const statusData = {
        repository,
        initialized: true,
        created: false,
        message: `Repository already initialized at ${repository}`,
      };
      const handle = await context.writeResource(
        "repositoryStatus",
        "repository-status",
        statusData as unknown as Record<string, unknown>,
      );
      context.logger.info(
        "init: repository already exists, skipping init",
        { repository },
      );
      return { dataHandles: [handle] };
    }

    // Repository is not yet openable — attempt to create it.
    const result = await invokeResticInit(repository, secrets, resticPath, cwd);

    let initialized = false;
    let created = false;
    let message = "";

    if (result.success) {
      // Decode and validate the whole-payload init result via the boundary decoder.
      // decodeResticOutput parses the stdout and validates it against the Zod schema
      // (message_type=="initialized" is a required literal — schema mismatch throws
      // a sanitized boundary error). No raw output is embedded in any error path.
      decodeResticOutput(result.stdout, ResticInitOutputSchema, "init");
      created = true;
      initialized = true;
      message = `Repository created at ${repository}`;
    } else {
      // init failed — surface the JSON error message if available, otherwise stderr.
      // We do NOT classify the error by message text; all non-zero exits are failures.
      // Apply redactSecrets before including any subprocess output in the thrown error
      // to prevent accidental secret reflection into logs or error messages.
      const errorJsonSource = result.stdout.trim() || result.stderr.trim();
      let errorDetail = redactSecrets(result.stderr.slice(0, 300), secrets);
      try {
        const errorParsed = JSON.parse(errorJsonSource) as Record<string, unknown>;
        errorDetail = redactSecrets(
          (errorParsed["message"] as string) ?? result.stderr.slice(0, 300),
          secrets,
        );
      } catch { /* keep stderr fallback */ }
      throw new Error(
        `restic init failed (exit ${result.exitCode}): ${errorDetail}`,
      );
    }

    const statusData = { repository, initialized, created, message };
    const handle = await context.writeResource(
      "repositoryStatus",
      "repository-status",
      statusData as unknown as Record<string, unknown>,
    );

    context.logger.info(
      "init: initialized={initialized} created={created}",
      { initialized, created, repository },
    );

    return { dataHandles: [handle] };
  },
};
