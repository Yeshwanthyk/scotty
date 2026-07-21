---
name: decoding-effect-boundaries
description: Decodes unknown HTTP, environment, storage, OAuth, CLI, archive, and SDK data with Effect Schema or precise typed adapters. Use when data is cast, manually probed, or parsed without validation.
license: MIT
compatibility: Scotty with Effect 4.0.0-beta.99; verify Schema APIs against vendor/effect.
---

# Decode Effect boundaries

Parse unknown data once at ingress, then keep the domain typed.

## Workflow

1. Locate the trust boundary: HTTP, env, KV, R2, OAuth, CLI, archive, state, or third-party response.
2. Define or reuse the smallest schema that owns the accepted shape.
3. Compile reusable decoders at module scope.
4. Decode before domain logic and preserve the typed schema failure or map it to a stable domain error.
5. Remove downstream casts and repeated shape probes made unnecessary by decoding.

## Preferred forms

```ts
const Input = Schema.Struct({ endpoint: Schema.String });
const decodeInput = Schema.decodeUnknownEffect(Input);

const program = Effect.flatMap(decodeInput(raw), useInput);
```

For JSON text:

```ts
const decodeInputJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Input));
```

Avoid `JSON.parse`, `as unknown as X`, inline object assertions, `as Record<string, unknown>`, `Reflect.get`, and `"field" in value` for untrusted input. A named guard is acceptable when parsing is not the right abstraction, but it must have a precise type predicate and validate every field required by its result.

At a native Cloudflare or Alchemy boundary, locally construct an allow-listed output rather than retaining an untrusted response object. Never retain request objects, raw causes, or credential-bearing fields in state, errors, logs, telemetry, or Alchemy outputs.

Verify decoder names and signatures against `vendor/effect/packages/effect/src/Schema.ts` and beta.99 tests. Do not use Effect v3 Schema imports.
