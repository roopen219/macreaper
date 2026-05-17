// src/scanners/languages.ts
// Other language toolchains: Python, Rust, Go, Homebrew.
//
// All of these have the same pattern: a global cache that's safe to clear
// because the tool will re-download on next use.

import { $ } from "bun";
import type { CleanTarget } from "../lib/types.ts";
import { pathSize, pathExists } from "../lib/utils.ts";

interface CacheSpec {
  label: string;
  path: string;
  description: string;
  rebuildCost: string;
  cleanCommand?: string;
}

const PYTHON: CacheSpec[] = [
  {
    label: "pip cache",
    path: "~/Library/Caches/pip",
    description: "pip's wheel cache. Re-downloads on next pip install.",
    rebuildCost: "Re-downloads wheels on next pip install",
    cleanCommand: "pip cache purge",
  },
  {
    label: "Poetry cache",
    path: "~/Library/Caches/pypoetry",
    description: "Poetry's package cache.",
    rebuildCost: "Re-downloads packages on next poetry install",
  },
  {
    label: "uv cache",
    path: "~/Library/Caches/uv",
    description: "uv (Astral) package cache — usually quite large because it caches aggressively.",
    rebuildCost: "Re-downloads packages on next uv install",
    cleanCommand: "uv cache clean",
  },
  {
    label: "Conda pkgs",
    path: "~/anaconda3/pkgs",
    description: "Conda's downloaded package archives. Distinct from environments.",
    rebuildCost: "Re-downloads packages on next conda install",
    cleanCommand: "conda clean -a -y",
  },
  {
    label: "Miniconda pkgs",
    path: "~/miniconda3/pkgs",
    description: "Miniconda's downloaded package archives.",
    rebuildCost: "Re-downloads packages on next conda install",
    cleanCommand: "conda clean -a -y",
  },
];

const RUST: CacheSpec[] = [
  {
    label: "Cargo registry cache",
    path: "~/.cargo/registry/cache",
    description: "Cargo's downloaded .crate files.",
    rebuildCost: "Re-downloads crates on next build",
  },
  {
    label: "Cargo registry src",
    path: "~/.cargo/registry/src",
    description: "Extracted crate sources. Cargo will re-extract from cache as needed.",
    rebuildCost: "Re-extracts from cache on next build",
  },
  {
    label: "Cargo git checkouts",
    path: "~/.cargo/git",
    description: "Git dependencies cargo has fetched.",
    rebuildCost: "Re-clones git deps on next build",
  },
];

const GO: CacheSpec[] = [
  {
    label: "Go build cache",
    path: "~/Library/Caches/go-build",
    description: "Compiled Go build artifacts. Safe — Go rebuilds on demand.",
    rebuildCost: "Slower next compile; rebuilds incrementally after",
    cleanCommand: "go clean -cache",
  },
  {
    label: "Go module cache",
    path: "~/go/pkg/mod",
    description: "Downloaded Go module sources. Read-only files — needs `go clean -modcache` to delete properly.",
    rebuildCost: "Re-downloads modules on next build",
    cleanCommand: "go clean -modcache",
  },
];

const HOMEBREW: CacheSpec[] = [
  {
    label: "Homebrew downloads",
    path: "~/Library/Caches/Homebrew",
    description: "Tarballs/bottles Homebrew has downloaded. Recommended: run `brew cleanup` which is safer.",
    rebuildCost: "Re-downloads bottles on next install/upgrade",
    cleanCommand: "brew cleanup -s --prune=all",
  },
  {
    label: "Homebrew downloads (alt path)",
    path: "~/Library/Caches/Homebrew/downloads",
    description: "Alternate Homebrew download cache location.",
    rebuildCost: "Re-downloads bottles on next install/upgrade",
  },
];

async function scanGroup(specs: CacheSpec[]): Promise<CleanTarget[]> {
  const targets: CleanTarget[] = [];
  for (const c of specs) {
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
      cleanCommand: c.cleanCommand,
      category: "dev",
    });
  }
  return targets;
}

export async function scanPython(): Promise<CleanTarget[]> {
  return scanGroup(PYTHON);
}

export async function scanRust(): Promise<CleanTarget[]> {
  return scanGroup(RUST);
}

export async function scanGo(): Promise<CleanTarget[]> {
  return scanGroup(GO);
}

export async function scanHomebrew(): Promise<CleanTarget[]> {
  const targets = await scanGroup(HOMEBREW);

  // Bonus: query `brew --cache` for the canonical path on this machine.
  // This catches non-default Homebrew prefixes (Apple Silicon vs Intel, etc.).
  const brewWhich = await $`which brew`.quiet().nothrow();
  if (brewWhich.exitCode === 0) {
    const cacheRes = await $`brew --cache`.quiet().nothrow();
    if (cacheRes.exitCode === 0) {
      const brewCachePath = cacheRes.stdout.toString().trim();
      // Only add if we don't already have it from the static list.
      const already = targets.some((t) => t.path.replace(/^~/, "") === brewCachePath.replace(/^~/, ""));
      if (!already && pathExists(brewCachePath)) {
        const size = await pathSize(brewCachePath);
        if (size > 0) {
          targets.push({
            label: "Homebrew cache (brew --cache)",
            path: brewCachePath,
            size,
            risk: "safe",
            description: "Resolved by `brew --cache` — the canonical cache path for your Homebrew install.",
            rebuildCost: "Re-downloads bottles on next install/upgrade",
            cleanCommand: "brew cleanup -s --prune=all",
            category: "dev",
          });
        }
      }
    }
  }
  return targets;
}
