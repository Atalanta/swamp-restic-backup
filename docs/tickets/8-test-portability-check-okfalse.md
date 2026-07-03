# Fix test portability and cover check ok:false with populated errors

GitHub issue: #8

## What

Two test-suite fixes:

1. **Portability:** stop hardcoding `/opt/homebrew/bin/restic` in the tests.
   Resolve the restic binary from `PATH` (or a documented env override, e.g.
   `RESTIC_BINARY`), and have the integration tests that need a real restic
   **skip with a clear message** when it is absent — rather than passing
   vacuously because the binary was never invoked.
2. **check ok:false with errors:** add a test that drives `check` against a
   restic that exits non-zero AND emits `message_type:"error"` output, and
   asserts the written `checkResult` has `ok: false` and `errors` **populated**
   (the existing ISSUE-3/S5 test covers `ok:false` on a well-formed
   `num_errors>0` summary, but that path emits no error lines, so `errors` stays
   empty — the populated-errors path is untested).

## Why

The tests hardcode `/opt/homebrew/bin/restic` at eight sites; on any
non-macOS/non-Homebrew machine the binary is absent, so `--json`-usage
assertions pass for the wrong reason (restic was never invoked) and integration
tests fail spuriously. The `check` ok:false-with-populated-errors path has no
grounded test, so a regression that dropped the error-line collection (reporting
a corrupt repo's errors as empty) could pass green. Audit findings:
`finding-tests-hardcode-homebrew-restic`, `finding-check-okfalse-untested`.

## Scope

In scope (tests only): a shared `resticBinary()` test helper that returns the
`RESTIC_BINARY` env override if set, else resolves `restic` from `PATH` (e.g.
via `Deno.Command("which"/"command -v")` or checking `PATH` entries); replacing
the eight hardcoded paths (in `makeGlobalArgs`, `makeIntegrationContext`, and the
inline test contexts) with that helper; an integration-test skip guard
(`ignore: !(await hasRestic())` or equivalent) that skips real-restic tests with
a clear message when restic is absent; a new `check` test with a fake binary
that exits non-zero and emits an error line, asserting `ok:false` + non-empty
`errors`. Document the `RESTIC_BINARY` override in the test file or a test note.

Out of scope: production code — no change to any method, the invoker, or the
model surface (this is a test-only ticket; if a production seam is genuinely
required to make a `--json` assertion fail-on-absence, call it out explicitly).
The env-gated real-B2 test's existing skip mechanism is unchanged.

## Done

- No test hardcodes `/opt/homebrew/bin/restic`; the binary is resolved via
  `PATH` or the `RESTIC_BINARY` override, documented in the test file.
- Integration tests that need a real restic skip with a clear message when it is
  absent, instead of passing vacuously; they do not fail spuriously on a machine
  without Homebrew.
- The `--json`-usage assertions fail if the flag is actually absent (they do not
  pass merely because the binary was never invoked).
- A `check` test drives a non-zero restic exit with error output and asserts the
  written `checkResult` has `ok: false` and a populated `errors` array; the
  existing ISSUE-3/S5 `ok:false` test is unchanged.
- The suite stays green on this (Homebrew) machine and would skip — not fail —
  the integration tests on a machine without restic.

## Constraints

- Do not require a specific restic install location.
- Do not weaken any existing assertion to make it pass; the portability change
  must keep the current tests as strong (a skipped integration test is
  acceptable when restic is absent, a vacuously-passing one is not).
- Test-only change: no production behaviour, model surface, or `_lib` module
  change.
