import assert from "node:assert/strict";
import test from "node:test";
import {
  compactPath,
  contextRailWidth,
  fitFrameBorder,
  joinResponsive,
  parseGitDiffNumstat,
} from "./layout.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const ansi = (text: string) => `\x1b[36m${text}\x1b[39m`;

test("fitFrameBorder preserves the requested width with ANSI labels", () => {
  const line = fitFrameBorder(ansi(" MODE "), ansi(" ctx 42% "), 40, ansi, ["╭", "╮"]);
  assert.equal(visibleWidth(line), 40);
  assert.match(line, /╭/);
  assert.match(line, /╮/);
});

test("fitFrameBorder truncates the right label before the left label", () => {
  const line = fitFrameBorder(" LEFT ", " A VERY LONG RIGHT LABEL ", 14, (value) => value, ["╰", "╯"]);
  assert.equal(visibleWidth(line), 14);
  assert.match(line, /LEFT/);
});

test("joinResponsive keeps both sides when space permits", () => {
  const line = joinResponsive("working", "~/code (main)", 30);
  assert.equal(visibleWidth(line), 30);
  assert.match(line, /^working/);
  assert.match(line, /\(main\)$/);
});

test("compactPath abbreviates home and clips from the left", () => {
  assert.equal(compactPath("/Users/yesh/code/project", "/Users/yesh", 40), "~/code/project");
  assert.equal(compactPath("/Users/yesh/code/project", "/Users/yesh", 8), "…project");
});

test("contextRailWidth keeps non-zero usage visible and clamps invalid values", () => {
  assert.equal(contextRailWidth(undefined, 40), 0);
  assert.equal(contextRailWidth(0, 40), 0);
  assert.equal(contextRailWidth(0.1, 40), 1);
  assert.equal(contextRailWidth(12.4, 40), 5);
  assert.equal(contextRailWidth(140, 40), 40);
  assert.equal(contextRailWidth(50, 0), 0);
});

test("parseGitDiffNumstat totals text changes and ignores binary files", () => {
  const output = "12\t3\tsrc/index.ts\n5\t0\tREADME.md\n-\t-\timage.png\n";
  assert.deepEqual(parseGitDiffNumstat(output), { additions: 17, deletions: 3 });
});
