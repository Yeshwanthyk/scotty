---
name: modeling-effect-errors
description: Models failures as typed Effect errors and keeps throws, rejections and Effect execution at host boundaries. Use when adding a failure path, wrapping a Promise or throwing API, recovering from an error, or converting an Effect to a Promise.
---

# Model Effect errors

A recoverable failure is a **tagged error** in the typed channel. Throws, rejected Promises and `Effect.run*` live only at a **host boundary**: a Worker or DO entrypoint, a native callback, the CLI's `main`, the supervisor's process entry.

## Rules

- Reuse the module's tagged error (`Schema.TaggedError` or `Data.TaggedError`) when callers recover the same way. Add a new one only for a distinct recovery: a different status, retry, hint or UI state.
- A failure stays a failure. It becomes `null`, `false` or an empty result only where that was already the contract.
- An unknown external value rides along as `cause` or is dropped. Domain behaviour and user-facing text come from the tag and its fields, never from `String(cause)` or `cause.message`.

## Forms

```ts
return yield * new RepositoryFailure({ status: 404 }); // inside Effect.gen

Effect.flatMap(read, (value) =>
  value === undefined ? Effect.fail(new NotFound({ id })) : Effect.succeed(value),
);

Effect.tryPromise({
  // wrap a Promise once
  try: (signal) => fetch(url, { signal }),
  catch: () => new UpstreamFailure({ stage: "fetch" }),
});
```

Recover with `Effect.catchTag` / `Effect.catchTags`. `Effect.orDie` is for a genuine defect — a broken invariant — not for skipping an error type.

## Host boundaries

Keep each boundary the smallest adapter that translates between the host contract and Effect: `Effect.runPromise` in the DO's socket callback, `Command.runWith` under `main`'s one `try`. Domain modules return Effects. Pass the host's `AbortSignal` through when converting. A runtime lives no longer than the request, socket or process that owns it.

Before using an unfamiliar API, find it in `vendor/effect/packages/effect/src/Effect.ts` (or `Data.ts`, `Schema.ts`) and its tests.
