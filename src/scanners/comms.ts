// src/scanners/comms.ts
// Desktop comms apps (Slack, Discord, Teams, WhatsApp, Telegram) all ship as
// Electron or Catalyst wrappers and accumulate Electron-style cache subdirs
// (Cache, Code Cache, GPUCache, Service Worker/CacheStorage) plus rich media
// caches that grow without bound.
//
// We surface each cache subdir individually rather than the parent
// Application Support folder — the parent folder also holds chat state /
// credentials we never want users to nuke by accident.
//
// Paths verified for the macOS 2026 builds of each app.

import type { CleanTarget } from "../lib/types.ts";
import { scanCacheSpecs, type CacheSpec, isProcessRunning } from "../lib/utils.ts";

const SLACK: CacheSpec[] = [
  {
    label: "Slack Cache",
    path: "~/Library/Application Support/Slack/Cache",
    description: "Slack's Electron HTTP cache (images, attachments thumbnails).",
    rebuildCost: "Refetches when you scroll back to old messages",
  },
  {
    label: "Slack Code Cache",
    path: "~/Library/Application Support/Slack/Code Cache",
    description: "Slack's V8 compiled-code cache.",
    rebuildCost: "Slower first launch after cleanup",
  },
  {
    label: "Slack GPUCache",
    path: "~/Library/Application Support/Slack/GPUCache",
    description: "Slack's GPU shader cache.",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "Slack Service Worker cache",
    path: "~/Library/Application Support/Slack/Service Worker/CacheStorage",
    description: "Slack's service-worker offline cache. Frequently the biggest single Slack dir on long-running installs.",
    rebuildCost: "Refetches from network on next sync",
  },
  {
    label: "Slack OS-level cache",
    path: "~/Library/Caches/com.tinyspeck.slackmacgap",
    description: "Slack's macOS-level OS cache (separate from the in-app caches above).",
    rebuildCost: "Rebuilds on next launch",
  },
];

const DISCORD: CacheSpec[] = [
  {
    label: "Discord Cache",
    path: "~/Library/Application Support/discord/Cache",
    description: "Discord's Electron HTTP cache (images, GIFs, videos, avatars).",
    rebuildCost: "Refetches media on next view",
  },
  {
    label: "Discord Code Cache",
    path: "~/Library/Application Support/discord/Code Cache",
    description: "Discord's V8 compiled-code cache.",
    rebuildCost: "Slower first launch after cleanup",
  },
  {
    label: "Discord GPUCache",
    path: "~/Library/Application Support/discord/GPUCache",
    description: "Discord's GPU shader cache.",
    rebuildCost: "Rebuilds on next launch",
  },
];

const TEAMS: CacheSpec[] = [
  {
    label: "Microsoft Teams (new) cache",
    path: "~/Library/Group Containers/UBF8T346G9.com.microsoft.teams2/Library/Caches",
    description: "New Teams (MAUI rewrite) macOS cache directory.",
    rebuildCost: "Refetches media on next view",
  },
  {
    label: "Microsoft Teams (Classic) cache",
    path: "~/Library/Application Support/Microsoft/Teams/Cache",
    description: "Classic Teams Electron HTTP cache. Only matters if you still run Teams Classic.",
    rebuildCost: "Refetches media on next view",
  },
  {
    label: "Microsoft Teams (Classic) Code Cache",
    path: "~/Library/Application Support/Microsoft/Teams/Code Cache",
    description: "Classic Teams V8 compiled-code cache.",
    rebuildCost: "Slower first launch after cleanup",
  },
];

const WHATSAPP: CacheSpec[] = [
  {
    label: "WhatsApp Desktop group container",
    path: "~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared",
    description: "WhatsApp Desktop's chat history + cached media. Can balloon to 50+ GB on heavy-media accounts because WhatsApp downloads every photo/video shown to you. Use WhatsApp → Settings → Storage and Data → Manage storage to clear by chat before nuking the folder.",
    rebuildCost: "Local chat history & cached media are gone — chats re-sync from the phone but media won't redownload until reopened",
    risk: "risky",
  },
  {
    label: "WhatsApp iCloud backup mirror",
    path: "~/Library/Mobile Documents/57T9237FN3~net~whatsapp~WhatsApp/Accounts",
    description: "WhatsApp's iCloud-backed media backup mirror. Holds Media.tar / Document.tar per account.",
    rebuildCost: "Re-uploaded from your phone on next iCloud backup",
    risk: "caution",
  },
];

const TELEGRAM: CacheSpec[] = [
  {
    label: "Telegram media cache",
    path: "~/Library/Group Containers/6N38VWS5BX.ru.keepcoder.Telegram/cache",
    description: "Telegram's auto-download media cache. Famous for growing to 100+ GB on accounts that auto-download large files. Settings → Data and Storage → Storage Usage → Clear All inside the app is the cleanest path.",
    rebuildCost: "Re-downloads on demand when you reopen messages",
    risk: "caution",
  },
  {
    label: "Telegram OS-level cache",
    path: "~/Library/Caches/ru.keepcoder.Telegram",
    description: "Telegram's macOS-level OS cache (separate from the in-app media cache).",
    rebuildCost: "Rebuilds on next launch",
  },
];

const ZOOM: CacheSpec[] = [
  {
    label: "Zoom app cache",
    path: "~/Library/Application Support/zoom.us/AutoUpdater",
    description: "Old Zoom auto-updater payloads kept after upgrades.",
    rebuildCost: "Re-downloaded on next update",
  },
];

const SPOTIFY: CacheSpec[] = [
  {
    label: "Spotify offline cache",
    path: "~/Library/Caches/com.spotify.client",
    description: "Spotify's local audio cache (streams + downloaded tracks for offline). Configurable via Spotify → Settings → Storage → Cache size.",
    rebuildCost: "Tracks re-stream / re-download on next play",
    risk: "caution",
  },
];

export async function scanComms(): Promise<CleanTarget[]> {
  // Guards: refuse to nuke caches of apps that are actively running. Most of
  // these are Electron and the renderer will throw if its cache disappears
  // mid-session.
  const guards = await Promise.all([
    isProcessRunning("Slack"),
    isProcessRunning("Discord"),
    isProcessRunning("Microsoft Teams"),
    isProcessRunning("WhatsApp"),
    isProcessRunning("Telegram"),
    isProcessRunning("zoom.us"),
    isProcessRunning("Spotify"),
  ]);
  const [slackOn, discordOn, teamsOn, whatsappOn, telegramOn, zoomOn, spotifyOn] = guards;

  const withGuard = (specs: CacheSpec[], appName: string, running: boolean): CacheSpec[] =>
    specs.map((s) =>
      running ? { ...s, guard: async () => `${appName} is running — quit it before cleaning this` } : s,
    );

  const [slack, discord, teams, whatsapp, telegram, zoom, spotify] = await Promise.all([
    scanCacheSpecs(withGuard(SLACK, "Slack", slackOn), "user"),
    scanCacheSpecs(withGuard(DISCORD, "Discord", discordOn), "user"),
    scanCacheSpecs(withGuard(TEAMS, "Microsoft Teams", teamsOn), "user"),
    scanCacheSpecs(withGuard(WHATSAPP, "WhatsApp", whatsappOn), "user"),
    scanCacheSpecs(withGuard(TELEGRAM, "Telegram", telegramOn), "user"),
    scanCacheSpecs(withGuard(ZOOM, "Zoom", zoomOn), "user"),
    scanCacheSpecs(withGuard(SPOTIFY, "Spotify", spotifyOn), "user"),
  ]);

  return [...slack, ...discord, ...teams, ...whatsapp, ...telegram, ...zoom, ...spotify];
}
