import { Credentials } from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  type DestinationAccountKey,
  type DestinationSecretKey,
  type SecretMetadata,
  WriteOnlySecretDestination,
  WriteOnlySecretDestinationError,
} from "./write-only-secret.ts";

const SecretStatusSchema = Schema.Literals(["pending", "active", "deleted"]);

const SecretWireSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: SecretStatusSchema,
  store_id: Schema.String,
  comment: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  scopes: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.Null])),
});

const ResultInfoSchema = Schema.Struct({
  page: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  total_pages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

const SecretEnvelopeSchema = Schema.Struct({
  success: Schema.Literal(true),
  result: SecretWireSchema,
});

const SecretListEnvelopeSchema = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(SecretWireSchema),
  result_info: ResultInfoSchema,
});

const SecretCreateEnvelopeSchema = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(SecretWireSchema),
});

const DeleteEnvelopeSchema = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.optional(Schema.Unknown),
});

const decodeSecretEnvelope = HttpClientResponse.schemaBodyJson(SecretEnvelopeSchema);
const decodeSecretListEnvelope = HttpClientResponse.schemaBodyJson(SecretListEnvelopeSchema);
const decodeSecretCreateEnvelope = HttpClientResponse.schemaBodyJson(SecretCreateEnvelopeSchema);
const decodeDeleteEnvelope = HttpClientResponse.schemaBodyJson(DeleteEnvelopeSchema);

const secretUrl = (apiBaseUrl: string, key: DestinationAccountKey): string =>
  `${apiBaseUrl}/accounts/${encodeURIComponent(key.accountId)}/secrets_store/stores/${encodeURIComponent(key.storeId)}/secrets`;

const exactSecretUrl = (apiBaseUrl: string, key: DestinationSecretKey): string =>
  `${secretUrl(apiBaseUrl, key)}/${encodeURIComponent(key.secretId)}`;

const sanitizeFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  operation: WriteOnlySecretDestinationError["operation"],
  key: DestinationAccountKey,
  secretId?: string,
): Effect.Effect<A, WriteOnlySecretDestinationError, R> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.fail(
            new WriteOnlySecretDestinationError({
              operation,
              code: "destination-failure",
              accountId: key.accountId,
              storeId: key.storeId,
              secretId,
            }),
          ),
    ),
  );

const metadataFromWire = (
  accountId: string,
  secret: Schema.Schema.Type<typeof SecretWireSchema>,
): SecretMetadata => ({
  secretId: secret.id,
  secretName: secret.name,
  storeId: secret.store_id,
  accountId,
  status: secret.status,
  scopes: secret.scopes ?? [],
  comment: secret.comment ?? undefined,
});

const decodeMetadata = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  operation: WriteOnlySecretDestinationError["operation"],
  key: DestinationAccountKey,
  secretId?: string,
) {
  const envelope = yield* sanitizeFailure(decodeSecretEnvelope(response), operation, key, secretId);
  return metadataFromWire(key.accountId, envelope.result);
});

/**
 * Concrete Account Secrets Store HTTP adapter. It resolves Alchemy's
 * Cloudflare credentials for each request, decodes all response JSON with
 * Effect Schema, and exposes only sanitized destination errors.
 */
export const cloudflareWriteOnlySecretDestinationLayer = Layer.effect(
  WriteOnlySecretDestination,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const client = yield* HttpClient.HttpClient;

    const authenticatedRequest = (
      request: HttpClientRequest.HttpClientRequest,
      current: Effect.Success<typeof credentials>,
    ): Effect.Effect<HttpClientRequest.HttpClientRequest> =>
      Effect.succeed(
        Match.value(current).pipe(
          Match.when({ type: "apiToken" }, (value) =>
            HttpClientRequest.bearerToken(request, value.apiToken),
          ),
          Match.when({ type: "oauth" }, (value) =>
            HttpClientRequest.bearerToken(request, value.accessToken),
          ),
          Match.when({ type: "apiKey" }, (value) =>
            request.pipe(
              HttpClientRequest.setHeader("x-auth-key", Redacted.value(value.apiKey)),
              HttpClientRequest.setHeader("x-auth-email", value.email),
            ),
          ),
          Match.exhaustive,
        ),
      );

    const execute = Effect.fnUntraced(function* (
      request: (apiBaseUrl: string) => Effect.Effect<HttpClientRequest.HttpClientRequest, unknown>,
      operation: WriteOnlySecretDestinationError["operation"],
      key: DestinationAccountKey,
      secretId?: string,
    ) {
      return yield* sanitizeFailure(
        Effect.gen(function* () {
          const current = yield* credentials;
          const apiBaseUrl = current.apiBaseUrl.replace(/\/$/u, "");
          const built = yield* request(apiBaseUrl);
          const authenticated = yield* authenticatedRequest(built, current);
          return yield* client
            .execute(authenticated)
            .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true));
        }),
        operation,
        key,
        secretId,
      );
    });

    const read = Effect.fnUntraced(function* (key: DestinationSecretKey) {
      const response = yield* execute(
        (apiBaseUrl) =>
          Effect.succeed(
            HttpClientRequest.get(exactSecretUrl(apiBaseUrl, key)).pipe(
              HttpClientRequest.acceptJson,
            ),
          ),
        "read",
        key,
        key.secretId,
      );
      if (response.status === 404) return undefined;
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          new WriteOnlySecretDestinationError({
            operation: "read",
            code: "destination-failure",
            accountId: key.accountId,
            storeId: key.storeId,
            secretId: key.secretId,
          }),
        );
      }
      return yield* decodeMetadata(response, "read", key, key.secretId);
    });

    const find = Effect.fnUntraced(function* (
      key: DestinationAccountKey & { readonly secretName: string },
    ) {
      let page = 1;
      let complete = false;
      let declaredTotalPages: number | undefined;
      let found: SecretMetadata | undefined;
      yield* Effect.whileLoop({
        while: () => found === undefined && !complete,
        body: () =>
          Effect.gen(function* () {
            const requestedPage = page;
            const response = yield* execute(
              (apiBaseUrl) =>
                Effect.succeed(
                  HttpClientRequest.get(secretUrl(apiBaseUrl, key)).pipe(
                    HttpClientRequest.acceptJson,
                    HttpClientRequest.setUrlParams({
                      search: key.secretName,
                      page: String(requestedPage),
                      per_page: "100",
                    }),
                  ),
                ),
              "find",
              key,
            );
            if (response.status < 200 || response.status >= 300) {
              return yield* Effect.fail(
                new WriteOnlySecretDestinationError({
                  operation: "find",
                  code: "destination-failure",
                  accountId: key.accountId,
                  storeId: key.storeId,
                  secretId: undefined,
                }),
              );
            }
            const envelope = yield* sanitizeFailure(
              decodeSecretListEnvelope(response),
              "find",
              key,
            );
            const infoPage = envelope.result_info.page;
            const totalPages = envelope.result_info.total_pages;
            if (
              infoPage !== requestedPage ||
              totalPages < requestedPage ||
              totalPages > 100 ||
              (declaredTotalPages !== undefined && totalPages !== declaredTotalPages) ||
              (envelope.result.length === 0 && requestedPage < totalPages)
            ) {
              return yield* Effect.fail(
                new WriteOnlySecretDestinationError({
                  operation: "find",
                  code: "destination-failure",
                  accountId: key.accountId,
                  storeId: key.storeId,
                  secretId: undefined,
                }),
              );
            }
            const exact = envelope.result.find((secret) => secret.name === key.secretName);
            declaredTotalPages = totalPages;
            complete = requestedPage === totalPages;
            page = requestedPage + 1;
            return exact === undefined ? undefined : metadataFromWire(key.accountId, exact);
          }),
        step: (metadata) => {
          found = metadata;
        },
      });
      return found;
    });

    const create = Effect.fnUntraced(function* (
      key: DestinationAccountKey,
      body: {
        readonly name: string;
        readonly value: string;
        readonly scopes: readonly string[];
        readonly comment: string;
      },
    ) {
      const response = yield* execute(
        (apiBaseUrl) =>
          HttpClientRequest.post(secretUrl(apiBaseUrl, key)).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJson([
              { name: body.name, value: body.value, scopes: body.scopes, comment: body.comment },
            ]),
          ),
        "create",
        key,
      );
      if (response.status === 409) {
        return yield* Effect.fail(
          new WriteOnlySecretDestinationError({
            operation: "create",
            code: "conflict",
            accountId: key.accountId,
            storeId: key.storeId,
            secretId: undefined,
          }),
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          new WriteOnlySecretDestinationError({
            operation: "create",
            code: "destination-failure",
            accountId: key.accountId,
            storeId: key.storeId,
            secretId: undefined,
          }),
        );
      }
      const envelope = yield* sanitizeFailure(decodeSecretCreateEnvelope(response), "create", key);
      const created = envelope.result.length === 1 ? envelope.result[0] : undefined;
      if (created === undefined) {
        return yield* Effect.fail(
          new WriteOnlySecretDestinationError({
            operation: "create",
            code: "destination-failure",
            accountId: key.accountId,
            storeId: key.storeId,
            secretId: undefined,
          }),
        );
      }
      return metadataFromWire(key.accountId, created);
    });

    const patch = Effect.fnUntraced(function* (
      key: DestinationSecretKey,
      body: {
        readonly value: string;
        readonly scopes: readonly string[];
        readonly comment: string;
      },
    ) {
      const response = yield* execute(
        (apiBaseUrl) =>
          HttpClientRequest.patch(exactSecretUrl(apiBaseUrl, key)).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJson({
              value: body.value,
              scopes: body.scopes,
              comment: body.comment,
            }),
          ),
        "patch",
        key,
        key.secretId,
      );
      if (response.status === 404) {
        return yield* Effect.fail(
          new WriteOnlySecretDestinationError({
            operation: "patch",
            code: "not-found",
            accountId: key.accountId,
            storeId: key.storeId,
            secretId: key.secretId,
          }),
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          new WriteOnlySecretDestinationError({
            operation: "patch",
            code: "destination-failure",
            accountId: key.accountId,
            storeId: key.storeId,
            secretId: key.secretId,
          }),
        );
      }
      return yield* decodeMetadata(response, "patch", key, key.secretId);
    });

    const deleteSecret = Effect.fnUntraced(function* (key: DestinationSecretKey) {
      const response = yield* execute(
        (apiBaseUrl) =>
          Effect.succeed(
            HttpClientRequest.delete(exactSecretUrl(apiBaseUrl, key)).pipe(
              HttpClientRequest.acceptJson,
            ),
          ),
        "delete",
        key,
        key.secretId,
      );
      if (response.status === 404) {
        return yield* Effect.fail(
          new WriteOnlySecretDestinationError({
            operation: "delete",
            code: "not-found",
            accountId: key.accountId,
            storeId: key.storeId,
            secretId: key.secretId,
          }),
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          new WriteOnlySecretDestinationError({
            operation: "delete",
            code: "destination-failure",
            accountId: key.accountId,
            storeId: key.storeId,
            secretId: key.secretId,
          }),
        );
      }
      yield* sanitizeFailure(decodeDeleteEnvelope(response), "delete", key, key.secretId);
    });

    return WriteOnlySecretDestination.of({
      read,
      find,
      create,
      patch,
      delete: deleteSecret,
    });
  }),
);
