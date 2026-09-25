import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { decodeSessionMessageInput } from "../../../protocol/session/session-steer";
import {
  emptySidecarFollowUps,
  enqueueSidecarFollowUp,
} from "../../src/session/sidecar-follow-ups";

describe("Codex follow-up admission bounds", () => {
  it("retains queued text beyond the former serialized byte cap", () => {
    const text = "x".repeat(16 * 1024);
    const queue = {
      pending: [],
      receipts: Array.from({ length: 6 }, (_, index) => ({ id: `receipt-${index}`, text })),
    };
    const result = enqueueSidecarFollowUp(queue, { id: "next", text });
    expect(result.status).toBe("queued");
    expect(result.queue.pending[0]?.text).toBe(text);
  });
  it("keeps a terminal receipt available for retries at the item limit", () => {
    const queue = {
      pending: [],
      receipts: Array.from({ length: 100 }, (_, index) => ({
        id: `receipt-${index}`,
        text: "done",
      })),
    };
    expect(enqueueSidecarFollowUp(queue, { id: "receipt-0", text: "done" }).status).toBe("replay");
    expect(enqueueSidecarFollowUp(queue, { id: "new", text: "new" }).status).toBe("full");
    expect(
      enqueueSidecarFollowUp(emptySidecarFollowUps(), { id: "first", text: "first" }).status,
    ).toBe("queued");
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
