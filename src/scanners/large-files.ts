// src/scanners/large-files.ts
// Find individual files above a size threshold anywhere under $HOME.
// Useful for catching things no category-based scanner would know about:
// downloaded ISOs, old video projects, forgotten dataset exports, etc.

import { $ } from "bun";
import { HOME } from "../lib/utils.ts";
import {
  readLargeFilesCache,
  writeLargeFilesCache,
  CACHE_SCHEMA_VERSION,
} from "../lib/cache.ts";

export interface LargeFile {
  path: string;
  size: number;
}

export interface LargeFilesResult {
  files: LargeFile[];
  source: "fresh" | "cache";
  cacheAgeMs?: number;
  /** Threshold the cache was originally produced at, if loaded from cache. */
  cacheThresholdMB?: number;
}

/**
 * Run `find` to locate files above the threshold. We prune the usual suspects
 * (other scanners handle those) so this returns *novel* large files.
 *
 * thresholdMB defaults to 500 MB — small enough to catch forgotten installers,
 * big enough to not be overwhelming on a developer's machine.
 *
 * Implementation note: BSD `find` uses `\( ... \)` for grouping which Bun's
 * shell template-literal parser chokes on (same root cause as the node.ts
 * findNodeModules fix). We delegate the whole pipeline to `sh -c` so the
 * shell, not Bun, parses the escapes.
 */
export async function findLargeFiles(
  thresholdMB = 500,
  opts: { fromCache?: boolean } = {},
): Promise<LargeFilesResult> {
  // Cache hit path: if the cache was produced at a threshold *at most* as
  // restrictive as the current request, we can re-filter for free. A request
  // for a lower threshold means we'd need files the cache never saw, so we
  // fall through to a fresh walk.
  if (opts.fromCache) {
    const hit = readLargeFilesCache();
    if (hit && hit.cache.thresholdMB <= thresholdMB) {
      const minBytes = thresholdMB * 1024 * 1024;
      const filtered = hit.cache.files
        .filter((f) => f.size >= minBytes)
        .sort((a, b) => b.size - a.size);
      return {
        files: filtered,
        source: "cache",
        cacheAgeMs: hit.ageMs,
        cacheThresholdMB: hit.cache.thresholdMB,
      };
    }
    // miss / wrong threshold → fall through
  }

  // -size +Nc takes bytes on BSD find; we convert MB → bytes for precision.
  const bytes = thresholdMB * 1024 * 1024;

  const script =
    `find "${HOME}" ` +
    `\\( -path "*/.Trash" ` +
    `-o -path "*/Library/Caches" ` +
    `-o -path "*/Library/Containers/com.docker.docker" ` +
    `-o -path "*/node_modules" ` +
    `-o -path "*/.git" ` +
    `-o -path "*/Library/Application Support/MobileSync" ` +
    `\\) -prune ` +
    `-o -type f -size +${bytes}c -print0`;

  const result = await $`sh -c ${script}`.quiet().nothrow();

  const paths = result.stdout
    .toString()
    .split("\0")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Stat each one for size. Doing this in parallel is fast even with hundreds.
  // `stat -f%z` is BSD-only (macOS) and prints raw byte size.
  const stats = await Promise.all(
    paths.map(async (p) => {
      const r = await $`stat -f%z ${p}`.quiet().nothrow();
      const size = parseInt(r.stdout.toString().trim(), 10);
      return { path: p, size: Number.isFinite(size) ? size : 0 };
    }),
  );

  const files = stats
    .filter((f) => f.size > 0)
    .sort((a, b) => b.size - a.size);

  // Best-effort cache write.
  try {
    writeLargeFilesCache({
      version: CACHE_SCHEMA_VERSION,
      scannedAt: new Date().toISOString(),
      thresholdMB,
      files,
    });
  } catch {
    // ignore
  }

  return { files, source: "fresh" };
}
