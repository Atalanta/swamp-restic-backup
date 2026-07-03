# Captured restic 0.18.1 output shapes — ISSUE-3

Captured live 2026-07-03 against a local repo
(`restic init/backup/snapshots/check/forget/restore --json`, restic 0.18.1).
These are the ground-truth fixtures for the ticket. Every JSON block below is a
**verbatim, copy-pasteable** line of real restic output — no elision inside the
fenced blocks. Use them directly as test fixtures; do not hand-author or
abbreviate shapes.

Two output framings matter for the decode contract:

- **Whole-payload** commands emit one complete JSON value on stdout:
  `snapshots` (array), `check` (object), `forget` (array), `init` (object).
- **JSONL-stream** commands emit one JSON object per line; the shape we validate
  is the **last line with `message_type == "summary"`**: `backup`, `restore`.

## init — `restic init --json` — whole-payload, single object
```json
{"message_type":"initialized","id":"41f72b893fb95668c9f56b4062fec4a08f229199f7eddc02955933a513ae7462","repository":"/tmp/restic-shape-i3/repo"}
```
Required: `message_type` ("initialized"), `id` (string), `repository` (string).

## backup — `restic backup <path> --json` — JSONL stream; validate LAST `message_type=="summary"` line
```json
{"message_type":"summary","files_new":1,"files_changed":0,"files_unmodified":2,"dirs_new":0,"dirs_changed":5,"dirs_unmodified":0,"data_blobs":1,"tree_blobs":6,"data_added":3760,"data_added_packed":2454,"total_files_processed":3,"total_bytes_processed":31,"total_duration":0.714235458,"backup_start":"2026-07-03T08:11:21.855069+01:00","backup_end":"2026-07-03T08:11:22.569308+01:00","snapshot_id":"40794fa017d67541694f342e5d7aed40f724fb9f1b6015944c96ee2720c37f71"}
```
Required (consumed): `message_type`("summary"), `snapshot_id`, `backup_start`,
`backup_end`, `total_files_processed`, `total_bytes_processed`, `total_duration`.
Passthrough (present, unconsumed — must NOT cause rejection): `files_new`,
`files_changed`, `files_unmodified`, `dirs_new`, `dirs_changed`, `dirs_unmodified`,
`data_blobs`, `tree_blobs`, `data_added`, `data_added_packed`.

## snapshots — `restic snapshots --json` — whole-payload, JSON array of snapshot objects
Two-element fixture (element 0 is a **root** snapshot: no `parent`, no `tags`;
element 1 has a `parent`). Verbatim:
```json
[{"time":"2026-07-03T08:00:50.803314+01:00","tree":"d55567dd8e08984679118ea251101cff644a38c7f931f7ba8d46c4de24d83c38","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","uid":503,"gid":20,"program_version":"restic 0.18.1","summary":{"backup_start":"2026-07-03T08:00:50.803314+01:00","backup_end":"2026-07-03T08:00:51.537782+01:00","files_new":2,"files_changed":0,"files_unmodified":0,"dirs_new":5,"dirs_changed":0,"dirs_unmodified":0,"data_blobs":2,"tree_blobs":6,"data_added":3320,"data_added_packed":2486,"total_files_processed":2,"total_bytes_processed":29},"id":"c95c1d358d9c73d33b44e7f48097d58dd4dc4ff30eb08730b0b19fbdf1363b44","short_id":"c95c1d35"},{"time":"2026-07-03T08:00:51.60488+01:00","parent":"c95c1d358d9c73d33b44e7f48097d58dd4dc4ff30eb08730b0b19fbdf1363b44","tree":"d55567dd8e08984679118ea251101cff644a38c7f931f7ba8d46c4de24d83c38","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","uid":503,"gid":20,"program_version":"restic 0.18.1","summary":{"backup_start":"2026-07-03T08:00:51.60488+01:00","backup_end":"2026-07-03T08:00:52.298531+01:00","files_new":0,"files_changed":0,"files_unmodified":2,"dirs_new":0,"dirs_changed":0,"dirs_unmodified":5,"data_blobs":0,"tree_blobs":0,"data_added":0,"data_added_packed":0,"total_files_processed":2,"total_bytes_processed":29},"id":"08031febdae7ce0c784ea1508f7bed5d78f11225365abd07bbc49a38cf5f6620","short_id":"08031feb"}]
```
Required (consumed by code): `id`, `short_id`, `time`, `hostname`, `paths` (string[]).
Optional: `tags` (string[], absent when untagged), `parent` (string, only on
non-root snapshots), `excludes` (string[]), **`username`** (string; the current
code reads it as `?? ""` and the architecture requires it stay tolerant on older
restic — mark optional, default `""` on map). Passthrough: `tree`, `uid`, `gid`,
`program_version`, `summary` (object).

## check — `restic check --json` — whole-payload, single object
```json
{"message_type":"summary","num_errors":0,"broken_packs":null,"suggest_repair_index":false,"suggest_prune":false}
```
Fields: `message_type`("summary"), `num_errors`(number), `broken_packs`(null|array),
`suggest_repair_index`(bool), `suggest_prune`(bool). A well-formed summary with
`num_errors > 0` and a non-zero exit is a VALID integrity-FAILURE result, **not** a
shape mismatch — the validator must not conflate the two.

## restore — `restic restore latest --target T --json` — JSONL stream; validate LAST `message_type=="summary"` line
```json
{"message_type":"summary","total_files":8,"files_restored":8,"total_bytes":31,"bytes_restored":31}
```
Fields: `message_type`("summary"), `total_files`, `files_restored`, `total_bytes`,
`bytes_restored` — all numbers, all present.

## forget — `restic forget --keep-last 1 --dry-run --json` — whole-payload, JSON array of group objects
Each group carries `keep`/`remove` (snapshot arrays, same snapshot shape as above)
and a `reasons` array. Verbatim:
```json
[{"tags":null,"host":"UKFARTMML8397","paths":["/tmp/restic-shape-i3/src/.swamp"],"keep":[{"time":"2026-07-03T08:11:21.855069+01:00","parent":"08031febdae7ce0c784ea1508f7bed5d78f11225365abd07bbc49a38cf5f6620","tree":"ba20c905f867799b0eeef1cda4766be6df40644b27aeb377e0b6af166cf2e552","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","uid":503,"gid":20,"program_version":"restic 0.18.1","summary":{"backup_start":"2026-07-03T08:11:21.855069+01:00","backup_end":"2026-07-03T08:11:22.569308+01:00","files_new":1,"files_changed":0,"files_unmodified":2,"dirs_new":0,"dirs_changed":5,"dirs_unmodified":0,"data_blobs":1,"tree_blobs":6,"data_added":3760,"data_added_packed":2454,"total_files_processed":3,"total_bytes_processed":31},"id":"40794fa017d67541694f342e5d7aed40f724fb9f1b6015944c96ee2720c37f71","short_id":"40794fa0"}],"remove":[{"time":"2026-07-03T08:00:50.803314+01:00","tree":"d55567dd8e08984679118ea251101cff644a38c7f931f7ba8d46c4de24d83c38","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","uid":503,"gid":20,"program_version":"restic 0.18.1","summary":{"backup_start":"2026-07-03T08:00:50.803314+01:00","backup_end":"2026-07-03T08:00:51.537782+01:00","files_new":2,"files_changed":0,"files_unmodified":0,"dirs_new":5,"dirs_changed":0,"dirs_unmodified":0,"data_blobs":2,"tree_blobs":6,"data_added":3320,"data_added_packed":2486,"total_files_processed":2,"total_bytes_processed":29},"id":"c95c1d358d9c73d33b44e7f48097d58dd4dc4ff30eb08730b0b19fbdf1363b44","short_id":"c95c1d35"}],"reasons":[{"snapshot":{"time":"2026-07-03T08:11:21.855069+01:00","parent":"08031febdae7ce0c784ea1508f7bed5d78f11225365abd07bbc49a38cf5f6620","paths":["/tmp/restic-shape-i3/src/.swamp"],"hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","id":"40794fa017d67541694f342e5d7aed40f724fb9f1b6015944c96ee2720c37f71","short_id":"40794fa0"},"matches":["last snapshot"]}]}]
```
Per group: `tags`(null|string[]), `host`(string), `paths`(string[]),
`keep`(snapshot[]), `remove`(snapshot[]|null), `reasons`(array of
`{snapshot, matches[]}`). The code consumes group `paths`, `keep`, `remove`;
`reasons` is passthrough.
