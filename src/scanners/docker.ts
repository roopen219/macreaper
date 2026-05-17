// src/scanners/docker.ts
// Container runtimes: Docker Desktop, Colima, OrbStack.
//
// Important: Docker on macOS keeps everything inside a *single* sparse disk image
// (Docker.raw or similar). du reports the file's apparent size, which is what
// users actually see eaten on their SSD. We never delete that file directly —
// instead we surface it and recommend `docker system prune` which is the only
// safe way to shrink it.

import { $ } from "bun";
import type { CleanTarget } from "../lib/types.ts";
import { pathSize, pathExists } from "../lib/utils.ts";

export async function scanDocker(): Promise<CleanTarget[]> {
  const targets: CleanTarget[] = [];

  // Docker Desktop VM disk image — usually the biggest single offender for
  // devs who use Docker. Can hit 60+ GB easily.
  const dockerVm = "~/Library/Containers/com.docker.docker/Data";
  if (pathExists(dockerVm)) {
    const size = await pathSize(dockerVm);
    if (size > 0) {
      targets.push({
        label: "Docker Desktop data (VM disk image)",
        path: dockerVm,
        size,
        risk: "caution",
        description: "All your Docker images, volumes, and build cache live in this VM disk. Use the prune command rather than deleting the folder.",
        rebuildCost: "Images re-pull from registries; build cache rebuilds on next build",
        category: "dev",
        cleanCommand: "docker system prune -a --volumes -f",
        guard: async () => {
          // Check Docker is installed *and* the daemon is reachable, otherwise prune fails.
          const which = await $`which docker`.quiet().nothrow();
          if (which.exitCode !== 0) return "docker CLI not found on PATH";
          const ping = await $`docker info`.quiet().nothrow();
          if (ping.exitCode !== 0) return "Docker daemon isn't running — start Docker Desktop first";
          return null;
        },
      });
    }
  }

  // Colima — lightweight Docker alternative many devs prefer.
  const colima = "~/.colima";
  if (pathExists(colima)) {
    const size = await pathSize(colima);
    if (size > 0) {
      targets.push({
        label: "Colima VM data",
        path: colima,
        size,
        risk: "caution",
        description: "Colima's VM disk + config. Pruning Docker resources through Colima reclaims space here too.",
        rebuildCost: "VM data — only delete the folder if you're done with Colima",
        category: "dev",
        cleanCommand: "docker system prune -a --volumes -f",
      });
    }
  }

  // OrbStack — newer, popular fast alternative.
  const orbstack = "~/.orbstack";
  if (pathExists(orbstack)) {
    const size = await pathSize(orbstack);
    if (size > 0) {
      targets.push({
        label: "OrbStack data",
        path: orbstack,
        size,
        risk: "caution",
        description: "OrbStack's container data. Prune via docker commands (OrbStack is Docker-compatible).",
        rebuildCost: "Images re-pull, build cache rebuilds",
        category: "dev",
        cleanCommand: "docker system prune -a --volumes -f",
      });
    }
  }

  return targets;
}
