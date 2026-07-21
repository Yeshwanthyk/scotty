---
name: routing-effect-http
description: Routes HTTP through Effect v4 HttpClient and HttpRouter while preserving native Cloudflare Request, Response, WebSocket, stream, and Durable Object boundaries. Use for networked domain code, APIs, and Worker adapters.
license: MIT
compatibility: Scotty with Effect 4.0.0-beta.99 effect/unstable/http and Alchemy beta.63.
---

# Route Effect HTTP

Use Effect HTTP services inside migrated domain code and keep Cloudflare host conversion at explicit adapters.

## Outbound requests

- Prefer `HttpClient` and `HttpClientRequest` from `effect/unstable/http` for ordinary domain HTTP.
- Obtain `HttpClient.HttpClient` from the Effect context so tests can provide a replacement Layer.
- Decode response bodies with Schema before domain use.
- Keep raw `fetch` only in host entrypoints, bindings, third-party APIs that require a fetch function, or deliberately unmigrated callback islands.
- Never patch `globalThis.fetch` in tests.

```ts
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const program = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(HttpClientRequest.get(url));
});
```

## Inbound routing

- Use pinned `HttpRouter` or Alchemy's approved Effect bridge for migrated route composition.
- Decode path, query, header, cookie, and body input at ingress.
- Translate typed failures to stable public responses in one adapter.
- Preserve native `Request`, `Response`, WebSocket upgrades, streams, Durable Object methods, and Sandbox PTY callbacks where the host signature requires them.
- Convert Effects to Promises only at those host adapters, preserving cancellation when available.

Do not introduce a parallel router/runtime beside Alchemy's chosen model. Do not make raw Cloudflare callbacks artificially Effect-shaped when no domain behavior is gained.

The HTTP modules are unstable in beta.99. Before changing imports or combinators, inspect `vendor/effect/packages/effect/src/unstable/http/`, its tests, and Scotty's pinned Alchemy bridge. Do not rely on Effect v3 or beta.97 examples.
