/**
 * Restic subprocess spawn primitives.
 *
 * This is the SOLE owner of Deno.Command. No other module may construct
 * Deno.Command directly.
 *
 * Exports:
 *   - SpawnEffect — injectable seam for the spawn operation (real or fake)
 *   - realSpawn — the real Deno.Command-backed SpawnEffect. It takes a
 *     FULLY-BUILT env and injects NO secrets itself, so exporting it does not
 *     create a secret-bearing raw-argv escape hatch; secret-env assembly lives
 *     in commands.ts (the command layer), which is the only place restore is
 *     reachable — and only via the SafeRestoreTarget-checked invokeResticRestore.
 *   - invokeResticNoSecrets — the no-secrets version probe (clearEnv + PATH only)
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import type { ResticResult } from "./decode.ts";

/**
 * Injectable spawn seam.
 *
 * The real implementation wraps Deno.Command; tests inject a fake that
 * captures the argv/env for assertion without spawning a real process.
 *
 * Signature matches the internal spawnRestic primitive exactly so commands.ts
 * can pass a fake through the typed per-command entries without exposing a raw
 * secret-bearing argv invoker publicly.
 */
export type SpawnEffect = (
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  clearEnv: boolean,
) => Promise<ResticResult>;

/**
 * Real Deno.Command-backed spawn — the sole place Deno.Command is constructed.
 * Takes a fully-built env and injects no secrets; commands.ts builds the
 * secret env before calling this, and tests substitute a fake SpawnEffect.
 */
export const realSpawn: SpawnEffect = async (
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  clearEnv: boolean = false,
): Promise<ResticResult> => {
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
};

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
 *
 * The optional `spawn` parameter enables test injection. Real callers omit it.
 */
export async function invokeResticNoSecrets(
  argv: string[],
  cwd: string,
  spawn: SpawnEffect = realSpawn,
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
  return spawn(argv, probeEnv, cwd, /* clearEnv= */ true);
}
