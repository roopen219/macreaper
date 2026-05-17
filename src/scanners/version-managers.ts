// src/scanners/version-managers.ts
// Multi-version language toolchains. Every "version manager" has the same
// failure mode: you install a few Node/Python/Ruby versions, never `uninstall`
// the old ones, and a year later there's 5 GB of toolchains you never run.
//
// We report the parent install dir per manager so the size shows the full
// pile, then point users at the tool's own `uninstall` command in optimize.ts.
//
// Paths verified against upstream docs as of 2026:
//   Volta:  ~/.volta/tools/image/<tool>/<ver>            (volta.sh)
//   nvm:    ~/.nvm/versions/node/<ver>                   (nvm-sh/nvm)
//   fnm:    ~/Library/Application Support/fnm/node-versions/<ver>
//           ~/.local/state/fnm_multishells/              (per-shell symlinks)
//   asdf:   ~/.asdf/installs/<plugin>/<ver>              (asdf-vm/asdf)
//   mise:   ~/.local/share/mise/installs/<tool>/<ver>    (mise-en-place)
//   n:      /usr/local/n/versions/node/<ver> OR $N_PREFIX/n/versions/node
//   pyenv:  ~/.pyenv/versions/<ver>                      (pyenv/pyenv)
//   rbenv:  ~/.rbenv/versions/<ver>                      (rbenv/rbenv)
//   rustup: ~/.rustup/toolchains/<channel>-<target>      (rust-lang/rustup)

import { readdirSync } from "node:fs";
import type { CleanTarget } from "../lib/types.ts";
import { scanCacheSpecs, type CacheSpec, expandHome } from "../lib/utils.ts";

/** Count how many sub-directories live directly under `parent`. Used for the
 *  "(N versions)" label so users know whether the pile is one fat toolchain or many. */
function countSubdirs(parent: string): number {
  try {
    return readdirSync(expandHome(parent), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .length;
  } catch {
    return 0;
  }
}

interface ManagerSpec extends CacheSpec {
  /** If set, the label gets " (N versions)" appended once we know the count. */
  countAt?: string;
}

const MANAGERS: ManagerSpec[] = [
  {
    label: "Volta toolchains",
    path: "~/.volta/tools/image",
    countAt: "~/.volta/tools/image/node",
    description: "Every Node, npm, Yarn, and pnpm version Volta has fetched. Volta never auto-removes old versions — run `volta uninstall <tool>@<ver>` to drop unused ones.",
    rebuildCost: "Re-downloads if you ever pin that version again",
  },
  {
    label: "nvm Node versions",
    path: "~/.nvm/versions/node",
    countAt: "~/.nvm/versions/node",
    description: "Node binaries managed by nvm. `nvm uninstall <ver>` is the safe way to remove individual versions.",
    rebuildCost: "Re-downloads if you `nvm install` that version again",
  },
  {
    label: "fnm Node versions",
    path: "~/Library/Application Support/fnm/node-versions",
    countAt: "~/Library/Application Support/fnm/node-versions",
    description: "Node binaries managed by fnm. Use `fnm uninstall <ver>`.",
    rebuildCost: "Re-downloads if you `fnm install` that version again",
  },
  {
    label: "fnm multishell symlinks",
    path: "~/.local/state/fnm_multishells",
    description: "Per-shell symlinks fnm creates to keep parallel Node versions selected per terminal. Cleared safely when no shells are running.",
    rebuildCost: "None — recreated next time you open a shell with fnm active",
  },
  {
    label: "asdf installed versions",
    path: "~/.asdf/installs",
    description: "All plugin installs (nodejs, python, ruby, etc.). Use `asdf uninstall <plugin> <ver>` per pair.",
    rebuildCost: "Re-downloads if you `asdf install` again",
  },
  {
    label: "mise installed versions",
    path: "~/.local/share/mise/installs",
    description: "Tools installed via mise. `mise uninstall <tool>@<ver>` removes specific ones; `mise prune` clears anything not referenced by a .tool-versions / mise.toml file.",
    rebuildCost: "Re-downloads on next `mise install`",
    cleanCommand: "mise prune --dry-run",
  },
  {
    label: "mise downloads cache",
    path: "~/.local/share/mise/downloads",
    description: "Temporary download artifacts mise keeps around after install (tarballs, etc.).",
    rebuildCost: "None — only used during install",
  },
  {
    label: "n Node versions",
    path: "/usr/local/n/versions/node",
    countAt: "/usr/local/n/versions/node",
    description: "Node binaries installed by tj/n into /usr/local/n. `n rm <ver>` removes individual versions; `n prune` keeps only the active version.",
    rebuildCost: "Re-downloads on next `n <ver>`",
    cleanCommand: "n prune",
  },
  {
    label: "n Node versions (custom N_PREFIX)",
    path: "~/.n/versions/node",
    countAt: "~/.n/versions/node",
    description: "Node binaries when N_PREFIX is set to ~/.n. Same prune story as the /usr/local install.",
    rebuildCost: "Re-downloads on next `n <ver>`",
    cleanCommand: "n prune",
  },
  {
    label: "pyenv installed Pythons",
    path: "~/.pyenv/versions",
    countAt: "~/.pyenv/versions",
    description: "Python builds installed via pyenv. `pyenv uninstall <ver>` per version, or just `rm -rf ~/.pyenv/versions/<ver>`.",
    rebuildCost: "Recompiles (~5-10 min per version) on `pyenv install`",
  },
  {
    label: "pyenv build sources",
    path: "~/.pyenv/cache",
    description: "Source tarballs pyenv downloaded for previous builds. Safe to wipe.",
    rebuildCost: "Re-downloads tarball on next `pyenv install`",
  },
  {
    label: "rbenv installed Rubies",
    path: "~/.rbenv/versions",
    countAt: "~/.rbenv/versions",
    description: "Ruby builds managed by rbenv + ruby-build. `rbenv uninstall <ver>` per version.",
    rebuildCost: "Recompiles on `rbenv install`",
  },
  {
    label: "rustup toolchains",
    path: "~/.rustup/toolchains",
    countAt: "~/.rustup/toolchains",
    description: "Stable / beta / nightly Rust toolchains. `rustup toolchain uninstall <channel>` removes individual ones; `rustup toolchain list` shows what's installed.",
    rebuildCost: "Re-downloads via `rustup toolchain install`",
  },
  {
    label: "rustup downloads cache",
    path: "~/.rustup/downloads",
    description: "Temporary download artifacts kept after installing toolchains.",
    rebuildCost: "None — only used during install",
  },
];

export async function scanVersionManagers(): Promise<CleanTarget[]> {
  // First pass: standard size scan via the shared helper.
  const targets = await scanCacheSpecs(MANAGERS, "dev");

  // Second pass: enrich the labels with "(N versions)" where countAt is set
  // and the count is meaningful. We re-walk MANAGERS to keep the mapping easy
  // even though scanCacheSpecs already filtered for existence.
  return targets.map((t) => {
    const spec = MANAGERS.find((m) => m.label === t.label);
    if (!spec?.countAt) return t;
    const n = countSubdirs(spec.countAt);
    if (n < 2) return t; // "(1 versions)" is just noise
    return { ...t, label: `${t.label} (${n} versions)` };
  });
}
