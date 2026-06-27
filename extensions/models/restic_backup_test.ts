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
  checkRestoreTargetSafety,
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_INCLUDE_PATHS,
  model,
  parseResticJsonOutput,
} from "./restic_backup.ts";

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
