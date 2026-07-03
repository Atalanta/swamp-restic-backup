/**
 * Secret resolution (validate-and-brand) and redaction for the restic backup model.
 *
 * This is the ONLY module that produces or handles resolved secret values.
 * The branded ResolvedSecrets type and its sole producer, resolveSecrets, are
 * defined here; the invoker receives a ResolvedSecrets (never a plain string
 * triple), so a secret cannot reach restic without having passed validation.
 *
 * Does NOT perform subprocess invocation or filesystem IO.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { GlobalArgsSchema } from "./schemas.ts";

// Module-private brand. This is a REAL runtime symbol (not a type-only
// `declare const`, which would emit no value and make the branded property
// disappear at runtime). Because it is never exported, no other module can name
// this key — so a ResolvedSecrets value can only be constructed here, by
// resolveSecrets, after validation has passed. "Extract an unvalidated secret"
// is therefore not representable outside this module.
const RESOLVED_BRAND: unique symbol = Symbol("ResolvedSecrets");

/**
 * Resolved, validated secret values for injection into the restic subprocess
 * env. The brand field makes this type unforgeable: it exists only as the return
 * value of resolveSecrets, so any code that holds a ResolvedSecrets is holding a
 * value that provably passed validation.
 */
export type ResolvedSecrets = {
  readonly resticPassword: string;
  readonly b2AccountId: string;
  readonly b2AccountKey: string;
  readonly [RESOLVED_BRAND]: true;
};

/**
 * Validate and resolve the three required secrets in one step.
 *
 * Throws an Error whose message names the first missing/empty secret (the same
 * text the model has always used). On success, returns the branded
 * ResolvedSecrets — the ONLY way that value comes into existence. Callers cannot
 * reach the restic invoker with an unvalidated or empty secret because the
 * invoker accepts only ResolvedSecrets and this is its sole producer.
 *
 * Must be called before the restic invoker is constructed.
 */
export function resolveSecrets(
  globalArgs: z.infer<typeof GlobalArgsSchema>,
): ResolvedSecrets {
  if (!globalArgs.resticPassword || globalArgs.resticPassword.trim() === "") {
    throw new Error(
      "Secret 'resticPassword' is missing or empty — provide a vault.get expression that resolves to the restic encryption password",
    );
  }
  if (!globalArgs.b2AccountId || globalArgs.b2AccountId.trim() === "") {
    throw new Error(
      "Secret 'b2AccountId' is missing or empty — provide a vault.get expression that resolves to the B2 account ID",
    );
  }
  if (!globalArgs.b2AccountKey || globalArgs.b2AccountKey.trim() === "") {
    throw new Error(
      "Secret 'b2AccountKey' is missing or empty — provide a vault.get expression that resolves to the B2 account key",
    );
  }
  return {
    resticPassword: globalArgs.resticPassword,
    b2AccountId: globalArgs.b2AccountId,
    b2AccountKey: globalArgs.b2AccountKey,
    [RESOLVED_BRAND]: true,
  };
}

/**
 * Defensively replace all occurrences of known secret values in a string with
 * the placeholder "[REDACTED]". Used before persisting any subprocess output to
 * the resource store. Belt-and-suspenders: restic reads secrets from env and
 * should never echo them back, but this guards against unexpected reflection in
 * diagnostic or error output.
 */
export function redactSecrets(text: string, secrets: ResolvedSecrets): string {
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
