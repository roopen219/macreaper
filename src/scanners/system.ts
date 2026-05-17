// src/scanners/system.ts
// macOS system-level space hogs: caches, logs, Time Machine local snapshots,
// iOS device backups, old installer DMGs, the Downloads folder, plus the
// "Mac-only" piles most users forget about — leftover macOS installer apps,
// GarageBand/Logic sound libraries, Apple Loops, Mail Downloads, and the
// downloaded Enhanced/Premium text-to-speech voices.
//
// Also covers the root-owned piles you only find with GrandPerspective:
//   /Library/Updates                 — pre-downloaded Software Update .pkg payloads
//   /Library/Caches                  — system-wide application caches
//   /Library/Logs                    — system-wide application logs
//   /private/var/db/diagnostics      — unified logging (tracev3) archives
//   /private/var/folders/.../C/      — DARWIN_USER_CACHE_DIR per-user cache

import { $ } from "bun";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CleanTarget } from "../lib/types.ts";
import { pathSize, pathExists, shellQuote } from "../lib/utils.ts";

export async function scanSystem(): Promise<CleanTarget[]> {
  const targets: CleanTarget[] = [];

  // User-library caches: usually safe, apps rebuild them. Can grow huge for
  // streaming apps, browsers, communication apps.
  const userCaches = "~/Library/Caches";
  if (pathExists(userCaches)) {
    const size = await pathSize(userCaches);
    if (size > 0) {
      targets.push({
        label: "User application caches",
        path: userCaches,
        size,
        risk: "safe",
        description: "Per-app cache folders. Apps rebuild what they need; this can reclaim a lot from browsers + chat apps.",
        rebuildCost: "Apps re-cache on next use",
        category: "system",
      });
    }
  }

  // User logs.
  const userLogs = "~/Library/Logs";
  if (pathExists(userLogs)) {
    const size = await pathSize(userLogs);
    if (size > 0) {
      targets.push({
        label: "User application logs",
        path: userLogs,
        size,
        risk: "safe",
        description: "Log files written by apps. Useful for debugging but otherwise disposable.",
        rebuildCost: "None — apps just write new logs going forward",
        category: "system",
      });
    }
  }

  // iOS device backups — often forgotten and huge (full device images).
  const iosBackups = "~/Library/Application Support/MobileSync/Backup";
  if (pathExists(iosBackups)) {
    const size = await pathSize(iosBackups);
    if (size > 0) {
      targets.push({
        label: "iOS/iPadOS device backups",
        path: iosBackups,
        size,
        risk: "risky",
        description: "Full backups of iPhones/iPads ever connected to this Mac. Review individually in Finder before deleting.",
        rebuildCost: "Cannot be regenerated without the device + re-running a backup",
        category: "system",
      });
    }
  }

  // Downloads folder — almost always has forgotten DMGs/installers.
  const downloads = "~/Downloads";
  if (pathExists(downloads)) {
    const size = await pathSize(downloads);
    if (size > 0) {
      targets.push({
        label: "Downloads folder",
        path: downloads,
        size,
        risk: "risky",
        description: "Your Downloads folder. Often the easiest win — but only you know what's still needed.",
        rebuildCost: "Cannot recover specific files; re-download from original sources",
        category: "user",
      });
    }
  }

  // Time Machine local snapshots. These show up as "purgeable" in Finder and
  // are usually invisible to users. macOS *should* auto-delete them under
  // pressure, but sometimes doesn't.
  const snapshots = await listLocalSnapshots();
  if (snapshots.length > 0) {
    targets.push({
      label: `Time Machine local snapshots (${snapshots.length})`,
      path: "(APFS snapshots — managed by tmutil)",
      size: -1, // unknown without diskutil deep-dive
      risk: "safe",
      description: `${snapshots.length} hourly APFS snapshots on the boot volume. macOS counts these as "available" space but they can still cause cleanup messages.`,
      rebuildCost: "None — these are restore points only useful in the last 24h",
      cleanCommand: "macreaper-internal-delete-snapshots",
      category: "system",
    });
  }

  // ── Mac-specific "unused features" ────────────────────────────────────────

  // Leftover full-OS installer apps in /Applications. macOS upgrades land here
  // as "Install macOS Sequoia.app" / "Install macOS Tahoe.app" etc. (~12-15 GB
  // each) and most users never delete them after the upgrade completes. The
  // installer also reappears whenever Software Update pre-stages an update.
  for (const installer of findMacOSInstallers()) {
    const size = await pathSize(installer);
    if (size > 0) {
      targets.push({
        label: `macOS installer: ${installer.split("/").pop()}`,
        path: installer,
        size,
        risk: "caution",
        description: "Full macOS installer app left in /Applications after an OS upgrade. Safe to delete once you've finished the install; can be re-downloaded from Software Update if needed.",
        rebuildCost: "Re-download from System Settings → Software Update (~12 GB)",
        category: "system",
      });
    }
  }

  // Mail Downloads — every attachment you've ever previewed in Mail. Both the
  // current (sandboxed) and legacy (pre-Mavericks) locations: upgraders often
  // still have the old one sitting around.
  const mailDownloads = [
    {
      label: "Mail Downloads (current)",
      path: "~/Library/Containers/com.apple.mail/Data/Library/Mail Downloads",
      desc: "Attachments auto-saved when you preview them in Mail. Mail does not delete these on its own.",
    },
    {
      label: "Mail Downloads (legacy)",
      path: "~/Library/Mail Downloads",
      desc: "Pre-Mavericks Mail attachments cache. Often stale and forgotten after macOS upgrades.",
    },
  ];
  for (const md of mailDownloads) {
    if (!pathExists(md.path)) continue;
    const size = await pathSize(md.path);
    if (size === 0) continue;
    targets.push({
      label: md.label,
      path: md.path,
      size,
      risk: "caution",
      description: md.desc,
      rebuildCost: "Originals still on your mail server — re-fetched if you open the message again",
      category: "user",
    });
  }

  // GarageBand & Logic Pro sound libraries / Apple Loops. These are the
  // single biggest "set it up once, never touch again" download on a Mac
  // (up to ~32 GB of loops + several GB of instruments). If you don't make
  // music, they are pure dead weight.
  const audioLibraries = [
    {
      label: "GarageBand sound library (user)",
      path: "~/Library/Application Support/GarageBand",
      desc: "Downloaded GarageBand instruments. Safe to remove if you don't use GarageBand; the app will offer to re-download on next launch.",
    },
    {
      label: "Logic Pro sound library (user)",
      path: "~/Library/Application Support/Logic",
      desc: "Logic Pro instrument content. Re-downloadable from Logic → Sound Library → Download All Available Sounds.",
    },
    {
      label: "Apple Loops (system-wide)",
      path: "/Library/Audio/Apple Loops",
      desc: "Apple Loops shared across GarageBand and Logic. Often 10+ GB and rarely touched outside music production.",
    },
    {
      label: "GarageBand content (system-wide)",
      path: "/Library/Application Support/GarageBand",
      desc: "Shared GarageBand jam packs & lessons. Re-downloadable from GarageBand → Sound Library.",
    },
    {
      label: "Logic content (system-wide)",
      path: "/Library/Application Support/Logic",
      desc: "Shared Logic content. Re-downloadable from Logic → Sound Library.",
    },
  ];
  for (const a of audioLibraries) {
    if (!pathExists(a.path)) continue;
    const size = await pathSize(a.path);
    if (size === 0) continue;
    targets.push({
      label: a.label,
      path: a.path,
      size,
      risk: "caution",
      description: a.desc,
      rebuildCost: "Re-downloadable from GarageBand/Logic's Sound Library (multi-GB download)",
      category: "user",
    });
  }

  // Downloaded text-to-speech voices (Enhanced / Premium / Siri voices).
  // System Settings → Accessibility → Spoken Content lets you add these and
  // each one can be 500 MB – 2 GB. They're rarely audited.
  const voicePaths = [
    "~/Library/Speech/Voices",
    "/Library/Speech/Voices",
  ];
  for (const v of voicePaths) {
    if (!pathExists(v)) continue;
    const size = await pathSize(v);
    if (size === 0) continue;
    targets.push({
      label: `Downloaded TTS voices (${v.startsWith("~") ? "user" : "system"})`,
      path: v,
      size,
      risk: "caution",
      description: "Enhanced/Premium/Siri voices downloaded via System Settings → Accessibility → Spoken Content. Safe to delete individually from that panel; re-downloadable any time.",
      rebuildCost: "Re-download from System Settings → Accessibility → Spoken Content → System Voice → Manage Voices",
      category: "user",
    });
  }

  // ── Root-owned macOS internals (need sudo to clean) ───────────────────────
  // These are the categories that only show up in GrandPerspective because
  // they live outside ~ and the system never volunteers their size. Each
  // cleanCommand uses sudo because the dirs are root-owned (the dev/system
  // command path in cli.ts will prompt the user for their password when sudo
  // first runs).

  // Pending macOS / Xcode CLI Tools updates pre-downloaded by softwareupdated.
  // After install they sometimes hang around (Apple's softwareupdated daemon
  // is supposed to clean up but doesn't always). Each subdirectory is one
  // update payload; the .plist index files at the root should be preserved.
  for (const updateDir of listUpdatesSubdirs()) {
    const size = await pathSize(updateDir);
    if (size === 0) continue;
    const id = updateDir.split("/").pop() ?? "(unknown)";
    targets.push({
      label: `Pending Software Update: ${id}`,
      path: updateDir,
      size,
      risk: "caution",
      description:
        "Leftover macOS / Xcode CLI Tools update payload pre-downloaded by softwareupdated. " +
        "Safe to remove once the update is installed (or if you've decided to skip it); " +
        "softwareupdated will re-download on demand if you change your mind.",
      rebuildCost: "Re-downloaded by Software Update on next check",
      category: "system",
      cleanCommand: `sudo rm -rf ${shellQuote(updateDir)}`,
    });
  }

  // Unified logging archives (Special / Persist / Signpost / HighVolume).
  // logd auto-rotates and *should* target ~520 MB but on broken installs (or
  // after long uptime) this can balloon to multiple GB. We surface it with
  // caution risk and an honest description so the user can make the call —
  // Apple's official guidance is "don't delete this".
  const diagnostics = "/private/var/db/diagnostics";
  if (pathExists(diagnostics)) {
    const size = await pathSize(diagnostics);
    if (size > 0) {
      targets.push({
        label: "Unified logging archives (tracev3)",
        path: diagnostics,
        size,
        risk: "caution",
        description:
          "macOS unified-log binary archives written by logd. logd targets ~520 MB total via " +
          "automatic attrition, but a runaway logger can push it into multiple GB. Important: this " +
          "directory holds Time Machine backup reports + XProtect Remediator malware-scan records + " +
          "system error history; Apple's stance is don't manually delete. If you must, use the " +
          "sanctioned 'log erase --all' which resets the database cleanly.",
        rebuildCost: "Loses recent system error history & XProtect/Time Machine records; logd rebuilds storage on next event",
        category: "system",
        cleanCommand: "sudo log erase --all",
      });
    }
  }

  // System-wide /Library/Caches — distinct from ~/Library/Caches. Safe to
  // wipe contents (apps regenerate), keep the directory itself.
  if (pathExists("/Library/Caches")) {
    const size = await pathSize("/Library/Caches");
    if (size > 0) {
      targets.push({
        label: "System application caches (/Library/Caches)",
        path: "/Library/Caches",
        size,
        risk: "safe",
        description:
          "System-wide cache directory used by apps installed for all users (Adobe, Microsoft Office, " +
          "various installers, etc.). Separate from ~/Library/Caches. Apps regenerate on next launch.",
        rebuildCost: "Apps re-cache on next launch",
        category: "system",
        cleanCommand: "sudo find /Library/Caches -mindepth 1 -delete",
      });
    }
  }

  // System-wide /Library/Logs — distinct from ~/Library/Logs.
  if (pathExists("/Library/Logs")) {
    const size = await pathSize("/Library/Logs");
    if (size > 0) {
      targets.push({
        label: "System application logs (/Library/Logs)",
        path: "/Library/Logs",
        size,
        risk: "safe",
        description: "System-wide log directory (DiagnosticReports + various daemons). Disposable.",
        rebuildCost: "Daemons write fresh logs going forward",
        category: "system",
        cleanCommand: "sudo find /Library/Logs -type f -delete",
      });
    }
  }

  // DARWIN_USER_CACHE_DIR — the per-user macOS cache hidden under
  // /private/var/folders/<hashprefix>/<userhash>/C/. Persists across reboots
  // and only cleared on a safe boot otherwise. Owned by the user, so no sudo.
  const darwinCache = await getDarwinUserCacheDir();
  if (darwinCache && pathExists(darwinCache)) {
    const size = await pathSize(darwinCache);
    if (size > 0) {
      targets.push({
        label: "Per-user macOS cache (DARWIN_USER_CACHE_DIR)",
        path: darwinCache,
        size,
        risk: "safe",
        description:
          "The 'C' subdir under your per-user temp container in /private/var/folders. " +
          "macOS only clears this on safe boot, otherwise it persists. Caches inside are app-owned " +
          "and rebuild on demand.",
        rebuildCost: "Apps re-cache as needed (slightly slower first launches)",
        category: "system",
      });
    }
  }

  // Apple System Log (asl) archives — legacy /private/var/log/asl/. Modern
  // macOS routes most logs through unified logging, but asl files still
  // accumulate on systems that have been upgraded across major versions.
  if (pathExists("/private/var/log/asl")) {
    const size = await pathSize("/private/var/log/asl");
    if (size > 0) {
      targets.push({
        label: "Apple System Log archives (asl)",
        path: "/private/var/log/asl",
        size,
        risk: "safe",
        description: "Legacy Apple System Log archives. Largely superseded by unified logging on modern macOS but still written by some daemons.",
        rebuildCost: "None — logs continue going forward",
        category: "system",
        cleanCommand: "sudo find /private/var/log/asl -type f -name '*.asl' -delete",
      });
    }
  }

  return targets;
}

/** List each subdirectory of /Library/Updates (each = one pending update payload). */
function listUpdatesSubdirs(): string[] {
  const root = "/Library/Updates";
  if (!pathExists(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return [];
  }
}

/** Resolve $DARWIN_USER_CACHE_DIR via getconf — it's per-user and hash-based. */
async function getDarwinUserCacheDir(): Promise<string | null> {
  const r = await $`getconf DARWIN_USER_CACHE_DIR`.quiet().nothrow();
  if (r.exitCode !== 0) return null;
  const out = r.stdout.toString().trim();
  // getconf returns a trailing slash; strip for consistency.
  return out.length > 0 ? out.replace(/\/+$/, "") : null;
}


/**
 * Scan /Applications for "Install macOS *.app" bundles. Done by directory
 * listing rather than glob because /Applications can contain ACL-protected
 * entries that throw on stat.
 */
function findMacOSInstallers(): string[] {
  const apps = "/Applications";
  try {
    return readdirSync(apps)
      .filter((name) => /^Install macOS .+\.app$/.test(name))
      .map((name) => join(apps, name))
      .filter((p) => pathExists(p));
  } catch {
    return [];
  }
}

/** List Time Machine local snapshots on /. Returns the snapshot date strings. */
export async function listLocalSnapshots(): Promise<string[]> {
  const result = await $`tmutil listlocalsnapshots /`.quiet().nothrow();
  if (result.exitCode !== 0) return [];
  return result.stdout
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("com.apple.TimeMachine."))
    // tmutil prints lines like "com.apple.TimeMachine.2026-05-15-103022.local"
    // — we want the date portion "2026-05-15-103022" to pass to deletelocalsnapshots.
    .map((s) => {
      const m = s.match(/com\.apple\.TimeMachine\.([\d-]+)/);
      return m ? m[1]! : "";
    })
    .filter((s) => s.length > 0);
}

/** Delete all local TM snapshots. Requires sudo on some macOS versions. */
export async function deleteLocalSnapshots(dates: string[]): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (const d of dates) {
    const r = await $`tmutil deletelocalsnapshots ${d}`.quiet().nothrow();
    if (r.exitCode === 0) deleted++;
    else failed++;
  }
  return { deleted, failed };
}
