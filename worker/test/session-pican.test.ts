import { assert, describe, it } from "@effect/vitest";
import { ScottyError } from "../src/contracts";
import { PICAN_SANDBOX_ORIGIN } from "../src/session";
import {
  createSessionHarness,
  makeStoredCredential,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("Sandbox Pican transport", () => {
  it("ensures Pican before forwarding while the authoritative session is warm and idle", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord(),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });
    const calls: Array<{ readonly request: Request; readonly port: number }> = [];
    Object.defineProperty(harness.sandbox, "containerFetch", {
      value: (request: Request, port: number): Promise<Response> => {
        calls.push({ request, port });
        return Promise.resolve(new Response("pican"));
      },
    });

    const response = await harness.sandbox.fetchPican(
      new Request("https://scotty.example.test/api/sessions"),
    );

    assert.strictEqual(await response.text(), "pican");
    assert.strictEqual(calls.length, 2);
    assert.match(calls[0]?.request.url ?? "", /\/api\/settings$/u);
    assert.strictEqual(calls[1]?.port, 31_415);
    assert.strictEqual(harness.picanStarts.length, 1);
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
        [sessionHarnessKeys.record]: makeSessionRecord({
          provider: "runner",
          runner: "slumbers",
          execution: {
            provider: "runner",
            runner: "slumbers",
            runtimeId: `runner-v1:${SESSION_ID}`,
          },
        }),
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
      record: makeSessionRecord({ status: "sleeping" }),
      code: "wrong_state",
    },
    {
      name: "active operation",
      record: makeSessionRecord({
        operation: {
          kind: "snapshot",
          nonce: "snapshot-in-progress",
          startedAt: "2026-01-01T00:00:01.000Z",
        },
      }),
      code: "conflict",
    },
  ] as const) {
    it(`rejects ${testCase.name} state before containerFetch can auto-resume it`, async () => {
      const harness = await createSessionHarness({
        initialEntries: {
          [sessionHarnessKeys.record]: testCase.record,
          [sessionHarnessKeys.credential]: makeStoredCredential(),
        },
      });
      let calls = 0;
      Object.defineProperty(harness.sandbox, "containerFetch", {
        value: (): Promise<Response> => {
          calls += 1;
          return Promise.resolve(new Response());
        },
      });

      const error = await rejection(
        harness.sandbox.fetchPican(new Request("https://scotty.example.test/")),
      );

      assert.ok(error instanceof ScottyError);
      assert.strictEqual(error.code, testCase.code);
      assert.strictEqual(calls, 0);
    });
  }

  it("maps Pican transport rejection to one fixed public upstream error", async () => {
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord(),
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });
    Object.defineProperty(harness.sandbox, "containerFetch", {
      value: (request: Request): Promise<Response> =>
        new URL(request.url).pathname.endsWith("/api/settings")
          ? Promise.resolve(Response.json({ ready: true }))
          : Promise.reject(new Error("provider leaked ghp_secret and scotty-codex-secret")),
    });

    const error = await rejection(
      harness.sandbox.fetchPican(new Request("https://scotty.example.test/")),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "upstream");
    assert.strictEqual(error.message, "Pican upstream request failed");
    assert.ok(!JSON.stringify(error).includes("ghp_"));
    assert.ok(!JSON.stringify(error).includes("codex-secret"));
  });
});
