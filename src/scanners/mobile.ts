// src/scanners/mobile.ts
// Mobile / cross-platform toolchain caches: CocoaPods, Swift Package Manager,
// Carthage, Flutter/Dart, and the Android SDK. The Android SDK system images
// + AVDs are particularly heavy (each AVD snapshot can be multi-GB).

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CleanTarget } from "../lib/types.ts";
import { scanCacheSpecs, type CacheSpec, pathExists, pathSize, expandHome } from "../lib/utils.ts";

const MOBILE_CACHES: CacheSpec[] = [
  // ── iOS ecosystem ──────────────────────────────────────────────────────
  {
    label: "CocoaPods cache",
    path: "~/Library/Caches/CocoaPods",
    description: "Downloaded pod source archives and shared spec repos.",
    rebuildCost: "Re-downloads on next `pod install`",
    cleanCommand: "pod cache clean --all 2>/dev/null || true",
  },
  {
    label: "Swift Package Manager cache",
    path: "~/Library/Caches/org.swift.swiftpm",
    description: "Global SPM repository cache used to dedupe clones across packages.",
    rebuildCost: "Re-clones package repos on next resolve",
    cleanCommand: "swift package purge-cache 2>/dev/null || true",
  },
  {
    label: "Carthage cache",
    path: "~/Library/Caches/org.carthage.CarthageKit",
    description: "Carthage's downloaded binary frameworks and build cache.",
    rebuildCost: "Re-downloads frameworks on next `carthage update`",
  },

  // ── Flutter / Dart ──────────────────────────────────────────────────────
  {
    label: "Dart/Flutter pub cache",
    path: "~/.pub-cache",
    description: "Every Dart/Flutter package version your projects have ever used. Use `dart pub cache clean` for the safe nuke.",
    rebuildCost: "Re-downloads packages on next `flutter pub get`",
    cleanCommand: "dart pub cache clean -f 2>/dev/null || flutter pub cache clean -f 2>/dev/null || true",
  },
  // Note: Flutter's SDK cache (Dart SDK binaries, Material/Cupertino fonts,
  // devtools build) lives at $FLUTTER_ROOT/bin/cache, NOT in ~/Library. We
  // can't know FLUTTER_ROOT generically — users can `du -sh $(which flutter
  // | xargs dirname | xargs dirname)/bin/cache` themselves if needed.

  // ── Android SDK & emulator data ────────────────────────────────────────
  {
    label: "Android SDK system-images",
    path: "~/Library/Android/sdk/system-images",
    description: "Per-API-level emulator images (e.g. android-35 / google_apis_playstore). Each API level is 1.5-3 GB.",
    rebuildCost: "Re-download via Android Studio → SDK Manager → SDK Platforms",
    risk: "caution",
  },
  {
    label: "Android SDK platforms",
    path: "~/Library/Android/sdk/platforms",
    description: "android.jar + sources per API level. Smaller than system-images but rarely audited.",
    rebuildCost: "Re-download via SDK Manager",
    risk: "caution",
  },
  {
    label: "Android emulator caches",
    path: "~/Library/Android/sdk/.cache",
    description: "AVD package metadata and downloader cache. Always safe.",
    rebuildCost: "Re-populates as needed",
  },
  {
    label: "Android NDK side-by-side installs",
    path: "~/Library/Android/sdk/ndk",
    description: "Multiple NDK versions installed via SDK Manager. Old NDK versions still take ~3-4 GB each.",
    rebuildCost: "Re-download via SDK Manager",
    risk: "caution",
  },
  {
    label: "Android Gradle build cache",
    path: "~/.android/build-cache",
    description: "Build cache shared across Android Studio projects (separate from Gradle's own cache).",
    rebuildCost: "Slower first build per project after cleanup",
  },
];

export async function scanMobile(): Promise<CleanTarget[]> {
  const targets = await scanCacheSpecs(MOBILE_CACHES, "dev");

  // Android Virtual Devices (AVDs) live in ~/.android/avd. Each emulator
  // instance can be 5+ GB once you've installed apps + snapshots. Surface
  // each AVD individually so users can pick the dead ones to delete.
  const avdRoot = "~/.android/avd";
  if (pathExists(avdRoot)) {
    const expanded = expandHome(avdRoot);
    try {
      const entries = readdirSync(expanded);
      for (const name of entries) {
        if (!name.endsWith(".avd")) continue;
        const full = join(expanded, name);
        const size = await pathSize(full);
        if (size === 0) continue;
        targets.push({
          label: `AVD: ${name.replace(/\.avd$/, "")}`,
          path: full,
          size,
          risk: "caution",
          description: "Android Virtual Device — emulator disk image, snapshots, installed apps, and user data.",
          rebuildCost: "Recreate the AVD via Android Studio → Device Manager",
          category: "dev",
        });
      }
    } catch {
      // ignore
    }
  }

  return targets;
}
