import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { readBoundedUtf8Body } from "../../src/shared/bounded-http";

describe("bounded native HTTP body lifetime", () => {
  for (const mode of [
    "complete",
    "overflow",
    "declared-overflow",
    "invalid-utf8",
    "error",
  ] as const) {
    it.effect(`releases the reader on ${mode}`, () =>
      Effect.gen(function* () {
        let cancelled = 0;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (mode === "error") controller.error(new Error("synthetic body failure"));
            else {
              controller.enqueue(
                mode === "invalid-utf8" ? new Uint8Array([255]) : new TextEncoder().encode("hello"),
              );
              if (mode === "complete" || mode === "invalid-utf8") controller.close();
            }
          },
          cancel() {
            cancelled += 1;
          },
        });
        const response = new Response(stream, {
          headers: mode === "declared-overflow" ? { "content-length": "100" } : {},
        });
        const result = yield* Effect.tryPromise(() =>
          readBoundedUtf8Body(response, mode === "overflow" ? 2 : 10),
        ).pipe(Effect.result);
        assert.isFalse(stream.locked);
        assert.equal(Result.isFailure(result), mode === "error");
        assert.equal(Result.getOrUndefined(result), mode === "complete" ? "hello" : undefined);
        assert.equal(cancelled, mode === "overflow" || mode === "declared-overflow" ? 1 : 0);
      }),
    );
  }

  for (const cleanup of ["pending", "rejected"] as const) {
    it.effect(`abort releases a pending read even when producer cancellation is ${cleanup}`, () =>
      Effect.gen(function* () {
        let cancelled = 0;
        const stream = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled += 1;
            return cleanup === "pending"
              ? new Promise<void>(() => {})
              : Promise.reject(new Error("synthetic cancel failure"));
          },
        });
        const controller = new AbortController();
        const reading = readBoundedUtf8Body(new Response(stream), 10, controller.signal);
        controller.abort();
        const result = yield* Effect.tryPromise(() => reading).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result));
        assert.equal(cancelled, 1);
        assert.isFalse(stream.locked);
      }),
    );
  }

  it.effect("preserves bodyless responses", () =>
    Effect.gen(function* () {
      assert.equal(yield* Effect.promise(() => readBoundedUtf8Body(new Response(null), 10)), "");
    }),
  );
});
