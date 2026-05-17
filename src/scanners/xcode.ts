// src/scanners/xcode.ts
// Apple-developer caches — easily the largest single bucket on a Mac with
// Xcode installed. iOS Simulator runtimes + device data + old DeviceSupport
// directories routinely add up to 30-60 GB and almost never need to be kept.
//
// We classify these as the "dev" category so they show up in `macreaper dev`
// alongside Node/Docker/etc.

import type { CleanTarget } from "../lib/types.ts";
import { pathSize, pathExists, isProcessRunning } from "../lib/utils.ts";

interface XcodeSpec {
  label: string;
  path: string;
  description: string;
  rebuildCost: string;
  cleanCommand?: string;
  /** If true, refuse to clean while Xcode is open. */
  guardXcode?: boolean;
}

const XCODE_PATHS: XcodeSpec[] = [
  {
    label: "Xcode DerivedData",
    path: "~/Library/Developer/Xcode/DerivedData",
    description: "Per-project build artifacts, indexes, and module caches. Xcode rebuilds these on the next build.",
    rebuildCost: "Slower next build; rebuilds incrementally after",
    guardXcode: true,
  },
  {
    label: "Xcode Archives",
    path: "~/Library/Developer/Xcode/Archives",
    description: "Distribution archives created when you Product → Archive. Keep what you've shipped; old prerelease archives are usually dead weight.",
    rebuildCost: "Cannot recover archived builds; re-archive from current source if needed",
  },
  {
    label: "Xcode iOS DeviceSupport",
    path: "~/Library/Developer/Xcode/iOS DeviceSupport",
    description: "Symbol bundles Xcode downloads the first time you debug against a real iPhone on a given iOS version. Hangs around forever after the OS is gone.",
    rebuildCost: "Re-downloads next time you attach a device on that iOS version",
  },
  {
    label: "Xcode watchOS DeviceSupport",
    path: "~/Library/Developer/Xcode/watchOS DeviceSupport",
    description: "watchOS symbol bundles for previously-attached Apple Watches.",
    rebuildCost: "Re-downloads on next watch debug session",
  },
  {
    label: "Xcode tvOS DeviceSupport",
    path: "~/Library/Developer/Xcode/tvOS DeviceSupport",
    description: "tvOS symbol bundles for previously-attached Apple TVs.",
    rebuildCost: "Re-downloads on next Apple TV debug session",
  },
  {
    label: "Xcode user data caches",
    path: "~/Library/Caches/com.apple.dt.Xcode",
    description: "Xcode's own cache directory — index search results, module verification, source-control checkouts.",
    rebuildCost: "Xcode rebuilds caches on next open",
    guardXcode: true,
  },
  {
    label: "iOS Simulator: unavailable runtimes",
    path: "(managed by simctl)",
    description: "Simulator devices whose iOS runtime is no longer installed. Pure dead weight — use the Apple-sanctioned `simctl` command to remove them.",
    rebuildCost: "None — these are devices you can no longer boot anyway",
    cleanCommand: "xcrun simctl delete unavailable",
  },
  {
    label: "iOS Simulator devices",
    path: "~/Library/Developer/CoreSimulator/Devices",
    description: "All the simulator devices Xcode has spun up (per-runtime data + installed apps). Can grow to 20+ GB if you've ever profiled a heavy app.",
    rebuildCost: "Re-created on demand when you boot a fresh simulator",
    guardXcode: true,
  },
  {
    label: "iOS Simulator caches",
    path: "~/Library/Developer/CoreSimulator/Caches",
    description: "dyld shared caches and other per-runtime simulator caches. Regenerated on first boot of each runtime.",
    rebuildCost: "Slower first boot per runtime; rebuilds automatically",
    guardXcode: true,
  },
  {
    label: "CoreSimulator logs",
    path: "~/Library/Logs/CoreSimulator",
    description: "Boot and runtime logs from every simulator session you've ever started. Disposable.",
    rebuildCost: "None — fresh logs accumulate as you use the simulator",
  },
];

export async function scanXcode(): Promise<CleanTarget[]> {
  // Bail entirely if Xcode and CoreSimulator are both absent — no point
  // running `du` against folders that don't exist on a non-dev Mac.
  const hasAnyXcodeDir = XCODE_PATHS.some((s) => pathExists(s.path));
  if (!hasAnyXcodeDir) return [];

  const xcodeOpen = await isProcessRunning("Xcode");
  const targets: CleanTarget[] = [];

  for (const s of XCODE_PATHS) {
    // The simctl entry is a virtual target (no folder to du). Always surface
    // it so users discover the prune option, even if we can't size it.
    if (s.cleanCommand === "xcrun simctl delete unavailable") {
      targets.push({
        label: s.label,
        path: s.path,
        size: -1,
        risk: "safe",
        description: s.description,
        rebuildCost: s.rebuildCost,
        cleanCommand: s.cleanCommand,
        category: "dev",
      });
      continue;
    }

    if (!pathExists(s.path)) continue;
    const size = await pathSize(s.path);
    if (size === 0) continue;

    targets.push({
      label: s.label,
      path: s.path,
      size,
      risk: "safe",
      description: s.description,
      rebuildCost: s.rebuildCost,
      cleanCommand: s.cleanCommand,
      category: "dev",
      guard: s.guardXcode
        ? async () => (xcodeOpen ? "Xcode is running — quit Xcode before cleaning this" : null)
        : undefined,
    });
  }

  return targets;
}
