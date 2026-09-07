import { Option, Result } from "effect";
import { decodeJsonValue } from "./json";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export async function readBoundedBytes(
  message: Pick<Request | Response, "body" | "headers">,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
  const declaredLength = Number(message.headers.get("content-length") ?? "0");
  if (message.body === null) {
    signal?.throwIfAborted();
    return Number.isFinite(declaredLength) && declaredLength > maxBytes
      ? undefined
      : new Uint8Array();
  }
  const reader = message.body.getReader();
  let finished = false;
  let cancelled = false;
  // Native stream boundary: cancellation may itself stall or reject. Release the local
  // reader synchronously without making the request deadline wait for the producer.
  const cancel = () => {
    if (!finished && !cancelled) {
      cancelled = true;
      // oxlint-disable-next-line scotty/no-promise-catch -- boundary: native stream cancellation must not retain a lock or mask the read failure.
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  };
  signal?.addEventListener("abort", cancel, { once: true });
  // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: native reader ownership requires finally on rejection and abort as well as EOF.
  try {
    signal?.throwIfAborted();
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return undefined;
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) {
        finished = true;
        break;
      }
      length += next.value.byteLength;
      if (length > maxBytes) return undefined;
      chunks.push(next.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

export async function readBoundedUtf8Body(
  message: Pick<Request | Response, "body" | "headers">,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const body = await readBoundedBytes(message, maxBytes, signal);
  if (body === undefined) return undefined;
  return Result.getOrUndefined(Result.try(() => utf8Decoder.decode(body)));
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Option.Option<unknown>> {
  const text = await readBoundedUtf8Body(response, maxBytes, signal).then(
    (value) => Result.succeed(value),
    () => Result.fail(undefined),
  );
  if (Result.isFailure(text) || text.success === undefined) return Option.none();
  return decodeJsonValue(text.success);
}
