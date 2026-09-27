import { Schema } from "effect";

export const CloudResourceKindSchema = Schema.Literals(["skill", "package", "tool", "extension"]);
export const CloudResourceNameSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z0-9@][a-zA-Z0-9@._-]*(?:\/[a-zA-Z0-9._-]+)?$/u),
);
export const CloudResourceFileSchema = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240)),
  contentBase64: Schema.String.check(Schema.isMaxLength(12_000_000)),
  modeClass: Schema.Literals(["regular", "executable"]),
});
export const CloudResourcePutSchema = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  shape: Schema.Literals(["file", "directory"]),
  files: Schema.Array(CloudResourceFileSchema),
});
export const CloudResourceDeleteSchema = Schema.Struct({
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  idempotencyKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type CloudResourceKind = typeof CloudResourceKindSchema.Type;
export type CloudResourceFile = typeof CloudResourceFileSchema.Type;
export type CloudResourcePut = typeof CloudResourcePutSchema.Type;
export const decodeCloudResourcePut = Schema.decodeUnknownResult(CloudResourcePutSchema, {
  onExcessProperty: "error",
});
export const decodeCloudResourceDelete = Schema.decodeUnknownResult(CloudResourceDeleteSchema, {
  onExcessProperty: "error",
});
