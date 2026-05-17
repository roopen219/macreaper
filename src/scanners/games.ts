// src/scanners/games.ts
// Game libraries. Steam is far and away the biggest offender on developer
// Macs (anything you've ever played sits in steamapps/common forever), but
// we also catch Epic, GOG Galaxy, and the App Store-installed Apple Arcade
// games where they live.
//
// We enumerate Steam per-game so users can uninstall the giant 50 GB title
// they haven't played in two years without nuking the whole library.
//
// Path verified: ~/Library/Application Support/Steam/steamapps/common/<game>

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CleanTarget } from "../lib/types.ts";
import { pathExists, pathSize, expandHome } from "../lib/utils.ts";

const STEAM_COMMON = "~/Library/Application Support/Steam/steamapps/common";
const STEAM_SHADER_CACHE = "~/Library/Application Support/Steam/steamapps/shadercache";
const STEAM_DOWNLOADING = "~/Library/Application Support/Steam/steamapps/downloading";

function listSteamGames(): Array<{ name: string; path: string; mtime: Date }> {
  const root = expandHome(STEAM_COMMON);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const path = join(root, d.name);
        let mtime = new Date(0);
        try {
          mtime = statSync(path).mtime;
        } catch {
          /* ignore */
        }
        return { name: d.name, path, mtime };
      });
  } catch {
    return [];
  }
}

function ago(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days < 30) return `played ${days || "<1"} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `played ${months} mo ago`;
  return `played ${Math.floor(months / 12)} yr ago`;
}

export async function scanGames(): Promise<CleanTarget[]> {
  if (!pathExists(STEAM_COMMON)) return [];

  const games = listSteamGames();
  if (games.length === 0) return [];

  const sized = await Promise.all(
    games.map(async (g) => ({ ...g, size: await pathSize(g.path) })),
  );
  const real = sized.filter((g) => g.size > 0).sort((a, b) => b.size - a.size);

  const targets: CleanTarget[] = real.map((g) => ({
    label: `Steam game: ${g.name} (${ago(g.mtime)})`,
    path: g.path,
    size: g.size,
    risk: "caution" as const,
    description: `Installed Steam game. Saves usually live in Steam Cloud, but local mods/configs may be lost. Uninstalling via Steam (Library → right-click → Manage → Uninstall) is preferred over rm -rf because Steam tracks install state.`,
    rebuildCost: "Re-download from Steam (multi-GB; same install size)",
    category: "user" as const,
  }));

  // Aux dirs (shadercache and downloading remnants) — also surface so users
  // can clear those independently.
  if (pathExists(STEAM_SHADER_CACHE)) {
    const size = await pathSize(STEAM_SHADER_CACHE);
    if (size > 0) {
      targets.push({
        label: "Steam shader cache",
        path: STEAM_SHADER_CACHE,
        size,
        risk: "safe",
        description: "Per-game pre-compiled GPU shaders. Steam regenerates them as needed; first launch after deletion may stutter while shaders recompile.",
        rebuildCost: "Slower first launch per game until shaders recompile",
        category: "user",
      });
    }
  }
  if (pathExists(STEAM_DOWNLOADING)) {
    const size = await pathSize(STEAM_DOWNLOADING);
    if (size > 0) {
      targets.push({
        label: "Steam interrupted downloads",
        path: STEAM_DOWNLOADING,
        size,
        risk: "safe",
        description: "Partial downloads from interrupted Steam updates. Safe to clear; Steam re-fetches what's needed.",
        rebuildCost: "Re-downloaded on next update",
        category: "user",
      });
    }
  }

  return targets;
}
