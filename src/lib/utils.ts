// src/lib/utils.ts
// Low-level helpers. Everything that touches the filesystem goes through here
// so we can swap implementations or add dry-run support in one place.

import { $ } from "bun";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CleanTarget, RiskTier } from "./types.ts";

// Always silence Bun.$ — we'll handle output ourselves.
$.nothrow();

/* ────────────────────────────────────────────────────────────────────────── */
/*  SIZE FORMATTING                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  // Show 1 decimal for >1 GB so 12.4 GB reads better than 12 GB
  return `${value.toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}

/** Right-pad/truncate a string to a fixed display width (treating it as plain ASCII). */
export function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  if (s.length >= width) return s;
  const padding = " ".repeat(width - s.length);
  return align === "left" ? s + padding : padding + s;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  PATH / FILESYSTEM                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

export const HOME = homedir();

/** Expand a leading ~/ to the user's home dir. */
export function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

export function pathExists(p: string): boolean {
  try {
    return existsSync(expandHome(p));
  } catch {
    return false;
  }
}

/** Single-quote a path for safe inclusion in a shell command, escaping any
 *  embedded single quotes via close-quote/escaped-quote/re-open. Use this
 *  whenever you're building a shell command string with a user-influenced path. */
export function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/**
 * Compute the on-disk size of a path using `du -sk` (kilobytes) so we don't
 * have to walk a deep tree in JS. Returns 0 if the path doesn't exist or du
 * emits no parseable output.
 *
 * Uses `du -sk` (apparent in 1024-byte blocks) rather than `du -sh` because we
 * need a parseable number, not a human-readable string. Apparent size matches
 * what users expect from "size on disk" without surfacing APFS clone weirdness.
 *
 * We deliberately do NOT gate on `du`'s exit code. macOS sandbox-protected
 * paths (e.g. /private/var/folders/.../C/) make `du` exit non-zero due to
 * permission errors on individual subdirs, but it still prints a useful
 * partial total to stdout. Parsing stdout is the right behaviour.
 */
export async function pathSize(p: string): Promise<number> {
  const expanded = expandHome(p);
  if (!pathExists(expanded)) return 0;

  const result = await $`du -sk ${expanded}`.quiet().nothrow();
  const text = result.stdout.toString().trim();
  if (!text) return 0;

  const firstField = text.split(/\s+/)[0];
  const kb = parseInt(firstField ?? "0", 10);
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : 0;
}

/** Quick stat without recursing — used for "is this a regular file we should touch?" checks. */
export function safeStat(p: string) {
  try {
    return statSync(expandHome(p));
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  DISK FREE                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export interface DiskInfo {
  total: number;
  used: number;
  free: number;
  purgeable: number;
  percentUsed: number;
}

/**
 * Query disk usage for the boot volume.
 *
 * macOS is tricky here:
 *   - `df -h /` reports the container view including "purgeable" space as free
 *   - `diskutil info /` exposes the real "Free Space" + "Container Free Space"
 * We use `df -k /System/Volumes/Data` because it matches what users see in
 * About This Mac → Storage, then look up purgeable via diskutil.
 */
export async function getDiskInfo(): Promise<DiskInfo> {
  const dfResult = await $`df -k /System/Volumes/Data`.quiet();
  const lines = dfResult.stdout.toString().trim().split("\n");
  const dataLine = lines[lines.length - 1] ?? "";
  const parts = dataLine.split(/\s+/);

  // df -k columns on macOS: Filesystem 1024-blocks Used Available Capacity ...
  const totalKb = parseInt(parts[1] ?? "0", 10);
  const usedKb = parseInt(parts[2] ?? "0", 10);
  const freeKb = parseInt(parts[3] ?? "0", 10);

  const total = totalKb * 1024;
  const used = usedKb * 1024;
  const free = freeKb * 1024;

  // Purgeable: ask diskutil. Falls back to 0 if not available.
  let purgeable = 0;
  const diskutil = await $`diskutil info /System/Volumes/Data`.quiet();
  if (diskutil.exitCode === 0) {
    const txt = diskutil.stdout.toString();
    const m = txt.match(/Volume Free Space:\s+([\d.]+)\s+(\w+)/);
    const cm = txt.match(/Container Free Space:\s+([\d.]+)\s+(\w+)/);
    if (m && cm) {
      const volFree = unitToBytes(parseFloat(m[1]!), m[2]!);
      const contFree = unitToBytes(parseFloat(cm[1]!), cm[2]!);
      // Purgeable ≈ container free - volume free (rough but useful)
      purgeable = Math.max(0, contFree - volFree);
    }
  }

  return {
    total,
    used,
    free,
    purgeable,
    percentUsed: total > 0 ? (used / total) * 100 : 0,
  };
}

function unitToBytes(n: number, unit: string): number {
  const u = unit.toUpperCase();
  if (u.startsWith("T")) return n * 1024 ** 4;
  if (u.startsWith("G")) return n * 1024 ** 3;
  if (u.startsWith("M")) return n * 1024 ** 2;
  if (u.startsWith("K")) return n * 1024;
  return n;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  PROCESS DETECTION (guards)                                                */
/* ────────────────────────────────────────────────────────────────────────── */

/** Is a process matching this name currently running? Used to refuse to clean
 *  caches owned by a live process (e.g. don't nuke DerivedData while Xcode is open). */
export async function isProcessRunning(name: string): Promise<boolean> {
  const result = await $`pgrep -i ${name}`.quiet();
  return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  SAFE DELETE — move to Trash, never rm -rf                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Move a path to the user's Trash. We never call `rm -rf` — every cleanup
 * is reversible from Finder until the user empties Trash.
 *
 * We use `mv` to ~/.Trash/ with a timestamp suffix to avoid clobbering an
 * existing item of the same name already in Trash.
 *
 * Returns true if the move succeeded, false otherwise.
 */
export async function moveToTrash(p: string): Promise<boolean> {
  const expanded = expandHome(p);
  if (!pathExists(expanded)) return false;

  const trash = join(HOME, ".Trash");
  const base = expanded.split("/").pop() ?? "item";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(trash, `${base}.macreaper-${ts}`);

  const result = await $`mv ${expanded} ${dest}`.quiet();
  return result.exitCode === 0;
}

/**
 * Run a tool's own cleanup command (e.g. `docker system prune`, `brew cleanup`).
 * These are safer than deleting folders because the tool knows what's truly disposable.
 */
export async function runCleanCommand(cmd: string): Promise<{ ok: boolean; output: string }> {
  // Bun.$ supports raw shell strings via the `sh` template — but for our hand-curated
  // commands list (all of which we control), executing through sh is acceptable.
  const result = await $`sh -c ${cmd}`.quiet();
  return {
    ok: result.exitCode === 0,
    output: (result.stdout.toString() + result.stderr.toString()).trim(),
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  CACHE SPEC HELPER — used by most scanners                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export interface CacheSpec {
  label: string;
  path: string;
  description: string;
  rebuildCost: string;
  /** Defaults to "safe" — bump to "caution" for caches whose loss costs real time, or "risky" for state-bearing dirs. */
  risk?: RiskTier;
  /** Optional tool-native cleanup command (preferred over a raw folder delete when present). */
  cleanCommand?: string;
  /** Optional guard — return a string reason to skip, or null to proceed. */
  guard?: () => Promise<string | null>;
}

/**
 * Walk a list of cache specs, size each path that exists, and produce
 * CleanTarget rows. Shared by every "list of known folders" scanner so the
 * sizing/skipping logic only lives in one place.
 */
export async function scanCacheSpecs(
  specs: CacheSpec[],
  category: "dev" | "system" | "user",
): Promise<CleanTarget[]> {
  const targets: CleanTarget[] = [];
  for (const c of specs) {
    if (!pathExists(c.path)) continue;
    const size = await pathSize(c.path);
    if (size === 0) continue;
    targets.push({
      label: c.label,
      path: c.path,
      size,
      risk: c.risk ?? "safe",
      description: c.description,
      rebuildCost: c.rebuildCost,
      cleanCommand: c.cleanCommand,
      guard: c.guard,
      category,
    });
  }
  return targets;
}
