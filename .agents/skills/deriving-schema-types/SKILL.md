---
name: deriving-schema-types
description: Derives TypeScript data types from the Effect Schema that owns their runtime shape. Use when an interface or object type duplicates a nearby Schema definition and can drift from decoding.
license: MIT
compatibility: Scotty with Effect 4.0.0-beta.99.
---

# Derive schema-owned types

Define a runtime data shape once and infer its TypeScript type from that schema.

## Workflow

1. Find the runtime `Schema.Struct`, union, tagged struct, record, array, or transformation.
2. Compare the nearby manual interface or object type, including optionality, literals, and nullability.
3. Confirm the schema is the intended source of truth and identify export consumers.
4. Keep the exported type name stable while replacing its definition.
5. Run typecheck to expose any real mismatch the duplicate type previously hid.

```ts
export const StoredSessionSchema = Schema.Struct({
  id: Schema.String,
  status: SessionStatusSchema,
});

export type StoredSession = typeof StoredSessionSchema.Type;
```

For a transformation, derive the domain type from the decoded/domain schema, not the raw transport schema. Recursive schemas may use one private helper type where TypeScript needs an annotation for `Schema.suspend`; exported consumer-facing types should remain schema-derived.

Do not apply this pattern to authored public input contracts, branded IDs, service interfaces with multiple implementations, or types that intentionally differ from their transport schema.
