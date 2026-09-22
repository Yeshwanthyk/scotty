import { describe, expect, it, vi } from "vitest";
import {
  publishUnlessAborted,
  startVisibilityPolling,
  type VisibilitySource,
} from "./visibility-polling";

class FakeVisibility extends EventTarget implements VisibilitySource {
  visibilityState: DocumentVisibilityState = "visible";

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("visibility polling", () => {
  it("pauses while hidden and refreshes immediately when visible", async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibility();
    const poll = vi.fn(async () => 5_000);
    const polling = startVisibilityPolling(visibility, poll);
    await vi.runAllTicks();
    expect(poll).toHaveBeenCalledOnce();

    visibility.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledOnce();

    visibility.setVisibility("visible");
    await vi.runAllTicks();
    expect(poll).toHaveBeenCalledTimes(2);
    polling.stop();
    vi.useRealTimers();
  });

  it("aborts active work and removes its listener on stop", async () => {
    const visibility = new FakeVisibility();
    let signal: AbortSignal | undefined;
    const polling = startVisibilityPolling(visibility, (nextSignal) => {
      signal = nextSignal;
      return new Promise(() => undefined);
    });
    await Promise.resolve();
    polling.stop();
    expect(signal?.aborted).toBe(true);

    visibility.setVisibility("visible");
    expect(signal?.aborted).toBe(true);
  });

  it("queues one refresh when visibility returns during an aborted read", async () => {
    const visibility = new FakeVisibility();
    let finish: (() => void) | undefined;
    const poll = vi.fn(
      (signal: AbortSignal) =>
        new Promise<number | undefined>((resolve) => {
          finish = () => resolve(signal.aborted ? undefined : 5_000);
        }),
    );
    const polling = startVisibilityPolling(visibility, poll);
    await Promise.resolve();
    visibility.setVisibility("hidden");
    visibility.setVisibility("visible");
    expect(poll).toHaveBeenCalledOnce();
    finish?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(poll).toHaveBeenCalledTimes(2);
    polling.stop();
  });

  it("contains a polling rejection", async () => {
    const visibility = new FakeVisibility();
    const polling = startVisibilityPolling(visibility, () => Promise.reject(new Error("offline")));
    await Promise.resolve();
    await Promise.resolve();
    polling.stop();
  });
});

describe("abort-fenced publishing", () => {
  it("drops a stale response after its request is aborted", () => {
    const controller = new AbortController();
    const publish = vi.fn();
    controller.abort();
    publishUnlessAborted(controller.signal, "stale patch", publish);
    expect(publish).not.toHaveBeenCalled();
  });
});
