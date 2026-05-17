// src/scanners/native-bins.ts
// "Heavy native binaries duplicated inside node_modules."
//
// This is the disk-hog pattern the user spotted in the GrandPerspective
// treemaps: every project's node_modules carries its own copy of a fat
// platform-specific binary (workerd, esbuild, swc native, sharp, etc.).
// pnpm + yarn berry hardlink between projects so the duplication is virtual,
// but npm + bun + yarn classic copy them, so 10 projects = 10× the bytes.
//
// We walk ~ once with a single `find` invocation looking for the *parent
// package directory* of each known offender. For each match we record the
// containing project (the dir holding node_modules), then group by package
// name and surface one CleanTarget per package with:
//   - count of duplicate copies
//   - total size on disk
//   - top 5 fattest project paths in the description
//
// The CleanTarget itself isn't deletable as a single path — we set
// cleanCommand to a one-liner that nukes every copy at once, gated by a
// guard that requires confirmation.
//
// Prune list: same as findNodeModules in node.ts, plus we also prune
// existing nested node_modules so we only count top-level project copies.

import { $ } from "bun";
import type { CleanTarget } from "../lib/types.ts";
import { HOME, pathSize } from "../lib/utils.ts";

/**
 * Known heavy platform-specific native packages. Each entry is the path
 * fragment after `node_modules/` that uniquely identifies the package dir.
 *
 * These are the worst offenders by typical install size (>50 MB each):
 *   workerd:       ~150-200 MB  (Cloudflare Workers runtime)
 *   electron/dist: ~200-300 MB  (Electron binaries bundled per project)
 *   @img/sharp-*:  ~80-150 MB   (libvips + sharp native)
 *   @next/swc-*:   ~120-180 MB  (Next.js SWC native)
 *   @swc/core-*:   ~30-50 MB    (SWC native)
 *   esbuild:       ~10-15 MB    (each platform package)
 *   rollup native: ~5-10 MB
 *   biome cli:     ~30 MB
 *   turbo:         ~50 MB
 *   lightningcss:  ~5-10 MB
 *   parcel:        ~5-10 MB
 *   tailwindcss/oxide: ~5-10 MB
 *
 * We grep both -arm64 and -x64 fragments because lockfiles sometimes pull
 * the wrong arch (e.g. when a Rosetta-installed Node was used by mistake).
 */
const HEAVY_PACKAGES = [
  "@cloudflare/workerd-darwin-arm64",
  "@cloudflare/workerd-darwin-64",
  "electron/dist",
  "@img/sharp-darwin-arm64",
  "@img/sharp-darwin-x64",
  "@img/sharp-libvips-darwin-arm64",
  "@img/sharp-libvips-darwin-x64",
  "@next/swc-darwin-arm64",
  "@next/swc-darwin-x64",
  "@swc/core-darwin-arm64",
  "@swc/core-darwin-x64",
  "@esbuild/darwin-arm64",
  "@esbuild/darwin-x64",
  "@rollup/rollup-darwin-arm64",
  "@rollup/rollup-darwin-x64",
  "@biomejs/cli-darwin-arm64",
  "@biomejs/cli-darwin-x64",
  "turbo-darwin-arm64",
  "turbo-darwin-64",
  "lightningcss-darwin-arm64",
  "lightningcss-darwin-x64",
  "@parcel/watcher-darwin-arm64",
  "@parcel/watcher-darwin-x64",
  "@tailwindcss/oxide-darwin-arm64",
  "@tailwindcss/oxide-darwin-x64",
];

interface Hit {
  pkg: string;
  path: string;
  size: number;
}

// Use a single find invocation to locate every heavy-package dir under $HOME.
// Routed through `sh -c` for the same reason as findNodeModules: Bun's
// template-literal shell parser can't handle escaped grouping parens for BSD
// find. -name patterns alone would be ambiguous (esbuild appears as both
// node_modules/esbuild/ and node_modules/@esbuild/darwin-arm64/), so we match
// on -path with the full "<star>/node_modules/<pkg>" fragment.
//
// We prune the same paths as findNodeModules to avoid descending into Trash,
// Library, and nested node_modules.
async function findHeavyDirs(): Promise<Hit[]> {
  const pathExprs = HEAVY_PACKAGES.map((p) => `-path "*/node_modules/${p}"`).join(" -o ");

  const findCmd =
    `find "${HOME}" -maxdepth 12 ` +
    `\\( -path "*/.Trash" ` +
    `-o -path "*/Library/Caches" ` +
    `-o -path "*/Library/Containers/com.docker.docker" ` +
    `-o -path "*/.git" ` +
    `-o -path "*/Library/Application Support/MobileSync" ` +
    // also prune nested node_modules so we only catch top-level package copies
    `-o -path "*/node_modules/*/node_modules" ` +
    `\\) -prune ` +
    `-o \\( ${pathExprs} \\) -type d -print`;

  const result = await $`sh -c ${findCmd}`.quiet().nothrow();

  const paths = result.stdout
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // For each path, figure out which heavy-package fragment matched.
  const hits: Hit[] = [];
  for (const path of paths) {
    const pkg = HEAVY_PACKAGES.find((p) => path.endsWith(`/node_modules/${p}`));
    if (!pkg) continue;
    hits.push({ pkg, path, size: 0 });
  }

  // Size in parallel.
  const sized = await Promise.all(
    hits.map(async (h) => ({ ...h, size: await pathSize(h.path) })),
  );

  return sized.filter((h) => h.size > 0);
}

/** Strip $HOME from a path for friendlier output. */
function shortenPath(p: string): string {
  if (p.startsWith(HOME)) return `~${p.slice(HOME.length)}`;
  return p;
}

export async function scanNativeBins(): Promise<CleanTarget[]> {
  const hits = await findHeavyDirs();
  if (hits.length === 0) return [];

  // Group by package name.
  const byPackage = new Map<string, Hit[]>();
  for (const h of hits) {
    const list = byPackage.get(h.pkg) ?? [];
    list.push(h);
    byPackage.set(h.pkg, list);
  }

  const targets: CleanTarget[] = [];
  for (const [pkg, copies] of byPackage) {
    // Only surface packages where the duplication is meaningful — single
    // copies are just "a project uses this", not waste.
    if (copies.length < 2) continue;
    const total = copies.reduce((acc, c) => acc + c.size, 0);
    copies.sort((a, b) => b.size - a.size);
    const top = copies.slice(0, 5).map((c) => `  • ${formatBytesShort(c.size)}  ${shortenPath(c.path)}`);
    const moreSuffix = copies.length > 5 ? `\n  …and ${copies.length - 5} more` : "";

    targets.push({
      label: `Heavy native pkg: ${pkg} (${copies.length} copies)`,
      // Use the parent ~ as the path because there's no single dir to nuke.
      // The cleanCommand actually does the multi-delete.
      path: `~/...  (${copies.length} node_modules copies)`,
      size: total,
      risk: "caution",
      description:
        `${copies.length} duplicate copies of '${pkg}' across your projects (${formatBytesShort(total)} total). ` +
        `Migrate to pnpm or yarn-berry-with-hardlinks to dedupe automatically, or rm a project's node_modules ` +
        `when you're done with it.\n\nTop copies:\n${top.join("\n")}${moreSuffix}`,
      rebuildCost: "Re-installs when you next run npm/bun install in each project",
      category: "dev",
      // We provide a "burn-all" command but mark it caution because deleting
      // these mid-project will break in-flight builds.
      cleanCommand: copies.map((c) => `rm -rf "${c.path}"`).join(" && "),
    });
  }

  // Sort by total size so the biggest pile floats up.
  targets.sort((a, b) => b.size - a.size);
  return targets;
}

/** Local short-bytes formatter so we don't pull the table-formatter into a scanner. */
function formatBytesShort(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
}
