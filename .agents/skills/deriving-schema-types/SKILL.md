---
name: deriving-schema-types
description: Derives a TypeScript type from the Effect Schema that owns its runtime shape. Use when an interface or type alias repeats a nearby Schema and can drift from what decoding accepts.
---

# Derive schema-owned types

The Schema is the **single source of truth** for a data shape; its type is `typeof X.Type`.

## Steps

1. Pair the hand-written type with the Schema it mirrors, field by field: optionality, literals, nullability.
2. Replace the type's body with the derived form, keeping its exported name so consumers don't change.
3. Run `npm run typecheck`. A new error is a real mismatch the duplicate was hiding: fix the Schema or the consumer, whichever is wrong.

Done when the shape is written once and typecheck passes.

```ts
export const SessionEvent = Schema.Union([Created, ContainerStart /* … */]);
export type SessionEvent = typeof SessionEvent.Type;
```

- For a transformation, derive from the decoded side (`.Type`), and use `.Encoded` only where the wire form is what's handled.
- `Schema.suspend` may need one private helper type for recursion; the exported type stays derived.
- Leave authored types that intentionally differ from any Schema: service interfaces, branded IDs, public input contracts.
