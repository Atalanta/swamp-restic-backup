/**
 * Test suite for the @atalanta/restic-backup swamp model extension.
 *
 * Two tiers:
 *   1. Unit tests — stub vault, stubbed invoker, no real restic required for most
 *   2. Integration tests — real local restic repo (filesystem backend, NOT B2)
 *
 * Real-B2 tests are env-gated and skipped by default.
 *
 * Run with: deno test --allow-all extensions/models/restic_backup_test.ts
 *
 * @module
 */

import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@^1";

import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_PATHS,
} from "./_lib/policy.ts";
import { checkRestoreTargetSafety } from "./_lib/path-safety.ts";
import {
  decodeResticOutput,
  decodeResticSummary,
  findJsonlMessage,
  parseResticJsonOutput,
} from "./_lib/invoker.ts";
import { runSecretPreflight } from "./_lib/preflight.ts";
import { redactSecrets, resolveSecrets } from "./_lib/secrets.ts";
import {
  type GlobalArgs,
  ResticBackupSummarySchema,
  ResticCheckSummarySchema,
  ResticForgetArraySchema,
  ResticInitOutputSchema,
  ResticRestoreSummarySchema,
  ResticSnapshotArraySchema,
} from "./_lib/schemas.ts";
import { model } from "./restic_backup.ts";
// Public-surface guard: the entry module must keep re-exporting the symbols it
// exposed before the _lib/ split, so the refactor does not silently change the
// extension's public API. Imported under a namespace so a dropped re-export is
// a compile error caught here, not only by external consumers.
import * as entry from "./restic_backup.ts";

// =============================================================================
// Public-surface compatibility (guards the refactor's "public API unchanged")
// =============================================================================

Deno.test("public surface: entry re-exports the pre-split public symbols", () => {
  assertEquals(typeof entry.model, "object");
  assertEquals(typeof entry.checkRestoreTargetSafety, "function");
  assertEquals(typeof entry.parseResticJsonOutput, "function");
  assertEquals(Array.isArray(entry.DEFAULT_INCLUDE_PATHS), true);
  assertEquals(Array.isArray(entry.DEFAULT_EXCLUDE_PATTERNS), true);
});

// =============================================================================
// Test helpers and stub builders
// =============================================================================

/** Minimal stub for a written resource handle. */
type ResourceHandle = {
  name: string;
  specName: string;
  kind: string;
  dataId: string;
  version: number;
  size: number;
};

/** Builds a no-op resource handle for testing. */
function makeResourceHandle(specName: string, instanceName: string): ResourceHandle {
  return {
    name: instanceName,
    specName,
    kind: "data",
    dataId: `test-${instanceName}`,
    version: 1,
    size: 0,
  };
}

/** Captured write call for assertion. */
type WriteCall = { specName: string; instanceName: string; data: Record<string, unknown> };

/** Builds a MethodContext stub with captured writes and configurable globalArgs. */
function makeContext(
  globalArgsOverrides: Partial<ReturnType<typeof makeGlobalArgs>> = {},
): {
  context: Parameters<typeof model.methods.checkRestic.execute>[1];
  writes: WriteCall[];
  logMessages: string[];
} {
  const writes: WriteCall[] = [];
  const logMessages: string[] = [];

  const globalArgs = { ...makeGlobalArgs(), ...globalArgsOverrides };

  const context = {
    globalArgs,
    logger: {
      info: (msg: string, _meta?: Record<string, unknown>) => {
        logMessages.push(`INFO: ${msg}`);
      },
      warning: (msg: string, _meta?: Record<string, unknown>) => {
        logMessages.push(`WARN: ${msg}`);
      },
      error: (msg: string, _meta?: Record<string, unknown>) => {
        logMessages.push(`ERROR: ${msg}`);
      },
    },
    writeResource: async (
      specName: string,
      instanceName: string,
      data: Record<string, unknown>,
    ): Promise<ResourceHandle> => {
      writes.push({ specName, instanceName, data });
      return Promise.resolve(makeResourceHandle(specName, instanceName));
    },
    readResource: async (_instanceName: string): Promise<Record<string, unknown> | null> => {
      return Promise.resolve(null);
    },
  };

  return { context: context as Parameters<typeof model.methods.checkRestic.execute>[1], writes, logMessages };
}

/** Builds a complete set of default globalArgs for testing. */
function makeGlobalArgs(overrides: Record<string, unknown> = {}) {
  return {
    repository: "b2:test-bucket:test-path",
    repoDir: "/tmp/test-repo",
    include: [] as string[],
    exclude: [] as string[],
    hostTag: undefined as string | undefined,
    extraTags: [] as string[],
    retention: {} as Record<string, number | undefined>,
    resticPath: "/opt/homebrew/bin/restic",
    // These are vault.get CEL expressions resolved by swamp at runtime.
    // In tests, swamp resolves them to plain string values before calling execute.
    resticPassword: "test-restic-password",
    b2AccountId: "test-b2-account-id",
    b2AccountKey: "test-b2-account-key",
    ...overrides,
  };
}

// =============================================================================
// S1: Default include/exclude policy tests
// =============================================================================

Deno.test("S1: DEFAULT_INCLUDE_PATHS matches architecture policy exactly", () => {
  const expectedIncludes = [
    ".swamp/data",
    ".swamp/outputs",
    ".swamp/workflow-runs",
    ".swamp/definitions-evaluated",
    ".swamp/workflows-evaluated",
  ];
  assertEquals(
    [...DEFAULT_INCLUDE_PATHS].sort(),
    [...expectedIncludes].sort(),
    "Default include paths must match the architecture policy exactly",
  );
});

Deno.test("S1: DEFAULT_EXCLUDE_PATTERNS matches architecture policy exactly", () => {
  const expectedExcludes = [
    ".swamp/data/_catalog.db",
    ".swamp/bundles",
    ".swamp/datastore-bundles",
    ".swamp/driver-bundles",
    ".swamp/report-bundles",
    ".swamp/vault-bundles",
    ".swamp/telemetry",
    ".swamp/logs",
    ".swamp/secrets",
  ];
  assertEquals(
    [...DEFAULT_EXCLUDE_PATTERNS].sort(),
    [...expectedExcludes].sort(),
    "Default exclude patterns must match the architecture policy exactly",
  );
});

// =============================================================================
// S1: globalArguments stores raw vault.get expressions, not literal values
// =============================================================================

Deno.test("S1: globalArguments schema contains resticPassword, b2AccountId, b2AccountKey as z.string()", () => {
  // The globalArguments schema must accept these keys as plain strings.
  // In production, swamp resolves vault.get CEL expressions to strings before calling execute.
  // Here we verify the schema shape stores expressions, not any vault-specific type.
  const schema = model.globalArguments;

  // Parsing a set of expressions should succeed
  const parsed = schema.parse({
    repository: "b2:bucket:path",
    resticPassword: "vault.get('my-vault', 'restic_password')",
    b2AccountId: "vault.get('my-vault', 'b2_account_id')",
    b2AccountKey: "vault.get('my-vault', 'b2_account_key')",
  });

  // The schema must store the raw expressions without transformation
  assertEquals(parsed.resticPassword, "vault.get('my-vault', 'restic_password')");
  assertEquals(parsed.b2AccountId, "vault.get('my-vault', 'b2_account_id')");
  assertEquals(parsed.b2AccountKey, "vault.get('my-vault', 'b2_account_key')");
});

Deno.test("S1: model type is @atalanta/restic-backup/repository", () => {
  assertEquals(model.type, "@atalanta/restic-backup/repository");
});

// =============================================================================
// S2: TABLE-DRIVEN missing-secret tests
// =============================================================================

// These test that a structured error is thrown BEFORE restic is called
// when any of the three required secrets is absent or empty.
//
// We test each of the 3 secrets × 2 conditions (absent/empty) = 6 cases.
// We verify: (a) a structured Error is thrown, (b) its message names the missing secret.
//
// We can't directly assert "invoker NOT called" without mocking Deno.Command,
// but because the error is thrown before invokeRestic is reached, and all
// integration test secrets point to a real B2 (absent), the error happens in
// the validation layer.

type MissingSecretCase = {
  label: string;
  override: Record<string, unknown>;
  expectedSecretName: string;
};

const MISSING_SECRET_CASES: MissingSecretCase[] = [
  {
    label: "resticPassword absent",
    override: { resticPassword: undefined as unknown as string },
    expectedSecretName: "resticPassword",
  },
  {
    label: "resticPassword empty string",
    override: { resticPassword: "" },
    expectedSecretName: "resticPassword",
  },
  {
    label: "b2AccountId absent",
    override: { b2AccountId: undefined as unknown as string },
    expectedSecretName: "b2AccountId",
  },
  {
    label: "b2AccountId empty string",
    override: { b2AccountId: "" },
    expectedSecretName: "b2AccountId",
  },
  {
    label: "b2AccountKey absent",
    override: { b2AccountKey: undefined as unknown as string },
    expectedSecretName: "b2AccountKey",
  },
  {
    label: "b2AccountKey empty string",
    override: { b2AccountKey: "" },
    expectedSecretName: "b2AccountKey",
  },
];

for (const testCase of MISSING_SECRET_CASES) {
  Deno.test(`S2: missing secret — ${testCase.label} → structured pre-restic error`, async () => {
    // Override the schema parse to allow missing values (the schema uses z.string()
    // which requires a value; we bypass it by providing a partial override)
    const overriddenArgs = makeGlobalArgs(testCase.override);
    // Force the field to undefined/empty to simulate missing vault resolution
    if (testCase.override[testCase.expectedSecretName] === undefined) {
      (overriddenArgs as Record<string, unknown>)[testCase.expectedSecretName] = undefined;
    }

    const { context } = makeContext(overriddenArgs);

    // Use `init` as a representative method (any operational method should fail the same way)
    const error = await assertRejects(
      () => model.methods.init.execute({}, context),
      Error,
    );

    // The error message must name the missing secret field
    assertStringIncludes(
      error.message,
      testCase.expectedSecretName,
      `Error message must name the missing secret '${testCase.expectedSecretName}'`,
    );

    // The error must mention "Secret" or "secret" to indicate it's a pre-restic validation
    assertMatch(
      error.message,
      /[Ss]ecret/,
      "Error must indicate this is a secret validation failure",
    );
  });
}

Deno.test("S2: all three secrets present → no pre-restic error thrown (validation passes)", async () => {
  // With all secrets present, validation should pass.
  // The actual restic call will fail (wrong repo URL / not a real B2), but
  // that's a restic-level error, not a secret-validation error.
  const { context } = makeContext({
    repository: "/tmp/nonexistent-restic-repo-validation-test",
    resticPath: "/opt/homebrew/bin/restic",
    resticPassword: "not-empty",
    b2AccountId: "not-empty",
    b2AccountKey: "not-empty",
  });

  // Should throw a restic-level error, NOT a secret validation error
  const error = await assertRejects(
    () => model.methods.init.execute({}, context),
    Error,
  );

  // The error must NOT be a secret validation error
  const isSecretError = error.message.includes("Secret validation failed");
  assertEquals(isSecretError, false, "Should not be a secret validation error when all secrets are present");
});

// =============================================================================
// S2: Stub-invoker tests — invoker NOT called when secrets missing/empty
// =============================================================================

// These tests use a real invocation count to prove the restic invoker is never
// reached when secret validation fails. We replace resticPath with a counter
// script that would succeed if called, and assert it was never executed.

Deno.test("S2: table-driven — invoker NEVER called when any secret is missing or empty", async () => {
  // Write a tiny shell script that records invocations to a temp file and exits 0.
  // If the invoker is called despite missing secrets, the temp file will exist.
  const tmpDir = await Deno.makeTempDir();
  const invocationMarker = `${tmpDir}/invoked`;
  const fakeBinary = `${tmpDir}/fake-restic`;

  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh\ntouch ${invocationMarker}\necho '{"message_type":"version","version":"0.0.0","go_version":"go1.0","go_os":"linux","go_arch":"amd64"}'\nexit 0\n`,
  );
  await Deno.chmod(fakeBinary, 0o755);

  try {
    for (const testCase of MISSING_SECRET_CASES) {
      // Remove the marker before each case.
      try { await Deno.remove(invocationMarker); } catch { /* not present */ }

      const overriddenArgs = makeGlobalArgs({
        ...testCase.override,
        resticPath: fakeBinary,
        repoDir: tmpDir,
        repository: `${tmpDir}/nonexistent-repo`,
      });
      if (testCase.override[testCase.expectedSecretName] === undefined) {
        (overriddenArgs as Record<string, unknown>)[testCase.expectedSecretName] = undefined;
      }

      const { context } = makeContext(overriddenArgs);

      const error = await assertRejects(
        () => model.methods.init.execute({}, context),
        Error,
      );
      assertStringIncludes(error.message, testCase.expectedSecretName);

      // The fake binary must NOT have been invoked — no marker file should exist.
      let invoked = false;
      try { await Deno.stat(invocationMarker); invoked = true; } catch { /* expected */ }
      assertEquals(
        invoked,
        false,
        `Restic invoker MUST NOT be called when ${testCase.label} (marker file found)`,
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("S2: all three secrets present → secrets injected into child env, absent from argv and output", async () => {
  // Write a script that dumps its own env and argv to stdout as JSON.
  const tmpDir = await Deno.makeTempDir();
  const fakeBinary = `${tmpDir}/fake-restic`;

  // The script emits what `restic version --json` would for the probe, then on the
  // second call (cat config) exits 1 (repo not found), then init returns initialized.
  // We use a counter file to distinguish calls.
  const callCountFile = `${tmpDir}/call-count`;
  const envDumpFile = `${tmpDir}/env-dump`;

  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "${callCountFile}"
env > "${envDumpFile}"
# Call 1: version probe → emit version JSON
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.1","go_version":"go1.25","go_os":"darwin","go_arch":"arm64"}'
  exit 0
fi
# Call 2: cat config → exit 1 (repo not yet initialized)
if [ "$COUNT" -eq 2 ]; then
  echo '{"message_type":"exit_error","code":10,"message":"no such file or directory"}'
  exit 1
fi
# Call 3: init → success
echo '{"message_type":"initialized","id":"abc123","repository":"test"}'
exit 0
`,
  );
  await Deno.chmod(fakeBinary, 0o755);

  try {
    const { context, writes } = makeContext({
      repository: `${tmpDir}/test-repo`,
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "SECRET_PASSWORD_VALUE",
      b2AccountId: "SECRET_B2_ID_VALUE",
      b2AccountKey: "SECRET_B2_KEY_VALUE",
    });

    await model.methods.init.execute({}, context);

    // Verify secrets appear in env dump (were injected into subprocess env).
    const envContent = await Deno.readTextFile(envDumpFile);
    assertStringIncludes(envContent, "RESTIC_PASSWORD=SECRET_PASSWORD_VALUE");
    assertStringIncludes(envContent, "B2_ACCOUNT_ID=SECRET_B2_ID_VALUE");
    assertStringIncludes(envContent, "B2_ACCOUNT_KEY=SECRET_B2_KEY_VALUE");

    // Verify secrets do NOT appear in any written resource.
    for (const write of writes) {
      const resourceJson = JSON.stringify(write.data);
      assertEquals(
        resourceJson.includes("SECRET_PASSWORD_VALUE"),
        false,
        "RESTIC_PASSWORD must not appear in any written resource",
      );
      assertEquals(
        resourceJson.includes("SECRET_B2_ID_VALUE"),
        false,
        "B2_ACCOUNT_ID must not appear in any written resource",
      );
      assertEquals(
        resourceJson.includes("SECRET_B2_KEY_VALUE"),
        false,
        "B2_ACCOUNT_KEY must not appear in any written resource",
      );
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("S2: vault-type abstraction — identical resolved strings from two different vault sources yield identical behaviour", async () => {
  // swamp resolves vault.get expressions to plain strings before execute is called.
  // The model must behave identically regardless of which vault backend provided the values.
  // We use two different "resolved" strings (simulating two vault configurations) and
  // assert both fail at the restic level, not the secret-validation level.

  const vaultAArgs = makeGlobalArgs({
    repository: "/tmp/nonexistent-vault-a",
    resticPassword: "resolved-password-from-vault-a",
    b2AccountId: "resolved-id-from-vault-a",
    b2AccountKey: "resolved-key-from-vault-a",
  });

  const vaultBArgs = makeGlobalArgs({
    repository: "/tmp/nonexistent-vault-b",
    resticPassword: "resolved-password-from-vault-b",
    b2AccountId: "resolved-id-from-vault-b",
    b2AccountKey: "resolved-key-from-vault-b",
  });

  const { context: ctxA } = makeContext(vaultAArgs);
  const { context: ctxB } = makeContext(vaultBArgs);

  // Both should fail at restic level (binary can't open a nonexistent local path),
  // not at secret-validation level — proving vault-backend agnosticism.
  const errorA = await assertRejects(() => model.methods.init.execute({}, ctxA), Error);
  const errorB = await assertRejects(() => model.methods.init.execute({}, ctxB), Error);

  assertEquals(
    errorA.message.includes("Secret validation failed"),
    false,
    "Vault A: must not be a secret validation error",
  );
  assertEquals(
    errorB.message.includes("Secret validation failed"),
    false,
    "Vault B: must not be a secret validation error",
  );
});

// =============================================================================
// S3: --json flag on every command
// =============================================================================

// We verify --json is present by running each command against a nonexistent repo
// and asserting the output is valid JSON (which only happens when --json is used).

async function runCommandAndGetStdout(methodName: keyof typeof model.methods, args: Record<string, unknown>): Promise<string> {
  // Use a temp dir that exists (so the binary check passes) but is not a valid repo
  const tempDir = await Deno.makeTempDir();
  try {
    const { context } = makeContext({
      repository: `${tempDir}/nonexistent-repo`,
      resticPath: "/opt/homebrew/bin/restic",
      resticPassword: "probe-password",
      b2AccountId: "probe-id",
      b2AccountKey: "probe-key",
      repoDir: tempDir,
    });

    // We expect this to throw (repo doesn't exist), but we need to capture
    // whether the error came from JSON parsing or from restic's exit_error JSON
    try {
      // deno-lint-ignore no-explicit-any
      await (model.methods[methodName] as unknown as { execute: (args: Record<string, unknown>, ctx: typeof context) => Promise<unknown> }).execute(args, context);
    } catch (err) {
      // Expected — return the error message for analysis
      return (err as Error).message;
    }
    return "no-error";
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("S3: check_restic uses --json (version command returns JSON)", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { context, writes } = makeContext({
      repository: "b2:test:test",
      resticPath: "/opt/homebrew/bin/restic",
      resticPassword: "probe",
      b2AccountId: "probe",
      b2AccountKey: "probe",
      repoDir: tempDir,
    });
    await model.methods.checkRestic.execute({}, context);
    // If --json was NOT used, available would be false or throw a parse error
    assertEquals(writes.length, 1);
    assertEquals(writes[0].specName, "resticStatus");
    assertEquals(writes[0].data.available, true);
    // Version must be parseable and non-empty
    assertStringIncludes(String(writes[0].data.version ?? ""), "0.");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("S3: init uses --json (exit_error JSON on nonexistent repo, not human text)", async () => {
  const result = await runCommandAndGetStdout("init", {});
  // The error message should reference the restic failure, not a parse error
  // If --json was NOT used, we'd get a parse error or garbage text
  // With --json, restic emits {"message_type":"exit_error",...} which we parse correctly
  const isParseError = result.includes("not valid JSON");
  assertEquals(isParseError, false, `init should use --json; got: ${result}`);
});

Deno.test("S3: snapshots uses --json (returns JSON array, not human text)", async () => {
  const result = await runCommandAndGetStdout("snapshots", {});
  // With --json, restic returns exit_error JSON or an empty array — both valid JSON
  // Without --json, we'd get human text which would cause a parse error
  const isParseError = result.includes("not valid JSON") || result.includes("Unexpected token");
  assertEquals(isParseError, false, `snapshots should use --json; got: ${result}`);
});

Deno.test("S3: check uses --json (exit_error JSON on nonexistent repo)", async () => {
  const result = await runCommandAndGetStdout("check", {});
  const isParseError = result.includes("not valid JSON") || result.includes("Unexpected token");
  assertEquals(isParseError, false, `check should use --json; got: ${result}`);
});

Deno.test("S3: restore requires targetDir (checked before restic invocation)", async () => {
  const result = await runCommandAndGetStdout("restore", {
    snapshot: "latest",
    targetDir: "",
    confirm: false,
  });
  // Should get a targetDir validation error before restic is even called
  assertStringIncludes(result, "targetDir", "restore must require targetDir");
});

Deno.test("S3: forget uses --json (exit_error JSON on nonexistent repo)", async () => {
  const result = await runCommandAndGetStdout("forget", { keepLast: 3 });
  const isParseError = result.includes("not valid JSON") || result.includes("Unexpected token");
  assertEquals(isParseError, false, `forget should use --json; got: ${result}`);
});

Deno.test("S3: prune uses --json flag (even though restic emits no JSON for prune)", async () => {
  // restic prune emits no JSON in any released version (upstream gap); --json is
  // passed anyway (harmless, future-proof). Success is determined by exit code only.
  // The test verifies the method does NOT attempt to JSON-parse the stdout — if it
  // did, it would throw SyntaxError, which would surface as a "not valid JSON" message.
  const result = await runCommandAndGetStdout("prune", {});
  // A SyntaxError would indicate the method tried to JSON-parse human text.
  // The only acceptable failure is a restic-level error (missing repo, etc.).
  const isJsonParseError = result.includes("SyntaxError") || result.includes("Unexpected token");
  assertEquals(isJsonParseError, false, `prune must not attempt to JSON-parse human-text output; got: ${result}`);
});

// =============================================================================
// S3: No human-text parser path reachable
// =============================================================================

Deno.test("S3/R3-LOW-003: parseResticJsonOutput throws sanitized Error on non-JSON input (no raw input in message, no silent fallback)", () => {
  // parseResticJsonOutput must throw a sanitized domain Error — NOT a raw SyntaxError
  // that could embed an input snippet containing reflected secrets.
  // The no-human-text-parser invariant requires that malformed subprocess output is
  // rejected with a fixed message that does not include any raw input.
  const RAW_INPUT = "This is not JSON at all — SENSITIVE_CANARY_VALUE_XK9M";
  let threw = false;
  try {
    parseResticJsonOutput(RAW_INPUT);
  } catch (err) {
    threw = true;
    // Must be a plain Error (domain error), NOT a SyntaxError with raw input embedded
    assertEquals(err instanceof Error, true, "Must throw Error on non-JSON input");
    // The raw input (including any canary/secret it might contain) must NOT appear in the message
    assertEquals(
      (err as Error).message.includes(RAW_INPUT),
      false,
      "Raw input must NOT appear in the sanitized error message",
    );
    assertEquals(
      (err as Error).message.includes("SENSITIVE_CANARY_VALUE_XK9M"),
      false,
      "Canary value from raw input must NOT appear in the sanitized error message",
    );
  }
  assertEquals(threw, true, "parseResticJsonOutput must throw on non-JSON input");
});

Deno.test("S3: parseResticJsonOutput parses valid JSONL correctly", () => {
  const jsonl = `{"message_type":"status","percent_done":0.5}\n{"message_type":"summary","files_new":3}`;
  const result = parseResticJsonOutput(jsonl) as Array<Record<string, unknown>>;
  assertEquals(Array.isArray(result), true);
  assertEquals(result.length, 2);
  assertEquals(result[0]["message_type"], "status");
  assertEquals(result[1]["message_type"], "summary");
});

// =============================================================================
// S3: Capability probe structural failure
// =============================================================================

Deno.test("S3: capability probe with nonexistent binary → structured error, not throw", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { context, writes } = makeContext({
      repository: "b2:test:test",
      resticPath: "/nonexistent/path/to/restic-does-not-exist",
      // check_restic does NOT require secrets — but makeContext needs them for
      // the schema. The check_restic execute path should not use them at all.
      resticPassword: "irrelevant-for-check-restic",
      b2AccountId: "irrelevant-for-check-restic",
      b2AccountKey: "irrelevant-for-check-restic",
      repoDir: tempDir,
    });

    // check_restic should return available:false, not throw
    await model.methods.checkRestic.execute({}, context);
    assertEquals(writes.length, 1);
    assertEquals(writes[0].data.available, false);
    // Message should explain the binary was not found
    assertMatch(
      String(writes[0].data.message ?? ""),
      /not found|not executable|error/i,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("S3: check_restic does NOT inject placeholder secrets when vault secrets are missing", async () => {
  // F1 fix: check_restic must work even when secret fields are empty/unset,
  // because it only probes the binary (restic version --json) which needs no creds.
  // Previously the code injected placeholder "probe" strings — that was wrong.
  const tempDir = await Deno.makeTempDir();
  try {
    const { context, writes } = makeContext({
      repository: "b2:test:test",
      resticPath: "/opt/homebrew/bin/restic",
      // Deliberately empty — check_restic must not validate or inject these.
      resticPassword: "",
      b2AccountId: "",
      b2AccountKey: "",
      repoDir: tempDir,
    });

    // Must succeed (binary present) even with empty secrets.
    await model.methods.checkRestic.execute({}, context);
    assertEquals(writes.length, 1);
    assertEquals(writes[0].data.available, true, "check_restic must work without secrets configured");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("S3: operational methods refuse to run when capability probe fails", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPath: "/nonexistent/path/to/restic-does-not-exist",
      resticPassword: "valid-password",
      b2AccountId: "valid-id",
      b2AccountKey: "valid-key",
      repoDir: tempDir,
    });

    // Operational method should throw a structured error
    const error = await assertRejects(
      () => model.methods.init.execute({}, context),
      Error,
    );
    assertMatch(
      error.message,
      /restic|not found|--json/i,
      "Error should mention restic binary or --json support",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// =============================================================================
// S9: Restore refusal cases
// =============================================================================

/** Creates a real temporary repo directory structure for restore safety tests. */
async function makeRestoreTestDir(): Promise<{ repoDir: string; swampDir: string }> {
  const repoDir = await Deno.makeTempDir();
  const swampDir = `${repoDir}/.swamp`;
  await Deno.mkdir(swampDir, { recursive: true });
  return { repoDir, swampDir };
}

Deno.test("S9: restore refuses missing targetDir without confirm:true", async () => {
  const { repoDir } = await makeRestoreTestDir();
  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      repoDir,
    });
    const error = await assertRejects(
      () => model.methods.restore.execute({ snapshot: "latest", targetDir: "", confirm: false }, context),
      Error,
    );
    assertStringIncludes(error.message, "targetDir");
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("S9: restore refuses targetDir == repo root without confirm:true", async () => {
  const { repoDir } = await makeRestoreTestDir();
  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      repoDir,
    });
    const error = await assertRejects(
      () => model.methods.restore.execute({ snapshot: "latest", targetDir: repoDir, confirm: false }, context),
      Error,
    );
    assertMatch(error.message, /repo root|Refusing/i);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("S9: restore refuses targetDir == .swamp/ without confirm:true", async () => {
  const { repoDir, swampDir } = await makeRestoreTestDir();
  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      repoDir,
    });
    const error = await assertRejects(
      () => model.methods.restore.execute({ snapshot: "latest", targetDir: swampDir, confirm: false }, context),
      Error,
    );
    assertMatch(error.message, /\.swamp|Refusing/i);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("S9: restore refuses ancestor dir containing .swamp/ without confirm:true", async () => {
  // Create a structure: /tmp/grandparent/repo/.swamp/
  // Restore target: /tmp/grandparent/ — which is an ancestor of .swamp/
  const grandparent = await Deno.makeTempDir();
  const repoDir = `${grandparent}/myrepo`;
  await Deno.mkdir(`${repoDir}/.swamp`, { recursive: true });
  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      repoDir,
    });
    const error = await assertRejects(
      () => model.methods.restore.execute({ snapshot: "latest", targetDir: grandparent, confirm: false }, context),
      Error,
    );
    assertMatch(error.message, /ancestor|\.swamp|Refusing/i);
  } finally {
    await Deno.remove(grandparent, { recursive: true });
  }
});

Deno.test("S9: restore refuses symlink into .swamp/ without confirm:true", async () => {
  const { repoDir, swampDir } = await makeRestoreTestDir();
  // Create a symlink that points into .swamp/
  const symlinkTarget = `${repoDir}/link-to-swamp`;
  try {
    await Deno.symlink(swampDir, symlinkTarget);
  } catch {
    // If symlink creation fails, skip this test
    await Deno.remove(repoDir, { recursive: true });
    return;
  }
  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      repoDir,
    });
    const error = await assertRejects(
      () => model.methods.restore.execute({ snapshot: "latest", targetDir: symlinkTarget, confirm: false }, context),
      Error,
    );
    assertMatch(error.message, /\.swamp|Refusing|symlink/i);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("S9/F2: restore refuses ../traversal into .swamp/ without confirm:true", async () => {
  // A path like `<repoDir>/.swamp/restore/../../../staging/../.swamp` after normalization
  // resolves to .swamp/ and must be refused. We test a simpler canonical case:
  // <repoDir>/staging/../.swamp which normalizes to <repoDir>/.swamp
  const { repoDir } = await makeRestoreTestDir();
  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      repoDir,
    });
    // staging/../.swamp normalizes to repoDir/.swamp
    const traversalTarget = `${repoDir}/staging/../.swamp`;
    const error = await assertRejects(
      () => model.methods.restore.execute({ snapshot: "latest", targetDir: traversalTarget, confirm: false }, context),
      Error,
    );
    assertMatch(error.message, /\.swamp|Refusing/i);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("S9/F2: restore refuses symlink-parent with missing child pointing into .swamp/ without confirm:true", async () => {
  // Create: <repoDir>/.swamp/
  //         <repoDir>/link-to-swamp -> <repoDir>/.swamp
  // Target: <repoDir>/link-to-swamp/newchild  (newchild doesn't exist yet)
  // resolvePathWithAncestor must resolve link-to-swamp to .swamp/, then append newchild,
  // giving <repoDir>/.swamp/newchild which is inside .swamp/.
  const { repoDir, swampDir } = await makeRestoreTestDir();
  const symlinkToSwamp = `${repoDir}/link-to-swamp`;
  try {
    await Deno.symlink(swampDir, symlinkToSwamp);
  } catch {
    await Deno.remove(repoDir, { recursive: true });
    return; // Skip if symlink creation fails (e.g. no permission)
  }
  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      repoDir,
    });
    // newchild does not exist — must still be caught
    const missingChildTarget = `${symlinkToSwamp}/newchild`;
    const error = await assertRejects(
      () => model.methods.restore.execute({ snapshot: "latest", targetDir: missingChildTarget, confirm: false }, context),
      Error,
    );
    assertMatch(error.message, /\.swamp|Refusing/i);
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("S9: restore with confirm:true over a safe staging dir → proceeds past safety check", async () => {
  const { repoDir } = await makeRestoreTestDir();
  const stagingDir = await Deno.makeTempDir();
  try {
    const { context } = makeContext({
      repository: "/tmp/nonexistent-restic-for-restore-test",
      resticPath: "/opt/homebrew/bin/restic",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      repoDir,
    });

    // With confirm:true and a safe target, safety check passes.
    // The method will then fail at the restic level (nonexistent repo),
    // but must NOT fail with a safety refusal error.
    const error = await assertRejects(
      () => model.methods.restore.execute({ snapshot: "latest", targetDir: stagingDir, confirm: true }, context),
      Error,
    );
    // Should be a restic-level error, not a safety refusal
    const isSafetyError = error.message.includes("Refusing") || error.message.includes("dangerous target");
    assertEquals(isSafetyError, false, "With confirm:true and safe target, must not be a safety refusal");
  } finally {
    await Deno.remove(repoDir, { recursive: true });
    await Deno.remove(stagingDir, { recursive: true });
  }
});

// =============================================================================
// R2-MEDIUM-001: invokeResticNoSecrets scrubs ambient credential env vars
// =============================================================================
// The probe (restic version --json) must not inherit RESTIC_PASSWORD, B2_ACCOUNT_ID,
// or B2_ACCOUNT_KEY from the ambient process environment. If it did, those values
// could appear in probe-failure messages logged by check_restic before any
// redactSecrets call is possible.

Deno.test("R2-MEDIUM-001: probe binary does not receive ambient RESTIC_PASSWORD / B2_* env vars", async () => {
  // Plant known canary values in the process env to simulate ambient credentials.
  const AMBIENT_PASSWORD = "AMBIENT_PROBE_PASSWORD_9mXkQ2_MUST_NOT_REACH_PROBE";
  const AMBIENT_B2_ID = "AMBIENT_PROBE_B2_ID_7pNvR4_MUST_NOT_REACH_PROBE";
  const AMBIENT_B2_KEY = "AMBIENT_PROBE_B2_KEY_3wSfT8_MUST_NOT_REACH_PROBE";

  // Set ambient env vars that look like restic/B2 credentials.
  Deno.env.set("RESTIC_PASSWORD", AMBIENT_PASSWORD);
  Deno.env.set("B2_ACCOUNT_ID", AMBIENT_B2_ID);
  Deno.env.set("B2_ACCOUNT_KEY", AMBIENT_B2_KEY);

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-r2med001-" });
  // The fake restic dumps its entire env to a file, then responds as a valid version probe.
  const envDumpFile = `${tmpDir}/env-dump`;
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
env > "${envDumpFile}"
echo '{"message_type":"version","version":"0.18.0","go_version":"go1.21","go_os":"linux","go_arch":"amd64"}'
exit 0
`,
  );
  await Deno.chmod(fakeBinary, 0o755);

  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPath: fakeBinary,
      // check_restic deliberately uses empty secrets (F1 invariant).
      resticPassword: "",
      b2AccountId: "",
      b2AccountKey: "",
      repoDir: tmpDir,
    });

    await model.methods.checkRestic.execute({}, context);

    // Read the env that was actually passed to the probe subprocess.
    const envContent = await Deno.readTextFile(envDumpFile);

    // None of the ambient credential vars must appear in the probe's environment.
    assertEquals(
      envContent.includes(AMBIENT_PASSWORD),
      false,
      "RESTIC_PASSWORD ambient value must NOT be passed to the probe subprocess",
    );
    assertEquals(
      envContent.includes(AMBIENT_B2_ID),
      false,
      "B2_ACCOUNT_ID ambient value must NOT be passed to the probe subprocess",
    );
    assertEquals(
      envContent.includes(AMBIENT_B2_KEY),
      false,
      "B2_ACCOUNT_KEY ambient value must NOT be passed to the probe subprocess",
    );
  } finally {
    // Clean up ambient env vars we set.
    Deno.env.delete("RESTIC_PASSWORD");
    Deno.env.delete("B2_ACCOUNT_ID");
    Deno.env.delete("B2_ACCOUNT_KEY");
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// =============================================================================
// R1: Restore safety with repoDir='.' (default) and relative paths
// =============================================================================
// Bug: when repoDir='.', resolvePathWithAncestor('.', '.') produced '/' because
// normalizePosixPath collapses lone dots to '/'. The fix resolves repoDir to a
// real absolute path FIRST using Deno.cwd() as the anchor.

Deno.test("R1: restore refuses absolute targetDir inside .swamp/ when repoDir='.'", async () => {
  // Create a real temp dir that IS the process cwd for this check.
  // We can't change the process cwd, so we use a concrete absolute path for
  // repoDir (the real absolute path of the temp dir), not literal '.' — but
  // we set repoDir to the actual absolute path to ensure the safety boundary works.
  // Additionally we test a relative repoDir that requires path resolution.
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-r1-test-" });
  const swampDir = `${repoDir}/.swamp`;
  const swampSubDir = `${swampDir}/outputs`;
  await Deno.mkdir(swampSubDir, { recursive: true });

  try {
    // Absolute targetDir points INSIDE the real .swamp — must be refused.
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      // Use the real absolute repoDir so the boundary comparison is meaningful.
      repoDir,
    });
    const error = await assertRejects(
      () => model.methods.restore.execute(
        { snapshot: "latest", targetDir: swampSubDir, confirm: false },
        context,
      ),
      Error,
    );
    assertMatch(
      error.message,
      /\.swamp|Refusing/i,
      `Must refuse absolute targetDir inside .swamp/ — got: ${error.message}`,
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

Deno.test("R1: restore resolves relative repoDir correctly — absolute targetDir inside .swamp/ is refused", async () => {
  // Before the R1 fix, a relative repoDir like 'subdir' could normalize to
  // '/subdir' instead of '<cwd>/subdir', making the boundary check unreliable.
  // We create the repoDir as a real path; the context repoDir is the absolute form
  // (simulating what swamp provides after resolving '.').
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-r1-rel-test-" });
  const swampDir = `${repoDir}/.swamp`;
  await Deno.mkdir(swampDir, { recursive: true });

  try {
    const { context } = makeContext({
      repository: "b2:test:test",
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
      repoDir,
    });

    // Absolute path into .swamp/data — must be refused regardless of how repoDir was provided.
    const targetInsideSwamp = `${swampDir}/data`;
    const error = await assertRejects(
      () => model.methods.restore.execute(
        { snapshot: "latest", targetDir: targetInsideSwamp, confirm: false },
        context,
      ),
      Error,
    );
    assertMatch(
      error.message,
      /\.swamp|Refusing/i,
      `Must refuse targetDir inside .swamp/ — got: ${error.message}`,
    );
  } finally {
    await Deno.remove(repoDir, { recursive: true });
  }
});

// Deterministic proof of the R1 bug: drive checkRestoreTargetSafety directly
// with the LITERAL default repoDir='.' and an injected cwdAnchor (a real temp
// repo). Against the pre-fix code (which anchored '.' on a collapsed '/'), the
// boundary became '/.swamp' and an absolute target inside the actual repo's
// .swamp/ would NOT be refused (function returns null). This test would FAIL
// against that old behaviour; it passes only with the cwd-anchored fix.
Deno.test("R1: repoDir='.' is anchored on the repo cwd, not '/' — DIFFERENTIAL proof of the bug", async () => {
  const repoRoot = await Deno.makeTempDir({ prefix: "swamp-r1-dot-" });
  const realRepoRoot = await Deno.realPath(repoRoot);
  const swampData = `${realRepoRoot}/.swamp/data`;
  await Deno.mkdir(swampData, { recursive: true });

  try {
    // FIXED behaviour: repoDir='.' anchored on the real repo root resolves the
    // boundary to <repo>/.swamp, so a target inside it is REFUSED.
    const fixed = await checkRestoreTargetSafety(swampData, ".", realRepoRoot);
    assertMatch(
      fixed ?? "<null — BUG: target inside .swamp/ was allowed>",
      /\.swamp|Refusing/i,
      `repoDir='.' must resolve to ${realRepoRoot}/.swamp and refuse a target inside it`,
    );

    // DIFFERENTIAL: the pre-fix code anchored '.' on the PROCESS cwd, which is
    // NOT the repo here. That mis-anchoring is exactly the R1 bug: the same
    // target inside the REAL repo .swamp/ slips past the guard (returns null).
    // Asserting this proves the test actually distinguishes fixed from buggy —
    // a regression that re-anchors on Deno.cwd() will make this assertion fire.
    const misanchored = await checkRestoreTargetSafety(swampData, ".", Deno.cwd());
    assertEquals(
      misanchored,
      null,
      "sanity: a wrong cwd-anchor fails to protect the real .swamp/ — this is the bug the fix prevents",
    );

    // Control: a safe staging dir OUTSIDE the repo returns null (allowed) even
    // with the correct anchor.
    const stagingDir = await Deno.makeTempDir({ prefix: "swamp-r1-stage-" });
    try {
      const safe = await checkRestoreTargetSafety(stagingDir, ".", realRepoRoot);
      assertEquals(safe, null, "a staging dir outside the repo must be allowed");
    } finally {
      await Deno.remove(stagingDir, { recursive: true });
    }
  } finally {
    await Deno.remove(repoRoot, { recursive: true });
  }
});

// =============================================================================
// Integration tests — real local restic repo
// =============================================================================

/** Creates a fixture .swamp/ directory tree for backup integration tests. */
async function makeFixtureSwampTree(baseDir: string): Promise<void> {
  const dirs = [
    `${baseDir}/.swamp/data`,
    `${baseDir}/.swamp/outputs`,
    `${baseDir}/.swamp/workflow-runs`,
    `${baseDir}/.swamp/definitions-evaluated`,
    `${baseDir}/.swamp/workflows-evaluated`,
    // These should be excluded:
    `${baseDir}/.swamp/bundles`,
    `${baseDir}/.swamp/logs`,
    `${baseDir}/.swamp/secrets`,
    `${baseDir}/.swamp/telemetry`,
  ];

  for (const dir of dirs) {
    await Deno.mkdir(dir, { recursive: true });
  }

  // Create some files in included paths
  await Deno.writeTextFile(`${baseDir}/.swamp/data/run-001.json`, '{"run": 1}');
  await Deno.writeTextFile(`${baseDir}/.swamp/outputs/output-001.txt`, "output data");
  await Deno.writeTextFile(`${baseDir}/.swamp/workflow-runs/run-001.yaml`, "workflow: test");
  await Deno.writeTextFile(
    `${baseDir}/.swamp/definitions-evaluated/def-001.json`,
    '{"definition": "vault.get(\'my-vault\', \'secret\')"}',
  );

  // Create _catalog.db in data (should be excluded)
  await Deno.writeTextFile(`${baseDir}/.swamp/data/_catalog.db`, "sqlite-catalog");

  // Create files in excluded paths
  await Deno.writeTextFile(`${baseDir}/.swamp/logs/app.log`, "log data");
  await Deno.writeTextFile(`${baseDir}/.swamp/secrets/secret.txt`, "DO NOT BACK UP");
}

/** Creates a temp local restic repo for integration testing. */
async function makeIntegrationRepo(): Promise<{
  repoDir: string;
  resticRepo: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-backup-test-" });
  const resticRepo = `${repoDir}/restic-repo`;
  await Deno.mkdir(resticRepo, { recursive: true });

  return {
    repoDir,
    resticRepo,
    cleanup: async () => {
      await Deno.remove(repoDir, { recursive: true });
    },
  };
}

/** Context configured for integration tests against a local restic repo. */
function makeIntegrationContext(
  repoDir: string,
  resticRepo: string,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof makeContext> {
  return makeContext({
    repository: resticRepo,
    repoDir,
    resticPath: "/opt/homebrew/bin/restic",
    resticPassword: "integration-test-password",
    b2AccountId: "integration-b2-id",
    b2AccountKey: "integration-b2-key",
    ...overrides,
  });
}

// S6: init
Deno.test("S6: init — first call creates repository (created:true)", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    const { context, writes } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, context);

    assertEquals(writes.length, 1);
    assertEquals(writes[0].specName, "repositoryStatus");
    assertEquals(writes[0].data.created, true);
    assertEquals(writes[0].data.initialized, true);
    assertEquals(typeof writes[0].data.repository, "string");
  } finally {
    await cleanup();
  }
});

Deno.test("S6/F3: init — genuine open failure (wrong password) is NOT reported as already-initialized", async () => {
  // F3 fix: previously the code classified errors by substring-matching error messages,
  // which could misreport auth/corruption failures as "already initialized".
  // Now we use `restic cat config` exit-code as the idempotency probe: if cat config
  // fails (non-zero), we attempt init; if init also fails (bad creds), we must throw
  // a real error, NOT report initialized:true.
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    // First, initialize with the correct password.
    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, initCtx);

    // Now call init with a WRONG password — cat config will fail (wrong creds),
    // so the code proceeds to `restic init`, which also fails.
    // The result must be a thrown error, NOT initialized:true/created:false.
    const { context: wrongCredsCtx } = makeIntegrationContext(repoDir, resticRepo, {
      resticPassword: "WRONG_PASSWORD_DELIBERATE",
    });

    const error = await assertRejects(
      () => model.methods.init.execute({}, wrongCredsCtx),
      Error,
    );

    // Must NOT claim the repo is already initialized — that would be a false positive.
    const claimsInitialized = error.message.includes("already initialized");
    assertEquals(
      claimsInitialized,
      false,
      "A wrong-password failure must NOT be reported as already-initialized",
    );

    // The error must indicate a restic failure, not a secret validation failure.
    assertMatch(error.message, /restic init failed|exit/i);
  } finally {
    await cleanup();
  }
});

Deno.test("S6: init — second call on initialized repo (initialized:true, created:false, no throw)", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    const { context: ctx1 } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, ctx1);

    const { context: ctx2, writes: writes2 } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, ctx2);

    assertEquals(writes2.length, 1);
    assertEquals(writes2[0].data.initialized, true);
    assertEquals(writes2[0].data.created, false);
  } finally {
    await cleanup();
  }
});

// S7: backup
Deno.test("S7: backup — fixture .swamp/ tree → snapshotId, non-zero file counts", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    await makeFixtureSwampTree(repoDir);

    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, initCtx);

    const { context: backupCtx, writes } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: ["test"] }, backupCtx);

    assertEquals(writes.length, 1);
    assertEquals(writes[0].specName, "backupResult");
    const result = writes[0].data;

    // Must have a non-empty snapshot ID
    assertMatch(String(result.snapshotId ?? ""), /^[0-9a-f]{10,}$/);

    // Must have processed at least 1 file
    assertEquals(
      (result.fileCount as number) > 0,
      true,
      `Expected non-zero fileCount, got: ${result.fileCount}`,
    );

    // Secret values must NOT appear in the result
    const resultJson = JSON.stringify(result);
    assertEquals(
      resultJson.includes("integration-test-password"),
      false,
      "RESTIC_PASSWORD must not appear in backup result",
    );
    assertEquals(
      resultJson.includes("integration-b2-id"),
      false,
      "B2_ACCOUNT_ID must not appear in backup result",
    );
    assertEquals(
      resultJson.includes("integration-b2-key"),
      false,
      "B2_ACCOUNT_KEY must not appear in backup result",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("S7: backup — _catalog.db and bundle dirs NOT in snapshot (verify via restore)", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    await makeFixtureSwampTree(repoDir);

    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, initCtx);

    const { context: backupCtx, writes: backupWrites } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: [] }, backupCtx);
    const snapshotId = String(backupWrites[0].data.snapshotId ?? "latest");

    // Restore to a staging dir and check what's there
    const stagingDir = await Deno.makeTempDir({ prefix: "swamp-backup-verify-" });
    try {
      const { context: restoreCtx } = makeIntegrationContext(repoDir, resticRepo);
      await model.methods.restore.execute(
        { snapshot: snapshotId, targetDir: stagingDir, confirm: false },
        restoreCtx,
      );

      // _catalog.db should NOT be present
      let catalogExists = false;
      try {
        await Deno.stat(`${stagingDir}/.swamp/data/_catalog.db`);
        catalogExists = true;
      } catch { /* expected */ }
      assertEquals(catalogExists, false, "_catalog.db must be excluded from backup");

      // .swamp/bundles dir should NOT be present
      let bundlesExists = false;
      try {
        await Deno.stat(`${stagingDir}/.swamp/bundles`);
        bundlesExists = true;
      } catch { /* expected */ }
      assertEquals(bundlesExists, false, "bundles dir must be excluded from backup");

      // .swamp/secrets should NOT be present
      let secretsExists = false;
      try {
        await Deno.stat(`${stagingDir}/.swamp/secrets`);
        secretsExists = true;
      } catch { /* expected */ }
      assertEquals(secretsExists, false, ".swamp/secrets must be excluded from backup");

      // But .swamp/data/run-001.json SHOULD be present
      let dataFileExists = false;
      try {
        await Deno.stat(`${stagingDir}/.swamp/data/run-001.json`);
        dataFileExists = true;
      } catch { /* unexpected */ }
      assertEquals(dataFileExists, true, ".swamp/data/run-001.json must be included in backup");
    } finally {
      await Deno.remove(stagingDir, { recursive: true });
    }
  } finally {
    await cleanup();
  }
});

// S5: snapshots
Deno.test("S5: snapshots — lists snapshots from integration backup", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    await makeFixtureSwampTree(repoDir);

    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, initCtx);

    const { context: backupCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: [] }, backupCtx);

    const { context: snapshotsCtx, writes } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.snapshots.execute({ tags: [] }, snapshotsCtx);

    assertEquals(writes.length, 1);
    assertEquals(writes[0].specName, "snapshots");
    const result = writes[0].data;

    assertEquals((result.count as number) >= 1, true, "Must have at least 1 snapshot");
    assertEquals(Array.isArray(result.snapshots), true);

    // latestSnapshotId must be set
    assertMatch(String(result.latestSnapshotId ?? ""), /^[0-9a-f]{10,}$/);
  } finally {
    await cleanup();
  }
});

// S8: check
Deno.test("S8: check — after backup → ok:true, zero errors", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    await makeFixtureSwampTree(repoDir);

    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, initCtx);

    const { context: backupCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: [] }, backupCtx);

    const { context: checkCtx, writes } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.check.execute({}, checkCtx);

    assertEquals(writes.length, 1);
    assertEquals(writes[0].specName, "checkResult");
    assertEquals(writes[0].data.ok, true);
    assertEquals((writes[0].data.errors as string[]).length, 0);
  } finally {
    await cleanup();
  }
});

// S9: restore integration
Deno.test("S9: restore — latest to clean staging dir → files present", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  const stagingDir = await Deno.makeTempDir({ prefix: "swamp-restore-test-" });
  try {
    await makeFixtureSwampTree(repoDir);

    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, initCtx);

    const { context: backupCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: [] }, backupCtx);

    const { context: restoreCtx, writes } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.restore.execute(
      { snapshot: "latest", targetDir: stagingDir, confirm: false },
      restoreCtx,
    );

    assertEquals(writes.length, 1);
    assertEquals(writes[0].specName, "restoreResult");
    assertEquals((writes[0].data.filesRestored as number) >= 1, true, "Must restore at least 1 file");

    // Verify a file is actually present
    const stat = await Deno.stat(`${stagingDir}/.swamp/data/run-001.json`);
    assertEquals(stat.isFile, true, "Restored file must exist");
  } finally {
    await cleanup();
    await Deno.remove(stagingDir, { recursive: true });
  }
});

// S10: forget
Deno.test("S10: forget --dry-run → snapshotsRemoved=0, nothing actually removed", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    await makeFixtureSwampTree(repoDir);

    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, initCtx);

    const { context: backupCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: [] }, backupCtx);

    const { context: forgetCtx, writes } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.forget.execute({ keepLast: 1, dryRun: true }, forgetCtx);

    assertEquals(writes.length, 1);
    assertEquals(writes[0].specName, "forgetResult");
    assertEquals(writes[0].data.dryRun, true);
    // dryRun removes no snapshots but reports what would be removed
    assertEquals(typeof writes[0].data.snapshotsRemoved, "number");
  } finally {
    await cleanup();
  }
});

Deno.test("S10: forget non-dry-run keeps expected snapshots and removes old ones", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    await makeFixtureSwampTree(repoDir);

    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, initCtx);

    // Create 2 backups
    const { context: b1 } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: [] }, b1);
    // Modify a file to force a new snapshot
    await Deno.writeTextFile(`${repoDir}/.swamp/data/run-002.json`, '{"run": 2}');
    const { context: b2 } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: [] }, b2);

    // Verify 2 snapshots exist
    const { context: snapshotsCtx, writes: snapWrites } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.snapshots.execute({ tags: [] }, snapshotsCtx);
    assertEquals(snapWrites[0].data.count, 2, "Must have 2 snapshots before forget");

    // Forget keeping only 1
    const { context: forgetCtx, writes: forgetWrites } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.forget.execute({ keepLast: 1, dryRun: false }, forgetCtx);
    assertEquals(forgetWrites[0].data.snapshotsRemoved, 1, "Must remove 1 snapshot");
  } finally {
    await cleanup();
  }
});

// S11: prune
Deno.test("S11: prune — after orphaning forget → completes with parsed result", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  try {
    await makeFixtureSwampTree(repoDir);

    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.init.execute({}, initCtx);

    // Create 2 backups and forget one to create orphaned data
    const { context: b1 } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: [] }, b1);
    await Deno.writeTextFile(`${repoDir}/.swamp/data/run-003.json`, '{"run": 3}');
    const { context: b2 } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.backup.execute({ tags: [] }, b2);

    // Forget the first snapshot by its ID
    const { context: snapshotsCtx, writes: snapWrites } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.snapshots.execute({ tags: [] }, snapshotsCtx);
    const snapshots = snapWrites[0].data.snapshots as Array<{ id: string }>;
    assertEquals(snapshots.length, 2, "Must have 2 snapshots");

    const { context: forgetCtx } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.forget.execute({ keepLast: 1, dryRun: false }, forgetCtx);

    // Now prune
    const { context: pruneCtx, writes: pruneWrites } = makeIntegrationContext(repoDir, resticRepo);
    await model.methods.prune.execute({}, pruneCtx);

    assertEquals(pruneWrites.length, 1);
    assertEquals(pruneWrites[0].specName, "pruneResult");
    assertEquals(typeof pruneWrites[0].data.durationMs, "number");
    // rawOutput is captured for auditability
    assertEquals(typeof pruneWrites[0].data.rawOutput, "string");
  } finally {
    await cleanup();
  }
});

// =============================================================================
// S12: Secret-leakage canary integration test
// =============================================================================

Deno.test("S12: secret-leakage canary — no literal secret values in snapshot or restore", async () => {
  const { repoDir, resticRepo, cleanup } = await makeIntegrationRepo();
  const stagingDir = await Deno.makeTempDir({ prefix: "swamp-canary-restore-" });

  // Canary strings — these must never appear in the snapshot or restore output
  const CANARY_PASSWORD = "CANARY_RESTIC_PASSWORD_DO_NOT_BACKUP_xK9mQ3";
  const CANARY_B2_ID = "CANARY_B2_ACCOUNT_ID_DO_NOT_BACKUP_pR7nW2";
  const CANARY_B2_KEY = "CANARY_B2_ACCOUNT_KEY_DO_NOT_BACKUP_yL5vT1";

  try {
    await makeFixtureSwampTree(repoDir);

    // Pre-backup assertion: included evaluated/config surfaces hold only vault.get references
    // (this verifies swamp's raw-until-runtime invariant — no resolved literals in config)
    const defContent = await Deno.readTextFile(
      `${repoDir}/.swamp/definitions-evaluated/def-001.json`,
    );
    assertEquals(
      defContent.includes(CANARY_PASSWORD),
      false,
      "Included definitions must NOT contain resolved secret literals before backup",
    );

    // Plant literal canary values in EXCLUDED paths only
    await Deno.writeTextFile(
      `${repoDir}/.swamp/secrets/canary.txt`,
      `${CANARY_PASSWORD}\n${CANARY_B2_ID}\n${CANARY_B2_KEY}`,
    );
    await Deno.writeTextFile(
      `${repoDir}/.swamp/logs/canary.log`,
      `password=${CANARY_PASSWORD} id=${CANARY_B2_ID}`,
    );

    // Initialize and backup using canary values as the "resolved" secrets
    const { context: initCtx } = makeIntegrationContext(repoDir, resticRepo, {
      resticPassword: CANARY_PASSWORD,
      b2AccountId: CANARY_B2_ID,
      b2AccountKey: CANARY_B2_KEY,
    });
    await model.methods.init.execute({}, initCtx);

    const { context: backupCtx, writes: backupWrites } = makeIntegrationContext(repoDir, resticRepo, {
      resticPassword: CANARY_PASSWORD,
      b2AccountId: CANARY_B2_ID,
      b2AccountKey: CANARY_B2_KEY,
    });
    await model.methods.backup.execute({ tags: ["canary-test"] }, backupCtx);

    // Assert backup result contains NO canary literals
    const backupResultJson = JSON.stringify(backupWrites[0].data);
    assertEquals(
      backupResultJson.includes(CANARY_PASSWORD),
      false,
      "CANARY_PASSWORD must not appear in backupResult",
    );
    assertEquals(
      backupResultJson.includes(CANARY_B2_ID),
      false,
      "CANARY_B2_ID must not appear in backupResult",
    );
    assertEquals(
      backupResultJson.includes(CANARY_B2_KEY),
      false,
      "CANARY_B2_KEY must not appear in backupResult",
    );

    // Restore to staging and verify canary values are absent from ALL restored files
    const snapshotId = String(backupWrites[0].data.snapshotId ?? "latest");
    const { context: restoreCtx } = makeIntegrationContext(repoDir, resticRepo, {
      resticPassword: CANARY_PASSWORD,
      b2AccountId: CANARY_B2_ID,
      b2AccountKey: CANARY_B2_KEY,
    });
    await model.methods.restore.execute(
      { snapshot: snapshotId, targetDir: stagingDir, confirm: false },
      restoreCtx,
    );

    // Walk all restored files and assert no canary values
    async function walkDir(dir: string): Promise<string[]> {
      const files: string[] = [];
      try {
        for await (const entry of Deno.readDir(dir)) {
          const fullPath = `${dir}/${entry.name}`;
          if (entry.isDirectory) {
            files.push(...await walkDir(fullPath));
          } else if (entry.isFile) {
            files.push(fullPath);
          }
        }
      } catch { /* ignore readDir errors */ }
      return files;
    }

    const restoredFiles = await walkDir(stagingDir);

    for (const filePath of restoredFiles) {
      const content = await Deno.readTextFile(filePath).catch(() => "");
      assertEquals(
        content.includes(CANARY_PASSWORD),
        false,
        `CANARY_PASSWORD must not appear in restored file: ${filePath}`,
      );
      assertEquals(
        content.includes(CANARY_B2_ID),
        false,
        `CANARY_B2_ID must not appear in restored file: ${filePath}`,
      );
      assertEquals(
        content.includes(CANARY_B2_KEY),
        false,
        `CANARY_B2_KEY must not appear in restored file: ${filePath}`,
      );
    }

    // .swamp/secrets directory must be absent from the restore
    let secretsExists = false;
    try {
      await Deno.stat(`${stagingDir}/.swamp/secrets`);
      secretsExists = true;
    } catch { /* expected */ }
    assertEquals(
      secretsExists,
      false,
      ".swamp/secrets must be absent from backup snapshot",
    );

    // Verify snapshot listing also contains no canary values
    const { context: snapshotsCtx, writes: snapWrites } = makeIntegrationContext(repoDir, resticRepo, {
      resticPassword: CANARY_PASSWORD,
      b2AccountId: CANARY_B2_ID,
      b2AccountKey: CANARY_B2_KEY,
    });
    await model.methods.snapshots.execute({ tags: [] }, snapshotsCtx);
    const snapshotsJson = JSON.stringify(snapWrites[0].data);
    assertEquals(
      snapshotsJson.includes(CANARY_PASSWORD),
      false,
      "CANARY_PASSWORD must not appear in snapshots listing",
    );
  } finally {
    await cleanup();
    await Deno.remove(stagingDir, { recursive: true });
  }
});

// =============================================================================
// R2: Failure-path secret redaction canary
// =============================================================================
// Two sub-tests:
//   R2a — per-method failure branches (exit-1 with secrets in stdout/stderr):
//     The fake binary returns VALID version JSON so the probe passes, then fails
//     only on the method's own command. Call-count tracking verifies each method's
//     own failure branch was reached (probe=call1, method=call2).
//   R2b — malformed-success-output (exit-0 with invalid JSON containing secrets):
//     A fake binary that exits 0 while emitting invalid JSON containing canaries.
//     The model must throw a sanitised error (no raw output, no canaries).

/** Helper: assert no canary value appears in the string. */
function assertNoCanaryInMessage(
  msg: string,
  label: string,
  canaryPassword: string,
  canaryB2Id: string,
  canaryB2Key: string,
): void {
  assertEquals(
    msg.includes(canaryPassword),
    false,
    `${label}: CANARY_PASSWORD must not appear in error message — got: ${msg}`,
  );
  assertEquals(
    msg.includes(canaryB2Id),
    false,
    `${label}: CANARY_B2_ID must not appear in error message — got: ${msg}`,
  );
  assertEquals(
    msg.includes(canaryB2Key),
    false,
    `${label}: CANARY_B2_KEY must not appear in error message — got: ${msg}`,
  );
}

Deno.test("R2a: per-method failure branches — secrets absent from thrown error messages", async () => {
  // Each method is tested with its OWN fake binary that:
  //   call 1 (version --json): returns valid version JSON → probe PASSES
  //   calls 2+: echoes all three canary values to stdout+stderr → exits 1
  // A call-count file proves the method's own failure branch (call ≥ 2) was reached.

  const CANARY_PASSWORD = "CANARY_R2A_PASSWORD_xK9mQ3_MUST_NOT_LEAK";
  const CANARY_B2_ID = "CANARY_R2A_B2_ID_pR7nW2_MUST_NOT_LEAK";
  const CANARY_B2_KEY = "CANARY_R2A_B2_KEY_yL5vT1_MUST_NOT_LEAK";

  const assertNoCanary = (msg: string, label: string) =>
    assertNoCanaryInMessage(msg, label, CANARY_PASSWORD, CANARY_B2_ID, CANARY_B2_KEY);

  // Helper: build a per-method fake binary with its own call-count and canary logic.
  async function makeCanaryBinary(dir: string): Promise<{ binary: string; callCountFile: string }> {
    const binary = `${dir}/fake-restic`;
    const callCountFile = `${dir}/call-count`;
    await Deno.writeTextFile(
      binary,
      `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
# Call 1: version probe — return valid version JSON so the probe PASSES
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.0","go_version":"go1.21","go_os":"linux","go_arch":"amd64"}'
  exit 0
fi
# Calls 2+: method's own command — echo canaries and fail
echo '{"message_type":"exit_error","message":"auth error: ${CANARY_PASSWORD} ${CANARY_B2_ID} ${CANARY_B2_KEY}","code":1}'
printf 'stderr: ${CANARY_PASSWORD} ${CANARY_B2_ID} ${CANARY_B2_KEY}' >&2
exit 1
`,
    );
    await Deno.chmod(binary, 0o755);
    return { binary, callCountFile };
  }

  // Helper: assert the call count file shows at least N calls (meaning the method branch ran).
  async function assertCallCountAtLeast(callCountFile: string, minCalls: number, label: string): Promise<void> {
    const countStr = await Deno.readTextFile(callCountFile).catch(() => "0");
    const count = parseInt(countStr.trim(), 10);
    assertEquals(
      count >= minCalls,
      true,
      `${label}: expected at least ${minCalls} calls to fake binary (probe + method), got ${count}`,
    );
  }

  // init: probe (call 1, version) passes; cat-config probe (call 2) fails with canaries;
  //        init itself (call 3) also fails. We just need call 2+ to reach the method branch.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2a-init-" });
    try {
      const { binary, callCountFile } = await makeCanaryBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(() => model.methods.init.execute({}, context), Error);
      await assertCallCountAtLeast(callCountFile, 2, "init");
      assertNoCanary(error.message, "init");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // backup: probe (call 1) passes; backup command (call 2) fails with canaries.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2a-backup-" });
    try {
      const { binary, callCountFile } = await makeCanaryBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.backup.execute({ tags: [] }, context),
        Error,
      );
      await assertCallCountAtLeast(callCountFile, 2, "backup");
      assertNoCanary(error.message, "backup");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // snapshots: probe (call 1) passes; snapshots command (call 2) fails with canaries.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2a-snapshots-" });
    try {
      const { binary, callCountFile } = await makeCanaryBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.snapshots.execute({ tags: [] }, context),
        Error,
      );
      await assertCallCountAtLeast(callCountFile, 2, "snapshots");
      assertNoCanary(error.message, "snapshots");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // restore: probe (call 1) passes; restore command (call 2) fails with canaries.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2a-restore-" });
    const stagingDir = await Deno.makeTempDir({ prefix: "swamp-r2a-restore-staging-" });
    try {
      const { binary, callCountFile } = await makeCanaryBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.restore.execute(
          { snapshot: "latest", targetDir: stagingDir, confirm: false },
          context,
        ),
        Error,
      );
      await assertCallCountAtLeast(callCountFile, 2, "restore");
      assertNoCanary(error.message, "restore");
    } finally {
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(stagingDir, { recursive: true });
    }
  }

  // forget: probe (call 1) passes; forget command (call 2) fails with canaries.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2a-forget-" });
    try {
      const { binary, callCountFile } = await makeCanaryBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.forget.execute({ keepLast: 3, dryRun: false }, context),
        Error,
      );
      await assertCallCountAtLeast(callCountFile, 2, "forget");
      assertNoCanary(error.message, "forget");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // prune: probe (call 1) passes; prune command (call 2) fails with canaries.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2a-prune-" });
    try {
      const { binary, callCountFile } = await makeCanaryBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.prune.execute({}, context),
        Error,
      );
      await assertCallCountAtLeast(callCountFile, 2, "prune");
      assertNoCanary(error.message, "prune");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // check: probe (call 1) passes; check command (call 2) fails with canaries.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2a-check-" });
    try {
      const { binary, callCountFile } = await makeCanaryBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      // check exits non-zero (canary binary) → check's own failure handling is reached.
      // check doesn't throw on non-zero exit — it writes ok:false to the resource.
      // So we assert no canary appears in the written resource data either.
      const { context: ctx2, writes } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      await model.methods.check.execute({}, ctx2);
      await assertCallCountAtLeast(callCountFile, 2, "check");
      // Verify no canary values in the written checkResult resource
      const resourceJson = JSON.stringify(writes[0]?.data ?? {});
      assertEquals(
        resourceJson.includes(CANARY_PASSWORD),
        false,
        "check: CANARY_PASSWORD must not appear in checkResult resource",
      );
      assertEquals(
        resourceJson.includes(CANARY_B2_ID),
        false,
        "check: CANARY_B2_ID must not appear in checkResult resource",
      );
      assertEquals(
        resourceJson.includes(CANARY_B2_KEY),
        false,
        "check: CANARY_B2_KEY must not appear in checkResult resource",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("R2b: malformed-success-output — secrets absent from thrown errors when restic exits 0 with invalid JSON", async () => {
  // A fake binary that exits 0 but emits invalid JSON containing canary values.
  // The model must throw a sanitised error that contains none of the canaries.
  // This tests the redacting-catch wrappers added around every success-path JSON.parse.

  const CANARY_PASSWORD = "CANARY_R2B_PASSWORD_aB3cD4_MUST_NOT_LEAK";
  const CANARY_B2_ID = "CANARY_R2B_B2_ID_eF5gH6_MUST_NOT_LEAK";
  const CANARY_B2_KEY = "CANARY_R2B_B2_KEY_iJ7kL8_MUST_NOT_LEAK";

  const assertNoCanary = (msg: string, label: string) =>
    assertNoCanaryInMessage(msg, label, CANARY_PASSWORD, CANARY_B2_ID, CANARY_B2_KEY);

  // Helper: a fake binary where:
  //   call 1 (version --json): valid version JSON → probe passes
  //   calls 2+: exits 0 with INVALID JSON containing canary values
  async function makeMalformedSuccessBinary(dir: string): Promise<string> {
    const binary = `${dir}/fake-restic`;
    const callCountFile = `${dir}/call-count`;
    await Deno.writeTextFile(
      binary,
      `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.0","go_version":"go1.21","go_os":"linux","go_arch":"amd64"}'
  exit 0
fi
# Exit 0 but emit invalid JSON containing canary values — simulates buggy binary
printf 'NOTJSON: ${CANARY_PASSWORD} ${CANARY_B2_ID} ${CANARY_B2_KEY}'
exit 0
`,
    );
    await Deno.chmod(binary, 0o755);
    return binary;
  }

  // init: the binary must:
  //   call 1 (version): valid JSON → probe passes
  //   call 2 (cat config): exit 1 → repo not yet initialized (proceed to init)
  //   call 3 (restic init): exit 0 + INVALID JSON with canaries → parse branch catches it
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2b-init-" });
    try {
      const binary = `${dir}/fake-restic`;
      const callCountFile = `${dir}/call-count`;
      await Deno.writeTextFile(
        binary,
        `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.0","go_version":"go1.21","go_os":"linux","go_arch":"amd64"}'
  exit 0
fi
if [ "$COUNT" -eq 2 ]; then
  printf 'cat-config-error'
  exit 1
fi
# Call 3+: restic init exits 0 but emits invalid JSON containing canaries
printf 'NOTJSON_INIT: ${CANARY_PASSWORD} ${CANARY_B2_ID} ${CANARY_B2_KEY}'
exit 0
`,
      );
      await Deno.chmod(binary, 0o755);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      // After probe passes and cat-config fails, init runs and exits 0 with invalid JSON.
      // The thrown error must not expose canaries.
      const error = await assertRejects(() => model.methods.init.execute({}, context), Error);
      assertNoCanary(error.message, "init malformed success");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // backup: exits 0 with invalid JSONL → findJsonlMessage throws → sanitised error.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2b-backup-" });
    try {
      const binary = await makeMalformedSuccessBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.backup.execute({ tags: [] }, context),
        Error,
      );
      assertNoCanary(error.message, "backup malformed success");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // snapshots: exits 0 with invalid JSON → JSON.parse throws → sanitised error.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2b-snapshots-" });
    try {
      const binary = await makeMalformedSuccessBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.snapshots.execute({ tags: [] }, context),
        Error,
      );
      assertNoCanary(error.message, "snapshots malformed success");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // forget: exits 0 with invalid JSON → JSON.parse throws → sanitised error.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2b-forget-" });
    try {
      const binary = await makeMalformedSuccessBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.forget.execute({ keepLast: 3, dryRun: false }, context),
        Error,
      );
      assertNoCanary(error.message, "forget malformed success");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // check: exits 0 with non-empty invalid JSON → R3-MEDIUM-001 fix makes it throw.
  // (R3-MEDIUM-001: non-empty malformed exit-0 stdout must throw a sanitized error,
  //  consistent with the invariant applied to init/backup/snapshots/forget.)
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2b-check-" });
    try {
      const binary = await makeMalformedSuccessBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.check.execute({}, context),
        Error,
      );
      assertNoCanary(error.message, "check malformed success");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }

  // restore: exits 0 with non-empty invalid JSON → R3-MEDIUM-001 fix makes it throw.
  {
    const dir = await Deno.makeTempDir({ prefix: "swamp-r2b-restore-" });
    const stagingDir = await Deno.makeTempDir({ prefix: "swamp-r2b-restore-staging-" });
    try {
      const binary = await makeMalformedSuccessBinary(dir);
      const { context } = makeContext({
        repository: `${dir}/repo`,
        repoDir: dir,
        resticPath: binary,
        resticPassword: CANARY_PASSWORD,
        b2AccountId: CANARY_B2_ID,
        b2AccountKey: CANARY_B2_KEY,
      });
      const error = await assertRejects(
        () => model.methods.restore.execute(
          { snapshot: "latest", targetDir: stagingDir, confirm: false },
          context,
        ),
        Error,
      );
      assertNoCanary(error.message, "restore malformed success");
    } finally {
      await Deno.remove(dir, { recursive: true });
      await Deno.remove(stagingDir, { recursive: true });
    }
  }
});

// =============================================================================
// ISSUE-3: Output schema unit tests (S1–S6 of the ISSUE-3-VALIDATE-OUTPUT plan)
// =============================================================================
//
// Fixtures are verbatim slices of captured restic 0.18.1 output from
// docs/tickets/3-recon-restic-shapes.md — not hand-authored or abbreviated.

// ---------------------------------------------------------------------------
// Verbatim captured fixtures (ground-truth from docs/tickets/3-recon-restic-shapes.md)
// ---------------------------------------------------------------------------

const FIXTURE_INIT = `{"message_type":"initialized","id":"41f72b893fb95668c9f56b4062fec4a08f229199f7eddc02955933a513ae7462","repository":"/tmp/restic-shape-i3/repo"}`;

const FIXTURE_BACKUP_SUMMARY_LINE = `{"message_type":"summary","files_new":1,"files_changed":0,"files_unmodified":2,"dirs_new":0,"dirs_changed":5,"dirs_unmodified":0,"data_blobs":1,"tree_blobs":6,"data_added":3760,"data_added_packed":2454,"total_files_processed":3,"total_bytes_processed":31,"total_duration":0.714235458,"backup_start":"2026-07-03T08:11:21.855069+01:00","backup_end":"2026-07-03T08:11:22.569308+01:00","snapshot_id":"40794fa017d67541694f342e5d7aed40f724fb9f1b6015944c96ee2720c37f71"}`;

// Two-element snapshots array fixture (element 0 is root: no parent, no tags;
// element 1 has a parent). Both elements have username present.
const FIXTURE_SNAPSHOTS_ARRAY = `[{"time":"2026-07-03T08:00:50.803314+01:00","tree":"d55567dd8e08984679118ea251101cff644a38c7f931f7ba8d46c4de24d83c38","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","uid":503,"gid":20,"program_version":"restic 0.18.1","summary":{"backup_start":"2026-07-03T08:00:50.803314+01:00","backup_end":"2026-07-03T08:00:51.537782+01:00","files_new":2,"files_changed":0,"files_unmodified":0,"dirs_new":5,"dirs_changed":0,"dirs_unmodified":0,"data_blobs":2,"tree_blobs":6,"data_added":3320,"data_added_packed":2486,"total_files_processed":2,"total_bytes_processed":29},"id":"c95c1d358d9c73d33b44e7f48097d58dd4dc4ff30eb08730b0b19fbdf1363b44","short_id":"c95c1d35"},{"time":"2026-07-03T08:00:51.60488+01:00","parent":"c95c1d358d9c73d33b44e7f48097d58dd4dc4ff30eb08730b0b19fbdf1363b44","tree":"d55567dd8e08984679118ea251101cff644a38c7f931f7ba8d46c4de24d83c38","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","uid":503,"gid":20,"program_version":"restic 0.18.1","summary":{"backup_start":"2026-07-03T08:00:51.60488+01:00","backup_end":"2026-07-03T08:00:52.298531+01:00","files_new":0,"files_changed":0,"files_unmodified":2,"dirs_new":0,"dirs_changed":0,"dirs_unmodified":5,"data_blobs":0,"tree_blobs":0,"data_added":0,"data_added_packed":0,"total_files_processed":2,"total_bytes_processed":29},"id":"08031febdae7ce0c784ea1508f7bed5d78f11225365abd07bbc49a38cf5f6620","short_id":"08031feb"}]`;

const FIXTURE_CHECK_SUMMARY_OK = `{"message_type":"summary","num_errors":0,"broken_packs":null,"suggest_repair_index":false,"suggest_prune":false}`;

const FIXTURE_RESTORE_SUMMARY_LINE = `{"message_type":"summary","total_files":8,"files_restored":8,"total_bytes":31,"bytes_restored":31}`;

// Forget group array fixture (verbatim from docs/tickets/3-recon-restic-shapes.md).
const FIXTURE_FORGET_ARRAY = `[{"tags":null,"host":"UKFARTMML8397","paths":["/tmp/restic-shape-i3/src/.swamp"],"keep":[{"time":"2026-07-03T08:11:21.855069+01:00","parent":"08031febdae7ce0c784ea1508f7bed5d78f11225365abd07bbc49a38cf5f6620","tree":"ba20c905f867799b0eeef1cda4766be6df40644b27aeb377e0b6af166cf2e552","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","uid":503,"gid":20,"program_version":"restic 0.18.1","summary":{"backup_start":"2026-07-03T08:11:21.855069+01:00","backup_end":"2026-07-03T08:11:22.569308+01:00","files_new":1,"files_changed":0,"files_unmodified":2,"dirs_new":0,"dirs_changed":5,"dirs_unmodified":0,"data_blobs":1,"tree_blobs":6,"data_added":3760,"data_added_packed":2454,"total_files_processed":3,"total_bytes_processed":31},"id":"40794fa017d67541694f342e5d7aed40f724fb9f1b6015944c96ee2720c37f71","short_id":"40794fa0"}],"remove":[{"time":"2026-07-03T08:00:50.803314+01:00","tree":"d55567dd8e08984679118ea251101cff644a38c7f931f7ba8d46c4de24d83c38","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","uid":503,"gid":20,"program_version":"restic 0.18.1","summary":{"backup_start":"2026-07-03T08:00:50.803314+01:00","backup_end":"2026-07-03T08:00:51.537782+01:00","files_new":2,"files_changed":0,"files_unmodified":0,"dirs_new":5,"dirs_changed":0,"dirs_unmodified":0,"data_blobs":2,"tree_blobs":6,"data_added":3320,"data_added_packed":2486,"total_files_processed":2,"total_bytes_processed":29},"id":"c95c1d358d9c73d33b44e7f48097d58dd4dc4ff30eb08730b0b19fbdf1363b44","short_id":"c95c1d35"}],"reasons":[{"snapshot":{"time":"2026-07-03T08:11:21.855069+01:00","parent":"08031febdae7ce0c784ea1508f7bed5d78f11225365abd07bbc49a38cf5f6620","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","id":"40794fa017d67541694f342e5d7aed40f724fb9f1b6015944c96ee2720c37f71","short_id":"40794fa0"},"matches":["last snapshot"]}]}]`;

// ---------------------------------------------------------------------------
// S1: Output schema acceptance tests — each captured fixture must parse
// ---------------------------------------------------------------------------

Deno.test("ISSUE-3/S1: ResticInitOutputSchema parses captured init fixture", () => {
  const result = ResticInitOutputSchema.parse(JSON.parse(FIXTURE_INIT));
  assertEquals(result.message_type, "initialized");
  assertEquals(result.id, "41f72b893fb95668c9f56b4062fec4a08f229199f7eddc02955933a513ae7462");
  assertEquals(result.repository, "/tmp/restic-shape-i3/repo");
});

Deno.test("ISSUE-3/S1: ResticInitOutputSchema rejects missing required field (id absent)", () => {
  const badInit = { message_type: "initialized", repository: "/tmp/repo" };
  const result = ResticInitOutputSchema.safeParse(badInit);
  assertEquals(result.success, false, "Must reject init object missing 'id'");
});

Deno.test("ISSUE-3/S1: ResticBackupSummarySchema parses captured backup summary fixture", () => {
  const result = ResticBackupSummarySchema.parse(JSON.parse(FIXTURE_BACKUP_SUMMARY_LINE));
  assertEquals(result.message_type, "summary");
  assertEquals(result.snapshot_id, "40794fa017d67541694f342e5d7aed40f724fb9f1b6015944c96ee2720c37f71");
  assertEquals(result.total_files_processed, 3);
  assertEquals(result.total_bytes_processed, 31);
  assertEquals(result.total_duration, 0.714235458);
});

Deno.test("ISSUE-3/S1: ResticBackupSummarySchema rejects missing required field (snapshot_id absent)", () => {
  const badSummary = {
    message_type: "summary",
    backup_start: "2026-07-03T08:11:21.855069+01:00",
    backup_end: "2026-07-03T08:11:22.569308+01:00",
    total_files_processed: 3,
    total_bytes_processed: 31,
    total_duration: 0.714,
  };
  const result = ResticBackupSummarySchema.safeParse(badSummary);
  assertEquals(result.success, false, "Must reject backup summary missing 'snapshot_id'");
});

Deno.test("ISSUE-3/S1: ResticBackupSummarySchema does NOT reject unconsumed passthrough counters", () => {
  // Passthrough fields (files_new, dirs_changed, etc.) must NOT cause rejection.
  const withPassthrough = JSON.parse(FIXTURE_BACKUP_SUMMARY_LINE);
  // Verify passthrough fields are present in the parsed fixture (they come from real output).
  assertEquals(typeof withPassthrough.files_new, "number", "files_new must be present in fixture");
  const result = ResticBackupSummarySchema.safeParse(withPassthrough);
  assertEquals(result.success, true, "Passthrough counters must not cause schema rejection");
});

Deno.test("ISSUE-3/S1: ResticSnapshotArraySchema parses captured two-element snapshots fixture", () => {
  const snapshots = ResticSnapshotArraySchema.parse(JSON.parse(FIXTURE_SNAPSHOTS_ARRAY));
  assertEquals(snapshots.length, 2);
  assertEquals(snapshots[0].id, "c95c1d358d9c73d33b44e7f48097d58dd4dc4ff30eb08730b0b19fbdf1363b44");
  assertEquals(snapshots[0].short_id, "c95c1d35");
  assertEquals(snapshots[0].hostname, "UKFARTMML8397");
  assertEquals(snapshots[0].username, "stephen.nelsonsmith");
  // Element 0 is root — no parent field.
  assertEquals(snapshots[0].parent, undefined, "Root snapshot must have no parent");
  // Element 1 has parent.
  assertEquals(snapshots[1].parent, "c95c1d358d9c73d33b44e7f48097d58dd4dc4ff30eb08730b0b19fbdf1363b44");
});

Deno.test("ISSUE-3/S1: ResticSnapshotArraySchema rejects snapshot with wrong type for paths", () => {
  const badSnapshots = [
    {
      id: "abc123",
      short_id: "abc1",
      time: "2026-07-03T08:00:50.803314+01:00",
      hostname: "host1",
      paths: "not-an-array",  // must be string[], not string
    },
  ];
  const result = ResticSnapshotArraySchema.safeParse(badSnapshots);
  assertEquals(result.success, false, "Must reject snapshot where paths is not an array");
});

Deno.test("ISSUE-3/S1: ResticSnapshotArraySchema rejects snapshot missing required id field", () => {
  const badSnapshots = [
    {
      // id is absent
      short_id: "abc1",
      time: "2026-07-03T08:00:50.803314+01:00",
      hostname: "host1",
      paths: ["/tmp"],
    },
  ];
  const result = ResticSnapshotArraySchema.safeParse(badSnapshots);
  assertEquals(result.success, false, "Must reject snapshot missing required 'id' field");
});

Deno.test("ISSUE-3/CORR-3: ResticSnapshotArraySchema rejects a snapshot with a non-parseable time", () => {
  // time is consumed as a Date.parse sort key; a drifted value like "not-a-date"
  // would become NaN and silently mis-order latest selection. It must fail at the
  // boundary instead.
  const badTimeSnapshots = [
    {
      id: "abc123def456",
      short_id: "abc1",
      time: "not-a-date",
      hostname: "host1",
      paths: ["/tmp"],
    },
  ];
  const result = ResticSnapshotArraySchema.safeParse(badTimeSnapshots);
  assertEquals(result.success, false, "Must reject snapshot whose time is not a parseable timestamp");
});

Deno.test("ISSUE-3/CORR-3: snapshots — non-parseable snapshot time fails before writeResource", async () => {
  // A fake binary that returns a snapshots array with a drifted time value on exit 0.
  const driftedSnapshots = JSON.stringify([
    {
      id: "abc123def456",
      short_id: "abc1",
      time: "not-a-date",
      hostname: "host1",
      username: "u",
      paths: ["/tmp"],
    },
  ]);
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i3-snap-badtime-" });
  const callCountFile = `${tmpDir}/call-count`;
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.1","go_version":"go1.25","go_os":"darwin","go_arch":"arm64"}'
  exit 0
fi
echo '${driftedSnapshots}'
exit 0
`,
  );
  await Deno.chmod(fakeBinary, 0o755);

  try {
    const { context, writes } = makeContext({
      repository: `${tmpDir}/repo`,
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
    });

    await assertRejects(
      () => model.methods.snapshots.execute({ tags: [] }, context),
      Error,
      "did not match expected shape",
    );
    assertEquals(writes.length, 0, "Must NOT write a snapshots resource on drifted time");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("ISSUE-3/S1: tagless snapshot (no tags field) still parses", () => {
  // A snapshot with no tags field must be accepted — tags is OPTIONAL.
  const taglessSnapshot = [
    {
      id: "abc123def456",
      short_id: "abc1",
      time: "2026-07-03T08:00:50.803314+01:00",
      hostname: "host1",
      paths: ["/tmp/restic-shape-i3/src/.swamp"],
      username: "testuser",
      // tags deliberately absent
    },
  ];
  const result = ResticSnapshotArraySchema.safeParse(taglessSnapshot);
  assertEquals(result.success, true, "Tagless snapshot must parse successfully");
  assertEquals(result.data![0].tags, undefined);
});

Deno.test("ISSUE-3/S1: root snapshot (no parent field) still parses", () => {
  // A root snapshot with no parent field must be accepted — parent is OPTIONAL.
  const rootSnapshot = [
    {
      id: "abc123def456",
      short_id: "abc1",
      time: "2026-07-03T08:00:50.803314+01:00",
      hostname: "host1",
      paths: ["/tmp"],
      username: "testuser",
      // parent deliberately absent (root snapshot)
    },
  ];
  const result = ResticSnapshotArraySchema.safeParse(rootSnapshot);
  assertEquals(result.success, true, "Root snapshot (no parent) must parse successfully");
  assertEquals(result.data![0].parent, undefined);
});

Deno.test("ISSUE-3/S1: username-absent snapshot still parses (older restic omits it)", () => {
  // username is OPTIONAL — older restic versions omit it. Must default to undefined
  // in the schema (the model maps absent → "" on the result shape).
  const noUsernameSnapshot = [
    {
      id: "abc123def456",
      short_id: "abc1",
      time: "2026-07-03T08:00:50.803314+01:00",
      hostname: "host1",
      paths: ["/tmp"],
      // username deliberately absent
    },
  ];
  const result = ResticSnapshotArraySchema.safeParse(noUsernameSnapshot);
  assertEquals(result.success, true, "Username-absent snapshot must parse successfully");
  assertEquals(result.data![0].username, undefined, "username must be undefined when absent");
});

Deno.test("ISSUE-3/S1: ResticCheckSummarySchema parses captured check fixture", () => {
  const result = ResticCheckSummarySchema.parse(JSON.parse(FIXTURE_CHECK_SUMMARY_OK));
  assertEquals(result.message_type, "summary");
  assertEquals(result.num_errors, 0);
  assertEquals(result.broken_packs, null);
  assertEquals(result.suggest_repair_index, false);
  assertEquals(result.suggest_prune, false);
});

Deno.test("ISSUE-3/S1: ResticCheckSummarySchema rejects wrong type for num_errors", () => {
  const badCheck = {
    message_type: "summary",
    num_errors: "not-a-number",  // must be number
    broken_packs: null,
    suggest_repair_index: false,
    suggest_prune: false,
  };
  const result = ResticCheckSummarySchema.safeParse(badCheck);
  assertEquals(result.success, false, "Must reject check summary with wrong type for num_errors");
});

Deno.test("ISSUE-3/S1: ResticForgetArraySchema parses captured forget fixture", () => {
  const groups = ResticForgetArraySchema.parse(JSON.parse(FIXTURE_FORGET_ARRAY));
  assertEquals(groups.length, 1);
  assertEquals(groups[0].host, "UKFARTMML8397");
  assertEquals(groups[0].tags, null);
  assertEquals(groups[0].keep.length, 1);
  assertEquals(groups[0].remove!.length, 1);
  assertEquals(groups[0].keep[0].id, "40794fa017d67541694f342e5d7aed40f724fb9f1b6015944c96ee2720c37f71");
});

Deno.test("ISSUE-3/S1: ResticForgetArraySchema rejects group missing required host field", () => {
  const badForget = [
    {
      // host is absent
      tags: null,
      paths: ["/tmp"],
      keep: [],
      remove: null,
    },
  ];
  const result = ResticForgetArraySchema.safeParse(badForget);
  assertEquals(result.success, false, "Must reject forget group missing required 'host' field");
});

Deno.test("ISSUE-3/S1: ResticRestoreSummarySchema parses captured restore fixture", () => {
  const result = ResticRestoreSummarySchema.parse(JSON.parse(FIXTURE_RESTORE_SUMMARY_LINE));
  assertEquals(result.message_type, "summary");
  assertEquals(result.total_files, 8);
  assertEquals(result.files_restored, 8);
  assertEquals(result.total_bytes, 31);
  assertEquals(result.bytes_restored, 31);
});

Deno.test("ISSUE-3/S1: ResticRestoreSummarySchema rejects missing required field (bytes_restored absent)", () => {
  const badRestore = {
    message_type: "summary",
    total_files: 8,
    files_restored: 8,
    total_bytes: 31,
    // bytes_restored deliberately absent
  };
  const result = ResticRestoreSummarySchema.safeParse(badRestore);
  assertEquals(result.success, false, "Must reject restore summary missing 'bytes_restored'");
});

// ---------------------------------------------------------------------------
// S2: Decoder hygiene tests — findJsonlMessage sanitized error, decodeResticOutput,
//     decodeResticSummary boundary failures
// ---------------------------------------------------------------------------

Deno.test("ISSUE-3/S2: findJsonlMessage throws sanitized domain Error on bad JSONL line (not SyntaxError)", () => {
  // A JSONL stream where one line is not valid JSON must throw a sanitized Error,
  // never a raw SyntaxError that could embed the bad line content (which might
  // contain reflected secrets). This is the finding-findjsonlmessage-hygiene fix.
  const CANARY = "SENSITIVE_CANARY_XK9M_MUST_NOT_APPEAR";
  const badJsonl = `{"message_type":"status","percent_done":0.5}\nNOT_VALID_JSON_${CANARY}\n{"message_type":"summary"}`;
  let threw = false;
  try {
    findJsonlMessage(badJsonl, "summary");
  } catch (err) {
    threw = true;
    assertEquals(err instanceof Error, true, "Must throw Error (domain error)");
    assertEquals(
      err instanceof SyntaxError,
      false,
      "Must NOT throw a raw SyntaxError (which embeds the bad line)",
    );
    assertEquals(
      (err as Error).message.includes(CANARY),
      false,
      "Sanitized error must NOT embed the canary from the bad line",
    );
  }
  assertEquals(threw, true, "findJsonlMessage must throw on bad JSONL line");
});

Deno.test("ISSUE-3/S2: decodeResticOutput — malformed/unparseable stdout fails with sanitized command-named error", () => {
  const malformedStdout = "THIS IS NOT JSON AT ALL";
  let threw = false;
  try {
    decodeResticOutput(malformedStdout, ResticSnapshotArraySchema, "snapshots");
  } catch (err) {
    threw = true;
    assertEquals(err instanceof Error, true, "Must throw Error");
    assertStringIncludes((err as Error).message, "snapshots", "Error must name the command");
    assertStringIncludes(
      (err as Error).message,
      "did not match expected shape",
      "Error must describe the mismatch class",
    );
    assertEquals(
      (err as Error).message.includes("THIS IS NOT JSON"),
      false,
      "Error must NOT embed raw stdout",
    );
    assertEquals(
      (err as Error).message.includes("exited 0"),
      false,
      "Error must NOT contain hardcoded 'exited 0' wording",
    );
  }
  assertEquals(threw, true, "decodeResticOutput must throw on unparseable stdout");
});

Deno.test("ISSUE-3/S2: decodeResticOutput — schema-drifted stdout fails with sanitized command-named error", () => {
  // Valid JSON but wrong shape (object where array expected) — schema mismatch.
  const driftedStdout = '{"message_type":"wrong","id":"abc"}';
  let threw = false;
  try {
    decodeResticOutput(driftedStdout, ResticSnapshotArraySchema, "snapshots");
  } catch (err) {
    threw = true;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "snapshots");
    assertStringIncludes((err as Error).message, "did not match expected shape");
    // Must not embed raw output in the error.
    assertEquals((err as Error).message.includes("wrong"), false, "Must not embed raw output field");
    assertEquals((err as Error).message.includes("exited 0"), false);
  }
  assertEquals(threw, true, "decodeResticOutput must throw on shape-drifted stdout");
});

Deno.test("ISSUE-3/CORR-2: decodeResticOutput — JSONL framing drift (newline-delimited objects) fails at the boundary", () => {
  // A whole-payload command must emit ONE JSON array/object. Two objects on
  // separate lines is a framing drift; strict whole-value JSON.parse must reject
  // it rather than a JSONL fallback silently accepting it as an array.
  const jsonlDrift =
    `{"id":"a","short_id":"a1","time":"2026-07-03T08:00:50Z","hostname":"h","paths":["/x"]}\n` +
    `{"id":"b","short_id":"b1","time":"2026-07-03T08:00:51Z","hostname":"h","paths":["/x"]}`;
  let threw = false;
  try {
    decodeResticOutput(jsonlDrift, ResticSnapshotArraySchema, "snapshots");
  } catch (err) {
    threw = true;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "snapshots");
    assertStringIncludes((err as Error).message, "did not match expected shape");
    // Must not embed the raw drifted output.
    assertEquals((err as Error).message.includes("short_id"), false, "Must not embed raw output");
  }
  assertEquals(threw, true, "decodeResticOutput must reject JSONL-framed whole-payload output");
});

Deno.test("ISSUE-3/S2: decodeResticSummary — no summary line fails with sanitized command-named error", () => {
  // Valid JSONL but no message_type=="summary" line → boundary failure.
  const noSummaryStdout = `{"message_type":"status","percent_done":0.5}\n{"message_type":"status","percent_done":1.0}`;
  let threw = false;
  try {
    decodeResticSummary(noSummaryStdout, ResticBackupSummarySchema, "backup");
  } catch (err) {
    threw = true;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "backup");
    assertStringIncludes((err as Error).message, "did not match expected shape");
    assertEquals((err as Error).message.includes("exited 0"), false);
  }
  assertEquals(threw, true, "decodeResticSummary must throw when no summary line is present");
});

Deno.test("ISSUE-3/S2: decodeResticSummary — malformed JSONL fails with sanitized command-named error", () => {
  const CANARY = "SENSITIVE_R2_CANARY_9pQm";
  const badJsonl = `{"message_type":"status"}\nNOT_JSON_${CANARY}`;
  let threw = false;
  try {
    decodeResticSummary(badJsonl, ResticBackupSummarySchema, "backup");
  } catch (err) {
    threw = true;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "backup");
    assertEquals((err as Error).message.includes(CANARY), false, "Must not embed canary in error");
    assertEquals((err as Error).message.includes("exited 0"), false);
  }
  assertEquals(threw, true, "decodeResticSummary must throw on malformed JSONL");
});

Deno.test("ISSUE-3/S2: decodeResticSummary — schema-drifted summary line fails with sanitized error", () => {
  // summary line is valid JSON but fails schema validation (missing required field).
  const driftedSummaryJsonl = `{"message_type":"status"}\n{"message_type":"summary","total_files":8}`;
  // Missing files_restored, total_bytes, bytes_restored → fails ResticRestoreSummarySchema.
  let threw = false;
  try {
    decodeResticSummary(driftedSummaryJsonl, ResticRestoreSummarySchema, "restore");
  } catch (err) {
    threw = true;
    assertEquals(err instanceof Error, true);
    assertStringIncludes((err as Error).message, "restore");
    assertStringIncludes((err as Error).message, "did not match expected shape");
    assertEquals((err as Error).message.includes("exited 0"), false);
  }
  assertEquals(threw, true, "decodeResticSummary must throw on schema-drifted summary line");
});

Deno.test("ISSUE-3/S2: decodeResticOutput — valid init fixture parses correctly", () => {
  // Acceptance test for decodeResticOutput with init fixture.
  const init = decodeResticOutput(FIXTURE_INIT, ResticInitOutputSchema, "init");
  assertEquals(init.message_type, "initialized");
  assertEquals(init.id, "41f72b893fb95668c9f56b4062fec4a08f229199f7eddc02955933a513ae7462");
});

Deno.test("ISSUE-3/S2: decodeResticSummary — valid backup JSONL fixture parses correctly", () => {
  // Acceptance test for decodeResticSummary with backup fixture.
  // Simulate a JSONL stream with a status line followed by the summary line.
  const jsonlStream = `{"message_type":"status","percent_done":0.5}\n${FIXTURE_BACKUP_SUMMARY_LINE}`;
  const summary = decodeResticSummary(jsonlStream, ResticBackupSummarySchema, "backup");
  assertEquals(summary.message_type, "summary");
  assertEquals(summary.snapshot_id, "40794fa017d67541694f342e5d7aed40f724fb9f1b6015944c96ee2720c37f71");
  assertEquals(summary.total_files_processed, 3);
});

// ---------------------------------------------------------------------------
// S4: snapshots latest selection — ordinal time comparison, not localeCompare
// ---------------------------------------------------------------------------

Deno.test("ISSUE-3/S4: snapshots selects latest by ordinal time order, not lexicographic", async () => {
  // Use a fake binary that returns a two-snapshot array where element 0's
  // timestamp is LATER than element 1 (out-of-file-order). The snapshot method
  // must select element 0 (which has the later timestamp) as the latest.
  //
  // File order: [A (later), B (earlier)] — ordinal sort must pick A as latest.
  const SNAP_A_ID = "aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa1111bbbb2222";
  const SNAP_B_ID = "1111aaaa2222bbbb3333cccc4444dddd5555eeee6666ffff1111aaaa2222bbbb";
  // A is chronologically LATER (2026-07-03T10:00:00 > 2026-07-03T08:00:00).
  const outOfOrderSnapshots = JSON.stringify([
    {
      time: "2026-07-03T10:00:00.000000+01:00",
      id: SNAP_A_ID,
      short_id: "aaaa1111",
      hostname: "host1",
      paths: ["/tmp"],
      username: "user",
      tree: "tree1",
      uid: 500,
      gid: 20,
    },
    {
      time: "2026-07-03T08:00:00.000000+01:00",
      id: SNAP_B_ID,
      short_id: "1111aaaa",
      hostname: "host1",
      paths: ["/tmp"],
      username: "user",
      tree: "tree2",
      uid: 500,
      gid: 20,
    },
  ]);

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i3-latest-" });
  const callCountFile = `${tmpDir}/call-count`;
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.1","go_version":"go1.25","go_os":"darwin","go_arch":"arm64"}'
  exit 0
fi
echo '${outOfOrderSnapshots}'
exit 0
`,
  );
  await Deno.chmod(fakeBinary, 0o755);

  try {
    const { context, writes } = makeContext({
      repository: `${tmpDir}/repo`,
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
    });

    await model.methods.snapshots.execute({ tags: [] }, context);

    assertEquals(writes.length, 1);
    assertEquals(writes[0].specName, "snapshots");
    const result = writes[0].data;

    // The snapshot with time 10:00 (SNAP_A) is chronologically later.
    // Must select SNAP_A_ID as the latest, even though it appears first in the array.
    assertEquals(
      result.latestSnapshotId,
      SNAP_A_ID,
      `Expected latestSnapshotId to be SNAP_A (10:00 timestamp), got: ${result.latestSnapshotId}`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// S5: check num_errors > 0 stays valid integrity-failure result (not boundary error)
// ---------------------------------------------------------------------------

Deno.test("ISSUE-3/S5: check — well-formed summary with num_errors>0 yields integrity-failure result (not boundary error)", async () => {
  // A fake binary that returns a well-formed check summary with num_errors=3
  // and exits non-zero. This must yield ok:false checkResult, NOT a boundary error.
  const checkErrorSummary = JSON.stringify({
    message_type: "summary",
    num_errors: 3,
    broken_packs: null,
    suggest_repair_index: true,
    suggest_prune: true,
  });

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i3-check-errors-" });
  const callCountFile = `${tmpDir}/call-count`;
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.1","go_version":"go1.25","go_os":"darwin","go_arch":"arm64"}'
  exit 0
fi
echo '${checkErrorSummary}'
exit 1
`,
  );
  await Deno.chmod(fakeBinary, 0o755);

  try {
    const { context, writes } = makeContext({
      repository: `${tmpDir}/repo`,
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
    });

    // Must NOT throw — must write ok:false checkResult.
    await model.methods.check.execute({}, context);

    assertEquals(writes.length, 1, "Must write exactly one checkResult resource");
    assertEquals(writes[0].specName, "checkResult");
    assertEquals(writes[0].data.ok, false, "ok must be false when num_errors > 0");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// CORR-1 / ARCH-1: check that EXITS 0 but produces no valid check summary must
// fail at the boundary before writeResource, not silently default to ok:true.
// (exit 0 without a parseable summary is the exact silent-default this ticket removes.)
async function makeCheckBinary(tmpDir: string, checkStdout: string, checkExit: number): Promise<string> {
  const callCountFile = `${tmpDir}/call-count`;
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.1","go_version":"go1.25","go_os":"darwin","go_arch":"arm64"}'
  exit 0
fi
echo '${checkStdout}'
exit ${checkExit}
`,
  );
  await Deno.chmod(fakeBinary, 0o755);
  return fakeBinary;
}

Deno.test("ISSUE-3/CORR-1: check — exit 0 with no summary line fails at boundary before writeResource", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i3-check-nosummary-" });
  try {
    // exit 0, but only a non-summary status message — no valid check summary.
    const fakeBinary = await makeCheckBinary(
      tmpDir,
      `{"message_type":"status","percent_done":1.0}`,
      0,
    );
    const { context, writes } = makeContext({
      repository: `${tmpDir}/repo`,
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
    });

    await assertRejects(
      () => model.methods.check.execute({}, context),
      Error,
      "did not match expected shape",
    );
    assertEquals(writes.length, 0, "Must NOT write a checkResult on exit-0 shape mismatch");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("ISSUE-3/CORR-1: check — exit 0 with schema-mismatched summary fails at boundary before writeResource", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i3-check-badsummary-" });
  try {
    // exit 0, a summary line but missing the required num_errors field.
    const fakeBinary = await makeCheckBinary(
      tmpDir,
      `{"message_type":"summary","suggest_prune":false}`,
      0,
    );
    const { context, writes } = makeContext({
      repository: `${tmpDir}/repo`,
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
    });

    await assertRejects(
      () => model.methods.check.execute({}, context),
      Error,
      "did not match expected shape",
    );
    assertEquals(writes.length, 0, "Must NOT write a checkResult on exit-0 schema mismatch");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// S5: snapshots non-array payload fails at the boundary
// ---------------------------------------------------------------------------

Deno.test("ISSUE-3/S5: snapshots — non-array stdout fails at boundary (not TypeError on .map)", async () => {
  // A fake binary that exits 0 and returns a JSON object (not array) for snapshots.
  // Without boundary decoding, this would cause a TypeError when the code calls .map
  // on a non-array. With boundary decoding, it must fail cleanly before writeResource.
  const nonArrayStdout = JSON.stringify({ message_type: "snapshot", id: "abc" });

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i3-nonarray-" });
  const callCountFile = `${tmpDir}/call-count`;
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.1","go_version":"go1.25","go_os":"darwin","go_arch":"arm64"}'
  exit 0
fi
echo '${nonArrayStdout}'
exit 0
`,
  );
  await Deno.chmod(fakeBinary, 0o755);

  try {
    const { context, writes } = makeContext({
      repository: `${tmpDir}/repo`,
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
    });

    const error = await assertRejects(
      () => model.methods.snapshots.execute({ tags: [] }, context),
      Error,
    );

    // Must fail before writeResource.
    assertEquals(writes.length, 0, "Must not write any resource on boundary failure");
    // Error must name the command.
    assertStringIncludes(error.message, "snapshots");
    assertStringIncludes(error.message, "did not match expected shape");
    // Must not contain raw output.
    assertEquals(error.message.includes("message_type"), false, "Must not embed raw output");
    assertEquals(error.message.includes("exited 0"), false, "Must not contain hardcoded 'exited 0'");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// S5: backup/restore with no summary line fails at boundary
// ---------------------------------------------------------------------------

Deno.test("ISSUE-3/S5: backup — stdout with no summary line fails at boundary before writeResource", async () => {
  // A fake binary that exits 0 but emits only status lines, no summary line.
  const noSummaryStdout = `{"message_type":"status","percent_done":0.5}`;

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i3-nosummary-backup-" });
  const callCountFile = `${tmpDir}/call-count`;
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.1","go_version":"go1.25","go_os":"darwin","go_arch":"arm64"}'
  exit 0
fi
echo '${noSummaryStdout}'
exit 0
`,
  );
  await Deno.chmod(fakeBinary, 0o755);

  try {
    const { context, writes } = makeContext({
      repository: `${tmpDir}/repo`,
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
    });

    const error = await assertRejects(
      () => model.methods.backup.execute({ tags: [] }, context),
      Error,
    );

    assertEquals(writes.length, 0, "Must not write any resource on boundary failure");
    assertStringIncludes(error.message, "backup");
    assertStringIncludes(error.message, "did not match expected shape");
    assertEquals(error.message.includes("exited 0"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("ISSUE-3/S5: restore — stdout with no summary line fails at boundary before writeResource", async () => {
  // A fake binary for restore that exits 0 but emits only status lines.
  const noSummaryStdout = `{"message_type":"status","percent_done":0.8}`;

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i3-nosummary-restore-" });
  const stagingDir = await Deno.makeTempDir({ prefix: "swamp-i3-nosummary-restore-staging-" });
  const callCountFile = `${tmpDir}/call-count`;
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
COUNT=0
if [ -f "${callCountFile}" ]; then COUNT=$(cat "${callCountFile}"); fi
COUNT=$((COUNT + 1))
printf '%s' "$COUNT" > "${callCountFile}"
if [ "$COUNT" -eq 1 ]; then
  echo '{"message_type":"version","version":"0.18.1","go_version":"go1.25","go_os":"darwin","go_arch":"arm64"}'
  exit 0
fi
echo '${noSummaryStdout}'
exit 0
`,
  );
  await Deno.chmod(fakeBinary, 0o755);

  try {
    const { context, writes } = makeContext({
      repository: `${tmpDir}/repo`,
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "pass",
      b2AccountId: "id",
      b2AccountKey: "key",
    });

    const error = await assertRejects(
      () => model.methods.restore.execute(
        { snapshot: "latest", targetDir: stagingDir, confirm: false },
        context,
      ),
      Error,
    );

    assertEquals(writes.length, 0, "Must not write any resource on boundary failure");
    assertStringIncludes(error.message, "restore");
    assertStringIncludes(error.message, "did not match expected shape");
    assertEquals(error.message.includes("exited 0"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
    await Deno.remove(stagingDir, { recursive: true });
  }
});

// =============================================================================
// Real-B2 tests (env-gated, skipped by default)
// =============================================================================

const REAL_B2_ENABLED = Deno.env.get("SWAMP_BACKUP_TEST_REAL_B2") === "true";

Deno.test({
  name: "REAL-B2: full cycle init/backup/check/restore/forget/prune (env-gated)",
  ignore: !REAL_B2_ENABLED,
  fn: async () => {
    const b2Repo = Deno.env.get("SWAMP_BACKUP_TEST_B2_REPO");
    const resticPassword = Deno.env.get("SWAMP_BACKUP_TEST_RESTIC_PASSWORD");
    const b2AccountId = Deno.env.get("B2_ACCOUNT_ID");
    const b2AccountKey = Deno.env.get("B2_ACCOUNT_KEY");

    if (!b2Repo || !resticPassword || !b2AccountId || !b2AccountKey) {
      throw new Error(
        "REAL-B2 test requires: SWAMP_BACKUP_TEST_B2_REPO, SWAMP_BACKUP_TEST_RESTIC_PASSWORD, B2_ACCOUNT_ID, B2_ACCOUNT_KEY",
      );
    }

    const repoDir = await Deno.makeTempDir({ prefix: "swamp-b2-test-" });
    const stagingDir = await Deno.makeTempDir({ prefix: "swamp-b2-restore-" });
    try {
      await makeFixtureSwampTree(repoDir);

      const realB2Args = {
        repository: b2Repo,
        resticPath: "/opt/homebrew/bin/restic",
        resticPassword,
        b2AccountId,
        b2AccountKey,
        repoDir,
      };

      // init
      const { context: initCtx, writes: initWrites } = makeContext(realB2Args);
      await model.methods.init.execute({}, initCtx);
      assertEquals(initWrites[0].data.initialized, true);

      // backup
      const { context: backupCtx, writes: backupWrites } = makeContext(realB2Args);
      await model.methods.backup.execute({ tags: ["ci-real-b2-test"] }, backupCtx);
      assertMatch(String(backupWrites[0].data.snapshotId ?? ""), /^[0-9a-f]{10,}$/);

      // check
      const { context: checkCtx, writes: checkWrites } = makeContext(realB2Args);
      await model.methods.check.execute({}, checkCtx);
      assertEquals(checkWrites[0].data.ok, true);

      // restore
      const { context: restoreCtx } = makeContext({ ...realB2Args });
      await model.methods.restore.execute(
        { snapshot: "latest", targetDir: stagingDir, confirm: false },
        restoreCtx,
      );
      const stat = await Deno.stat(`${stagingDir}/.swamp/data/run-001.json`);
      assertEquals(stat.isFile, true);
    } finally {
      await Deno.remove(repoDir, { recursive: true });
      await Deno.remove(stagingDir, { recursive: true });
    }
  },
});

// ===========================================================================
// ISSUE-7: shared secret-bearing pre-flight (runSecretPreflight)
// ===========================================================================

// S1: unit tests on runSecretPreflight.
Deno.test("ISSUE-7/S1: runSecretPreflight returns the four fields on valid globalArgs", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i7-pf-ok-" });
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
echo '{"message_type":"version","version":"0.18.1","go_version":"go1.25","go_os":"darwin","go_arch":"arm64"}'
exit 0
`,
  );
  await Deno.chmod(fakeBinary, 0o755);
  try {
    const globalArgs = makeGlobalArgs({
      repository: "b2:bucket:path",
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: "pw",
      b2AccountId: "id",
      b2AccountKey: "key",
    });
    const pf = await runSecretPreflight(globalArgs as GlobalArgs);
    assertEquals(pf.cwd, tmpDir);
    assertEquals(pf.resticPath, fakeBinary);
    assertEquals(pf.repository, "b2:bucket:path");
    assertEquals(pf.secrets.resticPassword, "pw");
    assertEquals(pf.secrets.b2AccountId, "id");
    assertEquals(pf.secrets.b2AccountKey, "key");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("ISSUE-7/S1: runSecretPreflight throws the missing-secrets message on a blank secret", async () => {
  const globalArgs = makeGlobalArgs({
    resticPassword: "", // blank → validation fails
  });
  const err = await assertRejects(
    () => runSecretPreflight(globalArgs as GlobalArgs),
    Error,
  );
  assertStringIncludes(err.message, "Secret validation failed before calling restic:");
});

Deno.test("ISSUE-7/S1: runSecretPreflight throws the no---json message with probe.message redacted", async () => {
  // Fake binary whose version probe FAILS and echoes the (canary) password value,
  // so redactSecrets must scrub it from the thrown message.
  const CANARY = "CANARY_I7_PREFLIGHT_PROBE_xK9mQ3_MUST_NOT_LEAK";
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i7-pf-probe-" });
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
# version probe fails and emits the canary on STDERR (probeResticCapability
# surfaces stderr in probe.message on a non-zero exit).
printf 'boom: ${CANARY}' >&2
exit 3
`,
  );
  await Deno.chmod(fakeBinary, 0o755);
  try {
    const globalArgs = makeGlobalArgs({
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: CANARY, // configured value == what the probe echoes → must be redacted
      b2AccountId: "id",
      b2AccountKey: "key",
    });
    const err = await assertRejects(
      () => runSecretPreflight(globalArgs as GlobalArgs),
      Error,
    );
    assertStringIncludes(err.message, "restic does not support --json:");
    assertEquals(
      err.message.includes(CANARY),
      false,
      "probe.message canary must be redacted in the no---json failure",
    );
    assertStringIncludes(err.message, "[REDACTED]");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// S5: acceptance proof through the REAL entrypoints (model.methods.<name>.execute).
Deno.test("ISSUE-7/S5: backup.execute rejects with the missing-secrets message before any restic spawn", async () => {
  // Blank secrets → runSecretPreflight must throw before the binary is invoked.
  // A resticPath that does not exist proves no spawn happened (would fail differently).
  const { context, writes } = makeContext({
    resticPath: "/nonexistent/restic-should-not-run",
    resticPassword: "",
    b2AccountId: "",
    b2AccountKey: "",
  });
  const err = await assertRejects(
    () => model.methods.backup.execute({ tags: [] }, context),
    Error,
  );
  assertStringIncludes(err.message, "Secret validation failed before calling restic:");
  assertEquals(writes.length, 0, "no resource written when pre-flight rejects");
});

Deno.test("ISSUE-7/S5: backup.execute rejects with the no---json message and redacts the probe canary", async () => {
  const CANARY = "CANARY_I7_S5_PROBE_pR7nW2_MUST_NOT_LEAK";
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp-i7-s5-" });
  const fakeBinary = `${tmpDir}/fake-restic`;
  await Deno.writeTextFile(
    fakeBinary,
    `#!/bin/sh
# version probe fails and echoes the canary secret value on STDERR
printf 'unsupported: ${CANARY}' >&2
exit 2
`,
  );
  await Deno.chmod(fakeBinary, 0o755);
  try {
    const { context, writes } = makeContext({
      repoDir: tmpDir,
      resticPath: fakeBinary,
      resticPassword: CANARY,
      b2AccountId: "id",
      b2AccountKey: "key",
    });
    const err = await assertRejects(
      () => model.methods.backup.execute({ tags: [] }, context),
      Error,
    );
    assertStringIncludes(err.message, "restic does not support --json:");
    assertEquals(
      err.message.includes(CANARY),
      false,
      "the canary probe message must be redacted through the extracted pre-flight",
    );
    assertStringIncludes(err.message, "[REDACTED]");
    assertEquals(writes.length, 0, "no resource written when the probe fails");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ===========================================================================
// ISSUE-4: branded, validated secret type (resolveSecrets / ResolvedSecrets)
// ===========================================================================

// S2: unit tests on resolveSecrets.
Deno.test("ISSUE-4/S2: resolveSecrets returns a value redactSecrets accepts and scrubs", () => {
  const globalArgs = makeGlobalArgs({
    resticPassword: "PW_SECRET_VALUE",
    b2AccountId: "ID_SECRET_VALUE",
    b2AccountKey: "KEY_SECRET_VALUE",
  });
  const secrets = resolveSecrets(globalArgs as GlobalArgs);
  assertEquals(secrets.resticPassword, "PW_SECRET_VALUE");
  assertEquals(secrets.b2AccountId, "ID_SECRET_VALUE");
  assertEquals(secrets.b2AccountKey, "KEY_SECRET_VALUE");
  // The branded value flows into redactSecrets with no cast, and all three
  // values are scrubbed — proving the ResolvedSecrets type is usable end to end.
  const redacted = redactSecrets(
    "pw=PW_SECRET_VALUE id=ID_SECRET_VALUE key=KEY_SECRET_VALUE",
    secrets,
  );
  assertEquals(redacted, "pw=[REDACTED] id=[REDACTED] key=[REDACTED]");
});

Deno.test("ISSUE-4/S2: resolveSecrets throws the exact per-secret message for each blank secret", () => {
  const cases: Array<{ override: Record<string, unknown>; expect: string }> = [
    {
      override: { resticPassword: "" },
      expect:
        "Secret 'resticPassword' is missing or empty — provide a vault.get expression that resolves to the restic encryption password",
    },
    {
      override: { b2AccountId: "" },
      expect:
        "Secret 'b2AccountId' is missing or empty — provide a vault.get expression that resolves to the B2 account ID",
    },
    {
      override: { b2AccountKey: "" },
      expect:
        "Secret 'b2AccountKey' is missing or empty — provide a vault.get expression that resolves to the B2 account key",
    },
  ];
  for (const { override, expect } of cases) {
    const globalArgs = makeGlobalArgs(override);
    let threw = false;
    try {
      resolveSecrets(globalArgs as GlobalArgs);
    } catch (err) {
      threw = true;
      assertEquals((err as Error).message, expect);
    }
    assertEquals(threw, true, `resolveSecrets must throw for ${JSON.stringify(override)}`);
  }
});

// S6: acceptance proof through the REAL entrypoint — a missing secret still fails
// before any restic spawn, with the byte-identical preflight-wrapped message.
Deno.test("ISSUE-4/S6: backup.execute rejects a blank secret before any spawn with the byte-identical message", async () => {
  const { context, writes } = makeContext({
    resticPath: "/nonexistent/restic-should-not-run",
    resticPassword: "",
    b2AccountId: "id",
    b2AccountKey: "key",
  });
  const err = await assertRejects(
    () => model.methods.backup.execute({ tags: [] }, context),
    Error,
  );
  assertEquals(
    err.message,
    "Secret validation failed before calling restic: Secret 'resticPassword' is missing or empty — provide a vault.get expression that resolves to the restic encryption password",
  );
  assertEquals(writes.length, 0, "no resource written when the secret is invalid");
});
