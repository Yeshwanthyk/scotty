---
name: decoding-effect-boundaries
description: Decodes untrusted data with Effect Schema at the boundary where it enters. Use when code parses HTTP bodies, WebSocket messages, R2 objects, OAuth responses, container props or CLI input, or casts or probes an unknown value.
---

# Decode Effect boundaries

Decode each untrusted value once, at its **ingress**, then keep the domain typed.

## Steps

1. Find the ingress: the first Scotty code that receives the value (request body, socket frame, R2 read, OAuth response, `ctx.props`, argv, env).
2. Define or reuse the smallest Schema that owns the accepted shape, beside its ingress. Reusable decoders sit at module scope.
3. Decode before any domain logic. Keep the typed Schema failure, or map it to the module's tagged error or a stable HTTP error.
4. Delete the downstream casts and shape probes the decode made redundant.

Done when every value from that ingress reaches domain code already decoded, and the file holds no `as`, `JSON.parse`, `Reflect.get` or `"field" in value` on it.

## Forms

```ts
const Steer = Schema.Struct({
  text: Prompt,
  turn: Schema.String,
  req: Schema.optional(Schema.String),
});
const body = yield * Schema.decodeUnknownEffect(Steer)(yield * request.json);

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Record)); // JSON text
const parsed = Schema.decodeUnknownResult(UpstreamError)(value); // sync, no Effect
```

- Refine with `.check(Schema.isPattern(...), Schema.isMaxLength(...))` or `Schema.makeFilter` so limits live in the schema.
- A typed guard is the right tool for a host object Schema can't describe (a binding, `ctx.exports`): give it a precise predicate that checks every field its result claims.
- From a native Cloudflare or Alchemy response, build an allow-listed object of the fields you keep. State, errors, logs and Alchemy outputs hold only those fields — no request objects, raw causes or credential-bearing values.

Before using a Schema API, find it in `vendor/effect/packages/effect/src/Schema.ts` and its tests.
