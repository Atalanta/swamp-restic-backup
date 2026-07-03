/**
 * Restic output parsing and structured result type.
 *
 * Owns: ResticResult type, parseResticJsonOutput, findJsonlMessage,
 * decodeResticOutput, decodeResticSummary, decodeResticCheckOutput.
 *
 * This module has no Deno.Command, no Deno.env, no subprocess concerns.
 * It is importable by any module without creating cycles.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import type { z } from "npm:zod@4.4.3";

/** Structured result from running a restic subprocess. */
export type ResticResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
};

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
