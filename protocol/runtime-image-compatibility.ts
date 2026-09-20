import { Effect, Schema } from "effect";
import { RuntimeCliCompatibilitySchema } from "./runtime-cli-manifest";

export const RuntimeImageCompatibilityPayloadSchema = Schema.Struct({
  imageDigest: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u)),
  compatibility: RuntimeCliCompatibilitySchema,
});
export const RuntimeImageCompatibilityEvidenceSchema = Schema.Struct({
  ...RuntimeImageCompatibilityPayloadSchema.fields,
  signature: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{86}==$/u)),
});
export type RuntimeImageCompatibilityEvidence = typeof RuntimeImageCompatibilityEvidenceSchema.Type;
export const runtimeImageCompatibilityBytes = (
  value: typeof RuntimeImageCompatibilityPayloadSchema.Type,
) =>
  new TextEncoder().encode(
    JSON.stringify([
      "scotty-standard-image-runtime-compatibility-v1",
      value.imageDigest,
      value.compatibility.bunVersion,
      value.compatibility.compileTarget,
      value.compatibility.cpu,
      value.compatibility.libc,
      value.compatibility.cloudflareSandbox.packageVersion,
      value.compatibility.cloudflareSandbox.image,
    ]),
  );
export class RuntimeImageCompatibilityError extends Schema.TaggedError<RuntimeImageCompatibilityError>()(
  "RuntimeImageCompatibilityError",
  { reason: Schema.Literals(["unsupported_image", "invalid_evidence"]) },
) {}
const decodeEvidence = Schema.decodeUnknownEffect(RuntimeImageCompatibilityEvidenceSchema, {
  onExcessProperty: "error",
});
const bytes = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
export const verifyRuntimeImageCompatibility = Effect.fnUntraced(function* (
  input: unknown,
  imageDigest: string,
) {
  if (input === undefined || input === null)
    return yield* new RuntimeImageCompatibilityError({ reason: "unsupported_image" });
  const evidence = yield* decodeEvidence(input).pipe(
    Effect.mapError(() => new RuntimeImageCompatibilityError({ reason: "invalid_evidence" })),
  );
  if (evidence.imageDigest !== imageDigest)
    return yield* new RuntimeImageCompatibilityError({ reason: "unsupported_image" });
  const valid = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        bytes("b+jhy/AX9PzwFWofyVVPDg/FR8YLVJ9FGIAAJVVPpPE="),
        "Ed25519",
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        "Ed25519",
        key,
        bytes(evidence.signature),
        runtimeImageCompatibilityBytes(evidence),
      );
    },
    catch: () => new RuntimeImageCompatibilityError({ reason: "invalid_evidence" }),
  });
  if (!valid) return yield* new RuntimeImageCompatibilityError({ reason: "invalid_evidence" });
  return evidence;
});
