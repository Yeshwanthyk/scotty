// Each scotty rule passes the code it allows and fails a fixture it exists to catch.
import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import plugin from "./index.ts";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const { rules } = plugin;

tester.run("no-effect-run", rules["no-effect-run"], {
  valid: ["export const program = Effect.succeed(1).pipe(Effect.map((n) => n + 1));"],
  invalid: [
    { code: "Effect.runPromise(program);", errors: 1 },
    { code: "Effect.runSync(program);", errors: 1 },
    { code: "Effect.runFork(program);", errors: 1 },
    { code: "pipe(program, Effect.runPromise);", errors: 1 },
  ],
});

tester.run("no-json-parse", rules["no-json-parse"], {
  valid: ["const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Body));"],
  invalid: [{ code: "const body: unknown = JSON.parse(text);", errors: 1 }],
});

tester.run("no-type-assertion", rules["no-type-assertion"], {
  valid: ["const kinds = ['a', 'b'] as const;", "const n: number = 1;"],
  invalid: [
    { code: "const body = value as Body;", errors: 1 },
    { code: "const body = <Body>value;", errors: 1 },
    { code: "const body = value as unknown as Body;", errors: 2 },
  ],
});

tester.run("no-throw-in-generator", rules["no-throw-in-generator"], {
  valid: [
    "Effect.gen(function* () { return yield* new Missing(); });",
    "function check(ok: boolean) { if (!ok) throw new Error('bad'); }",
    // A callback inside a generator is its own function.
    "Effect.gen(function* () { yield* Effect.sync(() => { throw new Error('defect'); }); });",
  ],
  invalid: [
    { code: "Effect.gen(function* () { throw new Error('bad'); });", errors: 1 },
    { code: "function* steps() { if (done) throw new Error('bad'); }", errors: 1 },
    { code: "const f = Effect.fn(function* () { throw new Error('bad'); });", errors: 1 },
  ],
});

tester.run("pure-fold", rules["pure-fold"], {
  valid: [
    "const due = event.at + 30_000;",
    "const when = new Date(event.at).toISOString();",
    "const n = Math.max(a, b);",
    "const { at } = event;",
    "const { max } = Math;",
  ],
  invalid: [
    { code: "const now = Date.now();", errors: 1 },
    { code: "const now = new Date();", errors: 1 },
    { code: "const id = Math.random();", errors: 1 },
    { code: "const id = crypto.randomUUID();", errors: 1 },
    { code: "const t = performance.now();", errors: 1 },
    { code: "console.log(state);", errors: 1 },
    { code: "fetch('https://example.com');", errors: 1 },
    { code: "setTimeout(tick, 10);", errors: 1 },
    { code: "const now = globalThis.Date.now();", errors: 1 },
    { code: "const id = self.crypto.randomUUID();", errors: 1 },
    { code: "const { now } = Date;", errors: 1 },
    { code: "const { random } = globalThis.Math;", errors: 1 },
    { code: "const { ...all } = Date;", errors: 1 },
    { code: "globalThis.fetch('https://example.com');", errors: 1 },
    { code: "const now = new globalThis.Date();", errors: 1 },
  ],
});
