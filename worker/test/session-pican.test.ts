import { assert, describe, it } from "@effect/vitest";
import { ScottyError } from "../src/contracts";
import { createSessionHarness, makeStoredCredential, sessionHarnessKeys } from "./session-harness";
import { makeSessionRecord } from "./support";

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("Sandbox Pican transport", () => {
  it("forwards only while the authoritative session is warm and idle", async () => {
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
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]?.port, 31_415);
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
      value: (): Promise<Response> =>
        Promise.reject(new Error("provider leaked ghp_secret and scotty-codex-secret")),
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
