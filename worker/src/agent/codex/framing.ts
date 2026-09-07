import { Effect } from "effect";
import { CODEX_MAX_MESSAGE_BYTES } from "../../../../protocol/codex-app-server";
import { CodexHostError } from "./errors";

export const limits = {
  record: CODEX_MAX_MESSAGE_BYTES,
  output: 8 * 1024 * 1024,
  events: 4096,
  stderr: 256 * 1024,
  input: 1024 * 1024,
} as const;

// One fixed allocation, before text decoding; no unbounded splitLines accumulator.
export const makeFramer = (maxTotal: number) => {
  const buffer = new Uint8Array(limits.record);
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let used = 0,
    total = 0;
  return {
    push: Effect.fnUntraced(function* (
      chunk: Uint8Array,
      receive: (line: string) => Effect.Effect<void, CodexHostError>,
    ) {
      total += chunk.byteLength;
      if (total > maxTotal) return yield* new CodexHostError({ code: "output_budget" });
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        const length = end - offset;
        if (used + length > buffer.length)
          return yield* new CodexHostError({ code: "message_too_large" });
        buffer.set(chunk.subarray(offset, end), used);
        used += length;
        if (newline < 0) break;
        const line = yield* Effect.try({
          try: () => utf8.decode(buffer.subarray(0, used)),
          catch: () => new CodexHostError({ code: "invalid_utf8" }),
        });
        used = 0;
        yield* receive(line);
        offset = newline + 1;
      }
    }),
    end: Effect.suspend(() =>
      used === 0 ? Effect.void : Effect.fail(new CodexHostError({ code: "truncated_record" })),
    ),
  };
};
