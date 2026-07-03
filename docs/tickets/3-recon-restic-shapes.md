# Captured restic 0.18.1 output shapes — ISSUE-3

Captured live 2026-07-03 against a local repo (`restic init/backup/snapshots/check/forget/restore --json`).
These are the ground-truth fixtures the plan and its tests must match. Field names verbatim.

## init  (`restic init --json`) — single JSON object
```json
{"message_type":"initialized","id":"41f72b...","repository":"/tmp/.../repo"}
```
Fields: message_type ("initialized"), id (string), repository (string). All present.

## backup summary  (`restic backup --json`, LAST JSONL line, message_type="summary")
```json
{"message_type":"summary","files_new":2,"files_changed":0,"files_unmodified":0,
 "dirs_new":5,"dirs_changed":0,"dirs_unmodified":0,"data_blobs":2,"tree_blobs":6,
 "data_added":3320,"data_added_packed":2486,"total_files_processed":2,
 "total_bytes_processed":29,"total_duration":0.734470167,
 "backup_start":"2026-07-03T08:00:50.803314+01:00",
 "backup_end":"2026-07-03T08:00:51.537782+01:00","snapshot_id":"c95c1d35..."}
```
Code consumes: snapshot_id, backup_start, backup_end, total_files_processed,
total_bytes_processed, total_duration — all required on a real summary. Other numeric
counters present but unconsumed → schema must PASSTHROUGH/ignore extras, not reject.

## snapshots  (`restic snapshots --json`) — JSON array of objects
```json
{"time":"2026-07-03T08:00:50.803314+01:00","tree":"d55567...","paths":["/tmp/.../.swamp"],
 "hostname":"UKFARTMML8397","username":"stephen.nelsonsmith","uid":503,"gid":20,
 "program_version":"restic 0.18.1","summary":{...},"id":"c95c1d35...","short_id":"c95c1d35"}
```
Always present: time, tree, paths[], hostname, username, uid, gid, program_version,
summary(obj), id, short_id. Optional: parent (present only on non-root snapshots),
tags (absent above; nullable/absent), excludes (absent). Code consumes: id, short_id,
time, hostname, paths, username, (tags). Schema: those required + tags/parent/excludes
optional; ignore uid/gid/tree/program_version/summary extras.

## check  (`restic check --json`) — single JSON object, message_type="summary"
```json
{"message_type":"summary","num_errors":0,"broken_packs":null,
 "suggest_repair_index":false,"suggest_prune":false}
```
Fields: message_type("summary"), num_errors(number), broken_packs(null|array),
suggest_repair_index(bool), suggest_prune(bool). NOTE: an integrity FAILURE is
num_errors>0 (and restic exits non-zero) but the JSON is still WELL-FORMED. That is a
valid decoded result, NOT a shape mismatch — must not be conflated (resolves PLAN-5).

## forget  (`restic forget --dry-run --json`) — JSON array of group objects
```json
{"tags":null,"host":"UKFARTMML8397","paths":["/tmp/.../.swamp"],
 "keep":[<snapshot obj>...],"remove":[<snapshot obj>...]}
```
Per group: tags(null|array), host(string), paths(string[]), keep(snapshot[]),
remove(snapshot[]|null). keep/remove entries are the same snapshot shape as above.

## restore  (`restic restore latest --target T --json`) — LAST JSONL, message_type="summary"
```json
{"message_type":"summary","total_files":7,"files_restored":7,
 "total_bytes":29,"bytes_restored":29}
```
Fields: message_type("summary"), total_files, files_restored, total_bytes,
bytes_restored — all numbers, all present.
