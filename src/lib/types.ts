// src/lib/types.ts
// Shared types used across scanners.

export type RiskTier = "safe" | "caution" | "risky";

export interface CleanTarget {
  /** Display name shown to the user, e.g. "Xcode DerivedData" */
  label: string;
  /** Absolute path or glob pattern */
  path: string;
  /** Size on disk in bytes (filled in by the scanner) */
  size: number;
  /** Risk classification for cleanup */
  risk: RiskTier;
  /** A one-line explanation: what's in it, what happens if we delete it */
  description: string;
  /** Category for grouping in output: "dev", "system", "user" */
  category: "dev" | "system" | "user";
  /** Fine-grained group label propagated from the scanner that produced this
   *  target (e.g. "Logs", "Editors", "Node ecosystem"). Used purely for display
   *  grouping — the scanner wrapper fills this in, individual scanners don't. */
  group?: string;
  /** Optional: rebuild cost ("Re-downloads on next install", "Free, rebuilds on next build") */
  rebuildCost?: string;
  /** Optional: should we run a command instead of deleting a folder? */
  cleanCommand?: string;
  /** Optional: a guard function — returns a reason to skip, or null to proceed */
  guard?: () => Promise<string | null>;
}

export interface ScanResult {
  targets: CleanTarget[];
  scannedAt: Date;
  diskTotal: number;
  diskUsed: number;
  diskFree: number;
  purgeable: number;
}

export const RISK_META: Record<RiskTier, { emoji: string; label: string; color: "green" | "yellow" | "red" }> = {
  safe: { emoji: "🟢", label: "SAFE", color: "green" },
  caution: { emoji: "🟡", label: "CAUTION", color: "yellow" },
  risky: { emoji: "🔴", label: "RISKY", color: "red" },
};
