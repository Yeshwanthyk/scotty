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
      platform: Schema.optional(Schema.Struct({ os: Schema.String, architecture: Schema.String })),
    }),
  ),
});
export const Manifest = Schema.Struct({ config: Descriptor, layers: Schema.Array(Descriptor) });
export const Config = Schema.Struct({ os: Schema.String, architecture: Schema.String });
export const Token = Schema.Struct({ token: Schema.String });
export type Blob = typeof Descriptor.Type;

export class CopyError extends Schema.TaggedError<CopyError>()("CopyError", {
  step: Schema.String,
  status: Schema.Number,
}) {}
const fail = (step: string, status = 0) => new CopyError({ step, status });
export const decode = <S extends Schema.Top>(schema: S, value: unknown, step: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => fail(step)));
export const json = (bytes: Uint8Array, step: string) =>
  Effect.try({
    try: (): unknown => JSON.parse(new TextDecoder().decode(bytes)),
    catch: () => fail(step),
  });
export const hash = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const headerTimeoutMs = 15_000;
// A blob upload's response arrives only after its whole body, which for a 339 MB layer is minutes.
const uploadTimeoutMs = 600_000;
const idleTimeoutMs = 15_000;
const controllers = new WeakMap<Response, AbortController>();
const reading = <T>(response: Response, operation: () => Promise<T>): Promise<T> => {
  const controller = controllers.get(response);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(fail("body idle timeout", response.status));
    }, idleTimeoutMs);
  });
  return Promise.race([operation(), timeout]).finally(() => clearTimeout(timer));
};
const cancel = (response: Response, reader: ReadableStreamDefaultReader<Uint8Array>) => {
  controllers.get(response)?.abort();
  void reader.cancel().catch(() => {});
};

// Keep raw credentials inside this transport closure; callers only get request methods.
export const registry = (base: string, credential: Redacted.Redacted<string>) => {
  const request = (
    method: string,
    path: string,
    step: string,
    body?: () => BodyInit,
    mediaType?: string,
  ) =>
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
    upload: (url: URL, step: string, body: () => BodyInit) => {
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
        uploadTimeoutMs,
      );
    },
  };
};
export const call = (
  url: string,
  method: string,
  step: string,
  headers: Record<string, string>,
  body?: () => BodyInit,
  timeoutMs = headerTimeoutMs,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const response = yield* Effect.tryPromise({
        try: () => {
          const init: RequestInit & { duplex?: "half" } = {
            method,
            headers,
            ...(body ? { body: body(), duplex: "half" } : {}),
            redirect: "follow",
            signal: controller.signal,
          };
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<Response>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(fail(`${step} timeout`));
            }, timeoutMs);
          });
          return Promise.race([fetch(url, init), timeout]).finally(() => clearTimeout(timer));
        },
        catch: (cause) => (cause instanceof CopyError ? cause : fail(step)),
      }).pipe(Effect.result);
      if (Result.isSuccess(response)) {
        if (response.success.status < 500 || attempt >= 3) {
          controllers.set(response.success, controller);
          return response.success;
        }
        yield* Effect.promise(async () => {
          try {
            await response.success.body?.cancel();
          } catch {
            /* response already closed */
          }
        });
      } else if (attempt >= 3) return yield* response.failure;
      yield* Effect.sleep(200 * 2 ** attempt);
    }
  });
export const check = (response: Response, expected: number, step: string) =>
  response.status === expected ? Effect.void : Effect.fail(fail(step, response.status));
export const bytes = (response: Response, step: string, limit = 4 * 1024 * 1024) =>
  Effect.tryPromise({
    try: async () => {
      if (!response.body) throw fail(`${step} missing body`, response.status);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        const consume = async (): Promise<void> => {
          const { done, value } = await reading(response, () => reader.read());
          if (done) return;
          length += value.byteLength;
          if (length > limit) throw fail(`${step} size limit`, response.status);
          chunks.push(value);
          await consume();
        };
        await consume();
      } catch (cause) {
        cancel(response, reader);
        throw cause;
      }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    },
    catch: (cause) => (cause instanceof CopyError ? cause : fail(`${step} read`, response.status)),
  });

// Spool each missing blob to disk and verify before *any* upload. Never hold a layer in memory.
export const spool = (response: Response, blob: Blob, path: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!response.body) throw fail("blob missing body", response.status);
      const reader = response.body.getReader();
      const file = await open(path, "w").catch((cause: unknown) => {
        cancel(response, reader);
        throw cause;
      });
      const sum = createHash("sha256");
      let size = 0;
      try {
        const writeChunk = async (chunk: Uint8Array, offset = 0): Promise<void> => {
          if (offset === chunk.byteLength) return;
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw Error("short write");
          await writeChunk(chunk, offset + bytesWritten);
        };
        const consume = async (): Promise<void> => {
          const { done, value } = await reading(response, () => reader.read());
          if (done) return;
          size += value.byteLength;
          if (size > blob.size) throw fail(`blob size ${blob.digest}`, response.status);
          sum.update(value);
          await writeChunk(value);
          await consume();
        };
        await consume();
      } catch (cause) {
        cancel(response, reader);
        throw cause;
      } finally {
        await file.close();
      }
      if (size !== blob.size || `sha256:${sum.digest("hex")}` !== blob.digest)
        throw fail(`blob digest/size ${blob.digest}`, response.status);
      return size;
    },
    catch: (cause) =>
      cause instanceof CopyError ? cause : fail(`blob I/O ${blob.digest}`, response.status),
  });
export const streamFile = (path: string): BodyInit => {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
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
export const remove = (path: string) =>
  Effect.tryPromise({
    try: () => rm(path, { force: true, recursive: true }),
    catch: () => fail("cleanup"),
  });
