/**
 * snapshots method — list snapshots in the restic repository.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

import { z } from "npm:zod@4.4.3";
import { SnapshotsArgsSchema, ResticSnapshotArraySchema } from "../schemas.ts";
import { invokeResticSnapshots } from "../commands.ts";
import { decodeResticOutput } from "../decode.ts";
import { runSecretPreflight } from "../preflight.ts";
import { redactSecrets } from "../secrets.ts";
import type { MethodContext } from "../method-context.ts";

export const snapshots = {
  description: "List snapshots in the restic repository",
  arguments: SnapshotsArgsSchema,
  execute: async (
    args: z.infer<typeof SnapshotsArgsSchema>,
    context: MethodContext,
  ) => {
    const { secrets, cwd, resticPath, repository } = await runSecretPreflight(
      context.globalArgs,
    );

    const result = await invokeResticSnapshots(
      { host: args.host, tags: args.tags, path: args.path },
      repository,
      secrets,
      resticPath,
      cwd,
    );

    if (!result.success) {
      throw new Error(
        `restic snapshots failed (exit ${result.exitCode}): ${redactSecrets(result.stderr.slice(0, 200), secrets)}`,
      );
    }

    // Decode and validate the whole-payload JSON array via the boundary decoder.
    // decodeResticOutput parses the entire stdout and validates against the Zod
    // schema — a non-array payload fails at the boundary, not with a TypeError on .map.
    const snapshotArray = decodeResticOutput(
      result.stdout,
      ResticSnapshotArraySchema,
      "snapshots",
    );

    const snapshotsMapped = snapshotArray.map((snap) => ({
      id: snap.id,
      shortId: snap.short_id,
      time: snap.time,
      hostname: snap.hostname,
      paths: snap.paths,
      // username is OPTIONAL in the restic output schema (absent on older restic);
      // map absent → "" to preserve the public result-resource shape.
      tags: snap.tags ?? [],
      username: snap.username ?? "",
    }));

    // Select latest by chronological time comparison. Parse each timestamp to
    // epoch millis ONCE up front (Date.parse handles restic's RFC3339 output),
    // then sort on the precomputed value — NOT localeCompare, which is
    // locale-sensitive, and not reparsing inside the comparator.
    const withTimeMs = snapshotsMapped.map((snap) => ({ snap, timeMs: Date.parse(snap.time) }));
    withTimeMs.sort((a, b) => a.timeMs - b.timeMs);
    const latest = withTimeMs[withTimeMs.length - 1]?.snap;

    const snapshotsData = {
      snapshots: snapshotsMapped,
      latestSnapshotId: latest?.id ?? undefined,
      latestTime: latest?.time ?? undefined,
      count: snapshotsMapped.length,
    };

    const handle = await context.writeResource(
      "snapshots",
      "current",
      snapshotsData as unknown as Record<string, unknown>,
    );

    context.logger.info(
      "snapshots: {count} snapshots, latest={latest}",
      {
        count: snapshotsMapped.length,
        latest: latest?.id?.slice(0, 12) ?? "none",
      },
    );

    return { dataHandles: [handle] };
  },
};
