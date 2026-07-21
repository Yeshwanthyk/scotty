---
name: modeling-effect-errors
description: Models failures as typed Effect values and keeps defects, throws, Promise rejections, and unknown errors at explicit host boundaries. Use when implementing or reviewing Effect error handling.
license: MIT
compatibility: Scotty with Effect 4.0.0-beta.99; verify APIs against vendor/effect.
---

# Model Effect errors

Keep recoverable failures in the typed error channel. Preserve behavior while replacing JavaScript error escape hatches.

## Workflow

1. Identify whether the code is domain logic or a native Cloudflare, Alchemy, CLI, callback, or test boundary.
2. Reuse a nearby `Schema.TaggedErrorClass` or `Data.TaggedError` when it represents the same recovery policy.
3. Add a new tagged error only when callers need distinct recovery, retry, status, UI, or telemetry behavior.
4. Preserve failure semantics. Never turn a failure into `false`, `null`, `undefined`, an empty collection, or another successful fallback unless that was already the contract.
5. Keep unknown external values as `cause`; do not derive domain behavior or user-facing copy from `String(cause)`, `cause.message`, or `instanceof Error`.

## Preferred forms

Inside `Effect.gen`, terminal tagged failures can be yielded directly:

```ts
return yield * new SourceNotFoundError({ sourceId });
```

In combinator code, use `Effect.fail`:

```ts
Effect.flatMap(source, (value) =>
  value === undefined ? Effect.fail(new SourceNotFoundError({ sourceId })) : Effect.succeed(value),
);
```

Wrap throwing and Promise APIs once:

```ts
Effect.tryPromise({
  try: (signal) => client.read({ signal }),
  catch: (cause) => new ClientReadError({ cause }),
});
```

Use `Effect.catchTag` or `Effect.catchTags` for typed recovery. Do not use `try/catch` inside `Effect.gen`, `Effect.orDie` to avoid threading an error, or raw Promise `.catch` in domain code.

## True boundaries

Native host signatures may require throws, rejected Promises, or conversion to a Promise. Keep those operations in the smallest adapter and immediately translate to or from Effect. A lint suppression must be adjacent, rule-specific, and include a `boundary:` reason. Do not build fake Effect abstractions around pure parsing, static configuration, or native callback contracts merely for uniformity.

Before using an unfamiliar API, inspect `vendor/effect/.patterns/effect.md`, `vendor/effect/packages/effect/src/Effect.ts`, `Data.ts`, `Schema.ts`, and their tests at beta.99.
