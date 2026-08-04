import { assert, describe, it } from "vitest";
import { createComposerDrafts } from "../public/terminal-draft.js";

type DraftEntry = { draft: string };

function draftHarness() {
  const entries = new Map<string, DraftEntry>();
  const entry = (sessionId: string) => {
    let current = entries.get(sessionId);
    if (!current) {
      current = { draft: "" };
      entries.set(sessionId, current);
    }
    return current;
  };
  return { drafts: createComposerDrafts(entry), entry };
}

describe("terminal composer draft recovery", () => {
  for (const status of ["rejected", "stale", "ambiguous", "discarded"] as const) {
    it(`restores editable text after a ${status} outcome`, () => {
      const { drafts, entry } = draftHarness();
      drafts.set("session-a", "keep this text");

      const submission = drafts.begin("session-a", "keep this text");
      assert.strictEqual(entry("session-a").draft, "");

      assert.isTrue(drafts.settle(submission, status));
      assert.strictEqual(entry("session-a").draft, "keep this text");
    });
  }

  it("keeps an accepted submission cleared", () => {
    const { drafts, entry } = draftHarness();
    drafts.set("session-a", "sent text");

    const submission = drafts.begin("session-a", "sent text");

    assert.isFalse(drafts.settle(submission, "accepted"));
    assert.strictEqual(entry("session-a").draft, "");
  });

  it("restores into the submitted session after navigation without touching the current draft", () => {
    const { drafts, entry } = draftHarness();
    drafts.set("session-a", "session A text");
    const submission = drafts.begin("session-a", "session A text");
    drafts.set("session-b", "session B text");

    assert.isTrue(drafts.settle(submission, "rejected"));
    assert.strictEqual(entry("session-a").draft, "session A text");
    assert.strictEqual(entry("session-b").draft, "session B text");
  });

  it("does not overwrite a newer edit in the submitted session", () => {
    const { drafts, entry } = draftHarness();
    drafts.set("session-a", "submitted text");
    const submission = drafts.begin("session-a", "submitted text");
    drafts.set("session-a", "newer user edit");

    assert.isFalse(drafts.settle(submission, "ambiguous"));
    assert.strictEqual(entry("session-a").draft, "newer user edit");
  });
});
