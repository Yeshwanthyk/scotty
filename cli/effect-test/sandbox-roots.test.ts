import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { resolveSandboxBundleRoots } from "../src/sandbox-roots";

const withTempDirectory = <A, E, R>(use: (path: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "sandbox-roots-test-"))),
      use,
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    ),
  );

describe("sandbox push roots", () => {
  it.effect("resolves explicit roots and rejects duplicate, missing, or symlinked roots", () =>
    withTempDirectory((home) =>
      Effect.gen(function* () {
        const skills = join(home, "skills");
        yield* Effect.promise(() => mkdir(skills));
        yield* Effect.promise(() => symlink(skills, join(home, "alias")));
        const input = {
          home,
          cwd: home,
          skills: ["./skills"],
          packages: [],
          tools: [],
          extensions: [],
        };
        const roots = yield* resolveSandboxBundleRoots(input);
        assert.deepStrictEqual(roots, {
          skills: [yield* Effect.promise(() => realpath(skills))],
          packages: [],
          tools: [],
          extensions: [],
        });
        for (const rejected of [
          ["./skills", skills],
          ["./alias"],
          ["./missing"],
          ["~"],
          ["$UNRESOLVED"],
        ]) {
          const result = yield* Effect.result(
            resolveSandboxBundleRoots({ ...input, skills: rejected }),
          );
          assert.ok(Result.isFailure(result));
          assert.strictEqual(result.failure.code, "sandbox_source_invalid");
        }
      }),
    ),
  );
});
