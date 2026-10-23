// src/scanners/spotlight.ts
// Spotlight index bloat. There are two distinct piles, and people confuse them:
//
//   1. ~/Library/Metadata/CoreSpotlight/
//        User-level metadata Spotlight builds for "Suggested" search results,
//        notifications, and the Knowledge graph. Folders here regularly grow
//        to 10–100 GB on dev machines, especially these subdirs:
//          - Priority/
//          - NSFileProtectionCompleteUntilFirstUserAuthentication/
//          - SpotlightKnowledgeEvents/
//        Safe to delete from a normal terminal session (it's all under
//        ~/Library). The system rebuilds what it actually needs; expect CPU
//        + battery use for a few hours after.
//
//   2. /.Spotlight-V100 / /System/Volumes/Data/.Spotlight-V100
//        The actual file-content index at the volume root. Root-owned and
//        SIP-protected — `rm -rf` from a normal session will fail. Real
//        cleanup requires either `sudo mdutil -E /` (rebuild) or booting
//        into Recovery and deleting the folder. We report the size for
//        visibility but offer no clean command, just a pointer to the
//        Recovery-mode procedure in `optimize`.
//
// On top of that we read `mdutil -s /` to surface whether indexing is even
// enabled — if it's already off, all of these are inert and we skip emitting
// any "this is consuming space" rows.

import { $ } from "bun";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CleanTarget } from "../lib/types.ts";
import { pathSize, pathExists, expandHome, shellQuote } from "../lib/utils.ts";

/**
 * Like `pathSize`, but distinguishes "0 bytes" from "permission denied".
 *
 * `~/Library/Metadata/CoreSpotlight` and `/.Spotlight-V100` are both TCC /
 * SIP protected on modern macOS — a normal terminal session gets
 * "Operation not permitted" from `du`, which our `pathSize` swallows and
 * returns 0. That made the scanner emit nothing, which is misleading when
 * the actual on-disk pile is multi-GB.
 *
 * Returns:
 *   { size: N }                          — normal case
 *   { denied: true }                     — TCC / SIP refused us
 *   { size: 0 }                          — really empty
 */
async function probeSize(p: string): Promise<{ size: number; denied?: boolean }> {
  const expanded = expandHome(p);
  if (!pathExists(expanded)) return { size: 0 };

  const result = await $`du -sk ${expanded}`.quiet().nothrow();
  const stderr = result.stderr.toString();
  const stdout = result.stdout.toString().trim();

  if (/operation not permitted|permission denied/i.test(stderr) && !stdout) {
    return { size: 0, denied: true };
  }

  const firstField = stdout.split(/\s+/)[0];
  const kb = parseInt(firstField ?? "0", 10);
  return { size: Number.isFinite(kb) && kb > 0 ? kb * 1024 : 0 };
}

/**
 * Whether Spotlight indexing is currently on for the boot volume.
 *
 * `mdutil -s /` prints one of:
 *   "Indexing enabled."        → true
 *   "Indexing disabled."       → false
 *   "Indexing and searching disabled." → false
 *
 * Any other output (e.g. permission denied on a sandboxed runner) returns
 * `true` so we err on the side of showing the user the rows — better to
 * show a deletable target than to silently hide it.
 */
async function indexingEnabled(): Promise<boolean> {
  const result = await $`mdutil -s /`.quiet().nothrow();
  const out = result.stdout.toString().toLowerCase();
  if (!out) return true;
  if (out.includes("disabled")) return false;
  return true;
}

/**
 * Largest immediate children of ~/Library/Metadata/CoreSpotlight. Reported
 * separately so the user can nuke just the worst offender (e.g. `Priority`)
 * without forcing a full re-index of everything.
 */
async function coreSpotlightSubdirs(root: string, minBytes: number): Promise<CleanTarget[]> {
  const out: CleanTarget[] = [];
  const expanded = expandHome(root);

  let entries: string[];
  try {
    entries = readdirSync(expanded);
  } catch {
    return out;
  }

  for (const name of entries) {
    const full = join(expanded, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const size = await pathSize(full);
    if (size < minBytes) continue;

    out.push({
      label: `Spotlight ${name}`,
      path: full,
      size,
      risk: "caution",
      description: `Bloated CoreSpotlight subindex. Safe to delete, but Spotlight will reindex (CPU + battery) for a few hours.`,
      rebuildCost: "Background re-index; brief search outage",
      category: "system",
      cleanCommand: `rm -rf ${shellQuote(full)}`,
    });
  }
  return out;
}

export async function scanSpotlight(): Promise<CleanTarget[]> {
  const targets: CleanTarget[] = [];

  const enabled = await indexingEnabled();

  // The user-level CoreSpotlight metadata pile. We report the parent as a
  // single row only when indexing is OFF (in which case it's pure waste, the
  // system isn't using it); when indexing is ON we instead surface the
  // largest subdirs so the user can target the bloated one without nuking
  // the smaller ones.
  const userMeta = "~/Library/Metadata/CoreSpotlight";
  if (pathExists(userMeta)) {
    const probe = await probeSize(userMeta);
    if (probe.denied) {
      // Couldn't measure it because TCC blocks `du` from non-Full-Disk-Access
      // shells. Emit a -1 sentinel row so the user still sees it exists and
      // gets pointed at the fix. `size: -1` is rendered as "—" by the CLI.
      targets.push({
        label: "CoreSpotlight metadata (size hidden by TCC)",
        path: userMeta,
        size: -1,
        risk: "caution",
        description: "macOS won't let your terminal `du` this folder. Grant your terminal Full Disk Access (System Settings → Privacy & Security → Full Disk Access) and re-run, or open it in GrandPerspective to check size.",
        rebuildCost: "Background re-index after cleanup",
        category: "system",
      });
    } else if (probe.size > 0) {
      if (!enabled) {
        targets.push({
          label: "CoreSpotlight metadata (indexing disabled)",
          path: userMeta,
          size: probe.size,
          risk: "safe",
          description: "Spotlight indexing is OFF on this Mac, so the whole CoreSpotlight pile is dead weight.",
          rebuildCost: "None — indexing is disabled",
          category: "system",
          cleanCommand: `rm -rf ${shellQuote(expandHome(userMeta))}`,
        });
      } else {
        // Show subdirs >= 250 MB. Threshold prevents flooding the report
        // with tiny housekeeping folders that aren't worth a re-index.
        const subdirs = await coreSpotlightSubdirs(userMeta, 250 * 1024 * 1024);
        targets.push(...subdirs);
      }
    }
  }

  // The volume-level on-disk index. Root-owned, SIP-protected, and the path
  // varies by macOS layout (boot vs Data volume).
  //
  // We report the FIRST one we find — even when `du` is denied — so the row
  // surfaces in the report. No cleanCommand: deletion needs Recovery Mode
  // (covered by `optimize`).
  const volumeIndexCandidates = [
    "/System/Volumes/Data/.Spotlight-V100",
    "/.Spotlight-V100",
  ];
  for (const candidate of volumeIndexCandidates) {
    if (!pathExists(candidate)) continue;
    const probe = await probeSize(candidate);
    const reportedSize = probe.denied ? -1 : probe.size;
    if (!probe.denied && probe.size <= 0) continue;
    targets.push({
      label: probe.denied
        ? "Spotlight volume index (.Spotlight-V100) — size hidden by SIP"
        : "Spotlight volume index (.Spotlight-V100)",
      path: candidate,
      size: reportedSize,
      risk: "risky",
      description: probe.denied
        ? "SIP-protected so we can't `du` it. Use GrandPerspective (as admin) or check via Recovery Mode. Deletion also requires Recovery."
        : "Volume-level Spotlight index. Root-owned + SIP-protected — needs Recovery Mode to delete. See `macreaper optimize`.",
      rebuildCost: "Full re-index (hours, heavy CPU)",
      category: "system",
    });
    break;
  }

  return targets;
}
