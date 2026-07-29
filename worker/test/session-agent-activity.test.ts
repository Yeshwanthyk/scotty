import { assert, describe, it } from "@effect/vitest";
import {
  createSessionHarness,
  makeStoredCredential,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

interface CompletionPayload {
  readonly lastAgentEventAt: string;
}

describe("Sandbox agent activity lifecycle", () => {
  it("does not poll legacy Pican activity for a Cloudflare Pi session", async () => {
    let workerState: "idle" | "running" | "error" = "idle";
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          codexThreadId: "codex-thread",
          agentState: "working",
          lastAgentEventAt: "2026-01-01T00:00:01.000Z",
        }),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      initialPicanRunning: true,
      picanWorkerStatus: () => Response.json({ state: workerState }),
      stopCallsOnStop: true,
    });

    await harness.sandbox.observeAgentActivity();
    assert.strictEqual(harness.readRecord()?.agentState, "working");
    assert.strictEqual(harness.readRecord()?.lastAgentEventAt, "2026-01-01T00:00:01.000Z");
    assert.deepStrictEqual(harness.schedules, []);
    assert.ok(!harness.events.includes("host:pican:worker-status"));
    void workerState;
  });

  it("observes retained runner activity through the same projection contract", async () => {
    let workerState: "idle" | "running" = "idle";
    const requests: Request[] = [];
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          provider: "runner",
          runner: "slumbers",
          execution: {
            provider: "runner",
            runner: "slumbers",
            runtimeId: `runner-v1:${SESSION_ID}`,
          },
          codexThreadId: "codex-thread",
          agentState: "working",
          lastAgentEventAt: "2026-01-01T00:00:01.000Z",
        }),
      },
      runnerFetch: (request) => {
        requests.push(request);
        return Promise.resolve(Response.json({ state: workerState }));
      },
    });

    await harness.sandbox.observeAgentActivity();
    assert.strictEqual(harness.readRecord()?.agentState, "completed");
    const completion = harness.schedules.findLast(
      ({ callback }) => callback === "sleepAfterAgentCompletion",
    );
    assert.ok(completion);

    workerState = "running";
    await harness.sandbox.sleepAfterAgentCompletion(completion.payload as CompletionPayload);
    assert.strictEqual(harness.readRecord()?.status, "warm");
    assert.strictEqual(harness.readRecord()?.agentState, "working");
    assert.match(requests.at(-1)?.url ?? "", /\/api\/worker-status\?id=codex-thread$/u);
  });
});
