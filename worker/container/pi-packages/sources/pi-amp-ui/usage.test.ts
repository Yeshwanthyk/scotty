import assert from "node:assert/strict";
import test from "node:test";
import {
  formatProcessedTokens,
  summarizeSessionUsage,
  type UsageEntry,
} from "./usage.ts";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(id: string, reportedUsage: ReturnType<typeof usage>): UsageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet",
      usage: reportedUsage,
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

function toolResult(id: string, reportedUsage: ReturnType<typeof usage>): UsageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: `call-${id}`,
      toolName: "nested-agent",
      content: [],
      usage: reportedUsage,
      isError: false,
      timestamp: 0,
    },
  };
}

function compaction(id: string, reportedUsage?: ReturnType<typeof usage>): UsageEntry {
  return {
    type: "compaction",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "summary",
    firstKeptEntryId: "kept",
    tokensBefore: 100_000,
    ...(reportedUsage ? { usage: reportedUsage } : {}),
  };
}

function branchSummary(id: string, reportedUsage: ReturnType<typeof usage>): UsageEntry {
  return {
    type: "branch_summary",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    fromId: "old-leaf",
    summary: "summary",
    usage: reportedUsage,
  };
}

test("totals provider-reported assistant, tool, compaction, and branch-summary usage", () => {
  const result = summarizeSessionUsage([
    assistant("assistant", usage(100, 20, 80, 10)),
    toolResult("tool", usage(30, 5)),
    compaction("compact", usage(40, 10, 20)),
    branchSummary("branch", usage(15, 5)),
  ]);

  assert.equal(result.processedTokens, 335);
  assert.equal(result.latestCacheHitPercent, undefined);
});

test("uses the latest assistant cache rate from the active branch", () => {
  const cached = assistant("cached", usage(10, 5, 80, 10));
  const otherBranch = assistant("other", usage(100, 5));
  const result = summarizeSessionUsage([cached, otherBranch], [cached]);

  assert.equal(result.processedTokens, 210);
  assert.equal(result.latestCacheHitPercent, 80);
});

test("hides unsupported cache metrics and invalidates stale rates at compaction", () => {
  const unsupported = assistant("unsupported", usage(100, 5));
  assert.equal(summarizeSessionUsage([unsupported]).latestCacheHitPercent, undefined);

  const cached = assistant("cached", usage(10, 5, 80, 10));
  const compacted = compaction("compact");
  assert.equal(summarizeSessionUsage([cached, compacted]).latestCacheHitPercent, undefined);

  const miss = assistant("miss", usage(100, 5));
  assert.equal(summarizeSessionUsage([cached, compacted, miss]).latestCacheHitPercent, 0);
});

test("formats processed totals with compact uppercase units", () => {
  assert.equal(formatProcessedTokens(999), "999");
  assert.equal(formatProcessedTokens(1_200), "1.2K");
  assert.equal(formatProcessedTokens(748_126), "748K");
  assert.equal(formatProcessedTokens(1_248_126), "1.2M");
  assert.equal(formatProcessedTokens(12_800_000), "13M");
});
