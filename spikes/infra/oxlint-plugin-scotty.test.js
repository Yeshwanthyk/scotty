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
import noManualTagCheck from "../../scripts/oxlint-plugin-scotty/rules/no-manual-tag-check.js";
import noMatchOrelse from "../../scripts/oxlint-plugin-scotty/rules/no-match-orelse.js";
import noPromiseClientSurface from "../../scripts/oxlint-plugin-scotty/rules/no-promise-client-surface.js";
import noPromiseReject from "../../scripts/oxlint-plugin-scotty/rules/no-promise-reject.js";
import noRawErrorThrow from "../../scripts/oxlint-plugin-scotty/rules/no-raw-error-throw.js";
import noRawFetch from "../../scripts/oxlint-plugin-scotty/rules/no-raw-fetch.js";
import noRawWallClock from "../../scripts/oxlint-plugin-scotty/rules/no-raw-wall-clock.js";
import noRedundantErrorFactory from "../../scripts/oxlint-plugin-scotty/rules/no-redundant-error-factory.js";
import noRedundantPrimitiveCast from "../../scripts/oxlint-plugin-scotty/rules/no-redundant-primitive-cast.js";
import noSchemaClass from "../../scripts/oxlint-plugin-scotty/rules/no-schema-class.js";
import noSwitchStatement from "../../scripts/oxlint-plugin-scotty/rules/no-switch-statement.js";
import noTryCatchOrThrow from "../../scripts/oxlint-plugin-scotty/rules/no-try-catch-or-throw.js";
import noTsNocheck from "../../scripts/oxlint-plugin-scotty/rules/no-ts-nocheck.js";
import noUnsupportedEffectApi from "../../scripts/oxlint-plugin-scotty/rules/no-unsupported-effect-api.js";
import preferEffectPredicate from "../../scripts/oxlint-plugin-scotty/rules/prefer-effect-predicate.js";
import preferSchemaInferredTypes from "../../scripts/oxlint-plugin-scotty/rules/prefer-schema-inferred-types.js";
import preferValueInferredExtensionTypes from "../../scripts/oxlint-plugin-scotty/rules/prefer-value-inferred-extension-types.js";
import scottyPlugin from "../../scripts/oxlint-plugin-scotty.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" }, sourceType: "module" },
});
const productionFile = "spikes/infra/write-only-secret.ts";
const testFile = "spikes/infra/example.test.ts";
const toolingFile = path.resolve(import.meta.dirname, "../../scripts/example.ts");

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

tester.run("no-manual-tag-check", noManualTagCheck, {
  valid: [
    { filename: productionFile, code: `Predicate.isTagged(value, "Ready")` },
    { filename: productionFile, code: `const value = { _tag: "Ready" }` },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `value._tag === "Ready"; "_tag" in value; consume(value["_tag"])`,
      errors: 3,
    },
  ],
});

tester.run("no-match-orelse", noMatchOrelse, {
  valid: [
    { filename: productionFile, code: `const Match = localMatcher; Match.orElse(fallback)` },
    {
      filename: productionFile,
      code: `import * as Match from "effect/Match"; matcher.pipe(Match.exhaustive)`,
    },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `import * as Match from "effect/Match"; matcher.pipe(Match.orElse(fallback))`,
      errors: 1,
    },
    {
      filename: productionFile,
      code: `import { Match as M } from "effect"; matcher.pipe(M.orElse(fallback))`,
      errors: 1,
    },
  ],
});

tester.run("no-promise-client-surface", noPromiseClientSurface, {
  valid: [
    {
      filename: productionFile,
      code: `interface GitHubClient { readonly get: (id: string) => Effect.Effect<Result, Failure> }`,
    },
    {
      filename: productionFile,
      code: `interface PromiseFactory { readonly make: () => Promise<Result> }`,
    },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `interface GitHubClient { get(id: string): Promise<Result>; readonly list: () => Promise<Result[]> }`,
      errors: 2,
    },
    {
      filename: productionFile,
      code: `export interface GitHubSdk { readonly get: () => Promise<Result> }`,
      errors: 1,
    },
  ],
});

tester.run("no-raw-error-throw", noRawErrorThrow, {
  valid: [
    { filename: productionFile, code: `throw new Error("native host failure")` },
    { filename: productionFile, code: `throw new DomainFailure({ operation: "read" })` },
    { filename: productionFile, code: `assert.fail("bad")` },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `import { Effect } from "effect"; throw new Error("bad")`,
      errors: 1,
    },
  ],
});

tester.run("no-raw-fetch", noRawFetch, {
  valid: [
    { filename: productionFile, code: `env.ASSETS.fetch(request); service.fetch(request)` },
    { filename: productionFile, code: `class Worker { fetch(request) { return response } }` },
    { filename: productionFile, code: `httpClient.fetch(request)` },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `fetch(url); globalThis.fetch(url); window.fetch(url); self["fetch"]`,
      errors: 4,
    },
    {
      filename: productionFile,
      code: `(globalThis.fetch as typeof globalThis.fetch)(url)`,
      errors: 1,
    },
  ],
});

tester.run("no-redundant-error-factory", noRedundantErrorFactory, {
  valid: [
    {
      filename: productionFile,
      code: `const makeReadError = (cause) => new ReadError({ cause: sanitize(cause) })`,
    },
    { filename: productionFile, code: `const makeResult = (cause) => new ReadError({ cause })` },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `const makeReadError = (cause) => new ReadError({ cause })`,
      errors: 1,
    },
    {
      filename: productionFile,
      code: `function readError(cause) { return new ReadError({ cause, operation: "read" }) }`,
      errors: 1,
    },
  ],
});

tester.run("no-redundant-primitive-cast", noRedundantPrimitiveCast, {
  valid: [
    { filename: productionFile, code: `const value = String(input)` },
    { filename: productionFile, code: `const value = "ready" as const` },
    { filename: toolingFile, code: `const value = input as string` },
  ],
  invalid: [
    { filename: productionFile, code: `const value = input as string`, errors: 1 },
    { filename: productionFile, code: `const value = <number>record.count`, errors: 1 },
  ],
});

tester.run("no-schema-class", noSchemaClass, {
  valid: [
    {
      filename: productionFile,
      code: `import * as Schema from "effect/Schema"; class Failure extends Schema.TaggedErrorClass<Failure>()("Failure", {}) {}`,
    },
    {
      filename: productionFile,
      code: `import * as Schema from "effect/Schema"; const Model = Schema.Struct({ id: Schema.String })`,
    },
    { filename: productionFile, code: `const Schema = localSchema; Schema.Class()` },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `import * as Schema from "effect/Schema"; class Model extends Schema.Class<Model>("Model")({ id: Schema.String }) {}`,
      errors: 1,
    },
    {
      filename: productionFile,
      code: `import { Schema as S } from "effect"; const Tagged = S.TaggedClass<Tagged>()("Tagged", {})`,
      errors: 1,
    },
  ],
});

tester.run("no-switch-statement", noSwitchStatement, {
  valid: [{ filename: productionFile, code: `Match.value(value).pipe(Match.exhaustive)` }],
  invalid: [
    {
      filename: productionFile,
      code: `switch (value) { case "ready": break; default: break }`,
      errors: 1,
    },
  ],
});

tester.run("no-unsupported-effect-api", noUnsupportedEffectApi, {
  valid: [
    {
      filename: productionFile,
      code: `import * as Effect from "effect/Effect"; Effect.callback(register); Effect.andThen(first, second); Effect.timeoutOption(program, duration); Effect.timeoutOrElse(program, options)`,
    },
    { filename: productionFile, code: `client.async(); client.zipRight(); client.timeoutFail()` },
    { filename: productionFile, code: `const Effect = localRuntime; Effect.async(register)` },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `import * as Effect from "effect/Effect"; Effect.async(register); Effect.zipRight(first, second); Effect.timeoutFail(program, options)`,
      errors: 3,
    },
    {
      filename: productionFile,
      code: `import { Effect as Fx } from "effect"; Fx.async(register)`,
      errors: 1,
    },
  ],
});

tester.run("prefer-effect-predicate", preferEffectPredicate, {
  valid: [
    {
      filename: productionFile,
      code: `import { Predicate } from "effect"; values.filter(Predicate.isNotNullish)`,
    },
    { filename: productionFile, code: `values.filter((value) => value.active !== false)` },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `import { Effect } from "effect"; const present = (value) => value !== undefined; values.filter((value) => value != null); function absent(value) { return value === null }`,
      errors: 3,
    },
  ],
});

tester.run("prefer-value-inferred-extension-types", preferValueInferredExtensionTypes, {
  valid: [
    {
      filename: productionFile,
      code: `type SearchExtension = ReturnType<typeof makeSearchExtension>; const plugin = { extension: makeSearchExtension }`,
    },
    {
      filename: productionFile,
      code: `interface SearchService { readonly search: () => Result }`,
    },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `interface SearchExtension { readonly search: () => Result } const plugin = { extension: (): SearchExtension => ({ search }) }`,
      errors: 1,
    },
    {
      filename: productionFile,
      code: `type SearchPluginExtension = { readonly search: () => Result }; const plugin = { extension: () => ({ search }) satisfies SearchPluginExtension }`,
      errors: 1,
    },
  ],
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
  it("enables the complete non-fetch subset globally", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const config = JSON.parse(readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8"));
    const globalRules = [
      "no-manual-tag-check",
      "no-match-orelse",
      "no-promise-client-surface",
      "no-raw-error-throw",
      "no-redundant-error-factory",
      "no-redundant-primitive-cast",
      "no-schema-class",
      "no-switch-statement",
      "no-unsupported-effect-api",
      "prefer-effect-predicate",
      "prefer-value-inferred-extension-types",
    ];
    for (const rule of globalRules) {
      assert.equal(config.rules[`scotty/${rule}`], "error");
    }
    assert.equal(config.rules["scotty/no-raw-fetch"], undefined);
  });

  it("tracks migrated Effect modules explicitly", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const config = JSON.parse(readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8"));
    assert.deepEqual(config.overrides, [
      {
        files: [
          "alchemy.run.ts",
          "worker/src/contracts.ts",
          "worker/src/session-projection.ts",
          "worker/src/session-store.ts",
          "spikes/infra/account-secrets-store-canary.run.ts",
          "spikes/infra/account-secrets-store-canary.ts",
          "spikes/infra/external-sandbox-container-binding.ts",
          "spikes/infra/local-secret-source.ts",
          "spikes/infra/monolith-greenfield.ts",
          "spikes/infra/sandbox-sdk-canary.ts",
          "spikes/infra/write-only-secret-cloudflare.ts",
          "spikes/infra/write-only-secret.ts",
        ],
        rules: {
          "scotty/no-effect-runtime-escape": "error",
          "scotty/no-error-constructor": "error",
          "scotty/no-instanceof-error": "error",
          "scotty/no-json-parse": "error",
          "scotty/no-promise-reject": "error",
          "scotty/no-raw-error-throw": "off",
          "scotty/no-raw-fetch": "error",
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
