import { assert, describe, it } from "@effect/vitest";
import { ScottyError } from "../src/contracts";
import { PICAN_SANDBOX_ORIGIN } from "../src/session";
import { createSessionHarness, SESSION_ID, sessionHarnessKeys } from "./session-harness";
import { makeSessionRecord } from "./support";

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

const runnerRecord = (
  overrides: Parameters<typeof makeSessionRecord>[0] = {},
): ReturnType<typeof makeSessionRecord> =>
  makeSessionRecord({
    provider: "runner",
    runner: "slumbers",
    execution: {
      provider: "runner",
      runner: "slumbers",
      runtimeId: `runner-v1:${SESSION_ID}`,
    },
    ...overrides,
  });

describe("runner Pican transport", () => {
  it("does not expose the removed Cloudflare Pican runtime", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord(),
      },
    });

    const error = await rejection(harness.sandbox.fetch(new Request(`${PICAN_SANDBOX_ORIGIN}/`)));

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "wrong_state");
    assert.strictEqual(error.hint, "Cloudflare sessions use the Pi terminal");
    assert.strictEqual(harness.picanStarts.length, 0);
  });

  it("forwards exact request bytes and preserves runner response streaming", async () => {
    const sentinel = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    const encoder = new TextEncoder();
    let closeResponse: (() => void) | undefined;
    const responseStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: runner-ready\n\n"));
        closeResponse = () => controller.close();
      },
    });
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: runnerRecord(),
      },
      runnerFetch: async (request) => {
        assert.strictEqual(
          new URL(request.url).pathname,
          `/_scotty/runner-http/${SESSION_ID}/${encodeURIComponent(
            `runner-v1:${SESSION_ID}`,
          )}/s/${SESSION_ID}/api/sessions`,
        );
        assert.deepStrictEqual(new Uint8Array(await request.arrayBuffer()), sentinel);
        return new Response(responseStream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const response = await harness.sandbox.fetch(
      new Request(`${PICAN_SANDBOX_ORIGIN}/s/${SESSION_ID}/api/sessions`, {
        method: "POST",
        body: sentinel,
      }),
    );

    assert.strictEqual(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    assert.strictEqual(new TextDecoder().decode(first?.value), "event: runner-ready\n\n");
    closeResponse?.();
    await reader?.cancel();
  });

  for (const testCase of [
    {
      name: "sleeping",
      record: runnerRecord({ status: "sleeping" }),
      code: "wrong_state",
    },
    {
      name: "active operation",
      record: runnerRecord({
        operation: {
          kind: "snapshot",
          nonce: "snapshot-in-progress",
          startedAt: "2026-01-01T00:00:01.000Z",
        },
      }),
      code: "conflict",
    },
  ] as const) {
    it(`rejects ${testCase.name} state before contacting the runner`, async () => {
      let calls = 0;
      const harness = await createSessionHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: testCase.record,
        },
        runnerFetch: () => {
          calls += 1;
          return Promise.resolve(new Response());
        },
      });

      const error = await rejection(harness.sandbox.fetch(new Request(`${PICAN_SANDBOX_ORIGIN}/`)));

      assert.ok(error instanceof ScottyError);
      assert.strictEqual(error.code, testCase.code);
      assert.strictEqual(calls, 0);
    });
  }

  it("maps runner transport rejection to one fixed public error", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: runnerRecord(),
      },
      runnerFetch: () =>
        Promise.reject(new Error("provider leaked ghp_secret and scotty-codex-secret")),
    });

    const error = await rejection(harness.sandbox.fetch(new Request(`${PICAN_SANDBOX_ORIGIN}/`)));

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "upstream");
    assert.strictEqual(error.message, "Runner upstream request failed");
    assert.ok(!JSON.stringify(error).includes("ghp_"));
    assert.ok(!JSON.stringify(error).includes("codex-secret"));
  });
});
