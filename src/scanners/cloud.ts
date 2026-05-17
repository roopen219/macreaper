// src/scanners/cloud.ts
// Cloud SDK / IaC tool caches. Mostly small individually but they're never
// pruned and the Terraform / Pulumi plugin caches in particular can balloon
// past 20 GB on heavily-multi-provider repos.

import type { CleanTarget } from "../lib/types.ts";
import { scanCacheSpecs, type CacheSpec } from "../lib/utils.ts";

const CLOUD_CACHES: CacheSpec[] = [
  {
    label: "AWS CLI cache",
    path: "~/.aws/cli/cache",
    description: "Cached STS/SSO credentials and API responses. Safe to clear; AWS CLI will re-issue tokens on next call.",
    rebuildCost: "Next AWS call may prompt for SSO/MFA again",
  },
  {
    label: "AWS SAM build cache",
    path: "~/.aws-sam",
    description: "AWS SAM local build artifacts (Lambda images, layers, etc.).",
    rebuildCost: "Re-builds on next `sam build`",
  },
  {
    label: "gcloud cache",
    path: "~/.config/gcloud/cache",
    description: "Cached discovery documents and API responses. Stale entries can make new flags look unsupported.",
    rebuildCost: "Re-downloads discovery docs on next gcloud call",
  },
  {
    label: "gcloud logs",
    path: "~/.config/gcloud/logs",
    description: "Per-invocation log files. Disposable.",
    rebuildCost: "None",
  },
  {
    label: "Azure CLI object cache",
    path: "~/.azure/object_cache",
    description: "Objects cached by Azure CLI when using `--defer`. Use `az cache purge` for the tool-native cleanup.",
    rebuildCost: "Re-fetches objects on next call",
    cleanCommand: "az cache purge",
  },
  {
    label: "Azure CLI logs",
    path: "~/.azure/commands",
    description: "Per-command logs from Azure CLI.",
    rebuildCost: "None",
  },
  {
    label: "Terraform plugin cache (default)",
    path: "~/.terraform.d/plugin-cache",
    description: "Provider plugins shared across working directories (only populated if `plugin_cache_dir` is configured). Terraform never prunes this.",
    rebuildCost: "Re-downloads providers on next `terraform init`",
  },
  {
    label: "Terraform user dir",
    path: "~/.terraform.d",
    description: "Terraform's user home — credentials, checkpoint cache, optionally plugin-cache. Keep the credentials file if you have one.",
    rebuildCost: "Re-prompts for `terraform login` and re-downloads providers",
    risk: "caution",
  },
  {
    label: "Pulumi plugins",
    path: "~/.pulumi/plugins",
    description: "Resource provider plugins downloaded per-stack. Can easily grow past 20 GB; no built-in prune command yet.",
    rebuildCost: "Re-downloads plugins on next `pulumi up`",
  },
  {
    label: "Pulumi workspaces & history",
    path: "~/.pulumi/workspaces",
    description: "Per-stack workspace metadata. Small but accumulates one entry per stack you've ever touched.",
    rebuildCost: "Recreated automatically; doesn't affect cloud state",
  },
  {
    label: "kubectl cache (HTTP + discovery)",
    path: "~/.kube/cache",
    description: "Cached API discovery and HTTP responses per cluster context.",
    rebuildCost: "Re-fetches discovery on next kubectl call",
  },
  {
    label: "Helm cache",
    path: "~/Library/Caches/helm",
    description: "Cached Helm chart archives and repository indexes.",
    rebuildCost: "Re-downloads charts on next install/upgrade",
  },
];

export async function scanCloud(): Promise<CleanTarget[]> {
  return scanCacheSpecs(CLOUD_CACHES, "dev");
}
