// src/lib/optimize.ts
// Preventive recommendations: macOS settings + dev-tool config that keeps
// disk usage from creeping back up after a cleanup.

import { $ } from "bun";
import { pathExists, isProcessRunning } from "./utils.ts";

export interface Recommendation {
  title: string;
  detail: string;
  /** Shell snippet the user can copy-paste. Optional — some recs are GUI-only. */
  command?: string;
  /** "auto" = we can do it for them; "manual" = they need to do it themselves. */
  kind: "auto" | "manual";
}

export async function getRecommendations(): Promise<Recommendation[]> {
  const recs: Recommendation[] = [];

  // 1. Time Machine snapshot management — only relevant if TM is on.
  const tmStatus = await $`tmutil destinationinfo`.quiet().nothrow();
  const tmConfigured = tmStatus.exitCode === 0 && tmStatus.stdout.toString().trim().length > 0;
  if (tmConfigured) {
    recs.push({
      title: "Thin Time Machine local snapshots regularly",
      detail: "macOS keeps hourly APFS snapshots for 24h. Usually fine, but if your disk is tight, thin them weekly so they never become the reason 'About This Mac' shows you out of space.",
      command: "for s in $(tmutil listlocalsnapshots / | sed 's/com.apple.TimeMachine.//'); do sudo tmutil deletelocalsnapshots \"$s\"; done",
      kind: "manual",
    });
  }

  // 2. Docker Desktop disk image cap — Docker tends to hold onto every byte
  // it's ever expanded to.
  if (pathExists("~/Library/Containers/com.docker.docker")) {
    recs.push({
      title: "Cap Docker Desktop's virtual disk size",
      detail: "Docker Desktop → Settings → Resources → Virtual disk limit. Default is 64 GB; drop to 32 GB unless you genuinely need more.",
      kind: "manual",
    });
    recs.push({
      title: "Set Docker to prune build cache automatically",
      detail: "Docker keeps build layers forever by default. Schedule a prune. Uses `command -v docker` so the path works on both /usr/local/bin (Intel) and /opt/homebrew/bin (Apple Silicon).",
      command: "(crontab -l 2>/dev/null; echo \"0 3 * * 0 $(command -v docker) builder prune -a -f\") | crontab -",
      kind: "manual",
    });
  }

  // 3. macOS "Optimize Storage" — offloads old iCloud Drive files when low.
  recs.push({
    title: "Enable macOS Optimize Storage",
    detail: "System Settings → General → Storage → 'Store in iCloud' + 'Optimize Storage'. Offloads watched movies, old Mail attachments, and (for iCloud Drive users) rarely-touched files automatically.",
    kind: "manual",
  });

  // 4. Empty Trash on a schedule.
  recs.push({
    title: "Auto-empty Trash after 30 days",
    detail: "System Settings → General → Storage → 'Empty Trash Automatically'. Saves you from forgetting deleted files are still on disk.",
    kind: "manual",
  });

  // 5. Homebrew autoclean (if brew is present).
  const brewWhich = await $`which brew`.quiet().nothrow();
  if (brewWhich.exitCode === 0) {
    recs.push({
      title: "Enable Homebrew auto-cleanup",
      detail: "Homebrew accumulates old bottle versions forever. Setting HOMEBREW_CLEANUP_PERIODIC_FULL_DAYS=7 makes `brew install/upgrade` clean up weekly.",
      command: "echo 'export HOMEBREW_CLEANUP_PERIODIC_FULL_DAYS=7' >> ~/.zshrc",
      kind: "auto",
    });
  }

  // 6. Recurring scan reminder. Uses `command -v bun` because Bun installs to
  // ~/.bun/bin on most macs and /opt/homebrew/bin on brew-installed setups.
  recs.push({
    title: "Run `macreaper scan` weekly",
    detail: "Dev caches grow silently. A weekly scan keeps you ahead of the problem.",
    command: "(crontab -l 2>/dev/null; echo \"0 9 * * 1 $(command -v bun) \\$HOME/macreaper/src/cli.ts scan >> \\$HOME/.macreaper.log 2>&1\") | crontab -",
    kind: "manual",
  });

  // 7. iCloud Desktop & Documents — only suggest if it's NOT already on.
  // (Iff a user already has it on they don't need the suggestion.)
  const icloudDocs = pathExists("~/Library/Mobile Documents/com~apple~CloudDocs");
  if (!icloudDocs) {
    recs.push({
      title: "Consider iCloud Drive Desktop & Documents",
      detail: "Keeps Desktop + Documents in iCloud and offloads cold files locally. Great if you have iCloud storage to spare; skip if you're already maxed there.",
      kind: "manual",
    });
  }

  // 8. Quick health note if Xcode is running while user is here looking to clean.
  if (await isProcessRunning("Xcode")) {
    recs.push({
      title: "Heads up: Xcode is running",
      detail: "If you intend to clean ~/Library/Developer caches, quit Xcode first. Macreaper refuses to touch DerivedData while Xcode has a handle on it.",
      kind: "manual",
    });
  }

  // 9. iOS Simulator: prune unavailable runtimes — pure win, no rebuild cost.
  if (pathExists("~/Library/Developer/CoreSimulator")) {
    recs.push({
      title: "Prune dead iOS Simulator runtimes",
      detail: "`simctl delete unavailable` removes simulator devices whose iOS runtime is no longer installed. Frees gigabytes with zero downside — these devices can't boot anyway.",
      command: "xcrun simctl delete unavailable",
      kind: "auto",
    });
  }

  // 10. Leftover macOS installer apps in /Applications.
  if (pathExists("/Applications")) {
    recs.push({
      title: "Delete leftover macOS installer apps",
      detail: "After every macOS upgrade, `/Applications/Install macOS <name>.app` is left behind (~12 GB each). Drag to Trash once you've finished the upgrade — Software Update can re-download if you ever need it.",
      command: "ls -la /Applications | grep '^d.*Install macOS' || echo '(no installer apps found)'",
      kind: "manual",
    });
  }

  // 11. GarageBand sound library — only suggest if it's actually installed.
  if (
    pathExists("~/Library/Application Support/GarageBand") ||
    pathExists("/Library/Audio/Apple Loops")
  ) {
    recs.push({
      title: "Audit GarageBand / Apple Loops if you don't make music",
      detail: "GarageBand's full Sound Library + Apple Loops can occupy 20-30 GB. If you don't use GarageBand or Logic, both are pure dead weight and re-downloadable from inside the app if you ever change your mind.",
      kind: "manual",
    });
  }

  // 12. Downloaded TTS voices — Apple makes it hard to discover that these exist.
  if (pathExists("~/Library/Speech/Voices") || pathExists("/Library/Speech/Voices")) {
    recs.push({
      title: "Review downloaded Enhanced/Premium voices",
      detail: "Each Enhanced or Premium voice is 500 MB – 2 GB. Audit them in System Settings → Accessibility → Spoken Content → System Voice → Manage Voices. Keep one or two, delete the rest.",
      kind: "manual",
    });
  }

  // 13. JetBrains Toolbox — the built-in cleanup UIs are hidden in two places.
  if (pathExists("~/Library/Application Support/JetBrains/Toolbox")) {
    recs.push({
      title: "JetBrains Toolbox: clean leftover IDE directories",
      detail: "Toolbox 1.22+ has 'Clean up leftover tool directories' under Settings → Tools. Removes ~/Library/Application Support/JetBrains/<IDE><version> dirs (config/plugins/caches/logs) for IDEs you've uninstalled — JetBrains otherwise only auto-purges caches & logs after 180 days of inactivity, never config & plugins.",
      kind: "manual",
    });
    recs.push({
      title: "JetBrains Toolbox: remove previous-version backups",
      detail: "Toolbox 2.1+ keeps the previous build of every installed IDE for instant rollback. Settings → Tools → 'Remove the previous versions' shows the total size and clears them in one click.",
      kind: "manual",
    });
    recs.push({
      title: "JetBrains: 'Help → Delete Leftover IDE Directories'",
      detail: "From inside any running JetBrains IDE: Help menu → Delete Leftover IDE Directories. Same as the Toolbox option but per-IDE.",
      kind: "manual",
    });
  }

  // 14. Ollama model audit — single biggest local-AI win.
  if (pathExists("~/.ollama/models")) {
    recs.push({
      title: "Audit your Ollama models",
      detail: "Run `ollama list` to see every pulled model and its size, then `ollama rm <model>` for ones you no longer use. Properly handles shared blobs, unlike a raw rm -rf.",
      command: "ollama list",
      kind: "manual",
    });
  }

  // 14b. Claude Desktop Cowork VM — there is no working consumer off-switch
  // as of the macreaper 0.1 cut. Be honest with the user about that instead
  // of telling them to flip a toggle that doesn't exist (or doesn't work).
  // Tracking: anthropics/claude-code #22543 (169+ 👍, still open).
  if (pathExists("~/Library/Application Support/Claude/vm_bundles")) {
    recs.push({
      title: "Claude Cowork VM has no working off-switch (yet)",
      detail: "There is no individual-user setting to prevent ~/Library/Application Support/Claude/vm_bundles/claudevm.bundle from regenerating — even users on the free plan who've never opened Cowork get the full ~10 GB download on launch. The only real fix today is to switch to the web UI (claude.ai) or Claude Code CLI; deleting the bundle works for one session, then the app re-downloads it. Tracking: anthropics/claude-code #22543.",
      kind: "manual",
    });
    recs.push({
      title: "Team / Enterprise admins: disable Cowork org-wide",
      detail: "If you own a Team or Enterprise org, the only sanctioned kill switch lives at claude.ai → Organization settings → Capabilities → Cowork. This is the only place an actual toggle exists; the desktop app has no per-user equivalent.",
      kind: "manual",
    });
    recs.push({
      title: "Periodic Cowork bundle deletion (treadmill)",
      detail: "If you must keep using Claude Desktop on a tight SSD, schedule a weekly purge. The bundle will re-download but at least it won't accumulate alongside a 13-GB sessiondata.img.",
      command: "killall -9 Claude 2>/dev/null; rm -rf ~/Library/Application\\ Support/Claude/vm_bundles ~/Library/Application\\ Support/Claude/Cache ~/Library/Application\\ Support/Claude/Code\\ Cache",
      kind: "manual",
    });
  }

  // 15. Cursor / VS Code workspaceStorage gets huge on long-lived setups.
  if (pathExists("~/Library/Application Support/Cursor/User/workspaceStorage")) {
    recs.push({
      title: "Prune stale Cursor workspaceStorage",
      detail: "Cursor never cleans `User/workspaceStorage` — every project you've ever opened keeps a folder forever. Closes Cursor first, then audit `du -h --max-depth=1` to find the biggest stale ones.",
      command: "du -sh ~/Library/Application\\ Support/Cursor/User/workspaceStorage",
      kind: "manual",
    });
  }
  if (pathExists("~/Library/Application Support/Code/User/workspaceStorage")) {
    recs.push({
      title: "Prune stale VS Code workspaceStorage",
      detail: "Same story as Cursor — VS Code never auto-cleans per-workspace state.",
      command: "du -sh ~/Library/Application\\ Support/Code/User/workspaceStorage",
      kind: "manual",
    });
  }

  // 16. Gradle / Maven — point at the tool-native cleanups.
  if (pathExists("~/.gradle/caches")) {
    recs.push({
      title: "Let Gradle clean itself up",
      detail: "Force Gradle to run its built-in cleanup of stale wrapper distributions and version-bound caches. Much safer than rm -rf ~/.gradle/caches.",
      command: "find ~/.gradle/caches -maxdepth 1 -type d -name '[0-9]*' -mtime +60 -exec rm -rf {} +",
      kind: "manual",
    });
  }

  // 17. Pulumi plugin cache has no native prune yet.
  if (pathExists("~/.pulumi/plugins")) {
    recs.push({
      title: "Audit Pulumi provider plugins manually",
      detail: "Pulumi has no `pulumi plugin prune` command (still an open issue). Inspect `~/.pulumi/plugins` and rm old provider versions you no longer use.",
      command: "ls -lhS ~/.pulumi/plugins | head -20",
      kind: "manual",
    });
  }

  // 18. Android SDK system images add up fast.
  if (pathExists("~/Library/Android/sdk/system-images")) {
    recs.push({
      title: "Audit Android SDK system-images",
      detail: "Every API level you've ever toggled on in SDK Manager is 1.5-3 GB. Open Android Studio → SDK Manager → SDK Platforms and uncheck the ones you don't actively test against.",
      kind: "manual",
    });
  }

  // ── Log-file runaway prevention ────────────────────────────────────────

  // 19. Wrangler — disable disk logging entirely if you don't debug locally.
  if (pathExists("~/.wrangler/logs")) {
    recs.push({
      title: "Disable Wrangler disk logs",
      detail: "Wrangler ≥ 4.91 auto-prunes logs older than 30 days. To skip writing them in the first place, export WRANGLER_WRITE_LOGS=false in your shell rc.",
      command: "echo 'export WRANGLER_WRITE_LOGS=false' >> ~/.zshrc",
      kind: "auto",
    });
  }

  // 20. npm — cap log retention so the _logs dir can't run away.
  if (pathExists("~/.npm/_logs")) {
    recs.push({
      title: "Cap npm log retention",
      detail: "npm keeps the last `logs-max` debug logs (default 10) but bugs leave more behind. Pin it explicitly so the directory can't grow unbounded.",
      command: "npm config set logs-max 5",
      kind: "auto",
    });
  }

  // 21. Homebrew services — postgres/mongo/nginx logs grow forever.
  if (pathExists("/opt/homebrew/var/log") || pathExists("/usr/local/var/log")) {
    recs.push({
      title: "Rotate Homebrew services logs",
      detail: "`brew services` daemons (Postgres, MongoDB, nginx, MySQL, Redis…) write into var/log/<service>.log with no rotation. Set up macOS's `newsyslog` or schedule a periodic truncate so a year of Postgres logs can't reach 5 GB.",
      command: "find /opt/homebrew/var/log /usr/local/var/log -maxdepth 1 -type f -name '*.log' -size +200M 2>/dev/null",
      kind: "manual",
    });
  }

  // 22. cloudflared service writes the launchd stdout/stderr logs forever
  // because launchd has no rotation. The cloudflared binary DOES support
  // automatic rotation, but only via `--log-directory` (hardcoded to 1 MiB
  // per file, 5 backups — see cloudflare/cloudflared#518). The most reliable
  // fix on a service-installed tunnel is either to migrate to log-directory
  // or just truncate periodically.
  if (pathExists("~/Library/Logs/com.cloudflare.cloudflared.out.log")) {
    recs.push({
      title: "Truncate or migrate cloudflared service logs",
      detail: "The service-installed cloudflared writes ~/Library/Logs/com.cloudflare.cloudflared.{out,err}.log via launchd indefinitely — no rotation. Either pass `--log-directory /path/to/dir` in your cloudflared service args (gets automatic 1 MiB × 5 rotation) or schedule a truncate.",
      command: ": > ~/Library/Logs/com.cloudflare.cloudflared.out.log && : > ~/Library/Logs/com.cloudflare.cloudflared.err.log",
      kind: "manual",
    });
  }

  // 23. DiagnosticReports — macOS lets crash files pile up indefinitely too.
  if (pathExists("~/Library/Logs/DiagnosticReports")) {
    recs.push({
      title: "Periodically clear old crash reports",
      detail: "macOS doesn't auto-purge ~/Library/Logs/DiagnosticReports. Useful right after a crash; otherwise disposable.",
      command: "find ~/Library/Logs/DiagnosticReports -type f -mtime +60 -delete",
      kind: "manual",
    });
  }

  // ── Multi-version + duplicate-binary prevention ──────────────────────────

  // 24. Volta — `volta list` shows everything; `volta uninstall` removes one.
  if (pathExists("~/.volta/tools/image/node")) {
    recs.push({
      title: "Prune unused Volta Node versions",
      detail: "`volta list node` shows every installed version. Drop the ones no project pins (check the 'default' line and your `volta which node` per project).",
      command: "volta list",
      kind: "manual",
    });
  }

  // 25. nvm
  if (pathExists("~/.nvm/versions/node")) {
    recs.push({
      title: "Prune unused nvm Node versions",
      detail: "`nvm ls` shows everything installed. `nvm uninstall <ver>` per version. Pin defaults via `nvm alias default <ver>`.",
      command: "nvm ls",
      kind: "manual",
    });
  }

  // 26. mise has a native prune.
  if (pathExists("~/.local/share/mise/installs")) {
    recs.push({
      title: "Auto-prune unused mise installs",
      detail: "`mise prune --dry-run` shows what would be removed (anything not referenced by a .tool-versions or mise.toml). Drop --dry-run to commit.",
      command: "mise prune --dry-run",
      kind: "auto",
    });
  }

  // 27. n
  if (pathExists("/usr/local/n/versions/node") || pathExists("~/.n/versions/node")) {
    recs.push({
      title: "Prune unused `n` Node versions",
      detail: "`n prune` keeps only the active version and removes the rest. Fast win on machines that switch Node a lot.",
      command: "n prune",
      kind: "auto",
    });
  }

  // 28. yao-pkg / Vercel pkg cache — clears safely; pkg refetches on demand.
  if (pathExists("~/.pkg-cache")) {
    recs.push({
      title: "Clear yao-pkg / Vercel pkg cache",
      detail: "Prebuilt Node binaries pkg downloads for bundling. Refetched on demand the next time you bundle for that platform/arch.",
      command: "rm -rf ~/.pkg-cache/*",
      kind: "auto",
    });
  }

  // 29. Cursor agent worktrees — point to git's native worktree remove.
  if (pathExists("~/.cursor/worktrees")) {
    recs.push({
      title: "Remove stale Cursor agent worktrees",
      detail: "Each ~/.cursor/worktrees/<repo>/<branch> dir carries its own node_modules. Run `git worktree remove` from inside the parent repo to clean both the dir and git's metadata; otherwise just `rm -rf` the branch folder after merging.",
      command: "ls -lh ~/.cursor/worktrees",
      kind: "manual",
    });
  }

  // 30. node_modules dedupe story — only relevant for npm/yarn-classic users.
  // Bun + pnpm + yarn berry already hardlink so the duplication doesn't bite.
  if (pathExists("~/.npm")) {
    recs.push({
      title: "Switch to pnpm or Bun to dedupe native binaries",
      detail: "If `macreaper scan` is flagging multiple copies of workerd / @swc/core / sharp / etc., the cheapest fix is migrating from npm or classic yarn to pnpm (content-addressable hardlinks) or Bun (global cache + hardlinks). Same install, real disk savings.",
      kind: "manual",
    });
  }

  // 31. iCloud Drive evictable — brctl evict is the surgical tool.
  if (pathExists("~/Library/Mobile Documents/com~apple~CloudDocs")) {
    recs.push({
      title: "Use `brctl evict` to push iCloud Drive files back to the cloud",
      detail: "macOS's Optimize Storage doesn't always evict promptly. `brctl evict` immediately offloads a path to cloud-only (files stay browsable, download on open). Replace the path below with whichever subfolder is hogging space.",
      command: "brctl evict ~/Library/Mobile\\ Documents/com~apple~CloudDocs/<folder>",
      kind: "manual",
    });
  }

  // 32. Steam library — Steam itself is the safest uninstaller.
  if (pathExists("~/Library/Application Support/Steam/steamapps/common")) {
    recs.push({
      title: "Uninstall unused Steam games from Steam, not the Finder",
      detail: "Steam tracks install state per game. Use Steam → Library → right-click → Manage → Uninstall so the manifest stays correct. Cloud saves are preserved.",
      kind: "manual",
    });
  }

  // 33. Communication apps — clear inside-app, not via Finder.
  if (pathExists("~/Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram")) {
    recs.push({
      title: "Clear Telegram cache from the app, not Finder",
      detail: "Telegram → Settings → Data and Storage → Storage Usage → Clear All. Safer than deleting the folder because Telegram tracks references; deleting the folder while running can corrupt the local database.",
      kind: "manual",
    });
  }
  if (pathExists("~/Library/Application Support/Slack/Service Worker/CacheStorage")) {
    recs.push({
      title: "Slack: Help → Troubleshooting → Clear Cache and Restart",
      detail: "Slack has a built-in cache-clear under Help → Troubleshooting. Cleaner than deleting the dirs directly because Slack rebuilds them properly on next launch.",
      kind: "manual",
    });
  }

  // ── Root-owned macOS internals ────────────────────────────────────────────

  // 34. Pending Software Update payloads — Apple's daemon doesn't reliably
  // prune /Library/Updates after install, leaving multi-GB .pkg files.
  if (pathExists("/Library/Updates")) {
    recs.push({
      title: "Clear post-install Software Update payloads",
      detail: "After a macOS or Xcode CLI Tools update installs, the original .pkg payloads sometimes linger in /Library/Updates/<id>/. Keep the .plist index files at the root; just nuke the per-id subdirs.",
      command: "sudo find /Library/Updates -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +",
      kind: "manual",
    });
  }

  // 35. Unified logging — Apple's stance is don't, but `log erase --all` is
  // the sanctioned escape hatch when the dir has runaway.
  if (pathExists("/private/var/db/diagnostics")) {
    recs.push({
      title: "If unified logs have run away, use the sanctioned reset",
      detail: "logd targets ~520 MB total. If /private/var/db/diagnostics is multi-GB, `sudo log erase --all` resets it cleanly. This is destructive (loses Time Machine + XProtect history); only run if you're truly out of space and don't need recent system logs.",
      command: "sudo log erase --all",
      kind: "manual",
    });
  }

  // 36. /Library/Caches system-wide — apps regenerate, sudo required.
  if (pathExists("/Library/Caches")) {
    recs.push({
      title: "Wipe system-wide /Library/Caches contents",
      detail: "System-wide caches written by Adobe, Microsoft Office, installers, etc. Separate from your user ~/Library/Caches. Wipe contents only — keep the dir itself. Apps re-cache on next launch.",
      command: "sudo find /Library/Caches -mindepth 1 -delete",
      kind: "manual",
    });
  }

  // ── Spotlight ─────────────────────────────────────────────────────────────
  //
  // Spotlight bloat is one of the worst on dev machines because every file
  // under node_modules / .git / target / build gets indexed by default. The
  // tips below ladder from "least disruptive" (exclude dev folders) to
  // "nuclear" (recovery-mode rebuild).

  // 38. The single highest-ROI Spotlight tip: exclude your dev tree.
  // System Settings UI is the discoverable path; the `.metadata_never_index`
  // marker is the scriptable per-folder one. Both still work on Sequoia 15.x.
  recs.push({
    title: "Exclude dev folders from Spotlight (single biggest Spotlight win)",
    detail:
      "Every file under node_modules / .git / target / Pods / build gets indexed by default — on a dev machine that's millions of files Spotlight has no reason to ever surface. " +
      "Two ways: " +
      "(1) System Settings → Spotlight → Search Privacy → '+' and add ~/work (or wherever your code lives) — easiest and persists across reboots. " +
      "(2) Drop a `.metadata_never_index` marker in each folder you want skipped (works even if the parent is indexed). " +
      "After excluding, run `sudo mdutil -E /` once to rebuild without those paths.",
    command: "touch ~/work/.metadata_never_index",
    kind: "manual",
  });

  // 39. Bulk-mark every node_modules. Reuses the find-modules cache if it
  // exists so we don't re-walk $HOME. Side-effect-free for already-marked dirs.
  if (pathExists("~/Library/Caches/macreaper/node-modules.json")) {
    recs.push({
      title: "Drop `.metadata_never_index` into every node_modules",
      detail:
        "Bulk-applies the (2) trick above to every node_modules `macreaper find-modules` discovered. The marker file is ~0 bytes and Spotlight respects it on the next index pass — no need to delete the existing index first.",
      command:
        "bun -e \"const f=JSON.parse(await Bun.file(`${process.env.HOME}/Library/Caches/macreaper/node-modules.json`).text());for(const p of f.paths)await Bun.write(p.path+'/.metadata_never_index','');\"",
      kind: "auto",
    });
  }

  // 40. CoreSpotlight bloat — the user-side pile that grows for no good
  // reason on long-running installs.
  if (pathExists("~/Library/Metadata/CoreSpotlight")) {
    recs.push({
      title: "Clear bloated CoreSpotlight metadata (Priority / SpotlightKnowledgeEvents)",
      detail:
        "~/Library/Metadata/CoreSpotlight regularly hits 10–100 GB on dev machines. The `Priority` and `NSFileProtectionCompleteUntilFirstUserAuthentication` subdirs are the usual offenders. Safe to delete from a normal terminal — Spotlight rebuilds what it actually needs (expect a few hours of background CPU). Quit Spotlight-heavy apps (Mail, Notes) first if possible.",
      command: "rm -rf ~/Library/Metadata/CoreSpotlight/*",
      kind: "manual",
    });
  }

  // 41. mdutil category control — narrow disable when you want indexing
  // mostly-on but not for the boot volume's Time Machine snapshots.
  recs.push({
    title: "Disable Spotlight indexing on external & backup volumes",
    detail:
      "External drives (Time Machine targets, scratch SSDs, backup volumes) usually shouldn't be indexed at all. `sudo mdutil -i off /Volumes/<name>` disables and frees the on-volume `.Spotlight-V100`. For the boot volume, prefer Search Privacy exclusions (above) over a full disable, because a full disable also breaks the menubar Spotlight search.",
    command: "sudo mdutil -i off /Volumes/<external-drive-name>",
    kind: "manual",
  });

  // 42. Rebuild — the right knob when the index is *corrupt*, not when
  // it's just large. People reach for this too often; flag it as a fix, not
  // a space-saver.
  recs.push({
    title: "Rebuild Spotlight (only when search is broken, not to save space)",
    detail:
      "`sudo mdutil -E /` erases the boot-volume index and rebuilds from scratch. Use this when search returns wrong/no results, or after adding Search Privacy exclusions so the new index respects them. It does NOT permanently save space — the rebuilt index will grow back to the same size unless you also exclude folders.",
    command: "sudo mdutil -E /",
    kind: "manual",
  });

  // 43. The nuclear option for .Spotlight-V100. Requires Recovery Mode
  // because the path is SIP-protected from regular root.
  if (pathExists("/System/Volumes/Data/.Spotlight-V100") || pathExists("/.Spotlight-V100")) {
    recs.push({
      title: "Nuclear: delete /.Spotlight-V100 from Recovery Mode (only if multi-GB bloat)",
      detail:
        "The volume-level Spotlight index is root + SIP-protected; normal `sudo rm` will fail. If `macreaper scan` reports /.Spotlight-V100 in the tens of GB, the cleanup procedure is: " +
        "(1) Shut down. (2) Apple Silicon: hold power until 'Loading startup options'; Intel: hold Cmd+R at boot. " +
        "(3) Utilities → Terminal. (4) Run `rm -rf /System/Volumes/Data/.Spotlight-V100`. (5) Reboot. " +
        "(6) Before Spotlight reindexes, add your dev folders to Search Privacy — otherwise it'll grow right back. Time investment: ~5 min for the delete, ~hours for the rebuild.",
      kind: "manual",
    });
  }

  // 37. Cursor / VS Code SQLite state DBs — VACUUM, never delete.
  if (
    pathExists("~/Library/Application Support/Cursor/User/globalStorage/state.vscdb") ||
    pathExists("~/Library/Application Support/Code/User/globalStorage/state.vscdb")
  ) {
    recs.push({
      title: "VACUUM bloated state.vscdb (Cursor / VS Code) — never delete",
      detail:
        "Cursor and VS Code never VACUUM their SQLite state DB, so deleted rows accumulate as dead pages. " +
        "On long-running installs the file commonly hits 5–15 GB. Quit the editor fully (Cmd+Q, not just close window) then VACUUM in place: " +
        "you keep all chat history & workspace recents but typically reclaim 50–90% of the file size. " +
        "Repeat for VS Code by swapping 'Cursor' → 'Code'. The .backup sibling is regenerated on next write, so deleting it is free.",
      command:
        "sqlite3 ~/Library/Application\\ Support/Cursor/User/globalStorage/state.vscdb 'VACUUM;'",
      kind: "manual",
    });
  }

  return recs;
}
