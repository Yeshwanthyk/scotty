import { Data, Effect, Encoding, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

const issuer = "https://auth.openai.com";
const clientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const Device = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.String,
});
const Authorization = Schema.Struct({
  authorization_code: Schema.String,
  code_verifier: Schema.String,
  code_challenge: Schema.String,
});
const Tokens = Schema.Struct({
  id_token: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
});
const Claims = Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) });
const Jwt = Schema.Struct({
  "https://api.openai.com/auth": Schema.optional(Claims),
  exp: Schema.optional(Schema.Number),
  chatgpt_account_id: Schema.optional(Schema.String),
});
const UpstreamError = Schema.Struct({
  code: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ code: Schema.optional(Schema.String) })]),
  ),
});

export class OAuthFailure extends Data.TaggedError("OAuthFailure")<{
  readonly stage: "start" | "poll" | "exchange" | "claims";
  readonly status?: number;
  readonly code?: string;
}> {}

const failure = (stage: OAuthFailure["stage"], status?: number, code?: string) =>
  new OAuthFailure({
    stage,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  });

const errorCode = (value: unknown): string | undefined => {
  const parsed = Schema.decodeUnknownResult(UpstreamError)(value);
  if (Result.isFailure(parsed)) return undefined;
  const { error, code } = parsed.success;
  return code ?? (typeof error === "string" ? error : error?.code);
};

const execute = (request: HttpClientRequest.HttpClientRequest, stage: OAuthFailure["stage"]) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request).pipe(Effect.mapError(() => failure(stage)));
  });

const responseJson = (
  response: { readonly json: Effect.Effect<Schema.Json, unknown> },
  stage: OAuthFailure["stage"],
) => response.json.pipe(Effect.mapError(() => failure(stage)));

const checkStatus = (
  response: { readonly status: number; readonly json: Effect.Effect<Schema.Json, unknown> },
  stage: OAuthFailure["stage"],
) =>
  Effect.gen(function* () {
    if (response.status === 200) return;
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    return yield* failure(stage, response.status, errorCode(body));
  });

const decode = <S extends Schema.Top>(schema: S, value: unknown, stage: OAuthFailure["stage"]) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => failure(stage)));

export const startDevice = Effect.gen(function* () {
  const response = yield* execute(
    HttpClientRequest.post(`${issuer}/api/accounts/deviceauth/usercode`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ client_id: clientId }),
    ),
    "start",
  );
  yield* checkStatus(response, "start");
  const body = yield* decode(Device, yield* responseJson(response, "start"), "start");
  const interval = Number(body.interval);
  if (!Number.isFinite(interval) || interval < 1) return yield* failure("start");
  return {
    deviceAuthId: body.device_auth_id,
    userCode: body.user_code,
    interval,
    verificationUrl: `${issuer}/codex/device`,
    expiresAt: Date.now() + 900_000,
  };
}).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));

export const pollDevice = (deviceAuthId: string, userCode: string) =>
  Effect.gen(function* () {
    const response = yield* execute(
      HttpClientRequest.post(`${issuer}/api/accounts/deviceauth/token`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ device_auth_id: deviceAuthId, user_code: userCode }),
      ),
      "poll",
    );
    if (response.status !== 200) {
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      const code = errorCode(body);
      if (response.status === 403 && code === "deviceauth_authorization_pending")
        return { kind: "pending" as const };
      return yield* failure("poll", response.status, code);
    }
    const authorization = yield* decode(
      Authorization,
      yield* responseJson(response, "poll"),
      "poll",
    );
    return { kind: "authorized" as const, authorization };
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));

export const exchangeCode = (authorization: typeof Authorization.Type) =>
  Effect.gen(function* () {
    const response = yield* execute(
      HttpClientRequest.post(`${issuer}/oauth/token`).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: authorization.authorization_code,
          redirect_uri: `${issuer}/deviceauth/callback`,
          code_verifier: authorization.code_verifier,
        }),
      ),
      "exchange",
    );
    yield* checkStatus(response, "exchange");
    const tokens = yield* decode(Tokens, yield* responseJson(response, "exchange"), "exchange");
    const segment = tokens.id_token.split(".")[1];
    if (segment === undefined) return yield* failure("claims");
    const decoded = Encoding.decodeBase64UrlString(segment);
    if (Result.isFailure(decoded)) return yield* failure("claims");
    const json: unknown = yield* Effect.try({
      try: () => JSON.parse(decoded.success),
      catch: () => failure("claims"),
    });
    const jwt = yield* decode(Jwt, json, "claims");
    const accountId =
      jwt["https://api.openai.com/auth"]?.chatgpt_account_id ?? jwt.chatgpt_account_id;
    const accessSegment = tokens.access_token.split(".")[1];
    if (!accountId || accessSegment === undefined) return yield* failure("claims");
    const accessDecoded = Encoding.decodeBase64UrlString(accessSegment);
    if (Result.isFailure(accessDecoded)) return yield* failure("claims");
    const accessJson: unknown = yield* Effect.try({
      try: () => JSON.parse(accessDecoded.success),
      catch: () => failure("claims"),
    });
    const accessClaims = yield* decode(Schema.Struct({ exp: Schema.Number }), accessJson, "claims");
    return { ...tokens, accountId, expiresAt: accessClaims.exp * 1000 };
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));
