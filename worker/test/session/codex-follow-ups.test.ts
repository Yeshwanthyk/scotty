import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { decodeSessionMessageInput } from "../../../protocol/session-steer";
import { emptyCodexFollowUps, enqueueCodexFollowUp } from "../../src/session/codex-follow-ups";

describe("Codex follow-up admission bounds", () => {
  it("bounds serialized queue bytes including retained receipts", () => {
    const text = "x".repeat(16 * 1024);
    const queue = {
      pending: [],
      receipts: Array.from({ length: 6 }, (_, index) => ({ id: `receipt-${index}`, text })),
    };
    expect(enqueueCodexFollowUp(queue, { id: "next", text }).status).toBe("full");
  });
  it("keeps a terminal receipt available for retries at the item limit", () => {
    const queue = {
      pending: [],
      receipts: Array.from({ length: 100 }, (_, index) => ({
        id: `receipt-${index}`,
        text: "done",
      })),
    };
    expect(enqueueCodexFollowUp(queue, { id: "receipt-0", text: "done" }).status).toBe("replay");
    expect(enqueueCodexFollowUp(queue, { id: "new", text: "new" }).status).toBe("full");
    expect(enqueueCodexFollowUp(emptyCodexFollowUps(), { id: "first", text: "first" }).status).toBe(
      "queued",
    );
  });
  it("accepts only the explicit follow-up public intent while preserving default steering", () => {
    expect(
      Option.isSome(decodeSessionMessageInput({ message: "next", deliverAs: "followUp" })),
    ).toBe(true);
    expect(Option.isSome(decodeSessionMessageInput({ message: "steer" }))).toBe(true);
    expect(
      Option.isNone(decodeSessionMessageInput({ message: "next", deliverAs: "surprise" })),
    ).toBe(true);
  });
});
