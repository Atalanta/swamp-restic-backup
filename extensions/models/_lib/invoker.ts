/**
 * Restic subprocess construction and execution.
 *
 * This is the ONLY module that spawns a restic process (Deno.Command). No
 * other module may construct Deno.Command directly; all restic invocations
 * go through the exported functions here.
 *
 * Also owns restic output parsing (parseResticJsonOutput, findJsonlMessage)
 * and the ResticResult type (invoker-owned; not schema-derived).
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import type { z } from "npm:zod@4.4.3";
import type { ResticSecrets } from "./secrets.ts";

/** Structured result from running a restic subprocess. */
export type ResticResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
};

// =============================================================================
// Restic Invoker
// =============================================================================

/**
 * Invoke a restic command.
 * argv[0] is the binary; all subsequent elements are arguments.
 * env overrides or adds to the subprocess environment.
 * When clearEnv is true, the subprocess starts with an EMPTY environment and
 * only the keys in env are present — this is the mechanism used by the no-secrets
 * probe to prevent ambient credential vars from leaking into the child process.
 * (Deno.Command's env option merges with the parent env; only clearEnv=true gives
 * a fully isolated environment.)
 * Returns the raw stdout/stderr/exitCode without parsing.
 *
 * Module-private: this raw primitive takes arbitrary argv/env and does NOT
 * inject secrets. Keeping it unexported ensures the only ways to reach restic
 * from outside this module are invokeRestic (secrets injected) and
 * invokeResticNoSecrets — enforcing the secret-injection boundary structurally.
 */
async function spawnRestic(
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  clearEnv: boolean = false,
): Promise<ResticResult> {
  const startTime = performance.now();

  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
    cwd,
    env,
    // deno-lint-ignore no-explicit-any
    ...(clearEnv ? { clearEnv: true } as Record<string, any> : {}),
  });

  // Deno.Command.output() throws a NotFound error when the binary doesn't exist.
  // Catch and return a structured failure so callers can surface a clean message.
  let output: Deno.CommandOutput;
  try {
    output = await command.output();
  } catch (spawnError) {
    const durationMs = Math.round(performance.now() - startTime);
    const errorMessage = spawnError instanceof Error ? spawnError.message : String(spawnError);
    return {
      stdout: "",
      stderr: errorMessage,
      exitCode: 127,
      success: false,
      durationMs,
    };
  }
  const durationMs = Math.round(performance.now() - startTime);

  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  return {
    stdout,
    stderr,
    exitCode: output.code,
    success: output.success,
    durationMs,
  };
}

/**
 * Invoke a restic command that requires repo access.
 * Secrets are injected ONLY via subprocess env (RESTIC_PASSWORD, B2_ACCOUNT_ID,
 * B2_ACCOUNT_KEY) — never as argv or in any logged output.
 * Must only be called AFTER validateSecrets returns null.
 */
export async function invokeRestic(
  argv: string[],
  secrets: ResticSecrets,
  cwd: string,
): Promise<ResticResult> {
  // Build subprocess env: inherit current env then inject secrets, overwriting
  // any pre-existing RESTIC_PASSWORD/B2_* values to prevent ambient leakage.
  const subprocessEnv: Record<string, string> = { ...Deno.env.toObject() };
  subprocessEnv["RESTIC_PASSWORD"] = secrets.resticPassword;
  subprocessEnv["B2_ACCOUNT_ID"] = secrets.b2AccountId;
  subprocessEnv["B2_ACCOUNT_KEY"] = secrets.b2AccountKey;
  return spawnRestic(argv, subprocessEnv, cwd);
}

/**
 * Invoke a restic command that does NOT touch the repository (e.g. `restic version`).
 * No secrets are injected. Used by the capability probe so that check_restic can
 * verify binary presence without requiring vault secrets to be configured.
 *
 * IMPORTANT: The ambient process environment is scrubbed of all restic credential
 * and cloud-provider auth vars before spawning. This prevents ambient credentials
 * (e.g. RESTIC_PASSWORD already set in the shell) from leaking into probe output,
 * which would allow them to appear in check_restic's logged probe-failure messages
 * before any redactSecrets call can run.
 */
export async function invokeResticNoSecrets(
  argv: string[],
  cwd: string,
): Promise<ResticResult> {
  // Use clearEnv=true so the subprocess inherits NO parent env vars at all.
  // Deno.Command's env option MERGES with the parent env (deleting from a spread
  // copy has no effect because the OS-level fork still copies the full parent env
  // unless clearEnv is set). clearEnv=true gives an isolated environment where
  // only the keys we explicitly provide are present.
  //
  // The version probe only needs PATH (to find system libraries if the binary is
  // dynamically linked). We preserve PATH from the parent to avoid "not found"
  // errors on systems where the binary is on a non-default PATH.
  const probeEnv: Record<string, string> = {};
  const parentPath = Deno.env.get("PATH");
  if (parentPath !== undefined) {
    probeEnv["PATH"] = parentPath;
  }
  return spawnRestic(argv, probeEnv, cwd, /* clearEnv= */ true);
}

// =============================================================================
// JSON Parsing Helpers
// =============================================================================

/**
 * Parse the JSON output from a restic command.
 * Restic with --json emits one JSON object per line (JSONL) for streaming
 * commands, or a single JSON array/object for listing commands.
 *
 * Throws a sanitized domain Error (never a raw SyntaxError) on invalid input —
 * the no-human-text-parser invariant requires that malformed subprocess output
 * is rejected cleanly without embedding raw input snippets in the error message,
 * which could expose reflected secrets.
 */
export function parseResticJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return null;
  }

  // Try parsing as a complete JSON value first (arrays, objects)
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to JSONL parsing
  }

  // Parse as JSONL — return all lines as an array.
  // Any line that fails JSON.parse causes a sanitized domain error rather than
  // propagating a raw SyntaxError that could embed an input snippet.
  const lines = trimmed.split("\n").filter((line) => line.trim() !== "");
  const results: unknown[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line));
    } catch {
      throw new Error(
        "restic --json output contained a line that is not valid JSON — no human-text fallback",
      );
    }
  }
  return results;
}

/**
 * Find the last JSONL line matching a message_type predicate.
 * Used to extract specific event types from restic's streaming output.
 *
 * Throws a sanitized domain Error (never a raw SyntaxError) on invalid input —
 * consistent with the no-human-text-parser invariant in parseResticJsonOutput.
 * A bad JSONL line is rejected with a fixed message that does not embed the
 * raw line content (which could contain reflected secrets).
 */
export function findJsonlMessage(
  stdout: string,
  messageType: string,
): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").filter((line) => line.trim() !== "");
  let found: Record<string, unknown> | null = null;
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(
        "restic --json output contained a line that is not valid JSON — no human-text fallback",
      );
    }
    if (parsed["message_type"] === messageType) {
      found = parsed;
    }
  }
  return found;
}

// =============================================================================
// Validating Decode Helpers
// =============================================================================

/**
 * Decode and validate a whole-payload restic command output.
 *
 * These commands (init, snapshots, forget) emit ONE complete JSON value on
 * stdout — a single object or array — NOT the JSONL stream that backup/restore
 * produce. So this parses with a strict whole-value JSON.parse rather than
 * parseResticJsonOutput: the latter's JSONL fallback would silently accept
 * newline-delimited objects as an array, letting a whole-JSON→JSONL framing
 * drift pass validation instead of failing at the boundary. On parse failure OR
 * schema mismatch, throws ONE sanitized boundary error naming the command and
 * mismatch class — no raw restic output, no unobserved exit code.
 *
 * Used by: init, snapshots, forget. (check has its own exit-code-aware decoder
 * below because its output is a JSONL summary among error lines.)
 */
export function decodeResticOutput<T>(
  stdout: string,
  schema: z.ZodType<T>,
  command: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      `restic ${command}: output did not match expected shape — invalid JSON`,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `restic ${command}: output did not match expected shape`,
    );
  }
  return result.data;
}

/**
 * Decode and validate restic check output, which is exit-code-aware.
 *
 * check emits a JSONL stream: a message_type=="summary" line among possible
 * error/status lines. The exit code decides how a missing/invalid summary is
 * treated:
 *   - exit 0 (success=true) + a valid summary  → returns the validated summary.
 *   - exit 0 + missing/schema-mismatched summary → BOUNDARY FAILURE (restic
 *     claimed success but produced no parseable result — the silent-default this
 *     ticket removes).
 *   - non-zero exit + no valid summary → returns null: restic already failed the
 *     integrity check (e.g. it emitted exit_error JSON, not a summary); the
 *     caller records this as ok:false. This is the expected failed state, NOT a
 *     shape mismatch.
 * A bad JSONL line in non-empty output is always a boundary failure.
 * Throws a sanitized boundary error — no raw restic output.
 */
export function decodeResticCheckOutput(
  stdout: string,
  success: boolean,
  schema: z.ZodType<{ message_type: "summary"; num_errors: number }>,
): { message_type: "summary"; num_errors: number } | null {
  let rawSummary: Record<string, unknown> | null = null;
  if (stdout.trim() !== "") {
    try {
      rawSummary = findJsonlMessage(stdout, "summary");
    } catch {
      throw new Error(
        "restic check: output did not match expected shape — invalid JSON",
      );
    }
  }

  if (rawSummary !== null) {
    const validation = schema.safeParse(rawSummary);
    if (!validation.success) {
      throw new Error(
        "restic check: output did not match expected shape",
      );
    }
    return validation.data;
  }

  if (success) {
    // exit 0 but no valid check summary — fail at the boundary rather than
    // defaulting to ok:true downstream.
    throw new Error(
      "restic check: exit 0 but no valid check summary — output did not match expected shape",
    );
  }

  // Non-zero exit with no summary: the check itself failed; caller records ok:false.
  return null;
}

/**
 * Decode and validate the last summary JSONL line from a restic command output.
 *
 * Uses findJsonlMessage to locate the last line with message_type=='summary',
 * then validates it against a supplied Zod schema. A missing summary line is
 * itself a boundary failure. On parse failure OR schema mismatch, throws ONE
 * sanitized boundary error naming the command and mismatch class.
 *
 * Used by: backup, restore.
 */
export function decodeResticSummary<T>(
  stdout: string,
  schema: z.ZodType<T>,
  command: string,
): T {
  let summary: Record<string, unknown> | null;
  try {
    summary = findJsonlMessage(stdout, "summary");
  } catch {
    throw new Error(
      `restic ${command}: output did not match expected shape — invalid JSON`,
    );
  }

  if (summary === null) {
    throw new Error(
      `restic ${command}: output did not match expected shape — no summary line`,
    );
  }

  const result = schema.safeParse(summary);
  if (!result.success) {
    throw new Error(
      `restic ${command}: output did not match expected shape`,
    );
  }
  return result.data;
}

// =============================================================================
// Capability Probe
// =============================================================================

/**
 * Probe whether the restic binary is present and supports `--json` output.
 *
 * This checks only what it can verify without touching the repository: it runs
 * `restic version --json` (no repo credentials needed) and confirms the output
 * is valid JSON with message_type="version". It does NOT verify every command's
 * --json behaviour individually — that is guaranteed by restic >= 0.9.6 for all
 * commands this model uses. The probe is a structural binary-present + JSON-capable
 * check; if it fails, all operational methods refuse to run.
 *
 * No secrets are injected — `restic version` requires no repo access.
 */
export async function probeResticCapability(
  resticPath: string,
  cwd: string,
): Promise<{ supported: boolean; version: string | null; message: string }> {
  const result = await invokeResticNoSecrets(
    [resticPath, "version", "--json"],
    cwd,
  );

  if (!result.success && result.exitCode !== 0) {
    return {
      supported: false,
      version: null,
      message: `restic binary not found or not executable at '${resticPath}': ${result.stderr.slice(0, 200)}`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    if (parsed["message_type"] !== "version") {
      return {
        supported: false,
        version: null,
        message: `restic version --json did not emit message_type="version" (got '${parsed["message_type"]}') — binary may not support --json`,
      };
    }
    return {
      supported: true,
      version: (parsed["version"] as string) ?? null,
      message: `restic ${parsed["version"]} detected; --json output confirmed`,
    };
  } catch (parseError) {
    return {
      supported: false,
      version: null,
      message: `restic version --json did not emit valid JSON — binary may not support --json: ${String(parseError)}`,
    };
  }
}
