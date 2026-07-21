import { readFileSync } from "node:fs";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";
import noConditionalTests from "../../scripts/oxlint-plugin-scotty/rules/no-conditional-tests.js";
import noDoubleCast from "../../scripts/oxlint-plugin-scotty/rules/no-double-cast.js";
import noEffectEscapeHatch from "../../scripts/oxlint-plugin-scotty/rules/no-effect-escape-hatch.js";
import noEffectRunSyncInTests from "../../scripts/oxlint-plugin-scotty/rules/no-effect-run-sync-in-tests.js";
import noEffectRuntimeEscape from "../../scripts/oxlint-plugin-scotty/rules/no-effect-runtime-escape.js";
import noErrorConstructor from "../../scripts/oxlint-plugin-scotty/rules/no-error-constructor.js";
import noInlineObjectTypeAssertion from "../../scripts/oxlint-plugin-scotty/rules/no-inline-object-type-assertion.js";
import noInlineSchemaCompile from "../../scripts/oxlint-plugin-scotty/rules/no-inline-schema-compile.js";
import noInstanceofError from "../../scripts/oxlint-plugin-scotty/rules/no-instanceof-error.js";
import noJsonParse from "../../scripts/oxlint-plugin-scotty/rules/no-json-parse.js";
import noPromiseReject from "../../scripts/oxlint-plugin-scotty/rules/no-promise-reject.js";
import noRawWallClock from "../../scripts/oxlint-plugin-scotty/rules/no-raw-wall-clock.js";
import noTryCatchOrThrow from "../../scripts/oxlint-plugin-scotty/rules/no-try-catch-or-throw.js";
import noTsNocheck from "../../scripts/oxlint-plugin-scotty/rules/no-ts-nocheck.js";
import preferSchemaInferredTypes from "../../scripts/oxlint-plugin-scotty/rules/prefer-schema-inferred-types.js";
import scottyPlugin from "../../scripts/oxlint-plugin-scotty.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" }, sourceType: "module" },
});
const productionFile = "spikes/infra/write-only-secret.ts";
const testFile = "spikes/infra/example.test.ts";

tester.run("no-conditional-tests", noConditionalTests, {
  valid: [
    { filename: testFile, code: `import { assert } from "@effect/vitest"; assert.equal(a, b)` },
    { filename: productionFile, code: `if (enabled) expect(value).toBe(true)` },
  ],
  invalid: [
    { filename: testFile, code: `if (enabled) expect(value).toBe(true)`, errors: 1 },
    {
      filename: testFile,
      code: `import { assert as check } from "@effect/vitest"; if (enabled) check.equal(a, b)`,
      errors: 1,
    },
    {
      filename: testFile,
      code: `import { assert } from "@effect/vitest"; enabled && assert(value)`,
      errors: 1,
    },
  ],
});

tester.run("no-double-cast", noDoubleCast, {
  valid: [
    { filename: productionFile, code: `const value = input as Model` },
    {
      filename: productionFile,
      code: `// lint-allow-double-cast: boundary: native-host-contract\nconst value = input as unknown as Model`,
    },
  ],
  invalid: [
    { filename: productionFile, code: `const value = input as unknown as Model`, errors: 1 },
    { filename: productionFile, code: `const value = <Model><unknown>input`, errors: 1 },
    {
      filename: productionFile,
      code: `// lint-allow-double-cast: ignore\nconst value = input as unknown as Model`,
      errors: 1,
    },
  ],
});

tester.run("no-effect-escape-hatch", noEffectEscapeHatch, {
  valid: [{ filename: productionFile, code: `Effect.fail(error)` }],
  invalid: [
    {
      filename: productionFile,
      code: `Effect.die(error); Effect.dieMessage("bad"); Effect.orDie(program); Effect.orDieWith(program, f)`,
      errors: 4,
    },
  ],
});

tester.run("no-effect-run-sync-in-tests", noEffectRunSyncInTests, {
  valid: [{ filename: productionFile, code: `Effect.runSync(program)` }],
  invalid: [
    {
      filename: testFile,
      code: `Effect.runSync(program); Effect.runSyncExit(program)`,
      errors: 2,
    },
  ],
});

tester.run("no-inline-object-type-assertion", noInlineObjectTypeAssertion, {
  valid: [{ filename: productionFile, code: `const value = input as Model` }],
  invalid: [
    { filename: productionFile, code: `const value = input as { id: string }`, errors: 1 },
    {
      filename: productionFile,
      code: `const value = input as Record<string, unknown>`,
      errors: 1,
    },
    { filename: productionFile, code: `const value = <{ id: string }>input`, errors: 1 },
  ],
});

tester.run("no-inline-schema-compile", noInlineSchemaCompile, {
  valid: [
    {
      filename: productionFile,
      code: `const decode = Schema.decodeUnknownEffect(ModelSchema); const parse = (value: unknown) => decode(value)`,
    },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `const parse = (value: unknown) => Schema.decodeUnknownEffect(ModelSchema)(value)`,
      errors: 1,
    },
  ],
});

tester.run("no-ts-nocheck", noTsNocheck, {
  valid: [{ filename: productionFile, code: `const text = "@ts-nocheck"` }],
  invalid: [{ filename: productionFile, code: `// @ts-nocheck\nconst value = input`, errors: 1 }],
});

tester.run("prefer-schema-inferred-types", preferSchemaInferredTypes, {
  valid: [
    {
      filename: productionFile,
      code: `const ModelSchema = Schema.Struct({ id: Schema.String }); type Model = typeof ModelSchema.Type`,
    },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `const ModelSchema = Schema.Struct({ id: Schema.String }); interface Model { readonly id: string }`,
      errors: 1,
    },
  ],
});

tester.run("no-effect-runtime-escape", noEffectRuntimeEscape, {
  valid: [{ filename: productionFile, code: `program.pipe(Effect.flatMap(next))` }],
  invalid: [
    {
      filename: productionFile,
      code: `Effect.runPromise(program); Effect.runPromiseExit(program); Effect.runSync(program); Effect.runSyncExit(program); Effect.runFork(program)`,
      errors: 5,
    },
  ],
});

tester.run("no-error-constructor", noErrorConstructor, {
  valid: [{ filename: productionFile, code: `new DomainFailure({ operation: "read" })` }],
  invalid: [{ filename: productionFile, code: `new Error("bad"); TypeError("bad")`, errors: 2 }],
});

tester.run("no-instanceof-error", noInstanceofError, {
  valid: [{ filename: productionFile, code: `Predicate.isTagged(error, "DomainError")` }],
  invalid: [{ filename: productionFile, code: `error instanceof Error`, errors: 1 }],
});

tester.run("no-json-parse", noJsonParse, {
  valid: [{ filename: productionFile, code: `decodeJson(text)` }],
  invalid: [{ filename: productionFile, code: `JSON.parse(text)`, errors: 1 }],
});

tester.run("no-promise-reject", noPromiseReject, {
  valid: [{ filename: productionFile, code: `Effect.fail(error)` }],
  invalid: [
    { filename: productionFile, code: `Promise.reject(error)`, errors: 1 },
    {
      filename: productionFile,
      code: `new Promise((resolve, reject) => reject(error))`,
      errors: 1,
    },
  ],
});

tester.run("no-raw-wall-clock", noRawWallClock, {
  valid: [
    { filename: productionFile, code: `Clock.currentTimeMillis; new Date(0); Effect.sleep(1)` },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `Date.now(); new Date(); setTimeout(work, 1); setInterval(work, 1)`,
      errors: 4,
    },
  ],
});

tester.run("no-try-catch-or-throw", noTryCatchOrThrow, {
  valid: [{ filename: productionFile, code: `Effect.try({ try: work, catch: mapFailure })` }],
  invalid: [
    {
      filename: productionFile,
      code: `try { work() } catch (cause) { throw cause }`,
      errors: 2,
    },
  ],
});

describe("Scotty Oxlint policy integration", () => {
  it("tracks migrated Effect modules explicitly", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const config = JSON.parse(readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8"));
    assert.deepEqual(config.overrides, [
      {
        files: [
          "spikes/infra/external-sandbox-container-binding.ts",
          "spikes/infra/sandbox-sdk-canary.ts",
          "spikes/infra/write-only-secret.ts",
        ],
        rules: {
          "scotty/no-effect-runtime-escape": "error",
          "scotty/no-error-constructor": "error",
          "scotty/no-instanceof-error": "error",
          "scotty/no-json-parse": "error",
          "scotty/no-promise-reject": "error",
          "scotty/no-raw-wall-clock": "error",
          "scotty/no-try-catch-or-throw": "error",
        },
      },
    ]);
  });

  it("registers but does not enable rules awaiting semantic precision", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const config = readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8");
    const disabledRules = [
      "no-effect-internal-tags",
      "no-instanceof-tagged-error",
      "no-promise-catch",
      "no-unknown-error-message",
      "no-unknown-shape-probing",
      "prefer-yield-tagged-error",
    ];
    for (const rule of disabledRules) {
      assert.ok(scottyPlugin.rules[rule]);
      assert.equal(config.includes(`"scotty/${rule}"`), false);
    }
  });
});
