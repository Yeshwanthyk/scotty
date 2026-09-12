import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { buildResourceBundle, validateResourceFiles } from "../../src/sandbox/cloud-resources";
import { validateSandboxArchive } from "../../src/sandbox/archive";

const base64 = (text: string): string => btoa(text);

describe("cloud resource publishing", () => {
  it.effect("publishes a skill as a validated immutable bundle", () =>
    Effect.gen(function* () {
      const resource = yield* Effect.promise(() =>
        validateResourceFiles("skill", "example", {
          expectedRevision: 0,
          idempotencyKey: "example",
          shape: "directory",
          files: [{ path: "SKILL.md", contentBase64: base64("# Example\n"), modeClass: "regular" }],
        }),
      );
      assert.ok(resource !== undefined);
      const built = yield* buildResourceBundle({ items: [resource.item] }, resource.members);
      assert.ok(built !== undefined);
      const validated = yield* validateSandboxArchive(built.gzipBytes, built.digest).pipe(
        Effect.result,
      );
      assert.ok(Result.isSuccess(validated));
      assert.deepStrictEqual(
        validated.success.manifest.items.map(({ kind, name }) => ({ kind, name })),
        [{ kind: "skill", name: "example" }],
      );
    }),
  );

  it.effect("rejects unsafe files and unprepared dependency packages", () =>
    Effect.gen(function* () {
      const unsafe = yield* Effect.promise(() =>
        validateResourceFiles("skill", "example", {
          expectedRevision: 0,
          idempotencyKey: "unsafe",
          shape: "directory",
          files: [
            { path: "../SKILL.md", contentBase64: base64("# Example\n"), modeClass: "regular" },
          ],
        }),
      );
      assert.strictEqual(unsafe, undefined);
      const unprepared = yield* Effect.promise(() =>
        validateResourceFiles("package", "example", {
          expectedRevision: 0,
          idempotencyKey: "unprepared",
          shape: "directory",
          files: [
            {
              path: "package.json",
              contentBase64: base64(
                JSON.stringify({
                  name: "example",
                  pi: { extensions: ["index.ts"] },
                  dependencies: { leftpad: "1.0.0" },
                }),
              ),
              modeClass: "regular",
            },
          ],
        }),
      );
      assert.strictEqual(unprepared, undefined);
    }),
  );
});
