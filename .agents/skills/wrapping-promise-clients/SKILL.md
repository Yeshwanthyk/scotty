---
name: wrapping-promise-clients
description: Wraps Promise-based SDKs in Effect services with typed failures, interruption, and explicit retry ownership. Use when domain-facing APIs expose Promise rejection or raw third-party clients.
license: MIT
compatibility: Scotty with Effect 4.0.0-beta.99; verify APIs against vendor/effect.
---

# Wrap Promise clients

Keep third-party Promise APIs inside one adapter and expose Effect-shaped operations to domain code.

## Workflow

1. Find the SDK call, its owning adapter, existing service key, Layer, and tagged error.
2. Decide which layer owns retry, timeout, cancellation, and error sanitization.
3. Wrap each Promise once with `Effect.tryPromise`; pass its `AbortSignal` when supported.
4. Map rejection to a stable typed error without stringifying or retaining credential-bearing request/response objects.
5. Expose named Effect methods and provide test implementations through the same service contract.

```ts
export class ClientRequestError extends Schema.TaggedErrorClass<ClientRequestError>()(
  "ClientRequestError",
  { operation: Schema.String, cause: Schema.Unknown },
) {}

export interface SearchClientShape {
  readonly search: (
    query: string,
  ) => Effect.Effect<ReadonlyArray<SearchResult>, ClientRequestError>;
}

export class SearchClient extends Context.Service<SearchClient, SearchClientShape>()(
  "scotty/SearchClient",
) {}

const makeSearchClient = (sdk: VendorSdk): SearchClientShape => ({
  search: (query) =>
    Effect.tryPromise({
      try: (signal) => sdk.search({ query, signal }),
      catch: (cause) => new ClientRequestError({ operation: "search", cause }),
    }),
});
```

Do not expose the raw SDK, use Promise `.catch` for domain recovery, or silently replace failure with an empty result. Disable blind SDK retries for ambiguous mutations when Scotty must re-observe state before retrying.

Verify `Context.Service`, `Effect.tryPromise`, and Layer usage against pinned beta.99 source and tests.
