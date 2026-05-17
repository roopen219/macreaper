// src/scanners/editors.ts
// IDE / code editor caches. The Electron-based editors (VS Code, Cursor) and
// JetBrains Toolbox are both notorious for hoarding old data:
//   - VS Code / Cursor: per-workspace state, GPU shader cache, CachedExtensionVSIXs
//   - VS Code / Cursor SQLite state DBs (state.vscdb): chat history, recents,
//     extension metadata. Routinely grow to multiple GB and never auto-VACUUM.
//     Their .backup siblings are full SQLite snapshots written before each
//     mutation — pure waste once the main DB has settled.
//   - JetBrains Toolbox: old IDE binaries kept for 3-day rollback, plus
//     per-version config/caches/logs for IDEs you no longer have installed
//   - Zed: a smaller offender but still has caches worth scanning
//
// JetBrains Toolbox 1.22+ has a built-in "Clean up leftover tool directories"
// feature (Settings → Tools). For the actually-old-IDE-version detection we
// recommend that path in optimize.ts rather than guessing here.

import { $ } from "bun";
import type { CleanTarget } from "../lib/types.ts";
import {
  scanCacheSpecs,
  type CacheSpec,
  isProcessRunning,
  pathExists,
  expandHome,
  safeStat,
  shellQuote,
  HOME,
  formatBytes,
} from "../lib/utils.ts";

const JETBRAINS: CacheSpec[] = [
  {
    label: "JetBrains IDE caches (all IDEs/versions)",
    path: "~/Library/Caches/JetBrains",
    description: "Indexes, local history, VFS, and shared caches across every JetBrains IDE you've used. Easily 5-20 GB if you've used IntelliJ + WebStorm + DataGrip. JetBrains auto-deletes caches & logs for IDEs not opened in 180 days, but anything newer stays forever.",
    rebuildCost: "Slower first project open after cleanup (re-indexes)",
  },
  {
    label: "JetBrains IDE logs",
    path: "~/Library/Logs/JetBrains",
    description: "Per-IDE log directories. Disposable.",
    rebuildCost: "None — fresh logs accumulate as you use the IDEs",
  },
  // Note: Toolbox 2.0+ installs IDEs into ~/Applications/ and manages backup
  // retention there (3-day default). The previous-version cleanup UI lives at
  // Settings → Tools → "Remove the previous versions". We don't try to scan
  // ~/Applications because it would conflate Toolbox-installed apps with
  // regular .app bundles; the optimize tip points users at the UI instead.
];

const VSCODE: CacheSpec[] = [
  {
    label: "VS Code caches",
    path: "~/Library/Caches/Code",
    description: "VS Code's main cache directory (network cache, shader cache, code cache).",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "VS Code CachedExtensionVSIXs",
    path: "~/Library/Application Support/Code/CachedExtensionVSIXs",
    description: "Downloaded .vsix files retained after installing extensions.",
    rebuildCost: "Re-downloads VSIX on next extension update",
  },
  {
    label: "VS Code CachedData",
    path: "~/Library/Application Support/Code/CachedData",
    description: "Precompiled JS bytecode for VS Code's renderer process.",
    rebuildCost: "Slower first launch after cleanup",
  },
  {
    label: "VS Code Code Cache",
    path: "~/Library/Application Support/Code/Code Cache",
    description: "Electron HTTP cache for the renderer process.",
    rebuildCost: "Rebuilds automatically",
  },
  {
    label: "VS Code GPUCache",
    path: "~/Library/Application Support/Code/GPUCache",
    description: "GPU shader cache used by Electron.",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "VS Code logs",
    path: "~/Library/Application Support/Code/logs",
    description: "Per-session log directories. Disposable.",
    rebuildCost: "None — fresh logs each session",
  },
  {
    label: "VS Code workspaceStorage",
    path: "~/Library/Application Support/Code/User/workspaceStorage",
    description: "Per-workspace state (open tabs, undo history, extension state). Often the biggest VS Code dir — never auto-cleans.",
    rebuildCost: "Loses open-tabs/undo history per workspace; settings & extensions preserved",
    risk: "caution",
  },
];

const CURSOR: CacheSpec[] = [
  {
    label: "Cursor caches",
    path: "~/Library/Caches/Cursor",
    description: "Cursor's main cache directory (network cache, shader cache, code cache).",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "Cursor CachedExtensionVSIXs",
    path: "~/Library/Application Support/Cursor/CachedExtensionVSIXs",
    description: "Downloaded .vsix files retained after installing extensions.",
    rebuildCost: "Re-downloads VSIX on next extension update",
  },
  {
    label: "Cursor CachedData",
    path: "~/Library/Application Support/Cursor/CachedData",
    description: "Precompiled JS bytecode for Cursor's renderer process.",
    rebuildCost: "Slower first launch after cleanup",
  },
  {
    label: "Cursor Code Cache",
    path: "~/Library/Application Support/Cursor/Code Cache",
    description: "Electron HTTP cache for the renderer process.",
    rebuildCost: "Rebuilds automatically",
  },
  {
    label: "Cursor GPUCache",
    path: "~/Library/Application Support/Cursor/GPUCache",
    description: "GPU shader cache used by Electron.",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "Cursor logs",
    path: "~/Library/Application Support/Cursor/logs",
    description: "Per-session log directories. Disposable.",
    rebuildCost: "None — fresh logs each session",
  },
  {
    label: "Cursor workspaceStorage",
    path: "~/Library/Application Support/Cursor/User/workspaceStorage",
    description: "Per-workspace state for every Cursor project you've opened. Frequently the largest Cursor dir (10s of GB) and never auto-cleans.",
    rebuildCost: "Loses open-tabs/undo history per workspace; settings & extensions preserved",
    risk: "caution",
  },
];

const ZED: CacheSpec[] = [
  {
    label: "Zed cache",
    path: "~/Library/Caches/dev.zed.Zed",
    description: "Zed's network/code cache.",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "Zed logs",
    path: "~/Library/Logs/Zed",
    description: "Zed's log directory.",
    rebuildCost: "None",
  },
];

// Roots under which we look for state.vscdb / state.vscdb.backup. Both
// globalStorage/ and workspaceStorage/<hash>/ live below User/.
const STATE_DB_ROOTS: { editor: "Cursor" | "Visual Studio Code"; root: string }[] = [
  { editor: "Cursor", root: "~/Library/Application Support/Cursor/User" },
  { editor: "Visual Studio Code", root: "~/Library/Application Support/Code/User" },
  { editor: "Visual Studio Code", root: "~/Library/Application Support/Code - Insiders/User" },
];

interface BackupHit { path: string; size: number }

/** Find every state.vscdb.backup under the User dirs of Cursor + VS Code. */
async function findStateDbBackups(): Promise<BackupHit[]> {
  const hits: BackupHit[] = [];
  for (const { root } of STATE_DB_ROOTS) {
    if (!pathExists(root)) continue;
    const expanded = expandHome(root);
    // `find … -type f -name …` has no grouping parens, so Bun's $ handles it.
    const r = await $`find ${expanded} -type f -name state.vscdb.backup`.quiet().nothrow();
    const stdout = r.stdout.toString().trim();
    if (!stdout) continue;
    for (const line of stdout.split("\n")) {
      const stat = safeStat(line);
      if (stat?.isFile()) hits.push({ path: line, size: stat.size });
    }
  }
  return hits.sort((a, b) => b.size - a.size);
}

/** state.vscdb.backup: pure SQLite snapshots, freely deletable.
 *  Returned as one aggregate CleanTarget so they don't drown the table. */
async function scanStateDbBackups(): Promise<CleanTarget[]> {
  const hits = await findStateDbBackups();
  if (hits.length === 0) return [];

  const total = hits.reduce((s, h) => s + h.size, 0);
  if (total === 0) return [];

  const top = hits
    .slice(0, 3)
    .map((h) => `${formatBytes(h.size)} at ${h.path.replace(HOME, "~")}`)
    .join("; ");

  // Delete via per-root `find -delete` so we don't have to enumerate every
  // path in the shell command. Skip roots that don't exist.
  const deleteCommands = STATE_DB_ROOTS
    .filter(({ root }) => pathExists(root))
    .map(({ root }) => `find ${shellQuote(expandHome(root))} -type f -name state.vscdb.backup -delete`)
    .join(" && ");

  return [{
    label: `Cursor / VS Code state.vscdb.backup files (${hits.length} files)`,
    path: "Cursor + VS Code User/{globalStorage,workspaceStorage}",
    size: total,
    risk: "safe",
    description: `SQLite snapshots Cursor and VS Code write right before mutating the main state.vscdb. The editor recreates the .backup on its next DB write, so deletion is free. Largest: ${top}.`,
    rebuildCost: "Editor recreates each .backup on its next write to state.vscdb",
    category: "dev",
    cleanCommand: deleteCommands,
  }];
}

/** Bloated state.vscdb itself — never delete, always VACUUM in place. */
async function scanBloatedStateDbs(): Promise<CleanTarget[]> {
  // Only the GLOBAL state DBs (chat history, recents) actually balloon.
  // workspaceStorage state DBs stay small per workspace.
  const dbs = [
    { label: "Cursor state.vscdb", editor: "Cursor" as const, path: "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb" },
    { label: "VS Code state.vscdb", editor: "Visual Studio Code" as const, path: "~/Library/Application Support/Code/User/globalStorage/state.vscdb" },
  ];

  const out: CleanTarget[] = [];
  for (const db of dbs) {
    if (!pathExists(db.path)) continue;
    const stat = safeStat(db.path);
    if (!stat?.isFile()) continue;
    // Threshold: 500 MB. Below that VACUUM usually reclaims <50 MB.
    if (stat.size < 500 * 1024 * 1024) continue;

    const expanded = expandHome(db.path);
    out.push({
      label: `${db.label} (run VACUUM — never delete)`,
      path: db.path,
      size: stat.size,
      risk: "caution",
      description:
        `SQLite database storing ${db.editor}'s chat history, agent state, workspace recents, and ` +
        `extension metadata. ${db.editor} never VACUUMs it — deleted rows sit as dead pages forever, ` +
        `so the file grows monotonically. Cleanup here runs 'sqlite3 ... VACUUM;' in place, which ` +
        `typically reclaims 50-90% on a bloated DB. NEVER delete the file: you'll lose your entire ` +
        `chat history and workspace recents.`,
      rebuildCost: "None — VACUUM is in-place, all chat history & state are preserved",
      category: "dev",
      cleanCommand: `sqlite3 ${shellQuote(expanded)} 'VACUUM;'`,
      guard: async () =>
        (await isProcessRunning(db.editor))
          ? `${db.editor} is running — quit it completely before VACUUMing (SQLite needs an exclusive lock)`
          : null,
    });
  }
  return out;
}

export async function scanEditors(): Promise<CleanTarget[]> {
  // Guards: refuse to nuke caches of editors that are actively running.
  const vscodeRunning = await isProcessRunning("Visual Studio Code");
  const cursorRunning = await isProcessRunning("Cursor");
  // JetBrains processes are named per-IDE (idea, webstorm, etc.) so we don't
  // try to be precise — Caches/JetBrains is safe enough to clean live (the
  // IDE just re-reads it). We do guard Toolbox bin since that's binaries.
  const toolboxRunning = await isProcessRunning("JetBrains Toolbox");

  const guard = (name: string, running: boolean) =>
    async () => (running ? `${name} is running — quit it before cleaning this` : null);

  const withGuard = (specs: CacheSpec[], name: string, running: boolean): CacheSpec[] =>
    specs.map((s) => ({ ...s, guard: guard(name, running) }));

  const [jb, code, cursor, zed, stateBackups, bloatedStateDbs] = await Promise.all([
    scanCacheSpecs(
      JETBRAINS.map((s) =>
        s.path.includes("Toolbox/bin") && toolboxRunning
          ? { ...s, guard: guard("JetBrains Toolbox", true) }
          : s,
      ),
      "dev",
    ),
    scanCacheSpecs(withGuard(VSCODE, "VS Code", vscodeRunning), "dev"),
    scanCacheSpecs(withGuard(CURSOR, "Cursor", cursorRunning), "dev"),
    scanCacheSpecs(ZED, "dev"),
    scanStateDbBackups(),
    scanBloatedStateDbs(),
  ]);

  return [...jb, ...code, ...cursor, ...zed, ...stateBackups, ...bloatedStateDbs];
}
