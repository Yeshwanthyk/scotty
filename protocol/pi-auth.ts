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
    idToken: Schema.optionalKey(Schema.NonEmptyString),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);

export const PiCredentialSchema = Schema.Union([PiApiKeyCredentialSchema, PiOAuthCredentialSchema]);
export type PiCredential = typeof PiCredentialSchema.Type;
export type PiApiKeyCredential = typeof PiApiKeyCredentialSchema.Type;
export type PiOAuthCredential = typeof PiOAuthCredentialSchema.Type;

export const PiAuthStoreSchema = Schema.Record(Schema.NonEmptyString, PiCredentialSchema);
export type PiAuthStore = typeof PiAuthStoreSchema.Type;

export const PiAuthDigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
export const PiAuthRecordSourceSchema = Schema.Literals(["sync", "rotation"]);
export const PiAuthUpdatedAtSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  Schema.makeFilter(
    (value) => {
      const millis = Date.parse(value);
      return Number.isFinite(millis) && new Date(millis).toISOString() === value;
    },
    { expected: "a canonical UTC timestamp with millisecond precision" },
  ),
);
export const InstallationPiAuthRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  providers: PiAuthStoreSchema,
  digest: PiAuthDigestSchema,
  updatedAt: PiAuthUpdatedAtSchema,
  source: PiAuthRecordSourceSchema,
});
export type InstallationPiAuthRecord = typeof InstallationPiAuthRecordSchema.Type;

const stableJsonStringify = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};

export const canonicalPiAuthProviders = (providers: PiAuthStore): PiAuthStore =>
  Object.fromEntries(
    Object.entries(providers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([providerId, credential]) => {
        if (credential.type === "api_key") {
          const { env, key, ...rest } = credential;
          return [
            providerId,
            {
              ...rest,
              type: "api_key" as const,
              ...(key === undefined ? {} : { key }),
              ...(env === undefined
                ? {}
                : {
                    env: Object.fromEntries(
                      Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
                    ),
                  }),
            },
          ];
        }
        const { access, accountId, expires, idToken, refresh, ...rest } = credential;
        return [
          providerId,
          {
            ...rest,
            type: "oauth" as const,
            refresh,
            access,
            expires,
            ...(accountId === undefined ? {} : { accountId }),
            ...(idToken === undefined ? {} : { idToken }),
          },
        ];
      }),
  );

export const serializePiAuthProviders = (providers: PiAuthStore): string =>
  stableJsonStringify(canonicalPiAuthProviders(providers));

export const digestPiAuthProviders = async (providers: PiAuthStore): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serializePiAuthProviders(providers)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const makeInstallationPiAuthRecord = async (
  providers: PiAuthStore,
  updatedAt: string,
  source: InstallationPiAuthRecord["source"],
): Promise<InstallationPiAuthRecord> => {
  const canonical = canonicalPiAuthProviders(providers);
  return {
    version: 1,
    providers: canonical,
    digest: await digestPiAuthProviders(canonical),
    updatedAt,
    source,
  };
};

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
