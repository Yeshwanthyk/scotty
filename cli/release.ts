// The release a deploy uploads. The compiled CLI carries one, packed by deploy/compile.ts and
// handed over by cli/binary.ts; run from a checkout, the CLI builds one there.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Schema } from "effect";

// release.pack: each file of the release, and SKILL.md, by path, base64.
export const Pack = Schema.Record(Schema.String, Schema.String);

let packed: string | undefined;
export const useRelease = (path: string) => {
  packed = path;
};
export const embedded = () => packed !== undefined;

const readPack = (path: string) =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Pack))),
  );

// A file of the embedded pack, or undefined when the CLI runs from a checkout.
export const packedFile = (name: string) =>
  Effect.gen(function* () {
    if (packed === undefined) return undefined;
    const content = (yield* readPack(packed))[name];
    return content === undefined ? undefined : Buffer.from(content, "base64").toString("utf8");
  });

// Writes the embedded release to a temporary folder, removed when the scope closes.
export const unpackRelease = Effect.gen(function* () {
  if (packed === undefined) return yield* Effect.fail(new Error("This CLI carries no release"));
  const pack = yield* readPack(packed);
  const dir = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(join(tmpdir(), "scotty-release-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );
  yield* Effect.tryPromise(async () => {
    for (const [name, content] of Object.entries(pack)) {
      if (!name.startsWith("release/")) continue;
      const path = join(dir, name.slice("release/".length));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(content, "base64"));
    }
  });
  return dir;
});
