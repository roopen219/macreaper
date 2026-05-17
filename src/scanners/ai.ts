// src/scanners/ai.ts
// Local AI / LLM model storage and AI-app data. These are the new heavy
// hitters on a 2026 dev machine — Ollama models alone can easily occupy
// 50-200 GB once you've pulled a few 70B-class models, and Claude Desktop's
// Cowork feature silently drops a ~10 GB Linux VM bundle on every Mac it
// runs on. None of these tools auto-prune.

import type { CleanTarget } from "../lib/types.ts";
import { scanCacheSpecs, type CacheSpec, pathExists, pathSize } from "../lib/utils.ts";

const AI_CACHES: CacheSpec[] = [
  {
    label: "Ollama models",
    path: "~/.ollama/models",
    description: "Pulled LLM weights (Llama, Mistral, Qwen, etc.). Each 7B model ≈ 4 GB, 70B ≈ 40 GB. Use `ollama rm <model>` for clean removal so shared blobs aren't orphaned.",
    rebuildCost: "Re-download with `ollama pull <model>` (multi-GB per model)",
    risk: "caution",
    cleanCommand: "ollama list --format json 2>/dev/null || ollama list",
  },

  // ── Claude Desktop (Cowork VM + Electron caches) ─────────────────────
  // The big one: Anthropic's Cowork feature silently creates a ~10 GB
  // Ubuntu 24.04 VM bundle (rootfs.img + sessiondata.img) the first time
  // Claude Desktop launches and never cleans it up. Even users who never
  // use Cowork get the full bundle. Github issues anthropics/claude-code
  // #22543, #37604, #47039 all document the pattern.
  {
    label: "Claude Cowork VM bundle (claudevm.bundle)",
    path: "~/Library/Application Support/Claude/vm_bundles/claudevm.bundle",
    description: "Anthropic Cowork's Linux VM image (Ubuntu 24.04 + Chromium + Playwright + LibreOffice + Node/Python/Java). Auto-created at first Claude Desktop launch even for users who never use Cowork. There is no working individual-user off-switch — deleting it just kicks off another ~10 GB download on next launch. See `optimize` for full context.",
    rebuildCost: "Re-downloads ~10 GB on next Claude Desktop launch. The only true fix is to switch to claude.ai (web) or Claude Code CLI; Team/Enterprise admins can disable Cowork org-wide.",
    risk: "caution",
  },
  {
    label: "Claude Desktop Cache",
    path: "~/Library/Application Support/Claude/Cache",
    description: "Electron HTTP / network cache used by Claude Desktop.",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "Claude Desktop Code Cache",
    path: "~/Library/Application Support/Claude/Code Cache",
    description: "V8 bytecode cache for Claude Desktop's renderer process.",
    rebuildCost: "Slower first launch after cleanup",
  },
  {
    label: "Claude Desktop GPUCache",
    path: "~/Library/Application Support/Claude/GPUCache",
    description: "GPU shader cache used by Claude Desktop's Electron shell.",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "Claude Desktop caches (~/Library/Caches)",
    path: "~/Library/Caches/Claude",
    description: "Additional Claude Desktop cache directory.",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "Hugging Face hub cache",
    path: "~/.cache/huggingface/hub",
    description: "Downloaded models, datasets, and spaces from huggingface.co (transformers, diffusers, peft, etc.). Deduplicated via content-hash blobs.",
    rebuildCost: "Re-downloads on next `from_pretrained()` call",
    risk: "caution",
  },
  {
    label: "Hugging Face datasets cache",
    path: "~/.cache/huggingface/datasets",
    description: "Cached dataset shards. Often duplicated across the hub cache; safe to clear.",
    rebuildCost: "Re-downloads on next `load_dataset()` call",
    risk: "caution",
  },
  {
    label: "LM Studio models",
    path: "~/.lmstudio/models",
    description: "GGUF model files downloaded via LM Studio. Single Q4 7B model ≈ 4 GB. (Newer LM Studio builds; documented default per the app.)",
    rebuildCost: "Re-download from inside LM Studio",
    risk: "caution",
  },
  {
    label: "LM Studio models (cache path)",
    path: "~/.cache/lm-studio/models",
    description: "Older LM Studio builds (and some macOS installs) keep models under ~/.cache/lm-studio. Per lmstudio-bug-tracker #1371 the app currently writes to BOTH locations on macOS.",
    rebuildCost: "Re-download from inside LM Studio",
    risk: "caution",
  },
  {
    label: "LM Studio bundled runtime",
    path: "~/.lmstudio/.internal",
    description: "Bundled Node.js + LM Studio internal utilities (~300 MB). Re-extracts on next launch.",
    rebuildCost: "Slower first launch after cleanup",
  },
  {
    label: "LM Studio caches",
    path: "~/Library/Caches/LM Studio",
    description: "LM Studio's macOS application cache.",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "LM Studio sfl4 cache",
    path: "~/Library/Caches/ai.elementlabs.lmstudio.sfl4",
    description: "Sandbox-flagged container cache for LM Studio (Apple's sfl4 mechanism).",
    rebuildCost: "Rebuilds on next launch",
  },
  {
    label: "Whisper models",
    path: "~/.cache/whisper",
    description: "OpenAI Whisper checkpoint files (base, small, medium, large-v3). large-v3 ≈ 3 GB.",
    rebuildCost: "Re-downloads on next whisper invocation",
  },
  {
    label: "PyTorch hub cache",
    path: "~/.cache/torch/hub",
    description: "Models downloaded by `torch.hub.load()`.",
    rebuildCost: "Re-downloads on next `torch.hub.load()` call",
  },
  {
    label: "Hugging Face xet cache",
    path: "~/.cache/huggingface/xet",
    description: "Xet content-addressable cache for large HF blobs (newer hub format).",
    rebuildCost: "Re-downloads from hub as needed",
  },
];

export async function scanAI(): Promise<CleanTarget[]> {
  const targets = await scanCacheSpecs(AI_CACHES, "dev");

  // Cowork extras: surface leftover download archives (rootfs.img.zst etc.)
  // and any sibling bundles in vm_bundles/ that aren't claudevm.bundle.
  // We compute this as (vm_bundles total) − (claudevm.bundle) so we don't
  // double-count the 10 GB bundle that's already listed above.
  const vmBundlesPath = "~/Library/Application Support/Claude/vm_bundles";
  const claudeVmPath = "~/Library/Application Support/Claude/vm_bundles/claudevm.bundle";
  if (pathExists(vmBundlesPath)) {
    const parentSize = await pathSize(vmBundlesPath);
    const childSize = pathExists(claudeVmPath) ? await pathSize(claudeVmPath) : 0;
    const extra = parentSize - childSize;
    // Threshold to avoid surfacing tiny .DS_Store-sized noise.
    if (extra > 64 * 1024) {
      targets.push({
        label: "Claude Cowork VM bundles (other files)",
        path: vmBundlesPath,
        size: extra,
        risk: "caution",
        description: "Leftover rootfs.img.zst download archives or sibling VM bundles in vm_bundles/ that aren't claudevm.bundle. Safe to delete; will be re-fetched if Claude needs them.",
        rebuildCost: "Re-downloaded on next Cowork operation",
        category: "dev",
      });
    }
  }

  return targets;
}
