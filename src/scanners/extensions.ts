// src/scanners/extensions.ts
// Installed editor extensions + remote-dev server installs. These are separate
// from editor *caches* (handled in editors.ts) because the extensions
// directory holds the actual installed extension code — usually safe to
// delete (everything reinstalls on next launch when the editor re-syncs from
// settings sync / settings.json `extensions` list), but the size is bigger
// than people expect because extensions ship bundled native binaries
// (TypeScript server, Pylance, language servers, etc.).
//
// Remote-dev servers (~/.vscode-server, ~/.cursor-server) only exist on
// machines you SSH into — they pile up versions of the server binary plus
// all the per-host extensions.

import type { CleanTarget } from "../lib/types.ts";
import { scanCacheSpecs, type CacheSpec, isProcessRunning } from "../lib/utils.ts";

const EXTENSIONS: CacheSpec[] = [
  {
    label: "Cursor extensions",
    path: "~/.cursor/extensions",
    description: "Installed Cursor extensions (bundled language servers, themes, etc.). Reinstalled by Cursor's settings sync or your settings.json on next launch.",
    rebuildCost: "Re-downloads on next Cursor launch (or after manual reinstall)",
    risk: "caution",
  },
  {
    label: "VS Code extensions",
    path: "~/.vscode/extensions",
    description: "Installed VS Code extensions. Reinstalled by VS Code's settings sync on next launch.",
    rebuildCost: "Re-downloads on next VS Code launch",
    risk: "caution",
  },
  {
    label: "Cursor remote-dev server",
    path: "~/.cursor-server",
    description: "Per-host server binaries + extensions installed when you SSH into a host with Cursor's Remote-SSH. Cursor leaves old server versions behind across upgrades.",
    rebuildCost: "Re-downloads on next remote connection (1-2 min)",
    risk: "caution",
  },
  {
    label: "VS Code remote-dev server",
    path: "~/.vscode-server",
    description: "Per-host server binaries + extensions installed when you SSH into a host with VS Code Remote-SSH. Multiple commit-hashed server installs pile up over time.",
    rebuildCost: "Re-downloads on next remote connection (1-2 min)",
    risk: "caution",
  },
  {
    label: "VS Code Insiders remote-dev server",
    path: "~/.vscode-server-insiders",
    description: "Same as ~/.vscode-server but for VS Code Insiders.",
    rebuildCost: "Re-downloads on next remote connection",
    risk: "caution",
  },
];

export async function scanExtensions(): Promise<CleanTarget[]> {
  const cursorRunning = await isProcessRunning("Cursor");
  const vscodeRunning = await isProcessRunning("Visual Studio Code");

  const withGuard = (specs: CacheSpec[]): CacheSpec[] =>
    specs.map((s) => {
      const running =
        (s.path.includes(".cursor/") && cursorRunning) ||
        (s.path.includes(".vscode/") && vscodeRunning);
      if (!running) return s;
      const editor = s.path.includes(".cursor/") ? "Cursor" : "VS Code";
      return {
        ...s,
        guard: async () => `${editor} is running — quit it before cleaning installed extensions`,
      };
    });

  return scanCacheSpecs(withGuard(EXTENSIONS), "dev");
}
