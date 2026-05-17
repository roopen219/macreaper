#!/usr/bin/env bun
// src/cli.ts
// macreaper — a Bun-powered disk-space reaper for macOS developers.
//
// Subcommands:
//   scan          full diagnostic (default if no command given)
//   dev           interactive cleanup of developer caches
//   system        clean macOS system caches & logs
//   snapshots     list & purge Time Machine local snapshots
//   find-large    find files above a size threshold
//   find-modules  locate every node_modules folder
//   optimize      preventive recommendations
//   --help        usage

import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import pc from "picocolors";

import { getDiskInfo } from "./lib/utils.ts";
import {
  formatBytes,
  pad,
  moveToTrash,
  runCleanCommand,
  isProcessRunning,
  HOME,
} from "./lib/utils.ts";

// Trailing slash so we only match path prefixes, not e.g. `/Users/roopiX/...`.
// We replace with "~/" (with slash) so shortened paths read like "~/work/foo".
const HOME_PREFIX = HOME + "/";
const TILDE_PREFIX = "~/";
import { RISK_META, type CleanTarget } from "./lib/types.ts";
import {
  readCache,
  writeCache,
  formatAge,
  CACHE_FILE,
  CACHE_SCHEMA_VERSION,
  type ScanCache,
} from "./lib/cache.ts";
import { scanNode, findNodeModules } from "./scanners/node.ts";
import { scanDocker } from "./scanners/docker.ts";
import { scanPython, scanRust, scanGo, scanHomebrew } from "./scanners/languages.ts";
import { scanXcode } from "./scanners/xcode.ts";
import { scanEditors } from "./scanners/editors.ts";
import { scanExtensions } from "./scanners/extensions.ts";
import { scanAI } from "./scanners/ai.ts";
import { scanCloud } from "./scanners/cloud.ts";
import { scanJVM } from "./scanners/jvm.ts";
import { scanMobile } from "./scanners/mobile.ts";
import { scanLogs } from "./scanners/logs.ts";
import { scanSystem, listLocalSnapshots, deleteLocalSnapshots } from "./scanners/system.ts";
import { scanSpotlight } from "./scanners/spotlight.ts";
import { scanWorktrees } from "./scanners/worktrees.ts";
import { scanVersionManagers } from "./scanners/version-managers.ts";
import { scanPkgBinaries } from "./scanners/pkg-binaries.ts";
import { scanNativeBins } from "./scanners/native-bins.ts";
import { scanComms } from "./scanners/comms.ts";
import { scanGames } from "./scanners/games.ts";
import { findLargeFiles } from "./scanners/large-files.ts";
import { getRecommendations } from "./lib/optimize.ts";

/* ────────────────────────────────────────────────────────────────────────── */
/*  HELP                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

const HELP = `
${pc.bold(pc.cyan("macreaper"))} ${pc.dim("— reclaim disk space on your Mac, the dev-friendly way")}

${pc.bold("Usage:")}
  ${pc.cyan("macreaper")} ${pc.dim("[command] [options]")}

${pc.bold("Commands:")}
  ${pc.cyan("scan")}           Full diagnostic of where your disk space is going ${pc.dim("(default)")}
  ${pc.cyan("dev")}            Interactive cleanup of developer caches
  ${pc.cyan("system")}         Clean macOS user caches & logs
  ${pc.cyan("snapshots")}      List & purge Time Machine local snapshots
  ${pc.cyan("find-large")}     Find files larger than N MB ${pc.dim("(default 500)")}
  ${pc.cyan("find-modules")}   Locate every node_modules folder, sorted by size
  ${pc.cyan("optimize")}       Show preventive recommendations

${pc.bold("Options:")}
  ${pc.cyan("--dry-run")}      ${pc.dim("Show what would be done, don't actually do it (default for `dev`)")}
  ${pc.cyan("--fast")}         ${pc.dim("Skip $HOME find-walks (no node_modules / heavy-binary scan) — finishes in ~60 s")}
  ${pc.cyan("--from-cache")}   ${pc.dim("Reuse the last scan from ~/Library/Caches/macreaper/last-scan.json")}
  ${pc.cyan("--json")}         ${pc.dim("Output the scan as JSON on stdout (progress goes to stderr) — pipe into an LLM or jq")}
  ${pc.cyan("--flat")}         ${pc.dim("Single sorted table instead of per-group sub-tables (scan only)")}
  ${pc.cyan("--threshold")}    ${pc.dim("Size threshold in MB for `find-large` (default 500)")}
  ${pc.cyan("-h, --help")}     ${pc.dim("Show this help")}
  ${pc.cyan("-v, --version")}  ${pc.dim("Show version")}

${pc.bold("Examples:")}
  ${pc.dim("# Quick scan, show grouped findings (default)")}
  ${pc.cyan("macreaper scan --fast")}

  ${pc.dim("# Pipe the cached scan into an LLM for a tailored cleanup plan")}
  ${pc.cyan("macreaper scan --from-cache --json")} ${pc.dim("| llm 'pick the 5 best wins'")}

${pc.bold("Safety:")}
  All deletions move files to ${pc.cyan("~/.Trash")} — never permanent. Recover from Finder
  any time before emptying the Trash. Tool-native commands (${pc.dim("docker prune,")}
  ${pc.dim("brew cleanup, etc.")}) are used where available because they're safer than
  raw folder deletes.
`;

/* ────────────────────────────────────────────────────────────────────────── */
/*  ASCII BANNER                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Shorten a path for display in interactive prompts.
 *
 * Replaces $HOME with `~/` first. If the result still exceeds the visible
 * column budget (terminal width minus a fixed ~20-char prompt-chrome
 * allowance), we truncate from the left and prepend `…/`. Short paths are
 * left alone — no point uglifying `~/work/foo/node_modules` for a 200-col
 * terminal.
 */
function shortenPath(p: string, reserved = 20): string {
  const tilde = p.replace(HOME_PREFIX, TILDE_PREFIX);
  const cols = process.stdout.columns ?? 120;
  const budget = Math.max(40, cols - reserved);
  if (tilde.length <= budget) return tilde;
  // Trim from the left until it fits; keep the tail so the user can still
  // identify the project.
  return "…/" + tilde.slice(tilde.length - budget + 2);
}

/**
 * Cap a multiselect's visible-window height to the current terminal size.
 *
 * `@clack/prompts` already clamps internally (min 5, default Infinity) but
 * it doesn't dynamically size to your terminal — pass a huge list and it
 * tries to render every row, scrolling the cursor off-screen and breaking
 * navigation. We subtract 6 rows for the prompt header / footer / margins
 * and floor at 5 so very small terminals still get a usable view.
 *
 * Returns undefined when stdout isn't a TTY (e.g. piped output) so clack
 * uses its default render path.
 */
function ttyMaxItems(): number | undefined {
  const rows = process.stdout.rows;
  if (!rows || !Number.isFinite(rows)) return undefined;
  return Math.max(5, rows - 6);
}

function banner(): string {
  return [
    pc.cyan("  ┌──────────────────────────────────────────┐"),
    pc.cyan("  │  ") + pc.bold("🔪 macreaper") + pc.dim("  ·  disk space reaper") + pc.cyan("    │"),
    pc.cyan("  └──────────────────────────────────────────┘"),
  ].join("\n");
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  DISK HEADER — shown on every command                                      */
/* ────────────────────────────────────────────────────────────────────────── */

async function showDiskHeader(): Promise<void> {
  const s = p.spinner();
  s.start("Reading disk info");
  const info = await getDiskInfo();
  s.stop("Disk read");

  const used = formatBytes(info.used);
  const free = formatBytes(info.free);
  const total = formatBytes(info.total);
  const pct = info.percentUsed;

  // Color the percentage by pressure: green <70%, yellow 70–90%, red >90%.
  const pctStr = pct.toFixed(1) + "%";
  const pctColored =
    pct > 90 ? pc.red(pc.bold(pctStr)) : pct > 70 ? pc.yellow(pctStr) : pc.green(pctStr);

  // Build a simple 30-cell bar.
  const cells = 30;
  const filled = Math.round((pct / 100) * cells);
  const barChar = pct > 90 ? pc.red("█") : pct > 70 ? pc.yellow("█") : pc.green("█");
  const bar = barChar.repeat(filled) + pc.dim("░").repeat(cells - filled);

  console.log("");
  console.log(`  ${pc.bold("Disk:")} ${used} used / ${total} total · ${free} free · ${pctColored}`);
  console.log(`  ${bar}`);
  if (info.purgeable > 0) {
    console.log(`  ${pc.dim(`Purgeable: ${formatBytes(info.purgeable)} (snapshots & cached files macOS may reclaim)`)}`);
  }
  console.log("");
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  TARGET TABLE — the workhorse output format                                */
/* ────────────────────────────────────────────────────────────────────────── */

function renderTargetTable(targets: CleanTarget[]): void {
  if (targets.length === 0) {
    console.log(pc.dim("  (no targets found)"));
    return;
  }

  // Sort biggest-first (treating unknown -1 as 0 for sort purposes).
  const sorted = [...targets].sort((a, b) => Math.max(0, b.size) - Math.max(0, a.size));

  const LABEL_W = 38;
  const SIZE_W = 10;

  console.log(
    "  " +
      pc.dim(pad("ITEM", LABEL_W)) +
      pc.dim(pad("SIZE", SIZE_W, "right")) +
      pc.dim("  RISK     PATH"),
  );
  console.log("  " + pc.dim("─".repeat(LABEL_W + SIZE_W + 40)));

  for (const t of sorted) {
    const meta = RISK_META[t.risk];
    const colored =
      meta.color === "green" ? pc.green(meta.emoji) :
      meta.color === "yellow" ? pc.yellow(meta.emoji) : pc.red(meta.emoji);
    const sizeStr = t.size < 0 ? "—" : formatBytes(t.size);
    const truncatedLabel = t.label.length > LABEL_W - 2
      ? t.label.slice(0, LABEL_W - 3) + "…"
      : t.label;
    console.log(
      "  " +
        pad(truncatedLabel, LABEL_W) +
        pad(sizeStr, SIZE_W, "right") +
        "  " +
        colored +
        " " +
        pad(meta.label, 8) +
        pc.dim(t.path),
    );
  }

  const total = sorted.reduce((acc, t) => acc + Math.max(0, t.size), 0);
  console.log("  " + pc.dim("─".repeat(LABEL_W + SIZE_W + 40)));
  console.log(`  ${pc.bold("Total reclaimable:")} ${pc.cyan(pc.bold(formatBytes(total)))}`);
  console.log("");
}

/**
 * Render targets grouped by their `group` tag. Groups are sorted by total
 * reclaimable size descending, so the biggest opportunity is always first.
 * Within each group, targets are also sorted by size descending.
 *
 * Anything without a group (older data, third-party callers) gets bucketed
 * under "Other" so we don't silently drop rows.
 */
function renderGroupedTargets(targets: CleanTarget[]): void {
  if (targets.length === 0) {
    console.log(pc.dim("  (no targets found)"));
    return;
  }

  // Bucket by group.
  const buckets = new Map<string, CleanTarget[]>();
  for (const t of targets) {
    const key = t.group ?? "Other";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(t);
  }

  // Compute totals and sort groups biggest-first.
  const groupTotals = [...buckets.entries()].map(([name, list]) => ({
    name,
    list,
    total: list.reduce((s, t) => s + Math.max(0, t.size), 0),
  }));
  groupTotals.sort((a, b) => b.total - a.total);

  const LABEL_W = 38;
  const SIZE_W = 10;
  const SEP = "─".repeat(LABEL_W + SIZE_W + 40);
  const grandTotal = groupTotals.reduce((s, g) => s + g.total, 0);

  for (const { name, list, total } of groupTotals) {
    const sorted = [...list].sort((a, b) => Math.max(0, b.size) - Math.max(0, a.size));
    const pct = grandTotal > 0 ? ((total / grandTotal) * 100).toFixed(0) : "0";

    console.log("");
    console.log(
      `  ${pc.bold(pc.cyan(name))} ${pc.dim(
        `· ${sorted.length} item${sorted.length === 1 ? "" : "s"} · ${formatBytes(total)} (${pct}%)`,
      )}`,
    );
    console.log("  " + pc.dim(SEP));

    for (const t of sorted) {
      const meta = RISK_META[t.risk];
      const coloredEmoji =
        meta.color === "green" ? pc.green(meta.emoji) :
        meta.color === "yellow" ? pc.yellow(meta.emoji) : pc.red(meta.emoji);
      const sizeStr = t.size < 0 ? "—" : formatBytes(t.size);
      const truncatedLabel = t.label.length > LABEL_W - 2
        ? t.label.slice(0, LABEL_W - 3) + "…"
        : t.label;
      console.log(
        "  " +
          pad(truncatedLabel, LABEL_W) +
          pad(sizeStr, SIZE_W, "right") +
          "  " +
          coloredEmoji +
          " " +
          pad(meta.label, 8) +
          pc.dim(t.path),
      );
    }
  }

  console.log("");
  console.log("  " + pc.dim(SEP));
  console.log(`  ${pc.bold("Total reclaimable:")} ${pc.cyan(pc.bold(formatBytes(grandTotal)))} across ${groupTotals.length} groups, ${targets.length} items`);
  console.log("");
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  GATHER ALL TARGETS                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

// Each entry: short name shown in progress log + group label used by the
// grouped renderer + scan function. Two scanners (node + native-bins) walk
// $HOME with `find` and are tagged `slow` so we show a heartbeat after 10 s.
//
// `group` is the bucket label the renderer + cache use. Multiple scanners
// can share a group (e.g. node + native-bins + pkg-binaries all roll up
// into "Node ecosystem"). Group order is meaningful only as a tiebreaker —
// the renderer sorts groups by total reclaimable size descending.
const SCANNERS: Array<{
  name: string;
  group: string;
  run: () => Promise<CleanTarget[]>;
  slow?: boolean;
}> = [
  { name: "docker",            group: "Containers",       run: scanDocker },
  { name: "python",            group: "Languages",        run: scanPython },
  { name: "rust",              group: "Languages",        run: scanRust },
  { name: "go",                group: "Languages",        run: scanGo },
  { name: "homebrew",          group: "Languages",        run: scanHomebrew },
  { name: "jvm",               group: "Languages",        run: scanJVM },
  { name: "mobile",            group: "Mobile dev",       run: scanMobile },
  { name: "xcode",             group: "Mobile dev",       run: scanXcode },
  { name: "editors",           group: "Editors & IDEs",   run: scanEditors },
  { name: "extensions",        group: "Editors & IDEs",   run: scanExtensions },
  { name: "ai/llm",            group: "AI & LLMs",        run: scanAI },
  { name: "cloud",             group: "Cloud & DevOps",   run: scanCloud },
  { name: "logs",              group: "Logs",             run: scanLogs },
  { name: "system",            group: "System",           run: scanSystem },
  { name: "spotlight",         group: "System",           run: scanSpotlight },
  { name: "worktrees",         group: "Cursor worktrees", run: scanWorktrees },
  { name: "version-managers",  group: "Version managers", run: scanVersionManagers },
  { name: "pkg-binaries",      group: "Node ecosystem",   run: scanPkgBinaries },
  { name: "comms",             group: "Comms apps",       run: scanComms },
  { name: "games",             group: "Games",            run: scanGames },
  // Slow ones last so they sit at the bottom of the in-flight list visibly.
  { name: "node + node_modules", group: "Node ecosystem",  run: scanNode,       slow: true },
  { name: "heavy native bins",   group: "Node ecosystem",  run: scanNativeBins, slow: true },
];

/** Format an elapsed-ms duration as "120ms", "1.2s", or "1m 23s". */
function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// Where progress + status messages go. Switched to stderr when --json is
// active so stdout stays a clean machine-readable stream.
let progressOut: (line: string) => void = (line) => console.log(line);
function setProgressStream(stream: "stdout" | "stderr"): void {
  progressOut = stream === "stderr"
    ? (line) => process.stderr.write(line + "\n")
    : (line) => console.log(line);
}

interface GatherOptions {
  fast?: boolean;
  /** If true, try the disk cache first. If the cache is missing or the wrong
   *  schema, fall through to a fresh scan unless `requireCache` is also set. */
  fromCache?: boolean;
  /** If true, refuse to fall back to a fresh scan when the cache is missing. */
  requireCache?: boolean;
}

interface GatherResult {
  targets: CleanTarget[];
  source: "fresh" | "cache";
  cache: ScanCache;
}

/**
 * Run every scanner in parallel and stream completion lines as they finish.
 *
 * Each scanner gets a "✓ <name> · <elapsed> · <N items>" line when it
 * resolves. Slow scanners get a gentle "(still running)" hint after 10 s so
 * the user can tell macreaper is alive, not stuck. We use plain stream-writes
 * rather than @clack/prompts spinner because that one is single-line and we
 * want to show 21 concurrent jobs.
 *
 * The result is written to the on-disk cache before returning so subsequent
 * commands (and LLM workflows) can replay it via --from-cache.
 */
async function gatherAllTargets(opts: GatherOptions = {}): Promise<GatherResult> {
  // ── Cache load path ─────────────────────────────────────────────────────
  if (opts.fromCache) {
    const hit = readCache();
    if (hit) {
      progressOut(pc.dim(`  Using cached scan from ${formatAge(hit.ageMs)} (${pc.cyan(CACHE_FILE.replace(process.env.HOME ?? "", "~"))}).`));
      progressOut(pc.dim(`  Re-run without --from-cache to refresh.`));
      progressOut("");
      return {
        targets: hit.cache.targets as CleanTarget[],
        source: "cache",
        cache: hit.cache,
      };
    }
    if (opts.requireCache) {
      throw new Error(`No cached scan found at ${CACHE_FILE}. Run \`macreaper scan\` first.`);
    }
    progressOut(pc.yellow(`  No cached scan found — running a fresh scan.`));
  }

  // ── Fresh scan ──────────────────────────────────────────────────────────
  const start = performance.now();
  const scanners = opts.fast ? SCANNERS.filter((s) => !s.slow) : SCANNERS;
  const eta = opts.fast ? "under 60 s" : "3–5 min on a heavy dev machine";
  progressOut(
    pc.dim(
      `  Running ${scanners.length} scanners in parallel — typical scan: ${eta}` +
        (opts.fast ? pc.dim("  (--fast: skipping $HOME find-walks)") : ""),
    ),
  );
  progressOut("");

  let done = 0;
  const total = scanners.length;
  const timings: Record<string, number> = {};

  const wrapped = scanners.map(async ({ name, group, run, slow }) => {
    const t0 = performance.now();
    const heartbeat = slow
      ? setTimeout(() => {
          progressOut(pc.dim(`  · ${name.padEnd(22)} still running (walks $HOME — can take 1–3 min)`));
        }, 10_000)
      : null;

    try {
      const result = await run();
      if (heartbeat) clearTimeout(heartbeat);
      const elapsed = performance.now() - t0;
      timings[name] = elapsed;
      done++;
      const counter = pc.dim(`[${done.toString().padStart(2)}/${total}]`);
      const items = result.length === 1 ? "1 item" : `${result.length} items`;
      const rawTime = pad(fmtElapsed(elapsed), 7, "right");
      const colored =
        elapsed > 60_000 ? pc.red(rawTime) :
        elapsed > 5_000 ? pc.yellow(rawTime) :
        pc.dim(rawTime);
      progressOut(`  ${pc.green("✓")} ${counter} ${pad(name, 22)} ${colored} · ${pc.dim(items)}`);
      // Tag every target with the scanner's group so the renderer can bucket.
      return result.map((t) => ({ ...t, group }));
    } catch (err) {
      if (heartbeat) clearTimeout(heartbeat);
      const elapsed = performance.now() - t0;
      timings[name] = elapsed;
      done++;
      const counter = pc.dim(`[${done.toString().padStart(2)}/${total}]`);
      const msg = err instanceof Error ? err.message : String(err);
      progressOut(`  ${pc.red("✗")} ${counter} ${pad(name, 22)} ${pc.red("failed")} · ${pc.dim(msg.slice(0, 80))}`);
      return [] as CleanTarget[];
    }
  });

  const results = await Promise.all(wrapped);
  const elapsed = performance.now() - start;
  progressOut("");
  progressOut(pc.dim(`  Scan finished in ${fmtElapsed(elapsed)}.`));
  progressOut("");

  const targets = results.flat();

  // Persist the cache. Disk-info is needed for the file footer; this is
  // cheap (a couple of df / diskutil calls).
  const disk = await getDiskInfo();
  const cache: ScanCache = {
    version: CACHE_SCHEMA_VERSION,
    scannedAt: new Date().toISOString(),
    elapsedMs: Math.round(elapsed),
    fast: Boolean(opts.fast),
    disk,
    scannerTimingsMs: Object.fromEntries(
      Object.entries(timings).map(([k, v]) => [k, Math.round(v)]),
    ),
    targets,
  };
  try {
    writeCache(cache);
    progressOut(pc.dim(`  Cached to ${CACHE_FILE.replace(process.env.HOME ?? "", "~")} — reuse with ${pc.cyan("--from-cache")}.`));
    progressOut("");
  } catch (err) {
    progressOut(pc.yellow(`  Warning: failed to write scan cache: ${err instanceof Error ? err.message : String(err)}`));
  }

  return { targets, source: "fresh", cache };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  COMMAND: scan                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

async function cmdScan(opts: {
  fast: boolean;
  fromCache: boolean;
  json: boolean;
  flat: boolean;
}): Promise<void> {
  // JSON mode: machine-readable stdout, all progress to stderr.
  if (opts.json) {
    setProgressStream("stderr");
    const { cache } = await gatherAllTargets({ fast: opts.fast, fromCache: opts.fromCache });
    process.stdout.write(JSON.stringify(cache, null, 2) + "\n");
    return;
  }

  console.log(banner());
  await showDiskHeader();

  const { targets, source, cache } = await gatherAllTargets({
    fast: opts.fast,
    fromCache: opts.fromCache,
  });

  const headerSuffix = source === "cache"
    ? pc.dim(` (cached, ${formatAge(Date.now() - new Date(cache.scannedAt).getTime())})`)
    : "";
  console.log(pc.bold(`  Findings (${targets.length} cleanup candidates)${headerSuffix}:`));

  if (opts.flat) {
    console.log("");
    renderTargetTable(targets);
  } else {
    renderGroupedTargets(targets);
  }

  console.log(pc.dim("  Next: ") +
    pc.cyan("macreaper dev") + pc.dim(" for an interactive cleanup, ") +
    pc.cyan("macreaper optimize") + pc.dim(" for prevention tips,"));
  console.log(pc.dim("        or pipe ") +
    pc.cyan("macreaper scan --json") + pc.dim(" into your favourite LLM for a guided cleanup."));
  console.log("");
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  COMMAND: dev — interactive cleanup of developer caches                    */
/* ────────────────────────────────────────────────────────────────────────── */

async function cmdDev(opts: {
  dryRun: boolean;
  fast: boolean;
  fromCache: boolean;
}): Promise<void> {
  console.log(banner());
  await showDiskHeader();

  p.intro(pc.bgCyan(pc.black(" Developer cache cleanup ")));

  const { targets: all, source } = await gatherAllTargets({
    fast: opts.fast,
    fromCache: opts.fromCache,
  });
  const devTargets = all.filter((t) => t.category === "dev");
  console.log(pc.dim(`  ${devTargets.length} of ${all.length} are developer caches.`));

  // Heads-up: cached cleanup runs without live guards. If anything has a
  // command (vs trash-move), we WILL re-evaluate guard at clean time below,
  // but the cached selection might include items whose live state has changed.
  if (source === "cache") {
    console.log(pc.yellow(`  Cached scan — live guards (e.g. "is Xcode running?") will be re-checked at clean time.`));
  }
  console.log("");

  if (devTargets.length === 0) {
    p.outro("Nothing to clean here — you're tidy! 🎉");
    return;
  }

  console.log("");
  renderGroupedTargets(devTargets);

  // Interactive multi-select. Conservative default: nothing pre-selected.
  // The clack multiselect "options" want { value, label, hint }.
  const sorted = [...devTargets].sort((a, b) => Math.max(0, b.size) - Math.max(0, a.size));
  const selected = await p.multiselect({
    message: "Select what to clean (Space to toggle, Enter to confirm)",
    options: sorted.map((t) => {
      const meta = RISK_META[t.risk];
      const sizeStr = t.size < 0 ? "—" : formatBytes(t.size);
      return {
        value: t,
        label: `${meta.emoji} ${t.label} ${pc.dim(`(${sizeStr})`)}`,
        hint: t.rebuildCost ?? "",
      };
    }),
    required: false,
    initialValues: [] as CleanTarget[],
    maxItems: ttyMaxItems(),
  });

  if (p.isCancel(selected) || !Array.isArray(selected) || selected.length === 0) {
    p.cancel("Nothing selected — exiting without changes.");
    return;
  }

  const chosen = selected as CleanTarget[];
  const totalSize = chosen.reduce((acc, t) => acc + Math.max(0, t.size), 0);

  // Final confirmation — show exact paths so there are no surprises.
  console.log("");
  console.log(pc.bold("  Will clean:"));
  for (const t of chosen) {
    const meta = RISK_META[t.risk];
    console.log(`    ${meta.emoji} ${t.label} ${pc.dim(`(${t.size < 0 ? "—" : formatBytes(t.size)}`)}${pc.dim(")")}${t.cleanCommand ? pc.dim(` → ${t.cleanCommand}`) : pc.dim(` → move to Trash`)}`);
  }
  console.log("");
  console.log(pc.dim(`  Estimated reclaim: ${pc.cyan(formatBytes(totalSize))}`));
  console.log("");

  if (opts.dryRun) {
    p.outro(pc.yellow("Dry run — no changes made. Re-run without --dry-run to clean."));
    return;
  }

  const confirmed = await p.confirm({
    message: `Proceed? Files will be moved to ~/.Trash (recoverable)`,
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled. Nothing was changed.");
    return;
  }

  // Execute. Per item: if it has a cleanCommand, run that; otherwise move to Trash.
  // Run a guard if present (e.g. don't touch Xcode caches while Xcode is open).
  let reclaimed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const t of chosen) {
    const cleanSpin = p.spinner();
    cleanSpin.start(`Cleaning ${t.label}`);

    // Guard check.
    if (t.guard) {
      const reason = await t.guard();
      if (reason) {
        cleanSpin.stop(`${pc.yellow("⚠")}  Skipped ${t.label}: ${reason}`);
        failed++;
        continue;
      }
    }

    if (t.cleanCommand) {
      const { ok, output } = await runCleanCommand(t.cleanCommand);
      if (ok) {
        cleanSpin.stop(`${pc.green("✓")} Cleaned ${t.label}`);
        reclaimed += Math.max(0, t.size);
        succeeded++;
      } else {
        cleanSpin.stop(`${pc.red("✗")} Failed: ${t.label} — ${output.slice(0, 120)}`);
        failed++;
      }
    } else {
      const ok = await moveToTrash(t.path);
      if (ok) {
        cleanSpin.stop(`${pc.green("✓")} Trashed ${t.label}`);
        reclaimed += Math.max(0, t.size);
        succeeded++;
      } else {
        cleanSpin.stop(`${pc.red("✗")} Could not move ${t.label} to Trash`);
        failed++;
      }
    }
  }

  console.log("");
  console.log(`  ${pc.green(pc.bold(`Reclaimed ~${formatBytes(reclaimed)}`))} (${succeeded} ok, ${failed} skipped/failed)`);
  console.log("");
  p.outro("Done. Empty Trash to make the space permanent.");
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  COMMAND: system                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

async function cmdSystem(opts: { dryRun: boolean }): Promise<void> {
  console.log(banner());
  await showDiskHeader();
  p.intro(pc.bgCyan(pc.black(" System cleanup ")));

  const s = p.spinner();
  s.start("Scanning system caches and folders");
  const targets = await scanSystem();
  s.stop(`Found ${targets.length} system targets`);

  if (targets.length === 0) {
    p.outro("Nothing to clean.");
    return;
  }
  // System scanner emits a single bucket — flat table reads better than a
  // one-group "grouped" view, so we keep renderTargetTable here.
  renderTargetTable(targets);

  const selected = await p.multiselect({
    message: "Select what to clean",
    options: targets.map((t) => ({
      value: t,
      label: `${RISK_META[t.risk].emoji} ${t.label} ${pc.dim(`(${t.size < 0 ? "—" : formatBytes(t.size)})`)}`,
      hint: t.description,
    })),
    required: false,
    maxItems: ttyMaxItems(),
  });
  if (p.isCancel(selected) || !Array.isArray(selected) || selected.length === 0) {
    p.cancel("Nothing selected.");
    return;
  }

  if (opts.dryRun) {
    p.outro(pc.yellow("Dry run — no changes."));
    return;
  }

  const confirmed = await p.confirm({ message: "Move selected items to Trash?", initialValue: false });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    return;
  }

  let reclaimed = 0;
  for (const t of selected as CleanTarget[]) {
    if (t.cleanCommand === "macreaper-internal-delete-snapshots") {
      // handled by `snapshots` command — surface that here.
      console.log(pc.dim(`  Snapshots are managed by the dedicated 'snapshots' command — skipping here.`));
      continue;
    }
    const ok = await moveToTrash(t.path);
    if (ok) {
      reclaimed += Math.max(0, t.size);
      console.log(`  ${pc.green("✓")} ${t.label}`);
    } else {
      console.log(`  ${pc.red("✗")} ${t.label}`);
    }
  }
  p.outro(pc.green(`Reclaimed ~${formatBytes(reclaimed)}.`));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  COMMAND: snapshots                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

async function cmdSnapshots(): Promise<void> {
  console.log(banner());
  p.intro(pc.bgCyan(pc.black(" Time Machine local snapshots ")));

  const dates = await listLocalSnapshots();
  if (dates.length === 0) {
    p.outro("No local snapshots present. Nothing to do.");
    return;
  }

  console.log("");
  console.log(`  Found ${pc.bold(dates.length.toString())} local snapshot${dates.length === 1 ? "" : "s"}:`);
  for (const d of dates) console.log(`    · ${pc.dim(d)}`);
  console.log("");
  console.log(pc.dim("  macOS counts these as 'available' space, but they can still trigger"));
  console.log(pc.dim("  low-disk warnings under pressure. Deleting them is safe."));
  console.log("");

  const confirmed = await p.confirm({
    message: "Delete all local snapshots? (you may be prompted for your password)",
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    return;
  }

  const s = p.spinner();
  s.start("Deleting snapshots");
  const { deleted, failed } = await deleteLocalSnapshots(dates);
  s.stop(`Deleted ${deleted}, ${failed} failed`);
  p.outro(failed === 0 ? pc.green("All snapshots cleared.") : pc.yellow("Some failed — try running with sudo if needed."));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  COMMAND: find-large                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

async function cmdFindLarge(thresholdMB: number, opts: { fromCache: boolean }): Promise<void> {
  console.log(banner());
  p.intro(pc.bgCyan(pc.black(` Files larger than ${thresholdMB} MB `)));

  const s = p.spinner();
  s.start(
    opts.fromCache
      ? `Loading cached large-files list (or scanning if cache is missing)`
      : `Scanning your home folder (this can take a minute)`,
  );
  const result = await findLargeFiles(thresholdMB, { fromCache: opts.fromCache });
  const cacheHint = result.source === "cache"
    ? pc.dim(` (cached, ${formatAge(result.cacheAgeMs ?? 0)})`)
    : "";
  s.stop(`Found ${result.files.length} large file${result.files.length === 1 ? "" : "s"}${cacheHint}`);

  const { files } = result;
  if (files.length === 0) {
    p.outro("Nothing big enough to worry about.");
    return;
  }

  console.log("");
  for (const f of files.slice(0, 50)) {
    console.log(`  ${pad(formatBytes(f.size), 10, "right")}  ${pc.dim(f.path)}`);
  }
  if (files.length > 50) {
    console.log(pc.dim(`  … and ${files.length - 50} more.`));
  }
  console.log("");
  p.outro(pc.dim("Review and delete manually from Finder — these are user files we don't auto-touch."));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  COMMAND: find-modules                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

async function cmdFindModules(opts: { dryRun: boolean; fromCache: boolean }): Promise<void> {
  console.log(banner());
  p.intro(pc.bgCyan(pc.black(" node_modules locator ")));

  const s = p.spinner();
  s.start(
    opts.fromCache
      ? "Loading cached node_modules list (or scanning if cache is missing)"
      : "Finding every node_modules folder under your home",
  );
  const { count, totalSize, paths, source, cacheAgeMs } = await findNodeModules({
    fromCache: opts.fromCache,
  });
  const cacheHint = source === "cache" ? pc.dim(` (cached, ${formatAge(cacheAgeMs ?? 0)})`) : "";
  s.stop(`Found ${count} node_modules totalling ${formatBytes(totalSize)}${cacheHint}`);

  if (count === 0) {
    p.outro("None found.");
    return;
  }

  const sorted = [...paths].sort((a, b) => b.size - a.size);

  // Print only the top 10 as a preview — the searchable prompt below shows
  // the whole list with type-to-filter, so dumping all 312 lines as a wall
  // of text first is wasted scroll-back.
  console.log("");
  for (const f of sorted.slice(0, 10)) {
    console.log(`  ${pad(formatBytes(f.size), 10, "right")}  ${pc.dim(f.path)}`);
  }
  if (sorted.length > 10) {
    console.log(pc.dim(`  … and ${sorted.length - 10} more — start typing in the next prompt to filter.`));
  }
  console.log("");

  // autocompleteMultiselect lets the user type to filter — essential when
  // there are 100s of node_modules across years of side projects. Falls
  // back gracefully to a regular paginated list when the user types
  // nothing.
  const selected = await p.autocompleteMultiselect({
    message: "Select node_modules to remove (type to filter, Space to toggle, Enter to confirm)",
    options: sorted.map((f) => ({
      value: f.path,
      // Allow ~30 cols for size column + prompt chrome (cursor, brackets,
      // spacing). The full path stays in `hint` for the detail line.
      label: `${pad(formatBytes(f.size), 10, "right")}  ${shortenPath(f.path, 30)}`,
      hint: f.path,
    })),
    required: false,
    maxItems: ttyMaxItems(),
  });

  if (p.isCancel(selected) || !Array.isArray(selected) || selected.length === 0) {
    p.cancel("Nothing selected.");
    return;
  }

  if (opts.dryRun) {
    p.outro(pc.yellow("Dry run — no changes."));
    return;
  }

  const confirmed = await p.confirm({
    message: `Move ${selected.length} node_modules folder${selected.length === 1 ? "" : "s"} to Trash?`,
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    return;
  }

  let reclaimed = 0;
  for (const path of selected as string[]) {
    const match = sorted.find((s) => s.path === path);
    const ok = await moveToTrash(path);
    if (ok) {
      reclaimed += match?.size ?? 0;
      console.log(`  ${pc.green("✓")} ${path}`);
    } else {
      console.log(`  ${pc.red("✗")} ${path}`);
    }
  }
  p.outro(pc.green(`Reclaimed ~${formatBytes(reclaimed)}.`));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  COMMAND: optimize                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

async function cmdOptimize(): Promise<void> {
  console.log(banner());
  await showDiskHeader();
  p.intro(pc.bgCyan(pc.black(" Prevention & optimization ")));

  const recs = await getRecommendations();
  console.log("");
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    const tag = r.kind === "auto" ? pc.cyan("[auto]   ") : pc.dim("[manual] ");
    console.log(`  ${tag}${pc.bold(r.title)}`);
    console.log(`           ${pc.dim(r.detail)}`);
    if (r.command) {
      console.log(`           ${pc.green("$ " + r.command)}`);
    }
    console.log("");
  }
  p.outro(pc.dim("Pick the ones that fit your workflow. None of these are forced."));
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  ENTRYPOINT                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "dry-run": { type: "boolean", default: false },
      fast: { type: "boolean", default: false },
      "from-cache": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      flat: { type: "boolean", default: false },
      threshold: { type: "string", default: "500" },
      quiet: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log("macreaper v0.1.0");
    return;
  }

  // Refuse to run on non-Darwin — every command depends on macOS-specific
  // tools (tmutil, diskutil, mdfind, BSD stat, /Library paths).
  if (process.platform !== "darwin") {
    console.error(pc.red("✗ macreaper is macOS-only. Bailing."));
    process.exit(1);
  }

  const command = positionals[0] ?? "scan";
  const dryRun = Boolean(values["dry-run"]);
  const fast = Boolean(values.fast);
  const fromCache = Boolean(values["from-cache"]);
  const json = Boolean(values.json);
  const flat = Boolean(values.flat);

  try {
    switch (command) {
      case "scan":
        await cmdScan({ fast, fromCache, json, flat });
        break;
      case "dev":
        await cmdDev({ dryRun, fast, fromCache });
        break;
      case "system":
        await cmdSystem({ dryRun });
        break;
      case "snapshots":
        await cmdSnapshots();
        break;
      case "find-large": {
        const t = parseInt(values.threshold as string, 10);
        await cmdFindLarge(Number.isFinite(t) && t > 0 ? t : 500, { fromCache });
        break;
      }
      case "find-modules":
        await cmdFindModules({ dryRun, fromCache });
        break;
      case "optimize":
        await cmdOptimize();
        break;
      default:
        console.error(pc.red(`Unknown command: ${command}`));
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(pc.red("\n✗ Error: ") + (err instanceof Error ? err.message : String(err)));
    if (err instanceof Error && err.stack) {
      console.error(pc.dim(err.stack));
    }
    process.exit(1);
  }
}

await main();
