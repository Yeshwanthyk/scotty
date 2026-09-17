import { describe, expect, it, vi } from "vitest";
import type { EvidenceSummary } from "../data/session-workbench";
import { refreshConversationEvidence } from "./LiveConversation";

const evidence: ReadonlyArray<EvidenceSummary> = [
  {
    jobId: "job-1",
    status: "succeeded",
    totalSteps: 1,
    completedSteps: 1,
    frameCount: 1,
    recordVideo: false,
    videoAvailable: false,
    steps: [{ name: "Conversation", status: "passed", frameId: "frame-1" }],
  },
];

describe("conversation evidence refresh", () => {
  it("retries a failed evidence read and publishes the recovered projection", async () => {
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(evidence);
    const publish = vi.fn();
    let retry: (() => Promise<void>) | undefined;

    await refreshConversationEvidence(
      "a0b1c2d3e4f5",
      controller.signal,
      publish,
      (scheduled) => {
        retry = scheduled;
      },
      read,
    );

    expect(read).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    expect(retry).toBeDefined();
    await retry?.();
    expect(read).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith(evidence);
  });

  it("does not retry after the conversation stops observing evidence", async () => {
    const controller = new AbortController();
    controller.abort();
    const scheduleRetry = vi.fn();

    await refreshConversationEvidence(
      "a0b1c2d3e4f5",
      controller.signal,
      vi.fn(),
      scheduleRetry,
      vi.fn().mockRejectedValue(new Error("temporary")),
    );

    expect(scheduleRetry).not.toHaveBeenCalled();
  });
});
