# 🔪 macreaper

A Bun-powered CLI that reclaims disk space on your Mac, with developer caches as a first-class concern.

Built because every "Mac cleaner" app either ignores the dev-shaped 100 GB of cache rot on a typical dev machine, or charges $50/yr for the privilege of telling you about it.

## What it does

- **Scans** the places that actually fill up a Mac SSD:
  - **JS / Node**: npm, Bun, pnpm, Yarn 1.x, Yarn Berry, stray `node_modules` anywhere on disk.
  - **Headless-browser test runners**: Playwright (`ms-playwright`), Puppeteer, Cypress, Electron download cache.
  - **Other languages**: Python (pip, Poetry, uv, conda), Rust (Cargo registry + git + src), Go (build cache + module cache), Homebrew.
  - **Multi-version toolchains**: Volta, nvm, fnm, asdf, mise, n, pyenv, rbenv, rustup — every old Node/Python/Ruby/Rust version you forgot to uninstall, with version count per manager.
  - **JVM**: Gradle caches + wrapper distros + daemon, Maven `.m2`, sbt, Coursier, Ivy, Kotlin/Native.
  - **Mobile**: CocoaPods, Swift Package Manager, Carthage, Flutter / Dart pub-cache, Android SDK system-images/platforms/NDK, individual AVDs.
  - **Xcode & Apple dev**: DerivedData, Archives, iOS/watchOS/tvOS DeviceSupport, CoreSimulator devices + caches + logs, plus a one-liner to prune unavailable simulator runtimes.
  - **IDEs**: JetBrains caches/logs, VS Code (all the Electron caches + workspaceStorage), Cursor (same), Zed.
  - **Cursor / VS Code SQLite state DBs**: flags every `state.vscdb.backup` for free deletion, and flags the main `state.vscdb` when it exceeds 500 MB with a `VACUUM` command (never deletion) that preserves chat history while reclaiming 50-90%.
  - **Editor extensions & remote-dev servers**: `~/.cursor/extensions`, `~/.vscode/extensions`, `~/.vscode-server`, `~/.cursor-server`.
  - **Cursor agent worktrees**: every `~/.cursor/worktrees/<repo>/<branch>` listed with size + age — each carries its own `node_modules`.
  - **AI / local LLMs**: Ollama models, Hugging Face hub/datasets/xet caches, LM Studio (both `~/.lmstudio` and `~/.cache/lm-studio`), OpenAI Whisper, PyTorch hub, Claude Cowork VM bundles.
  - **Cloud & IaC**: AWS CLI cache + SAM, gcloud cache & logs, Azure object cache, Terraform plugin-cache, Pulumi plugins, kubectl, Helm.
  - **Containers**: Docker Desktop VM disk, Colima, OrbStack.
  - **Heavy native binaries duplicated across `node_modules`**: workerd, esbuild, `@swc/core`, sharp, `@next/swc`, lightningcss, rollup native, `@biomejs/cli`, turbo, `@tailwindcss/oxide`, `@parcel/watcher`, electron — counts copies, totals size, suggests pnpm/Bun migration.
  - **pkg / yao-pkg cache**: every prebuilt Node binary in `~/.pkg-cache/v*/fetched-*`.
  - **Comms apps' on-disk caches**: Slack (Cache, Code Cache, GPUCache, Service Worker), Discord (Cache, Code Cache, GPUCache), Microsoft Teams (new + Classic), WhatsApp Desktop group container + iCloud backup mirror, Telegram media cache, Zoom auto-updater, Spotify offline cache.
  - **Steam library**: every installed game in `steamapps/common/` with last-played date, plus shadercache and interrupted-download remnants.
  - **Log-file runaways**: Wrangler logs (unbounded pre-v4.91), npm `_logs`, Ollama `server.log`, Homebrew install + `brew services` (postgres/mongo/nginx/mysql) logs, cloudflared service logs, `gh` workflow-log cache, Slack/Discord/Zoom/Teams/Notion/Spotify logs, macOS DiagnosticReports.
  - **macOS-only piles**: leftover `Install macOS *.app` installers in `/Applications`, Mail Downloads (current + legacy paths), GarageBand / Logic sound libraries, Apple Loops, downloaded Enhanced/Premium TTS voices.
  - **Root-owned macOS internals** (need `sudo` to clean): pending Software Update payloads in `/Library/Updates/<id>`, unified-log `tracev3` archives in `/private/var/db/diagnostics`, system-wide `/Library/Caches` + `/Library/Logs`, the per-user `DARWIN_USER_CACHE_DIR` under `/private/var/folders`, legacy Apple System Log archives.
  - **System**: user caches & logs, Time Machine local snapshots, iOS device backups, Downloads.
- **Classifies** each finding by risk:
  - 🟢 SAFE — caches the tool rebuilds on demand
  - 🟡 CAUTION — caches that cost a re-download
  - 🔴 RISKY — irreplaceable data (iOS backups, Downloads); always asks before touching
- **Cleans** interactively, conservatively, and reversibly (everything goes to `~/.Trash`, never `rm -rf`).
- **Optimizes** macOS settings to prevent the buildup from coming back.

## Install

Requires [Bun](https://bun.sh) ≥ 1.0 and macOS.

```bash
git clone <this-repo> macreaper
cd macreaper
bun install
chmod +x src/cli.ts

# Run directly
./src/cli.ts scan

# Or symlink it onto your PATH
ln -s "$PWD/src/cli.ts" /usr/local/bin/macreaper
macreaper scan
```

Want a single binary you can drop on any Mac?

```bash
bun run build       # Apple Silicon → bin/macreaper
bun run build:intel # Intel         → bin/macreaper-intel
```

Or grab the latest pre-built binary from [Releases](https://github.com/roopen219/macreaper/releases):

```bash
# Apple Silicon
curl -L -o macreaper https://github.com/roopen219/macreaper/releases/latest/download/macreaper
chmod +x macreaper
sudo mv macreaper /usr/local/bin/

# Intel
curl -L -o macreaper https://github.com/roopen219/macreaper/releases/latest/download/macreaper-intel
chmod +x macreaper
sudo mv macreaper /usr/local/bin/
```

Every release ships a `SHA256SUMS` file you can verify with `shasum -a 256 -c SHA256SUMS`.

## Commands

| Command | What it does |
|---|---|
| `macreaper scan` *(default)* | Full diagnostic — disk free + every finding grouped by category (~3-5 min) |
| `macreaper scan --fast` | Same, but skips the two `$HOME` `find`-walks (~60 s) |
| `macreaper scan --from-cache` | Replay the last scan instantly from `~/Library/Caches/macreaper/last-scan.json` |
| `macreaper scan --json` | Machine-readable JSON on stdout (progress on stderr) — pipe into `jq` or an LLM |
| `macreaper scan --flat` | Single sorted table instead of per-group sub-tables |
| `macreaper dev` | Interactive cleanup of developer caches (`--fast`, `--from-cache` supported) |
| `macreaper system` | Clean user caches, logs, and friends |
| `macreaper snapshots` | List & delete Time Machine local snapshots |
| `macreaper find-large [--threshold MB]` | Locate files above N MB (default 500) — supports `--from-cache` |
| `macreaper find-modules` | Find every `node_modules` folder, sort by size, pick which to nuke — supports `--from-cache` |
| `macreaper optimize` | Preventive recommendations + copy-paste commands |

Add `--dry-run` to any cleanup command to preview without changes.

## Scan cache & LLM workflow

Every `scan` writes a normalised JSON snapshot to `~/Library/Caches/macreaper/last-scan.json`.
The two `find $HOME` commands maintain their own sibling caches:
- `~/Library/Caches/macreaper/node-modules.json` — populated by `find-modules` and any full `scan`
  (since `scan`'s Node scanner already walks `$HOME` for `node_modules`).
- `~/Library/Caches/macreaper/large-files.json` — populated by `find-large` and re-filtered for free
  when you re-run with a larger `--threshold`.

You can replay any of them instantly with `--from-cache`, or pipe the scan into anything that takes JSON:

```bash
# Quick scan, then ask Claude / Codex / your tool of choice to pick the safest wins
macreaper scan --fast
macreaper scan --from-cache --json | llm \
  "From this macreaper scan, list the 5 safest items to clean to reclaim the most space.
   For each, return: label, size, risk, command (cleanCommand or 'move to Trash'),
   and a one-line justification."
```

The JSON shape is small and stable — `version`, `scannedAt`, `disk`, `scannerTimingsMs`, and
a `targets[]` array where each item has `label`, `path`, `size`, `risk`, `description`,
`rebuildCost`, `category`, `group`, and optionally `cleanCommand`. Functions (guards) are
stripped on serialize because they need a live system to evaluate.

## Safety model

- **No permanent deletes.** Everything moves to `~/.Trash` — recoverable from Finder until you empty Trash.
- **Tool-native commands preferred.** When Docker has its own `prune` or Homebrew has its own `cleanup`, we use those because the tool knows what's *actually* disposable better than we do.
- **Guards.** Won't nuke Docker caches if the daemon isn't running, won't touch Xcode caches if Xcode is open, etc.
- **Whitelisted paths only.** Every scanner lists explicit paths; macreaper never walks `/` and deletes "stuff that looks unused."
- **Conservative defaults.** Nothing is pre-selected in the multi-select UI. You opt in to each item.

## Why Bun?

- Single TS file with a shebang — no build step to iterate.
- 10× faster cold-start than Node, which matters for a CLI you run often.
- `Bun.$` for shell calls with proper escaping (no shell-injection footguns).
- `bun build --compile` if you ever want a standalone binary.

## License

MIT
