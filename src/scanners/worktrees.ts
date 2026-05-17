// src/scanners/worktrees.ts
// Cursor agent worktrees: each parallel agent gets its own git worktree at
// ~/.cursor/worktrees/<repo>/<worktree-id>/ — and per Cursor's docs each
// worktree gets its *own* node_modules (no symlinking), so a single repo
// with five agent worktrees easily duplicates 1-5 GB of node_modules.
//
// We enumerate every <repo>/<worktree-id> dir, size it, and surface each as a
// separate CleanTarget so the user can delete abandoned branches one at a
// time. We also report the very rare case of a parent ~/.cursor/worktrees
// dir without a recognised <repo>/<branch> layout, to surface size we'd
// otherwise miss.
//
// Reference: cursor.com/docs/configuration/worktrees

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CleanTarget } from "../lib/types.ts";
import { pathExists, pathSize, expandHome } from "../lib/utils.ts";

const WORKTREES_ROOT = "~/.cursor/worktrees";

interface WorktreeEntry {
  repo: string;
  branch: string;
  path: string;
  size: number;
  mtime: Date;
}

function listWorktrees(): WorktreeEntry[] {
  const root = expandHome(WORKTREES_ROOT);
  const out: WorktreeEntry[] = [];
  let repos: string[];
  try {
    repos = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  for (const repo of repos) {
    const repoDir = join(root, repo);
    let branches: string[];
    try {
      branches = readdirSync(repoDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const branch of branches) {
      const path = join(repoDir, branch);
      let mtime = new Date(0);
      try {
        mtime = statSync(path).mtime;
      } catch {
        // ignore — file may have vanished mid-scan
      }
      out.push({ repo, branch, path, size: 0, mtime });
    }
  }
  return out;
}

/** Format "3 days ago" / "2 months ago" — short and stable enough for a table. */
function ago(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 0) return "just now";
  const days = Math.floor(ms / 86_400_000);
  if (days < 1) return "today";
  if (days < 2) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.floor(months / 12)} yr ago`;
}

export async function scanWorktrees(): Promise<CleanTarget[]> {
  if (!pathExists(WORKTREES_ROOT)) return [];

  const entries = listWorktrees();
  if (entries.length === 0) return [];

  // Size each entry. These can be huge (full node_modules per worktree) so
  // parallel `du` is meaningfully faster than serial.
  const sized = await Promise.all(
    entries.map(async (e) => ({ ...e, size: await pathSize(e.path) })),
  );

  // Drop empty / vanished worktrees (size 0 means du returned nothing).
  const real = sized.filter((e) => e.size > 0);
  if (real.length === 0) return [];

  // Sort biggest first so the high-value targets show up at the top of the
  // overall scan output.
  real.sort((a, b) => b.size - a.size);

  return real.map((e) => ({
    label: `Cursor worktree: ${e.repo}/${e.branch} (${ago(e.mtime)})`,
    path: e.path,
    size: e.size,
    risk: "caution" as const,
    description: `Isolated git worktree for the '${e.branch}' branch of '${e.repo}'. Includes its own node_modules. Safe to delete if the agent run is done and you've merged or abandoned the branch. Use 'git worktree remove' from the repo to clean up the git metadata too, or delete the folder directly if the parent repo is gone.`,
    rebuildCost: "Re-created next time you spawn an agent on that branch — node_modules re-installed",
    category: "dev" as const,
  }));
}
