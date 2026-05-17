// src/lib/cache.ts
// Persist scan results to ~/Library/Caches/macreaper/last-scan.json so other
// commands (and LLM-driven workflows) can replay the scan without paying the
// 3–5 min re-scan cost.
//
// SAFETY NOTE: CleanTarget can carry a `guard` function which JSON drops on
// serialize. That's intentional — guards must run against the live system, so
// `dev` / `system` cleanup commands still scan fresh by default. The cache is
// for display, reporting, and LLM input.

import { mkdirSync, readFileSync, writeFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { CleanTarget } from "./types.ts";
import { HOME } from "./utils.ts";

export const CACHE_DIR = join(HOME, "Library", "Caches", "macreaper");
export const CACHE_FILE = join(CACHE_DIR, "last-scan.json");
// Sibling caches for the two `find $HOME` commands that produce per-path
// detail rather than aggregate findings. Kept separate from the main scan
// cache so each can be invalidated independently and the main scan file
// stays compact.
export const MODULES_CACHE_FILE = join(CACHE_DIR, "node-modules.json");
export const LARGE_FILES_CACHE_FILE = join(CACHE_DIR, "large-files.json");

export const CACHE_SCHEMA_VERSION = 1;

export interface ScanCache {
  /** Bump when the on-disk schema changes incompatibly. */
  version: number;
  /** ISO-8601 timestamp of when the scan ran. */
  scannedAt: string;
  /** Total wall-clock time the scan took, in ms. */
  elapsedMs: number;
  /** True when the slow `$HOME` find-walks were skipped via --fast. */
  fast: boolean;
  /** Disk-usage snapshot at scan time. */
  disk: {
    total: number;
    used: number;
    free: number;
    purgeable: number;
    percentUsed: number;
  };
  /** Per-scanner timing — useful for "where did the time go?" introspection. */
  scannerTimingsMs: Record<string, number>;
  /** Aggregate findings. `guard` is intentionally absent here. */
  targets: Omit<CleanTarget, "guard">[];
}

/**
 * Atomically write any JSON-serializable cache payload. Writes to a sibling
 * `.tmp` file then renames, so an interrupted write can't leave a half-
 * flushed JSON blob behind for the next command to choke on.
 *
 * Strips `guard` function fields on serialize because they're not JSON-safe.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = path + ".tmp";
  const payload = JSON.stringify(
    value,
    (key, v) => (key === "guard" ? undefined : v),
    2,
  );
  writeFileSync(tmp, payload);
  renameSync(tmp, path);
}

/**
 * Read + JSON-parse a cache file. Returns null on missing/unreadable/malformed
 * input. The optional `validate` predicate lets each cache file enforce its
 * own schema (version field, required keys, etc.).
 */
function readJsonValidated<T>(path: string, validate: (parsed: unknown) => parsed is T): T | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ── Main scan cache ─────────────────────────────────────────────────────────

export function writeCache(cache: ScanCache): void {
  writeJsonAtomic(CACHE_FILE, cache);
}

export interface CacheReadResult {
  cache: ScanCache;
  ageMs: number;
}

/** Read & validate the main scan cache. Returns null on miss / bad schema. */
export function readCache(): CacheReadResult | null {
  const parsed = readJsonValidated<ScanCache>(CACHE_FILE, (v): v is ScanCache => {
    const x = v as Partial<ScanCache> | null;
    return !!x
      && x.version === CACHE_SCHEMA_VERSION
      && typeof x.scannedAt === "string"
      && Array.isArray(x.targets);
  });
  if (!parsed) return null;
  return { cache: parsed, ageMs: Date.now() - new Date(parsed.scannedAt).getTime() };
}

// ── node_modules cache (find-modules + scanNode share this) ─────────────────

export interface ModulesCache {
  version: number;
  scannedAt: string;
  count: number;
  totalSize: number;
  /** Each `node_modules` directory with its on-disk size. */
  paths: Array<{ path: string; size: number }>;
}

export function writeModulesCache(cache: ModulesCache): void {
  writeJsonAtomic(MODULES_CACHE_FILE, cache);
}

export function readModulesCache(): { cache: ModulesCache; ageMs: number } | null {
  const parsed = readJsonValidated<ModulesCache>(MODULES_CACHE_FILE, (v): v is ModulesCache => {
    const x = v as Partial<ModulesCache> | null;
    return !!x
      && x.version === CACHE_SCHEMA_VERSION
      && typeof x.scannedAt === "string"
      && Array.isArray(x.paths)
      && typeof x.count === "number"
      && typeof x.totalSize === "number";
  });
  if (!parsed) return null;
  return { cache: parsed, ageMs: Date.now() - new Date(parsed.scannedAt).getTime() };
}

// ── find-large cache ────────────────────────────────────────────────────────

export interface LargeFilesCache {
  version: number;
  scannedAt: string;
  /** Threshold (in MB) used when the cache was produced. When reading, we can
   *  re-filter the list to any HIGHER threshold for free, but a request for a
   *  lower threshold has to invalidate and re-scan. */
  thresholdMB: number;
  files: Array<{ path: string; size: number }>;
}

export function writeLargeFilesCache(cache: LargeFilesCache): void {
  writeJsonAtomic(LARGE_FILES_CACHE_FILE, cache);
}

export function readLargeFilesCache(): { cache: LargeFilesCache; ageMs: number } | null {
  const parsed = readJsonValidated<LargeFilesCache>(LARGE_FILES_CACHE_FILE, (v): v is LargeFilesCache => {
    const x = v as Partial<LargeFilesCache> | null;
    return !!x
      && x.version === CACHE_SCHEMA_VERSION
      && typeof x.scannedAt === "string"
      && typeof x.thresholdMB === "number"
      && Array.isArray(x.files);
  });
  if (!parsed) return null;
  return { cache: parsed, ageMs: Date.now() - new Date(parsed.scannedAt).getTime() };
}

/** "5 minutes ago", "2 hours ago", etc. — for cache-age messaging. */
export function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}
