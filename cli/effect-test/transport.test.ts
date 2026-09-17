import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { cliLayer } from "../src/services";
import { apiRequest, readResponseBytes } from "../src/transport";

it.effect("reads a snapshot response beyond the former 64 MiB client cap", () =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(64 * 1024 * 1024 + 1);
    bytes[bytes.length - 1] = 1;
    const received = yield* readResponseBytes(
      new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }),
    );
    assert.strictEqual(received.byteLength, bytes.byteLength);
    assert.strictEqual(received.at(-1), 1);
  }),
);

it.effect(
  "keeps one mutation fetch alive beyond five minutes and aborts at its bounded deadline",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      let idleTimeout: unknown;
      let signal: AbortSignal | undefined;
      const fetcher: typeof fetch = (_input, init) => {
        calls++;
        idleTimeout = Reflect.get(init ?? {}, "timeout");
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      };
      const fiber = yield* apiRequest(
        { host: "https://worker.example", token: "synthetic-token" },
        "/api/sessions/session-1/resume",
        { method: "POST" },
        { timeoutMs: 11 * 60_000 },
      ).pipe(
        Effect.provide(cliLayer({ fetch: fetcher })),
        Effect.forkChild({ startImmediately: true }),
      );
      while (calls === 0) yield* Effect.yieldNow;
      assert.strictEqual(idleTimeout, false);
      assert.isFalse(signal?.aborted);

      yield* TestClock.adjust(5 * 60_000);
      assert.isUndefined(fiber.pollUnsafe());
      assert.strictEqual(calls, 1);

      yield* TestClock.adjust(6 * 60_000);
      const result = yield* Effect.result(Fiber.join(fiber));
      assert.ok(Result.isFailure(result));
      assert.strictEqual(result.failure.code, "timeout");
      assert.include(result.failure.hint, "Inspect the authoritative session state");
      assert.isTrue(signal?.aborted);
      assert.strictEqual(calls, 1);
    }),
);

it.effect("aborts a stalled response body at the same request deadline", () =>
  Effect.gen(function* () {
    let calls = 0;
    let signal: AbortSignal | undefined;
    let bodyAborted = false;
    const fetcher: typeof fetch = (_input, init) => {
      calls++;
      signal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => {
                  bodyAborted = true;
                  controller.error(new Error("aborted"));
                },
                { once: true },
              );
            },
          }),
        ),
      );
    };
    const fiber = yield* apiRequest(
      { host: "https://worker.example", token: "synthetic-token" },
      "/api/sessions/session-1/resume",
      { method: "POST" },
      { timeoutMs: 11 * 60_000 },
    ).pipe(
      Effect.provide(cliLayer({ fetch: fetcher })),
      Effect.forkChild({ startImmediately: true }),
    );
    while (calls === 0) yield* Effect.yieldNow;
    yield* TestClock.adjust(11 * 60_000);
    const result = yield* Effect.result(Fiber.join(fiber));
    assert.ok(Result.isFailure(result));
    assert.strictEqual(result.failure.code, "timeout");
    assert.isTrue(signal?.aborted);
    assert.isTrue(bodyAborted);
    assert.strictEqual(calls, 1);
  }),
);

it.effect("reports an interrupted mutation transport as unconfirmed without redispatch", () =>
  Effect.gen(function* () {
    let calls = 0;
    const fetcher: typeof fetch = () => {
      calls++;
      return Promise.reject(new Error("connection dropped"));
    };
    const result = yield* Effect.result(
      apiRequest(
        { host: "https://worker.example", token: "synthetic-token" },
        "/api/sessions/session-1/resume",
        { method: "POST" },
      ).pipe(Effect.provide(cliLayer({ fetch: fetcher }))),
    );
    assert.ok(Result.isFailure(result));
    assert.strictEqual(result.failure.code, "network_error");
    assert.include(result.failure.hint, "Inspect the authoritative session state");
    assert.strictEqual(calls, 1);
  }),
);
