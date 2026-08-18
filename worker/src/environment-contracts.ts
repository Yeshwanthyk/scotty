import { Schema } from "effect";

export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
export const ENVIRONMENT_MAX_VALUE_BYTES = 65_536;

export const EnvironmentNameSchema = Schema.String.check(
  Schema.isPattern(ENVIRONMENT_NAME_PATTERN),
);
export const EnvironmentValueSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => new TextEncoder().encode(value).byteLength <= ENVIRONMENT_MAX_VALUE_BYTES,
    { expected: `an environment value at most ${ENVIRONMENT_MAX_VALUE_BYTES} UTF-8 bytes` },
  ),
);
export const EnvironmentVariableSchema = Schema.Struct({
  value: EnvironmentValueSchema,
  secret: Schema.Boolean,
  updatedAt: Schema.NonEmptyString,
});
export type EnvironmentVariable = typeof EnvironmentVariableSchema.Type;

export const EnvironmentAuthoritySchema = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  variables: Schema.Record(EnvironmentNameSchema, EnvironmentVariableSchema),
});
export type EnvironmentAuthority = typeof EnvironmentAuthoritySchema.Type;

export const EnvironmentSnapshotSchema = Schema.Struct({
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  variables: Schema.Record(EnvironmentNameSchema, EnvironmentValueSchema),
});
export type EnvironmentSnapshot = typeof EnvironmentSnapshotSchema.Type;

export const EnvironmentPutInputSchema = Schema.Struct({
  value: EnvironmentValueSchema,
  secret: Schema.Boolean,
});
export type EnvironmentPutInput = typeof EnvironmentPutInputSchema.Type;

export const EnvironmentVariableViewSchema = Schema.Struct({
  name: EnvironmentNameSchema,
  secret: Schema.Boolean,
  configured: Schema.Literal(true),
  updatedAt: Schema.NonEmptyString,
  value: Schema.optionalKey(EnvironmentValueSchema),
});
export type EnvironmentVariableView = typeof EnvironmentVariableViewSchema.Type;

export const ProtectedEnvironmentBindingSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  secret: Schema.Literal(true),
  source: Schema.NonEmptyString,
  destination: Schema.Literals(["process_environment", "file"]),
  path: Schema.optionalKey(Schema.NonEmptyString),
  managedBy: Schema.Literal("scotty"),
});
export type ProtectedEnvironmentBinding = typeof ProtectedEnvironmentBindingSchema.Type;

export const EnvironmentVariablesViewSchema = Schema.Struct({
  revision: Schema.Number,
  variables: Schema.Array(EnvironmentVariableViewSchema),
});
export type EnvironmentVariablesView = typeof EnvironmentVariablesViewSchema.Type;

export const EnvironmentViewSchema = Schema.Struct({
  ...EnvironmentVariablesViewSchema.fields,
  protectedBindings: Schema.Array(ProtectedEnvironmentBindingSchema),
});
export type EnvironmentView = typeof EnvironmentViewSchema.Type;

export const EnvironmentMutationResponseSchema = Schema.Struct({
  name: EnvironmentNameSchema,
  removed: Schema.optionalKey(Schema.Boolean),
  secret: Schema.optionalKey(Schema.Boolean),
  configured: Schema.optionalKey(Schema.Literal(true)),
  revision: Schema.Number,
});
export type EnvironmentMutationResponse = typeof EnvironmentMutationResponseSchema.Type;
