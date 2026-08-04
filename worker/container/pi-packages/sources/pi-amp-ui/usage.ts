import type {
  BranchSummaryEntry,
  CompactionEntry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

interface ReportedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type SummaryUsageEntry = (BranchSummaryEntry | CompactionEntry) & {
  usage?: ReportedUsage;
};

export type UsageEntry = Exclude<SessionEntry, BranchSummaryEntry | CompactionEntry> | SummaryUsageEntry;

export interface SessionUsage {
  processedTokens: number;
  latestCacheHitPercent: number | undefined;
}

function isReportedUsage(value: unknown): value is ReportedUsage {
  return typeof value === "object" && value !== null
    && "input" in value && typeof value.input === "number"
    && "output" in value && typeof value.output === "number"
    && "cacheRead" in value && typeof value.cacheRead === "number"
    && "cacheWrite" in value && typeof value.cacheWrite === "number";
}

function usageTokens(usage: ReportedUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function entryUsage(entry: UsageEntry): ReportedUsage | undefined {
  if (entry.type === "message") {
    if (entry.message.role === "assistant") return entry.message.usage;
    if (
      entry.message.role === "toolResult"
      && "usage" in entry.message
      && isReportedUsage(entry.message.usage)
    ) return entry.message.usage;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.usage;
  return undefined;
}

export function summarizeSessionUsage(
  entries: readonly UsageEntry[],
  activeBranch: readonly UsageEntry[] = entries,
): SessionUsage {
  let processedTokens = 0;
  for (const entry of entries) {
    const usage = entryUsage(entry);
    if (usage) processedTokens += usageTokens(usage);
  }

  let cacheReportingSeen = false;
  let latestCacheHitPercent: number | undefined;
  for (const entry of activeBranch) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      latestCacheHitPercent = undefined;
      continue;
    }
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;

    const usage = entry.message.usage;
    cacheReportingSeen ||= usage.cacheRead > 0 || usage.cacheWrite > 0;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    latestCacheHitPercent = cacheReportingSeen && promptTokens > 0
      ? (usage.cacheRead / promptTokens) * 100
      : undefined;
  }

  return { processedTokens, latestCacheHitPercent };
}

export function formatProcessedTokens(value: number): string {
  const tokens = Math.max(0, Math.round(value));
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}K`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${Math.round(tokens / 1_000_000)}M`;
}
