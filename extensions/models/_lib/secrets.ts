/**
 * Secret validation, extraction, and redaction for the restic backup model.
 *
 * This is the ONLY module that produces or handles resolved secret values.
 * The resolved secret values (resticPassword, b2AccountId, b2AccountKey) and
 * the ResticSecrets type are defined here; the invoker receives secrets as
 * plain function parameters.
 *
 * Does NOT perform subprocess invocation or filesystem IO.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { GlobalArgsSchema } from "./schemas.ts";

/** Resolved secret values for injection into restic subprocess env. */
export type ResticSecrets = {
  resticPassword: string;
  b2AccountId: string;
  b2AccountKey: string;
};

/**
 * Validate that all three required secrets are present and non-empty.
 * Called BEFORE the restic invoker is ever constructed, so the invoker
 * is never called when secrets are missing or empty.
 * Returns a structured error message string if validation fails, null if ok.
 */
export function validateSecrets(globalArgs: z.infer<typeof GlobalArgsSchema>): string | null {
  if (!globalArgs.resticPassword || globalArgs.resticPassword.trim() === "") {
    return "Secret 'resticPassword' is missing or empty — provide a vault.get expression that resolves to the restic encryption password";
  }
  if (!globalArgs.b2AccountId || globalArgs.b2AccountId.trim() === "") {
    return "Secret 'b2AccountId' is missing or empty — provide a vault.get expression that resolves to the B2 account ID";
  }
  if (!globalArgs.b2AccountKey || globalArgs.b2AccountKey.trim() === "") {
    return "Secret 'b2AccountKey' is missing or empty — provide a vault.get expression that resolves to the B2 account key";
  }
  return null;
}

/**
 * Extract resolved secret values from globalArgs for subprocess env injection.
 * Must only be called AFTER validateSecrets returns null.
 */
export function extractSecrets(globalArgs: z.infer<typeof GlobalArgsSchema>): ResticSecrets {
  return {
    resticPassword: globalArgs.resticPassword,
    b2AccountId: globalArgs.b2AccountId,
    b2AccountKey: globalArgs.b2AccountKey,
  };
}

/**
 * Defensively replace all occurrences of known secret values in a string with
 * the placeholder "[REDACTED]". Used before persisting any subprocess output to
 * the resource store. Belt-and-suspenders: restic reads secrets from env and
 * should never echo them back, but this guards against unexpected reflection in
 * diagnostic or error output.
 */
export function redactSecrets(text: string, secrets: ResticSecrets): string {
  let redacted = text;
  // Replace each secret value; skip empty strings to avoid corrupting all output.
  if (secrets.resticPassword) {
    redacted = redacted.replaceAll(secrets.resticPassword, "[REDACTED]");
  }
  if (secrets.b2AccountId) {
    redacted = redacted.replaceAll(secrets.b2AccountId, "[REDACTED]");
  }
  if (secrets.b2AccountKey) {
    redacted = redacted.replaceAll(secrets.b2AccountKey, "[REDACTED]");
  }
  return redacted;
}
