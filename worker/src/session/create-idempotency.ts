import { Option, Schema } from "effect";
import type { SessionRecord } from "./contracts";

export const CreateIdempotencyMetadataSchema = Schema.Struct({
  keyDigest: Schema.String,
  inputDigest: Schema.String,
});
export type CreateIdempotencyMetadata = typeof CreateIdempotencyMetadataSchema.Type;

export const decodeCreateIdempotencyMetadata = Schema.decodeUnknownOption(
  CreateIdempotencyMetadataSchema,
);

export type CreateIdempotencyDecision =
  | { readonly kind: "create" }
  | { readonly kind: "replay"; readonly record: SessionRecord }
  | { readonly kind: "conflict" };

export const decideIdempotentCreate = (
  existing: SessionRecord | undefined,
  stored: Option.Option<CreateIdempotencyMetadata>,
  incoming: CreateIdempotencyMetadata | undefined,
): CreateIdempotencyDecision => {
  if (existing === undefined) return { kind: "create" };
  if (incoming === undefined)
    return existing.status === "gone" ? { kind: "create" } : { kind: "conflict" };
  if (existing.status === "gone" || Option.isNone(stored)) return { kind: "conflict" };
  return stored.value.keyDigest === incoming.keyDigest &&
    stored.value.inputDigest === incoming.inputDigest
    ? { kind: "replay", record: existing }
    : { kind: "conflict" };
};
