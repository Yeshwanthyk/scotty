import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, formatSummary } from "./fold.ts";

test("formatDuration", () => {
  assert.equal(formatDuration(500), "<1s");
  assert.equal(formatDuration(14_000), "14s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(83_000), "1m 23s");
});

test("formatSummary with full stats", () => {
  assert.equal(
    formatSummary({ tools: 8, messages: 9, failures: 0, aborted: false, durationMs: 14_000 }),
    "▶ Worked for 14s · 8 tools · 9 msgs",
  );
});

test("formatSummary singulars and omissions", () => {
  assert.equal(
    formatSummary({ tools: 1, messages: 1, failures: 1, aborted: true, durationMs: undefined }),
    "▶ 1 tool · 1 msg · 1 failure · interrupted",
  );
});
