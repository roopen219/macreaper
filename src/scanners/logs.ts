// src/scanners/logs.ts
// Log-file runaways — the silent class of disk hogs. Most dev tools log to
// disk by default and surprisingly few of them ever rotate or prune. This
// scanner targets the *known offenders* whose log directories grow without
// bound rather than re-scanning the generic ~/Library/Logs catch-all (that
// one is already surfaced in system.ts as "User application logs").
//
// Notable runaways documented in upstream issues:
//   - Wrangler:    unbounded until v4.91.0 (cloudflare/workers-sdk #10523)
//   - npm:         logs-max bugs leave _logs uncleaned (npm/cli #6270, #7032)
//   - Ollama:      server.log grows without rotation
//   - cloudflared: out/err log files have no built-in rotation
//   - gh:          run-log-*.zip files persist forever in cache
//
// Where a path also lives under ~/Library/Logs (Homebrew install logs,
// DiagnosticReports), we surface it here at finer granularity AND it shows
// up inside the generic "User application logs" total — pick one to clean.

import type { CleanTarget } from "../lib/types.ts";
import { scanCacheSpecs, type CacheSpec } from "../lib/utils.ts";

// ── Dev-tool logs (category: "dev") ─────────────────────────────────────
const DEV_LOGS: CacheSpec[] = [
  {
    label: "Wrangler logs",
    path: "~/.wrangler/logs",
    description: "Cloudflare Workers SDK writes a fresh log file per `wrangler dev` / deploy. Unbounded before wrangler 4.91 — that's the version that added a 30-day autoprune. Set WRANGLER_WRITE_LOGS=false to disable disk logging entirely.",
    rebuildCost: "None — logs are diagnostic-only",
  },
  {
    label: "npm debug logs",
    path: "~/.npm/_logs",
    description: "Per-invocation npm-debug-*.log files. Should be capped by `logs-max` (default 10) but historic bugs (npm/cli #6270) leave them behind.",
    rebuildCost: "None — diagnostic only",
  },
  // Note: Yarn 1.x writes `yarn-error.log` to the project CWD, not a central
  // dir. pnpm has no documented persistent log directory on macOS. Bun uses
  // bun.report URLs rather than on-disk logs. So none of those get a scanner
  // entry here — chasing per-project files is the job of `find-large`.
  {
    label: "Ollama server log",
    path: "~/.ollama/logs",
    description: "Ollama's server.log + rotated server-N.log files. No built-in rotation; grows for the lifetime of the install.",
    rebuildCost: "None — Ollama starts fresh logs on next launch",
  },
  {
    label: "Homebrew install logs",
    path: "~/Library/Logs/Homebrew",
    description: "Per-formula install/upgrade logs (config.log, postinstall, etc.). Also counted in 'User application logs' from the system scan — pick one to clean.",
    rebuildCost: "None — fresh logs accumulate on next `brew install/upgrade`",
  },
  {
    label: "Homebrew services logs (Apple Silicon)",
    path: "/opt/homebrew/var/log",
    description: "stdout/stderr from every `brew services` daemon: postgres.log, mongo.log, nginx.log, mysql.log, redis.log, etc. No rotation — easily 1 GB+ if you've run a local Postgres for a year.",
    rebuildCost: "Services write fresh logs on next start",
  },
  {
    label: "Homebrew services logs (Intel)",
    path: "/usr/local/var/log",
    description: "stdout/stderr from every `brew services` daemon (Intel Mac path).",
    rebuildCost: "Services write fresh logs on next start",
  },
  {
    label: "cloudflared service stdout",
    path: "~/Library/Logs/com.cloudflare.cloudflared.out.log",
    description: "Cloudflare Tunnel service stdout when running via `cloudflared service install`. No built-in rotation.",
    rebuildCost: "None — fresh log on next start",
  },
  {
    label: "cloudflared service stderr",
    path: "~/Library/Logs/com.cloudflare.cloudflared.err.log",
    description: "Cloudflare Tunnel service stderr. Same rotation story as the stdout log.",
    rebuildCost: "None — fresh log on next start",
  },
  {
    label: "GitHub CLI run-log cache",
    path: "~/.cache/gh",
    description: "Workflow run logs downloaded by `gh run view --log` as run-log-*.zip files. Cached forever; no native prune.",
    rebuildCost: "Re-downloaded by `gh run view` on next look-up",
  },
];

// ── System / macOS logs (category: "system") ───────────────────────────
const SYSTEM_LOGS: CacheSpec[] = [
  {
    label: "User crash reports (DiagnosticReports)",
    path: "~/Library/Logs/DiagnosticReports",
    description: "Per-user .ips / .spin / .diag crash and hang reports. Useful right after a crash, otherwise disposable. Also rolled into 'User application logs'.",
    rebuildCost: "None — new crashes generate fresh reports",
  },
  {
    label: "System crash reports (DiagnosticReports)",
    path: "/Library/Logs/DiagnosticReports",
    description: "System-wide .ips / .spin crash reports written by privileged processes.",
    rebuildCost: "None — new crashes generate fresh reports",
  },
  {
    label: "Crash Reporter local cache",
    path: "~/Library/Application Support/CrashReporter",
    description: "Local working cache for crash reporting subsystem.",
    rebuildCost: "Rebuilds as needed",
  },
];

// ── User-facing comms-app logs (category: "user") ──────────────────────
// These all live under ~/Library/Logs so they're also inside the generic
// "User application logs" bucket — granular entries help the user pick.
const USER_APP_LOGS: CacheSpec[] = [
  {
    label: "Slack logs",
    path: "~/Library/Logs/Slack",
    description: "Slack desktop app log directory. Slack has a known habit of writing verbose logs continuously.",
    rebuildCost: "None — Slack starts fresh logs on next launch",
  },
  {
    label: "Discord logs",
    path: "~/Library/Logs/Discord",
    description: "Discord desktop app log directory.",
    rebuildCost: "None",
  },
  {
    label: "Zoom logs",
    path: "~/Library/Logs/zoom.us",
    description: "Zoom desktop client logs. Zoom has had public issues with logs growing into the multi-GB range.",
    rebuildCost: "None",
  },
  {
    label: "Microsoft Teams (Classic) logs",
    path: "~/Library/Application Support/Microsoft/Teams/logs.txt",
    description: "Classic Teams' rolling logs.txt. The 'new Teams' rewrite no longer writes here, so this only matters if you still run Teams Classic.",
    rebuildCost: "None",
  },
  {
    label: "Notion logs",
    path: "~/Library/Logs/Notion",
    description: "Notion desktop app logs.",
    rebuildCost: "None",
  },
  {
    label: "Spotify logs",
    path: "~/Library/Logs/Spotify",
    description: "Spotify desktop client logs.",
    rebuildCost: "None",
  },
];

export async function scanLogs(): Promise<CleanTarget[]> {
  const [dev, sys, user] = await Promise.all([
    scanCacheSpecs(DEV_LOGS, "dev"),
    scanCacheSpecs(SYSTEM_LOGS, "system"),
    scanCacheSpecs(USER_APP_LOGS, "user"),
  ]);
  return [...dev, ...sys, ...user];
}
