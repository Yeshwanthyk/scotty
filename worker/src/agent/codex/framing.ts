import { Effect } from "effect";
import { CodexHostError } from "./errors";

// The native app-server writes one JSON object per line. Keep only the
// unfinished line here; session state handles retention after decoding.
export const makeFramer = () => {
  const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let parts: Array<string> = [];
  return {
    push: Effect.fnUntraced(function* (
      chunk: Uint8Array,
      receive: (line: string) => Effect.Effect<void, CodexHostError>,
    ) {
      const text = yield* Effect.try({
        try: () => utf8.decode(chunk, { stream: true }),
        catch: () => new CodexHostError({ code: "invalid_utf8" }),
      });
      let start = 0;
      for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
        const line = parts.join("") + text.slice(start, end);
        parts = [];
        yield* receive(line);
        start = end + 1;
      }
      if (start < text.length) parts.push(text.slice(start));
    }),
    end: Effect.gen(function* () {
      const tail = yield* Effect.try({
        try: () => utf8.decode(),
        catch: () => new CodexHostError({ code: "invalid_utf8" }),
      });
      if (parts.length > 0 || tail.length > 0)
        return yield* new CodexHostError({ code: "truncated_record" });
    }),
  };
};
