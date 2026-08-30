import { readFileSync } from "node:fs";
import path from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";
import noBrowserPersistence from "./rules/no-browser-persistence.js";
import noConditionalTests from "./rules/no-conditional-tests.js";
import noDirectDoStorage from "./rules/no-direct-do-storage.js";
import noDoubleCast from "./rules/no-double-cast.js";
import noEffectEscapeHatch from "./rules/no-effect-escape-hatch.js";
import noEffectRunSyncInTests from "./rules/no-effect-run-sync-in-tests.js";
import noEffectRuntimeEscape from "./rules/no-effect-runtime-escape.js";
import noErrorConstructor from "./rules/no-error-constructor.js";
import noErrorSubclass from "./rules/no-error-subclass.js";
import noInlineObjectTypeAssertion from "./rules/no-inline-object-type-assertion.js";
import noInlineSchemaCompile from "./rules/no-inline-schema-compile.js";
import noInstanceofError from "./rules/no-instanceof-error.js";
import noJsonParse from "./rules/no-json-parse.js";
import noBrowserRpcPath from "./rules/no-browser-rpc-path.js";
import noManualTagCheck from "./rules/no-manual-tag-check.js";
import noMatchOrelse from "./rules/no-match-orelse.js";
import noPromiseClientSurface from "./rules/no-promise-client-surface.js";
import noPromiseReject from "./rules/no-promise-reject.js";
import noRecordStringUnknown from "./rules/no-record-string-unknown.js";
import noRawErrorThrow from "./rules/no-raw-error-throw.js";
import noRawFetch from "./rules/no-raw-fetch.js";
import noRawWallClock from "./rules/no-raw-wall-clock.js";
import noRedundantErrorFactory from "./rules/no-redundant-error-factory.js";
import noRedundantPrimitiveCast from "./rules/no-redundant-primitive-cast.js";
import noSchemaClass from "./rules/no-schema-class.js";
import noStorageKeyLiteral from "./rules/no-storage-key-literal.js";
import noSwitchStatement from "./rules/no-switch-statement.js";
import noTryCatchOrThrow from "./rules/no-try-catch-or-throw.js";
import noTsNocheck from "./rules/no-ts-nocheck.js";
import noUnsupportedEffectApi from "./rules/no-unsupported-effect-api.js";
import noUnsafeDomHtmlSink from "./rules/no-unsafe-dom-html-sink.js";
import preferEffectPredicate from "./rules/prefer-effect-predicate.js";
import preferSchemaInferredTypes from "./rules/prefer-schema-inferred-types.js";
import preferValueInferredExtensionTypes from "./rules/prefer-value-inferred-extension-types.js";
import scottyPlugin from "../oxlint-plugin-scotty.js";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    env: { browser: true },
    parserOptions: { lang: "ts" },
    sourceType: "module",
  },
});
const productionFile = "worker/src/session/object.ts";
const testFile = "worker/test/session/example.test.ts";
const toolingFile = path.resolve(import.meta.dirname, "../example.ts");
const workerFile = (name) => path.resolve(import.meta.dirname, `../../worker/src/${name}`);
const browserFile = (name) => path.resolve(import.meta.dirname, `../../worker/public/${name}`);

tester.run("no-browser-rpc-path", noBrowserRpcPath, {
  valid: [
    {
      filename: browserFile("terminal-console-client.js"),
      code: `const current = "/s/id/console/command"; const word = "/rpcish"`,
    },
    {
      filename: browserFile("terminal-console-client.js"),
      code: `const routes = { "/rpc": handler, [\`/rpc\`]: computed }; routes["/rpc"]`,
    },
  ],
  invalid: [
    {
      filename: browserFile("terminal-console-client.js"),
      code: `fetch("/rpc"); const endpoint = "https://example.test/rpc?stream=1"`,
      errors: 2,
    },
    {
      filename: browserFile("terminal-console-client.js"),
      code: "const endpoint = `/sessions/${sessionId}/rpc/events`; const root = `/rpc/${operation}`",
      errors: 2,
    },
  ],
});

tester.run("no-unsafe-dom-html-sink", noUnsafeDomHtmlSink, {
  valid: [
    {
      filename: browserFile("terminal.js"),
      code: `async function render(node) { node.textContent = await Promise.resolve("safe"); node.setAttribute("aria-label", "safe"); document.createElement("span"); fetch("/api"); new EventSource("/events") }`,
    },
    {
      filename: browserFile("terminal.js"),
      code: `const sinks = { innerHTML: value, insertAdjacentHTML() {} }; function write(document, window) { document.write(value); window.document.writeln(value) }`,
    },
  ],
  invalid: [
    {
      filename: browserFile("terminal.js"),
      code: `node.innerHTML = html; node["outerHTML"] += html; frame.srcdoc = html`,
      errors: 3,
    },
    {
      filename: browserFile("terminal.js"),
      code: `node.insertAdjacentHTML("beforeend", html); node["setHTMLUnsafe"](html); document.write(html); window.document.writeln(html)`,
      errors: 4,
    },
    {
      filename: browserFile("terminal.js"),
      code: `frame.setAttribute("srcdoc", html); frame.setAttribute(\`SRCDOC\`, html)`,
      errors: 2,
    },
  ],
});

tester.run("no-browser-persistence", noBrowserPersistence, {
  valid: [
    {
      filename: browserFile("sessions.js"),
      code: `const adapters = { localStorage: memory, sessionStorage() {}, indexedDB: db, caches: cache, cookieStore: cookies }; const { localStorage, cookieStore: localCookies } = adapters; adapters.localStorage.get("key"); localStorage.getItem("key")`,
    },
    {
      filename: browserFile("sessions.js"),
      code: `function read(localStorage, document, window) { localStorage.getItem("key"); document.cookie; window.sessionStorage }`,
    },
  ],
  invalid: [
    {
      filename: browserFile("sessions.js"),
      code: `localStorage.getItem("key"); sessionStorage.setItem("key", value); indexedDB.open("db"); caches.open("v1"); cookieStore.get("key")`,
      errors: 5,
    },
    {
      filename: browserFile("sessions.js"),
      code: `window.localStorage; globalThis["sessionStorage"]; self.indexedDB; window.caches; globalThis.cookieStore`,
      errors: 5,
    },
    {
      filename: browserFile("sessions.js"),
      code: `document.cookie = value; window.document.cookie; globalThis["document"]["cookie"]; self.document.cookie`,
      errors: 4,
    },
  ],
});

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

tester.run("no-direct-do-storage", noDirectDoStorage, {
  valid: [
    {
      filename: productionFile,
      code: `request.ctx.storage.get("key"); context.storage.get("key")`,
    },
    {
      filename: workerFile("session/store.ts"),
      code: `ctx.storage.get("key"); class Store { read() { return this.ctx.storage.get("key") } }`,
    },
    {
      filename: workerFile("auth/object.ts"),
      code: `class Auth { read() { return this.ctx.storage.get("key") } }`,
    },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `ctx.storage.get("key"); ctx["storage"].put("key", value)`,
      errors: 2,
    },
    {
      filename: productionFile,
      code: `class Session { read() { return this.ctx.storage.get("key") } }`,
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

tester.run("no-error-subclass", noErrorSubclass, {
  valid: [
    {
      filename: productionFile,
      code: `class DomainFailure extends Data.TaggedError("DomainFailure") {} class Custom extends BaseError {}`,
    },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `class DomainFailure extends Error {} const Anonymous = class extends globalThis.Error {}`,
      errors: 2,
    },
  ],
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
      code: `import * as Schema from "effect/Schema"; class Failure extends Schema.TaggedError<Failure>()("Failure", {}) {}`,
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

tester.run("no-storage-key-literal", noStorageKeyLiteral, {
  valid: [
    { filename: productionFile, code: `const key = "session"; const prefix = "scotty_"` },
    { filename: workerFile("session/store.ts"), code: `const key = "scotty:session"` },
    { filename: workerFile("auth/registry.ts"), code: `const key = "scotty:auth-authority"` },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `const record = "scotty:session"; const credential = 'scotty:credential'`,
      errors: 2,
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

tester.run("no-record-string-unknown", noRecordStringUnknown, {
  valid: [
    {
      filename: productionFile,
      code: `type JsonValue = string | number | boolean | null; type Precise = Record<string, string>; type ReadonlyPrecise = Readonly<Record<string, string>>; type Index = { [key: string]: string }; type ReadonlyIndex = { readonly [key: string]: string }; type Mapped = { [key in string]: string }; type ReadonlyMapped = { readonly [key in string]: string }; type Remapped = { [key in string as \`prefix_\${key}\`]: unknown }; type Recursive = Record<string, JsonValue>; type MapValue = Map<string, unknown>; const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json)`,
    },
  ],
  invalid: [
    {
      filename: productionFile,
      code: `type Direct = Record<string, unknown>; type ReadonlyDirect = Readonly<Record<string, unknown>>; type Index = { [key: string]: unknown }; type ReadonlyIndex = { readonly [key: string]: unknown }; type Mapped = { [key in string]: unknown }; type ReadonlyMapped = { readonly [key in string]: unknown }`,
      errors: 6,
      output: null,
    },
    {
      filename: productionFile,
      code: `type Parenthesized = Readonly<(Record<string, unknown>)>`,
      errors: 1,
      output: null,
    },
    {
      filename: productionFile,
      code: `type ReadonlyIndexWrapper = Readonly<{ [key: string]: unknown }>; type ReadonlyMappedWrapper = Readonly<{ [key in string]: unknown }>`,
      errors: 2,
      output: null,
    },
    {
      filename: productionFile,
      code: `const UnknownObjectSchema = Schema.Record(Schema.String, Schema.Unknown)`,
      errors: 1,
      output: null,
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

  it("covers Worker source strictly with only the three legacy exceptions", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const config = JSON.parse(readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8"));
    const legacyFiles = new Set([
      "worker/src/auth/request.ts",
      "worker/src/index.ts",
      "worker/src/session/object.ts",
    ]);
    const legacyOverrides = config.overrides.filter(
      (override) => override.files.length === 1 && legacyFiles.has(override.files[0]),
    );
    assert.ok(config.overrides[0].files.includes("worker/src/**/*.ts"));
    assert.deepEqual(
      legacyOverrides.map((override) => override.files),
      [["worker/src/session/object.ts"], ["worker/src/index.ts"], ["worker/src/auth/request.ts"]],
    );
    assert.deepEqual(legacyOverrides.flatMap((override) => override.files).sort(), [
      "worker/src/auth/request.ts",
      "worker/src/index.ts",
      "worker/src/session/object.ts",
    ]);
  });

  it("enables the precise strict rules and removes the imprecise rules", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const config = JSON.parse(readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8"));
    const strictRules = config.overrides[0].rules;
    const enabledRules = [
      "no-direct-do-storage",
      "no-effect-internal-tags",
      "no-error-subclass",
      "no-instanceof-tagged-error",
      "no-promise-catch",
      "no-unknown-error-message",
    ];
    for (const rule of enabledRules) {
      assert.ok(scottyPlugin.rules[rule]);
      assert.equal(strictRules[`scotty/${rule}`], "error");
    }
    for (const rule of ["no-unknown-shape-probing", "prefer-yield-tagged-error"]) {
      assert.equal(scottyPlugin.rules[rule], undefined);
      assert.equal(strictRules[`scotty/${rule}`], undefined);
    }
  });

  it("keeps storage, session, CLI, and test rules at their current migration gates", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const config = JSON.parse(readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8"));
    const strict = config.overrides[0];
    const workerStorage = config.overrides.find(
      (override) => override.files.length === 1 && override.files[0] === "worker/src/**/*.ts",
    );
    const session = config.overrides.find((override) =>
      override.files.includes("worker/src/session/object.ts"),
    );
    const workerTests = config.overrides.find(
      (override) => override.files.length === 1 && override.files[0] === "worker/test/**/*.ts",
    );

    assert.equal(strict.rules["scotty/no-direct-do-storage"], "error");
    assert.equal(strict.rules["scotty/no-error-subclass"], "error");
    assert.ok(scottyPlugin.rules["no-storage-key-literal"]);
    assert.equal(workerStorage.rules["scotty/no-storage-key-literal"], "error");
    assert.equal(session.rules["scotty/no-direct-do-storage"], undefined);
    assert.equal(session.rules["scotty/no-storage-key-literal"], undefined);
    assert.equal(session.rules["scotty/no-error-subclass"], undefined);
    assert.ok(strict.files.some((file) => file.startsWith("cli/")));
    assert.ok(!strict.files.some((file) => file.startsWith("worker/test/")));
    assert.equal(workerTests.rules["scotty/no-raw-wall-clock"], "error");
  });

  it("scopes browser quality rules to public adapters without banning browser ownership", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const config = JSON.parse(readFileSync(path.join(repoRoot, ".oxlintrc.json"), "utf8"));
    const browser = config.overrides.find(
      (override) => override.files.length === 1 && override.files[0] === "worker/public/**/*.js",
    );
    const browserRules = [
      "no-browser-persistence",
      "no-browser-rpc-path",
      "no-unsafe-dom-html-sink",
    ];

    assert.deepEqual(browser.env, { browser: true });
    for (const rule of browserRules) {
      assert.ok(scottyPlugin.rules[rule]);
      assert.equal(config.rules[`scotty/${rule}`], undefined);
      assert.equal(browser.rules[`scotty/${rule}`], "error");
    }
    assert.equal(browser.rules["scotty/no-promise-catch"], "off");
    assert.equal(browser.rules["scotty/no-raw-fetch"], undefined);
  });
});
