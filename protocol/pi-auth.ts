import { Option, Schema } from "effect";

export const PI_AUTH_ADAPTER_PROVIDER_IDS = ["openai", "openai-codex"] as const;

export const PiProviderEnvSchema = Schema.Record(Schema.String, Schema.String);

export const PiApiKeyCredentialSchema = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.optionalKey(Schema.NonEmptyString),
  env: Schema.optionalKey(PiProviderEnvSchema),
});

export const PiOAuthCredentialSchema = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.Literal("oauth"),
    refresh: Schema.NonEmptyString,
    access: Schema.NonEmptyString,
    expires: Schema.Finite,
    accountId: Schema.optionalKey(Schema.NonEmptyString),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const PiCredentialSchema = Schema.Union([PiApiKeyCredentialSchema, PiOAuthCredentialSchema]);
export type PiCredential = typeof PiCredentialSchema.Type;
export type PiApiKeyCredential = typeof PiApiKeyCredentialSchema.Type;
export type PiOAuthCredential = typeof PiOAuthCredentialSchema.Type;

export const PiAuthStoreSchema = Schema.Record(Schema.NonEmptyString, PiCredentialSchema);
export type PiAuthStore = typeof PiAuthStoreSchema.Type;

const decodePiAuthStoreJsonOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(PiAuthStoreSchema),
  { onExcessProperty: "preserve" },
);

export const decodePiAuthStoreResult = Schema.decodeUnknownResult(PiAuthStoreSchema, {
  onExcessProperty: "preserve",
});

export const parsePiAuthJsonOption = (value: string): Option.Option<PiAuthStore> =>
  decodePiAuthStoreJsonOption(value);

export const supportedPiProvider = (
  providerId: string,
): providerId is (typeof PI_AUTH_ADAPTER_PROVIDER_IDS)[number] =>
  PI_AUTH_ADAPTER_PROVIDER_IDS.some((supported) => supported === providerId);

export const piProviderMetadata = (store: PiAuthStore) =>
  Object.entries(store)
    .map(([id, credential]) => ({
      id,
      type: credential.type,
      adapter: supportedPiProvider(id) ? ("supported" as const) : ("unsupported" as const),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
