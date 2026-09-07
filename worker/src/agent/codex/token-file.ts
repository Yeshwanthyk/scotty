import { Effect, Schema } from "effect";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { CodexBridgeError, CodexControlToken } from "./runtime";

const decodeToken = Schema.decodeUnknownEffect(CodexControlToken);
// boundary: Effect FileSystem.OpenFlag cannot express O_NOFOLLOW or O_NONBLOCK.
export const consumeControlToken = Effect.fnUntraced(function* (path: string, workspace: string) {
  const attempt = <A>(operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: operation,
      catch: () => new CodexBridgeError({ code: "token_file", outcome: "rejected" }),
    });
  const parent = yield* attempt(() => realpath(dirname(path)));
  const cwd = yield* attempt(() => realpath(workspace));
  const parentInfo = yield* attempt(() => lstat(parent));
  if (
    parent === cwd ||
    parent.startsWith(`${cwd === "/" ? "" : cwd}/`) ||
    (parentInfo.mode & 0o077) !== 0 ||
    parentInfo.uid !== process.getuid?.()
  )
    return yield* new CodexBridgeError({ code: "token_file", outcome: "rejected" });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* Effect.acquireRelease(
        attempt(() => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)),
        (file) => attempt(() => file.close()).pipe(Effect.ignore),
      );
      const info = yield* attempt(() => file.stat());
      if (
        !info.isFile() ||
        (info.mode & 0o077) !== 0 ||
        info.uid !== process.getuid?.() ||
        info.size !== 64
      )
        return yield* new CodexBridgeError({ code: "token_file", outcome: "rejected" });
      const buffer = new Uint8Array(65);
      const read = yield* attempt(() => file.read(buffer, 0, buffer.length, 0));
      if (read.bytesRead !== 64)
        return yield* new CodexBridgeError({ code: "token_file", outcome: "rejected" });
      const token = yield* decodeToken(new TextDecoder().decode(buffer.subarray(0, 64))).pipe(
        Effect.mapError(() => new CodexBridgeError({ code: "token_file", outcome: "rejected" })),
      );
      const linked = yield* attempt(() => lstat(path));
      if (linked.dev !== info.dev || linked.ino !== info.ino)
        return yield* new CodexBridgeError({ code: "token_file", outcome: "rejected" });
      yield* attempt(() => unlink(path));
      return token;
    }),
  );
});
