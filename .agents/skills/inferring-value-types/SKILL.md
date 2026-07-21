---
name: inferring-value-types
description: Infers TypeScript object API types from the runtime factory or value that owns their shape. Use when an interface or type alias duplicates an extension, client surface, route map, handler table, or other returned object.
license: MIT
compatibility: Scotty TypeScript 7 and Effect 4.0.0-beta.99.
---

# Infer value-owned types

Replace duplicated object API declarations with types inferred from the runtime value or factory that owns the shape.

## Workflow

1. Find the runtime object returned by a named factory, extension callback, client constructor, route map, or handler table.
2. Find the nearby interface or type alias that manually repeats its properties and methods.
3. Confirm the runtime value is the source of truth. Keep an authored interface when it is a stable public contract with multiple implementations.
4. Preserve the exported type name while deriving it with `ReturnType<typeof makeValue>`.
5. Remove `satisfies` or return annotations that only force the runtime value through the duplicate shape.
6. Run the affected typecheck and tests so consumers expose any real contract mismatch.

## Preferred shape

```ts
const makeSearchExtension = (context: ExtensionContext<SearchStore>) => ({
  addSource: (config: SourceConfig) => addSource(context, config),
  removeSource: (namespace: string) => removeSource(context, namespace),
});

export type SearchExtension = ReturnType<typeof makeSearchExtension>;
```

For a curried factory:

```ts
const makeSearchExtension =
  (options: SearchOptions) => (context: ExtensionContext<SearchStore>) => ({
    search: (query: string) => search(context, options, query),
  });

export type SearchExtension = ReturnType<ReturnType<typeof makeSearchExtension>>;
```

## Do not replace

- Service or dependency interfaces with multiple implementations.
- Stable public configuration input contracts.
- Branded identifiers, discriminated unions, and data types that do not mirror one object value.
- Test fakes implementing an existing exported contract.
- Schema-owned data shapes; use `deriving-schema-types` for those.

When a lint finding is imprecise because no runtime value clearly owns the shape, keep the authored contract and improve the rule or its scope instead of forcing a `ReturnType` alias.
