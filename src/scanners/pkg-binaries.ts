// src/scanners/pkg-binaries.ts
// `@yao-pkg/pkg` (the maintained Vercel `pkg` fork) caches prebuilt Node
// binaries under ~/.pkg-cache/v<MAJOR.MINOR>/fetched-<nodever>-<platform>-<arch>[-signed].
//
// Each fetched-* file is a full Node executable (~70-120 MB) for the target
// platform/arch. If you've built apps for multiple target platforms or
// across several Node versions, this dir routinely sits at 1-3 GB.
//
// Reference: github.com/yao-pkg/pkg-binaries (cache path = ~/.pkg-cache, env
// override PKG_CACHE_PATH).

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CleanTarget } from "../lib/types.ts";
import { pathExists, pathSize, expandHome } from "../lib/utils.ts";

const PKG_CACHE = "~/.pkg-cache";

export async function scanPkgBinaries(): Promise<CleanTarget[]> {
  if (!pathExists(PKG_CACHE)) return [];

  const targets: CleanTarget[] = [];
  const totalSize = await pathSize(PKG_CACHE);
  if (totalSize === 0) return [];

  // Roll-up entry for the whole dir.
  targets.push({
    label: "yao-pkg / pkg prebuilt Node binaries",
    path: PKG_CACHE,
    size: totalSize,
    risk: "safe",
    description: "Prebuilt Node binaries downloaded by @yao-pkg/pkg (or Vercel pkg) when bundling apps. One ~80 MB binary per (Node version, platform, arch). Re-downloaded automatically the next time you bundle for that target.",
    rebuildCost: "Re-downloads needed binaries on next `pkg build`",
    category: "dev",
  });

  // List individual fetched-* binaries so users see which platform/version pile
  // is biggest. We only do this when there are at least 2 — otherwise the
  // roll-up entry already says it all.
  const fetched: Array<{ path: string; size: number; label: string }> = [];
  try {
    for (const versionDir of readdirSync(expandHome(PKG_CACHE), { withFileTypes: true })) {
      if (!versionDir.isDirectory() || !versionDir.name.startsWith("v")) continue;
      const versionPath = join(PKG_CACHE, versionDir.name);
      const versionAbs = expandHome(versionPath);
      for (const f of readdirSync(versionAbs, { withFileTypes: true })) {
        if (!f.isFile() || !f.name.startsWith("fetched-")) continue;
        const filePath = join(versionPath, f.name);
        const size = await pathSize(filePath);
        if (size === 0) continue;
        fetched.push({
          path: filePath,
          size,
          label: `pkg binary: ${versionDir.name}/${f.name}`,
        });
      }
    }
  } catch {
    // readdir can throw if perms are off; we already surfaced the roll-up.
  }

  if (fetched.length >= 2) {
    for (const f of fetched.sort((a, b) => b.size - a.size)) {
      targets.push({
        label: f.label,
        path: f.path,
        size: f.size,
        risk: "safe",
        description: "Single prebuilt Node binary for the platform/arch in the filename. Safe to delete; pkg re-fetches it on demand.",
        rebuildCost: "Re-downloaded on next `pkg build` for that target",
        category: "dev",
      });
    }
  }

  return targets;
}
