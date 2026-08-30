import { Option, Result } from "effect";
import { decodeJsonValue } from "./json";

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export async function readBoundedBytes(
  message: Pick<Request | Response, "body" | "headers">,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const declaredLength = Number(message.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return undefined;
  if (message.body === null) return new Uint8Array();
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readBoundedUtf8Body(
  message: Pick<Request | Response, "body" | "headers">,
  maxBytes: number,
): Promise<string | undefined> {
  const body = await readBoundedBytes(message, maxBytes);
  if (body === undefined) return undefined;
  return Result.getOrUndefined(Result.try(() => utf8Decoder.decode(body)));
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<Option.Option<unknown>> {
  const text = await readBoundedUtf8Body(response, maxBytes).then(
    (value) => Result.succeed(value),
    () => Result.fail(undefined),
  );
  if (Result.isFailure(text) || text.success === undefined) return Option.none();
  return decodeJsonValue(text.success);
}
