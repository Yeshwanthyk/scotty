import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  RUNNER_CREDIT_WINDOW,
  RUNNER_DATA_CHUNK_LIMIT,
  decodeRunnerFrameText,
  decodeRunnerReplyText,
  decodeRunnerRequestText,
  encodeRunnerFrame,
  encodeRunnerRequest,
  type HttpOpen,
} from "./runner";

const open = (overrides: Partial<HttpOpen> = {}): HttpOpen => ({
  _tag: "HttpOpen",
  version: 2,
  streamId: "stream-1",
  sessionId: "session-1",
  runtimeId: "runtime-1",
  method: "POST",
  target: "/mounted/path?x=1",
  headers: [["content-type", "application/octet-stream"]],
  hasBody: true,
  responseCredit: RUNNER_CREDIT_WINDOW,
  ...overrides,
});

const rejects = (decode: (text: string) => Effect.Effect<unknown, unknown>, value: unknown) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(decode(JSON.stringify(value)));
    assert.isTrue(Result.isFailure(result));
  });

describe("runner protocol v2 HTTP frames", () => {
  it.effect("roundtrips valid directional frames", () =>
    Effect.gen(function* () {
      const requestData = {
        _tag: "HttpData" as const,
        version: 2 as const,
        streamId: "stream-1",
        direction: "request" as const,
        data: "AQID",
      };
      assert.deepStrictEqual(yield* decodeRunnerRequestText(encodeRunnerRequest(open())), open());
      assert.deepStrictEqual(
        yield* decodeRunnerRequestText(encodeRunnerRequest(requestData)),
        requestData,
      );

      const response = {
        _tag: "HttpResponse" as const,
        version: 2 as const,
        streamId: "stream-1",
        status: 200,
        statusText: "OK",
        headers: [["content-type", "text/plain"]] as const,
        hasBody: true,
      };
      assert.deepStrictEqual(yield* decodeRunnerReplyText(encodeRunnerFrame(response)), response);
      assert.deepStrictEqual(yield* decodeRunnerFrameText(encodeRunnerFrame(response)), response);
    }),
  );

  it.effect("rejects malformed and oversized data", () =>
    Effect.gen(function* () {
      const frame = {
        _tag: "HttpData",
        version: 2,
        streamId: "stream-1",
        direction: "request",
      };
      yield* rejects(decodeRunnerRequestText, { ...frame, data: "not base64" });
      yield* rejects(decodeRunnerRequestText, { ...frame, data: "AQ=" });
      yield* rejects(decodeRunnerRequestText, {
        ...frame,
        data: Buffer.alloc(RUNNER_DATA_CHUNK_LIMIT + 1).toString("base64"),
      });
    }),
  );

  it.effect("rejects invalid open and response bounds", () =>
    Effect.gen(function* () {
      yield* rejects(decodeRunnerRequestText, open({ headers: Array(129).fill(["x", "y"]) }));
      yield* rejects(decodeRunnerRequestText, open({ headers: [["x", "y".repeat(65_536)]] }));
      yield* rejects(decodeRunnerRequestText, open({ method: "NOT A METHOD" }));
      yield* rejects(decodeRunnerRequestText, open({ target: "x".repeat(16 * 1024 + 1) }));
      yield* rejects(decodeRunnerReplyText, {
        _tag: "HttpResponse",
        version: 2,
        streamId: "stream-1",
        status: 99,
        statusText: "bad",
        headers: [],
        hasBody: false,
      });
    }),
  );

  it.effect("rejects frames sent in the wrong direction", () =>
    Effect.gen(function* () {
      const data = {
        _tag: "HttpData",
        version: 2,
        streamId: "stream-1",
        data: "AQ==",
      };
      yield* rejects(decodeRunnerRequestText, { ...data, direction: "response" });
      yield* rejects(decodeRunnerReplyText, { ...data, direction: "request" });
      yield* rejects(decodeRunnerReplyText, open());
    }),
  );
});
