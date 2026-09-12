import { assert, describe, it } from "@effect/vitest";
import { parseCodexRolloutListing } from "../../../src/agent/codex/rollout-export";

const parent = "sessions/2026/09/12/rollout-2026-09-12T14-00-00-parent.jsonl";
const childA = "sessions/2026/09/12/rollout-2026-09-12T14-01-00-child-a.jsonl";
const childB = "sessions/2026/09/12/rollout-2026-09-12T14-02-00-child-b.jsonl";

describe("Codex rollout export listing", () => {
  it("retains every parent and child rollout from one private generation", () => {
    const files = parseCodexRolloutListing(
      `${childB}\t90161\t1\n${parent}\t791758\t1\n${childA}\t119635\t1\n`,
    );
    assert.deepStrictEqual(files, [
      { path: parent, size: 791758 },
      { path: childA, size: 119635 },
      { path: childB, size: 90161 },
    ]);
  });

  it("rejects paths outside native rollouts and linked files", () => {
    assert.isNull(parseCodexRolloutListing("config.toml\t100\t1\n"));
    assert.isNull(parseCodexRolloutListing(`${parent}\t100\t2\n`));
    assert.isNull(parseCodexRolloutListing(`${parent}\t100\t1\n${parent}\t100\t1\n`));
  });
});
