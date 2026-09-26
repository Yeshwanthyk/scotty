import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
export const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)));
export const Descriptor = Schema.Struct({
  digest: Digest,
  size: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  mediaType: Schema.String,
});
export const Index = Schema.Struct({
  manifests: Schema.Array(
    Schema.Struct({
      ...Descriptor.fields,
      platform: Schema.Struct({ os: Schema.String, architecture: Schema.String }),
    }),
  ),
});
export const Manifest = Schema.Struct({ config: Descriptor, layers: Schema.Array(Descriptor) });
export const Config = Schema.Struct({ os: Schema.String, architecture: Schema.String });
export const Token = Schema.Struct({ token: Schema.String });
export class CopyError extends Schema.TaggedError()("CopyError", {
  step: Schema.String,
  status: Schema.Number,
}) {}
const fail = (step, status = 0) => new CopyError({ step, status });
export const decode = (schema, value, step) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => fail(step)));
export const json = (bytes, step) =>
  Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)),
    catch: () => fail(step),
  });
export const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
// Keep raw credentials inside this transport closure; callers only get request methods.
export const registry = (base, credential) => {
  const request = (method, path, step, body, mediaType) =>
    call(
      new URL(path, `${base}/`).toString(),
      method,
      step,
      {
        authorization: Redacted.value(credential),
        ...(mediaType ? { "content-type": mediaType } : {}),
      },
      body,
    );
  return {
    request,
    upload: (url, step, body) => {
      if (
        url.protocol !== "https:" ||
        url.host !== "registry.cloudflare.com" ||
        !url.pathname.startsWith("/v2/")
      )
        return Effect.fail(fail("upload location"));
      return call(
        url.toString(),
        "PUT",
        step,
        { authorization: Redacted.value(credential), "content-type": "application/octet-stream" },
        body,
      );
    },
  };
};
export const call = (url, method, step, headers, body) =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt++) {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method,
            headers,
            ...(body ? { body: body(), duplex: "half" } : {}),
            redirect: "follow",
          }),
        catch: () => fail(step),
      }).pipe(Effect.result);
      if (Result.isSuccess(response)) {
        if (response.success.status < 500 || attempt >= 3) return response.success;
        yield* Effect.tryPromise({
          try: async () => {
            await response.success.body?.cancel();
          },
          catch: () => fail(step),
        });
      } else if (attempt >= 3) return yield* response.failure;
      yield* Effect.sleep(200 * 2 ** attempt);
    }
  });
export const check = (response, expected, step) =>
  response.status === expected ? Effect.void : Effect.fail(fail(step, response.status));
export const bytes = (response, step) =>
  Effect.tryPromise({
    try: () => response.arrayBuffer().then((b) => new Uint8Array(b)),
    catch: () => fail(step, response.status),
  });
// Spool each missing blob to disk and verify before *any* upload. Never hold a layer in memory.
export const spool = (response, blob, path) =>
  Effect.tryPromise({
    try: async () => {
      if (!response.body) throw Error("missing body");
      const file = await open(path, "w");
      const reader = response.body.getReader();
      const sum = createHash("sha256");
      let size = 0;
      try {
        const writeChunk = async (chunk, offset = 0) => {
          if (offset === chunk.byteLength) return;
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw Error("short write");
          await writeChunk(chunk, offset + bytesWritten);
        };
        const consume = async () => {
          const { done, value } = await reader.read();
          if (done) return;
          size += value.byteLength;
          if (size > blob.size) throw Error("size mismatch");
          sum.update(value);
          await writeChunk(value);
          await consume();
        };
        await consume();
      } finally {
        await file.close();
        reader.releaseLock();
      }
      if (size !== blob.size || `sha256:${sum.digest("hex")}` !== blob.digest)
        throw Error("digest mismatch");
      return size;
    },
    catch: () => fail(`blob digest/size ${blob.digest}`, response.status),
  });
export const streamFile = (path) => {
  let file;
  return new ReadableStream({
    async start() {
      file = await open(path, "r");
    },
    async pull(controller) {
      if (!file) {
        controller.error(Error("file closed"));
        return;
      }
      const chunk = new Uint8Array(65536);
      const { bytesRead } = await file.read(chunk);
      if (bytesRead === 0) {
        await file.close();
        file = undefined;
        controller.close();
      } else controller.enqueue(chunk.subarray(0, bytesRead));
    },
    async cancel() {
      if (file) await file.close();
      file = undefined;
    },
  });
};
export const remove = (path) =>
  Effect.tryPromise({
    try: () => rm(path, { force: true, recursive: true }),
    catch: () => fail("cleanup"),
  });
