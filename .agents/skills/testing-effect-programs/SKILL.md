---
name: testing-effect-programs
description: Tests Effect programs with @effect/vitest, deterministic clocks, Layers, scopes, failures, and interruption. Use when adding Effect-returning tests or fixing conditional assertions and runtime escape hatches in tests.
license: MIT
compatibility: Scotty with @effect/vitest and Effect 4.0.0-beta.99.
---

# Test Effect programs

Use Effect-native tests for Effect-returning programs and ordinary Vitest tests for pure synchronous behavior.

## Rules

- Import `assert`, `describe`, and `it` from `@effect/vitest` for Effect tests.
- Use `it.effect` when the test returns an Effect.
- Use regular `it` for pure synchronous tests.
- Never use `Effect.runSync` or `Effect.runSyncExit` in tests.
- Use `TestClock` from `effect/testing` for time-dependent Effect behavior; do not wait on wall time.
- Provide dependencies with Layers or service replacement, not test-only routes around production ingress.
- Acquire resources in scopes and verify finalizers, interruption, retries, and typed failures where those are part of the contract.
- Keep assertions unconditional. Split cases or assert the discriminant before asserting branch data.

```ts
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

it.effect("retries after the scheduled delay", () =>
  Effect.gen(function* () {
    const fiber = yield* program.pipe(Effect.fork);
    yield* TestClock.adjust("1 second");
    const result = yield* fiber;
    assert.equal(result, "done");
  }),
);
```

Live Cloudflare tests remain skip-gated unless the exact user approval and isolated-stage guards are present. Never weaken no-deploy or credential-isolation assertions to make a test easier.

Read `vendor/effect/.patterns/testing.md` and inspect analogous beta.99 tests before introducing a new test pattern.
