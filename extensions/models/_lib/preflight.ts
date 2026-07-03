/**
 * Shared secret-bearing pre-flight for the operational restic methods.
 *
 * The seven methods that touch the repository (init, backup, snapshots, check,
 * restore, forget, prune) all begin with the same sequence: validate the vault
 * secrets, extract them, read cwd/resticPath/repository from globalArgs, and
 * probe restic's --json capability. This module is the SINGLE definition of
 * that sequence — the methods call runSecretPreflight instead of re-implementing
 * it, so a change to the pre-flight is made in one place and a new method that
 * calls it cannot silently skip a step.
 *
 * checkRestic is deliberately NOT a caller: it probes the binary without any
 * secrets (it must work when no vault is configured) and has its own
 * probe-failure behaviour.
 *
 * Pure composition — this module owns no restic invocation of its own. It calls
 * probeResticCapability (in invoker.ts, the sole owner of Deno.Command) and the
 * secret helpers (in secrets.ts). It must not construct Deno.Command directly,
 * and secrets.ts / invoker.ts must never import this module (no cycle).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import type { GlobalArgsSchema } from "./schemas.ts";
import {
  extractSecrets,
  redactSecrets,
  type ResticSecrets,
  validateSecrets,
} from "./secrets.ts";
import { probeResticCapability } from "./invoker.ts";

/** The resolved inputs every secret-bearing operational method needs. */
export type SecretPreflight = {
  secrets: ResticSecrets;
  cwd: string;
  resticPath: string;
  repository: string;
};

/**
 * Run the shared secret-bearing pre-flight.
 *
 * Validates and extracts the vault secrets, reads cwd/resticPath/repository from
 * globalArgs, and confirms restic supports --json. Throws — before returning —
 * on missing/invalid secrets or a restic binary without --json support. The two
 * failure messages are byte-identical to the prologue this replaces, including
 * the redaction of the probe message.
 *
 * Must be called before any operational restic invocation in a secret-bearing
 * method.
 */
export async function runSecretPreflight(
  globalArgs: z.infer<typeof GlobalArgsSchema>,
): Promise<SecretPreflight> {
  const secretError = validateSecrets(globalArgs);
  if (secretError !== null) {
    throw new Error(
      `Secret validation failed before calling restic: ${secretError}`,
    );
  }

  const secrets = extractSecrets(globalArgs);
  const cwd = globalArgs.repoDir;
  const resticPath = globalArgs.resticPath;
  const repository = globalArgs.repository;

  const probe = await probeResticCapability(resticPath, cwd);
  if (!probe.supported) {
    throw new Error(
      `restic does not support --json: ${redactSecrets(probe.message, secrets)}`,
    );
  }

  return { secrets, cwd, resticPath, repository };
}
