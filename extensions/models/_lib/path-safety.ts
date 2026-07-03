/**
 * Restore target path safety checker.
 *
 * Pure path logic + Deno filesystem queries (lstat, realPath). No subprocess
 * invocation, no secrets. Importable by any module; imports nothing from
 * invoker.ts or secrets.ts.
 *
 * Exports:
 *   - normalizePosixPath (pure string normalization)
 *   - resolvePathWithAncestor (symlink-safe path resolution for partially-existent paths)
 *   - checkRestoreTargetSafety (the main safety guard — exported for testing)
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * @module
 */

// =============================================================================
// Restore Safety Checker
// =============================================================================

/**
 * Normalize an absolute path by collapsing `.` and `..` segments without
 * touching the filesystem. This is a pure string operation applied BEFORE
 * any existence checks, ensuring that paths like `/a/b/../.swamp` are
 * collapsed to `/a/.swamp` even when `/a/b` does not exist.
 */
export function normalizePosixPath(absPath: string): string {
  const segments = absPath.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      // Skip empty and current-dir segments; preserve leading empty for root.
      if (normalized.length === 0) normalized.push("");
      continue;
    }
    if (segment === "..") {
      // Pop the last real segment, but never go above root.
      if (normalized.length > 1) normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/") || "/";
}

/**
 * Resolve a path to its real, symlink-normalized absolute path even when the
 * target doesn't fully exist yet.
 *
 * Algorithm:
 *   1. Make the path absolute.
 *   2. Collapse all `.` and `..` segments via string normalization first — this
 *      handles traversal attacks even for non-existent paths.
 *   3. Try Deno.realPath on the normalized path (handles symlinks if it exists).
 *   4. If that fails, walk up the normalized path to find the deepest existing
 *      ancestor, resolve that via Deno.realPath (handles symlinks in the
 *      existing portion), then re-append the non-existing tail.
 *
 * This prevents both `../` traversal and symlink-parent-with-missing-child
 * bypasses of the safety checker.
 */
export async function resolvePathWithAncestor(rawPath: string, cwd: string): Promise<string> {
  // Make the path absolute and collapse all `.` / `..` segments.
  const absPath = rawPath.startsWith("/") ? rawPath : `${cwd}/${rawPath}`;
  const normalizedPath = normalizePosixPath(absPath);

  // Try the full normalized path first (common case: target already exists).
  try {
    return await Deno.realPath(normalizedPath);
  } catch { /* target doesn't exist — walk up */ }

  // Split the already-normalized path into segments.
  const segments = normalizedPath.split("/").filter((s) => s !== "");
  let existingAncestor = "/";
  let lastExistingIndex = -1;

  for (let i = 0; i < segments.length; i++) {
    const candidate = "/" + segments.slice(0, i + 1).join("/");
    try {
      await Deno.lstat(candidate);
      lastExistingIndex = i;
      existingAncestor = candidate;
    } catch {
      // This segment doesn't exist — stop searching further.
      break;
    }
  }

  // Resolve the existing ancestor through any symlinks.
  let resolvedAncestor: string;
  try {
    resolvedAncestor = await Deno.realPath(existingAncestor);
  } catch {
    resolvedAncestor = existingAncestor;
  }

  // Re-append the non-existing tail segments (already free of `.`/`..`).
  const remainingSegments = segments.slice(lastExistingIndex + 1);
  if (remainingSegments.length === 0) {
    return resolvedAncestor;
  }
  return `${resolvedAncestor}/${remainingSegments.join("/")}`;
}

/**
 * Check whether a proposed restore target directory is dangerous.
 *
 * Refuses (returns an error message string) when the resolved, symlink-normalized
 * targetDir:
 *   (a) equals repo root
 *   (b) equals .swamp/ within the repo
 *   (c) is an ancestor/parent containing a live .swamp/
 *   (d) resolves into .swamp/ via symlink (including when the final segment doesn't exist)
 *
 * Uses resolvePathWithAncestor to handle `../` traversal and symlink-parent-with-
 * missing-child cases that Deno.realPath alone would miss.
 *
 * Returns null if the target is safe, or an error message string if it is dangerous.
 */
export async function checkRestoreTargetSafety(
  targetDir: string,
  repoDir: string,
  // Anchor used to absolutize a relative repoDir (defaults to the process cwd).
  // Injectable so tests can drive the default repoDir='.' resolution path
  // deterministically without mutating the real process working directory.
  cwdAnchor: string = Deno.cwd(),
): Promise<string | null> {
  if (!targetDir || targetDir.trim() === "") {
    return "targetDir is required for restore — specify an explicit directory to restore into";
  }

  // Resolve repoDir to a real absolute path FIRST.
  // repoDir defaults to '.' in globalArgs; if we skip this step, a relative
  // repoDir produces resolvedSwampDir = '/.swamp' (or some other wrong root),
  // allowing an absolute targetDir inside the ACTUAL .swamp/ to pass unchecked.
  // We must anchor everything to the actual working directory before comparisons.
  const absoluteRepoDir = repoDir.startsWith("/")
    ? repoDir
    : `${cwdAnchor}/${repoDir}`;
  let resolvedRepo: string;
  try {
    resolvedRepo = await Deno.realPath(absoluteRepoDir);
  } catch {
    resolvedRepo = normalizePosixPath(absoluteRepoDir);
  }

  // Resolve targetDir against the now-absolute resolvedRepo as cwd.
  const resolvedTarget = await resolvePathWithAncestor(targetDir, resolvedRepo);
  const resolvedSwampDir = `${resolvedRepo}/.swamp`;

  // (a) equals repo root
  if (resolvedTarget === resolvedRepo) {
    return `Refusing to restore into the repo root (${resolvedTarget}). Use a staging directory and move files manually.`;
  }

  // (b) equals .swamp/ directory
  if (resolvedTarget === resolvedSwampDir) {
    return `Refusing to restore into .swamp/ directly (${resolvedTarget}). Use a staging directory outside the repo.`;
  }

  // (c) is an ancestor/parent that contains .swamp/ — i.e. the .swamp/ path starts with target
  if (resolvedSwampDir.startsWith(resolvedTarget + "/")) {
    return `Refusing to restore into ${resolvedTarget} — it is an ancestor of .swamp/ (${resolvedSwampDir}). Use a staging directory outside the repo.`;
  }

  // (d) resolves into .swamp/ (including via symlink or missing-child traversal)
  if (
    resolvedTarget.startsWith(resolvedSwampDir + "/") ||
    resolvedTarget === resolvedSwampDir
  ) {
    return `Refusing to restore into a path inside .swamp/ (${resolvedTarget}). Use a staging directory outside the repo.`;
  }

  return null;
}
