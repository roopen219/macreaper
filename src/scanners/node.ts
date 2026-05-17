// src/scanners/node.ts
// Node ecosystem: npm/bun/pnpm/yarn caches + stray node_modules folders.

import { $ } from "bun";
import type { CleanTarget } from "../lib/types.ts";
import { HOME, pathSize, pathExists } from "../lib/utils.ts";
import {
  readModulesCache,
  writeModulesCache,
  CACHE_SCHEMA_VERSION,
} from "../lib/cache.ts";

const CACHE_PATHS: Array<{ label: string; path: string; description: string; rebuildCost: string }> = [
  {
    label: "npm cache",
    path: "~/.npm/_cacache",
    description: "Tarballs npm has downloaded. Safe to nuke; npm re-downloads on demand.",
    rebuildCost: "Re-downloads packages on next install",
  },
  {
    label: "Bun install cache",
    path: "~/.bun/install/cache",
    description: "Bun's global package cache. Used by `bun install` to skip re-downloads.",
    rebuildCost: "Re-downloads packages on next install",
  },
  {
    label: "pnpm content-addressable store",
    path: "~/Library/pnpm/store",
    description: "pnpm's global store. Hardlinked into projects, so deleting frees real space.",
    rebuildCost: "Re-downloads packages on next install",
  },
  {
    label: "pnpm store (XDG)",
    path: "~/.local/share/pnpm/store",
    description: "Alternate pnpm store location on some configurations.",
    rebuildCost: "Re-downloads packages on next install",
  },
  {
    label: "Yarn cache",
    path: "~/Library/Caches/Yarn",
    description: "Yarn 1.x package cache.",
    rebuildCost: "Re-downloads packages on next install",
  },
  {
    label: "Yarn Berry cache",
    path: "~/.yarn/berry/cache",
    description: "Yarn 2+ (Berry) package cache.",
    rebuildCost: "Re-downloads packages on next install",
  },

  // ── Headless-browser binaries downloaded by test runners ─────────────
  // Each install pulls Chromium + Firefox + WebKit for the matching version
  // of the runner. They never auto-prune, so an old project from 2 years
  // ago can leave 1.5 GB of dead browser binaries behind.
  {
    label: "Playwright browser binaries",
    path: "~/Library/Caches/ms-playwright",
    description: "Chromium / Firefox / WebKit binaries per Playwright version. ~1.5 GB per release.",
    rebuildCost: "Re-installed by `npx playwright install` on next test run",
  },
  {
    label: "Puppeteer browser binaries",
    path: "~/.cache/puppeteer",
    description: "Chrome/Firefox builds Puppeteer has downloaded.",
    rebuildCost: "Re-downloaded by Puppeteer on next install/test run",
  },
  {
    label: "Cypress binary cache",
    path: "~/Library/Caches/Cypress",
    description: "Per-version Cypress.app bundles. ~500 MB each; Cypress never cleans old versions.",
    rebuildCost: "Re-downloaded when a project pins an older Cypress version",
  },
  {
    label: "Electron downloads",
    path: "~/Library/Caches/electron",
    description: "Electron binary tarballs downloaded by @electron/get for various app builds.",
    rebuildCost: "Re-downloads on next electron-builder / electron-packager invocation",
  },
];

export async function scanNode(): Promise<CleanTarget[]> {
  const targets: CleanTarget[] = [];

  // Global package manager caches — 🟢 safe, they all rebuild.
  for (const c of CACHE_PATHS) {
    if (!pathExists(c.path)) continue;
    const size = await pathSize(c.path);
    if (size === 0) continue;
    targets.push({
      label: c.label,
      path: c.path,
      size,
      risk: "safe",
      description: c.description,
      rebuildCost: c.rebuildCost,
      category: "dev",
    });
  }

  // Stray node_modules — 🟡 caution: deleting them is fine, but you have to
  // `npm install` again to use the project. We surface them as a single bucket
  // and a count, rather than listing every one individually here (find-modules
  // command will do the detailed view).
  const nm = await findNodeModules();
  if (nm.totalSize > 0) {
    targets.push({
      label: `node_modules folders (${nm.count} found)`,
      path: "~/  (multiple locations — run `find-modules` for the full list)",
      size: nm.totalSize,
      risk: "caution",
      description: `${nm.count} node_modules directories scattered under your home folder. Safe to delete in projects you're not actively working on.`,
      rebuildCost: "Run `npm install` / `bun install` to rebuild per project",
      category: "dev",
    });
  }

  return targets;
}

export interface NodeModulesResult {
  count: number;
  totalSize: number;
  paths: Array<{ path: string; size: number }>;
  /** "fresh" if we ran the full walk; "cache" if we loaded the sibling JSON. */
  source?: "fresh" | "cache";
  /** Age in ms of the cache when source === "cache", undefined otherwise. */
  cacheAgeMs?: number;
}

/**
 * Walk ~ looking for node_modules. We use `find` because it's far faster than
 * recursing in JS, and `-prune` lets us stop descending once we find one
 * (saves walking the millions of nested files inside). We also prune common
 * heavy paths we don't care about.
 *
 * We invoke `find` through `sh -c` because Bun's tagged-template shell parser
 * doesn't tolerate the `\\( ... \\)` group syntax that BSD `find` requires for
 * combining prune expressions. Routing through `sh` lets the shell, not Bun,
 * handle the parens.
 *
 * Note: `find` returns non-zero if it hits an unreadable dir; we just ignore
 * the exit code and parse whatever stdout we got.
 *
 * Results are persisted to ~/Library/Caches/macreaper/node-modules.json after
 * every fresh run. Pass `{ fromCache: true }` to replay that cache without
 * re-walking (instant, vs ~60–90 s on a heavy dev machine).
 */
export async function findNodeModules(
  opts: { fromCache?: boolean } = {},
): Promise<NodeModulesResult> {
  if (opts.fromCache) {
    const hit = readModulesCache();
    if (hit) {
      return {
        count: hit.cache.count,
        totalSize: hit.cache.totalSize,
        paths: hit.cache.paths,
        source: "cache",
        cacheAgeMs: hit.ageMs,
      };
    }
    // Fall through to a fresh walk if the cache is missing/stale. The caller
    // gets `source: "fresh"` and can mention it in the UI.
  }

  // -maxdepth 8 catches most real project layouts without escaping into nested
  // weirdness. Prune .Trash, Library, .git, and node_modules-inside-node_modules.
  const findCmd =
    `find "${HOME}" -maxdepth 8 ` +
    `\\( -path "*/.Trash" -o -path "*/Library" -o -path "*/.git" -o -path "*/node_modules/*/node_modules" \\) -prune ` +
    `-o -type d -name node_modules -print`;
  const result = await $`sh -c ${findCmd}`.quiet().nothrow();

  const paths = result.stdout
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.includes("/node_modules/"));

  // Size each one. Doing these in parallel makes the scan vastly faster on
  // large dev folders — pathSize shells out to `du`, so the bottleneck is
  // disk I/O, not CPU, and macOS handles parallel `du` fine.
  const sized = await Promise.all(
    paths.map(async (p) => ({ path: p, size: await pathSize(p) })),
  );

  const totalSize = sized.reduce((acc, s) => acc + s.size, 0);

  // Persist for next find-modules / scan invocation. Best-effort: if the
  // disk is full or perms are weird, just swallow it — caching is an
  // optimization, not a correctness requirement.
  try {
    writeModulesCache({
      version: CACHE_SCHEMA_VERSION,
      scannedAt: new Date().toISOString(),
      count: sized.length,
      totalSize,
      paths: sized,
    });
  } catch {
    // ignore
  }

  return { count: sized.length, totalSize, paths: sized, source: "fresh" };
}
