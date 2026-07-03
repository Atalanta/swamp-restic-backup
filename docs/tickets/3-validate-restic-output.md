# Validate restic JSON/JSONL output at the boundary

GitHub issue: #3

## What

For the restic commands that emit JSON or JSONL, check the shape of that output
at the boundary before mapping it into a result resource, so a missing, renamed,
or wrong-typed field fails visibly instead of being silently defaulted.

## Why

restic output is external data. On the JSON/JSONL success paths the code reads
fields with casts and silent `?? ""` / `?? 0` defaults, so a shape change —
a renamed or absent field, an object where an array is expected, a non-array
snapshots payload — is either turned into a wrong result (empty `snapshotId`,
zero counts) or crashes far from the boundary. Recorded as
`finding-restic-json-unvalidated` (severity high) in the applied
`restic-backup-review` audit KB. Two adjacent defects in the same cluster: the
JSONL parse helpers carry inconsistent error contracts
(`finding-findjsonlmessage-hygiene-inconsistent`), and a `check`/`restore` error
message hardcodes "exited 0" regardless of the real exit code
(`finding-misleading-exited-0-message`). "Latest snapshot" selection is also
locale-sensitive (`finding-snapshot-sort-locale-sensitive`).

## Scope

In scope: the JSON/JSONL-emitting commands whose output is mapped into a typed
result — `init`, `backup`, `snapshots`, `check`, `restore`, `forget` — and the
shared JSONL parse helpers.

Out of scope: `prune`. restic emits no JSON for prune; `pruneResult` intentionally
carries raw text output. Its behaviour and its public resource shape are
unchanged by this ticket.

## Done

- On the in-scope commands, restic's JSON/JSONL output is shape-checked at the
  boundary; a field that is absent or the wrong type no longer produces a
  silently-defaulted value in the written resource.
- When restic exits 0 but its output does not match the expected shape, the
  method fails **before writing a result resource**; the failure names the
  command and the nature of the mismatch, and contains no raw restic output.
- The JSONL parse helpers present one consistent failure behaviour; no error
  message embeds raw restic output, and no message asserts an exit code that was
  not observed.
- "Latest snapshot" selection is deterministic and independent of process locale.
- The public result-resource shapes (spec names and fields) are unchanged; on
  well-formed restic output the written results are identical to today. `prune`
  is untouched.

## Constraints

- restic stays the only source of this data; do not add a parser for a format
  restic can already emit as JSON.
- Respect the secret-hygiene rule: parsed-JSON-bearing and secret-bearing
  subprocess output must not reach errors, logs, or resources unredacted. (This
  does not change the existing `pruneResult.rawOutput` contract, which is out of
  scope.)
- The boundary-checking mechanism is left to the plan; this ticket requires the
  behaviour (external shapes are checked and cannot silently default), not a
  named technique.
