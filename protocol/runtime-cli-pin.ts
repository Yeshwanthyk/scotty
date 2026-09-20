import { Schema } from "effect";
import { RuntimeCliArtifactDescriptorSchema } from "./runtime-cli-manifest";

// Non-secret admission snapshot. No host storage or network adapter dependencies.
export const RuntimeCliPinSchema = Schema.Struct({
  descriptor: RuntimeCliArtifactDescriptorSchema,
  verifiedAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  freshness: Schema.Literals(["github_verified", "cached_during_lookup_outage"]),
});
export type RuntimeCliPin = typeof RuntimeCliPinSchema.Type;
export const decodeRuntimeCliPin = Schema.decodeUnknownEffect(RuntimeCliPinSchema, {
  onExcessProperty: "error",
});
