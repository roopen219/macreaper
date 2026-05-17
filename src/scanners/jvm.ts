// src/scanners/jvm.ts
// JVM-ecosystem caches: Gradle, Maven, sbt, Coursier. The Gradle user home in
// particular hoards wrapper distributions for every project Gradle version
// you've ever touched, plus per-version caches that only get cleaned after
// 30 days of inactivity (and only if the daemon ran recently).

import type { CleanTarget } from "../lib/types.ts";
import { scanCacheSpecs, type CacheSpec } from "../lib/utils.ts";

const JVM_CACHES: CacheSpec[] = [
  {
    label: "Gradle caches",
    path: "~/.gradle/caches",
    description: "Resolved dependencies, transforms, and module metadata across every Gradle build on this machine. Gradle auto-cleans 30-day-stale entries but rarely keeps up.",
    rebuildCost: "Re-downloads dependencies on next build (multi-GB)",
  },
  {
    label: "Gradle wrapper distributions",
    path: "~/.gradle/wrapper/dists",
    description: "Every Gradle version any project has ever bootstrapped via the wrapper. Old, unused distros (gradle-6.x, 7.x) sit here forever.",
    rebuildCost: "Gradle wrapper re-downloads the needed version on next build (~150 MB each)",
  },
  {
    label: "Gradle daemon logs",
    path: "~/.gradle/daemon",
    description: "Per-version daemon logs and registry. Logs older than 14 days are auto-purged but the directory itself stays.",
    rebuildCost: "None",
  },
  {
    label: "Maven local repository",
    path: "~/.m2/repository",
    description: "Local copy of every Maven artifact your projects have ever depended on. Use `mvn dependency:purge-local-repository` for the project-aware cleanup.",
    rebuildCost: "Re-downloads dependencies on next build (multi-GB)",
    cleanCommand: "mvn dependency:purge-local-repository -DactTransitively=false 2>/dev/null || true",
  },
  {
    label: "Maven wrapper distributions",
    path: "~/.m2/wrapper/dists",
    description: "Cached Maven distributions downloaded by `mvnw`.",
    rebuildCost: "mvnw re-downloads the configured version on next run",
  },
  {
    label: "sbt boot",
    path: "~/.sbt/boot",
    description: "Scala/sbt boot directory — caches the sbt launcher's Scala compilers per version.",
    rebuildCost: "Re-downloads Scala compilers on next sbt run",
  },
  {
    label: "sbt cache (1.x+)",
    path: "~/.sbt/1.0/dependency",
    description: "sbt 1.x dependency lock cache.",
    rebuildCost: "Re-resolves on next sbt run",
  },
  {
    label: "Coursier cache",
    path: "~/Library/Caches/Coursier",
    description: "Coursier's per-artifact cache, used by sbt 1.3+, Mill, Bloop, and Scala CLI. Often duplicates ~/.ivy2 for hybrid projects.",
    rebuildCost: "Re-resolves on next Coursier-backed build",
  },
  {
    label: "Ivy cache",
    path: "~/.ivy2/cache",
    description: "Legacy Ivy resolver cache used by sbt and older JVM tooling.",
    rebuildCost: "Re-downloads on next resolve",
  },
  {
    label: "Kotlin Native dependencies",
    path: "~/.konan",
    description: "Kotlin/Native LLVM toolchains and platform libraries downloaded per Kotlin version.",
    rebuildCost: "Re-downloads on next Kotlin/Native build (multi-hundred MB per version)",
  },
];

export async function scanJVM(): Promise<CleanTarget[]> {
  return scanCacheSpecs(JVM_CACHES, "dev");
}
