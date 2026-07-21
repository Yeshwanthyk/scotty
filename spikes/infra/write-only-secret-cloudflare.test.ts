import { assert, describe, it } from "@effect/vitest";
import { Credentials } from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  WriteOnlySecretDestination,
  WriteOnlySecretDestinationError,
} from "./write-only-secret.ts";
import { cloudflareWriteOnlySecretDestinationLayer } from "./write-only-secret-cloudflare.ts";

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly apiKey: string | undefined;
  readonly email: string | undefined;
  readonly tracingDisabled: boolean;
  readonly body: unknown;
}

const isDestinationError = (value: unknown): value is WriteOnlySecretDestinationError =>
  Predicate.isTagged(value, "WriteOnlySecretDestinationError");

const secret = (overrides: Record<string, unknown> = {}) => ({
  id: "secret-1",
  name: "SYNTHETIC_TOKEN",
  status: "active",
  store_id: "store-1",
  scopes: ["workers"],
  comment: "marker",
  ...overrides,
});

const envelope = (result: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ success: true, result, ...extra });

const makeLayer = (
  responses: ReadonlyArray<{ readonly status: number; readonly body: string }>,
  captured: CapturedRequest[],
  authentication: "api-token" | "api-key" = "api-token",
) => {
  let index = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
      const text = yield* Effect.tryPromise(() => web.text()).pipe(Effect.orDie);
      const tracerDisabledWhen = yield* HttpClient.TracerDisabledWhen;
      captured.push({
        method: web.method,
        url: web.url,
        authorization: web.headers.get("authorization") ?? undefined,
        apiKey: web.headers.get("x-auth-key") ?? undefined,
        email: web.headers.get("x-auth-email") ?? undefined,
        tracingDisabled: tracerDisabledWhen(request),
        body: text.length === 0 ? undefined : JSON.parse(text),
      });
      const response = responses[index] ?? responses[responses.length - 1];
      index += 1;
      return HttpClientResponse.fromWeb(
        request,
        new Response(response?.body ?? "", {
          status: response?.status ?? 500,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  const credentials =
    authentication === "api-token"
      ? {
          type: "apiToken" as const,
          apiToken: Redacted.make("synthetic-api-token"),
          apiBaseUrl: "https://api.example.test/client/v4",
        }
      : {
          type: "apiKey" as const,
          apiKey: Redacted.make("synthetic-api-key"),
          email: "operator@example.test",
          apiBaseUrl: "https://api.example.test/client/v4",
        };
  return cloudflareWriteOnlySecretDestinationLayer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(Layer.succeed(Credentials, Effect.succeed(credentials))),
  );
};

describe("Cloudflare Account Secrets Store destination", () => {
  it.effect("reads exact-ID metadata with bearer authentication", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const metadata = yield* destination.read({
        accountId: "account/one",
        storeId: "store-1",
        secretId: "secret-1",
      });
      assert.deepEqual(metadata, {
        secretId: "secret-1",
        secretName: "SYNTHETIC_TOKEN",
        storeId: "store-1",
        accountId: "account/one",
        status: "active",
        scopes: ["workers"],
        comment: "marker",
      });
      assert.deepEqual(captured, [
        {
          method: "GET",
          url: "https://api.example.test/client/v4/accounts/account%2Fone/secrets_store/stores/store-1/secrets/secret-1",
          authorization: "Bearer synthetic-api-token",
          apiKey: undefined,
          email: undefined,
          tracingDisabled: true,
          body: undefined,
        },
      ]);
    }).pipe(Effect.provide(makeLayer([{ status: 200, body: envelope(secret()) }], captured)));
  });

  it.effect("supports API-key headers only with HTTP tracing disabled", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      yield* destination.read({
        accountId: "account-1",
        storeId: "store-1",
        secretId: "secret-1",
      });
      assert.strictEqual(captured[0]?.authorization, undefined);
      assert.strictEqual(captured[0]?.apiKey, "synthetic-api-key");
      assert.strictEqual(captured[0]?.email, "operator@example.test");
      assert.strictEqual(captured[0]?.tracingDisabled, true);
    }).pipe(
      Effect.provide(makeLayer([{ status: 200, body: envelope(secret()) }], captured, "api-key")),
    );
  });

  it.effect("maps exact-ID 404 to absence", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const metadata = yield* destination.read({
        accountId: "account-1",
        storeId: "store-1",
        secretId: "missing",
      });
      assert.isUndefined(metadata);
    }).pipe(Effect.provide(makeLayer([{ status: 404, body: "{}" }], captured)));
  });

  it.effect("finds only an exact name across paginated search results", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const metadata = yield* destination.find({
        accountId: "account-1",
        storeId: "store-1",
        secretName: "SYNTHETIC_TOKEN",
      });
      assert.strictEqual(metadata?.secretId, "exact");
      assert.strictEqual(captured.length, 2);
      assert.match(captured[0]?.url ?? "", /search=SYNTHETIC_TOKEN/u);
      assert.match(captured[1]?.url ?? "", /page=2/u);
    }).pipe(
      Effect.provide(
        makeLayer(
          [
            {
              status: 200,
              body: envelope([secret({ id: "partial", name: "SYNTHETIC_TOKEN_OLD" })], {
                result_info: { page: 1, total_pages: 2 },
              }),
            },
            {
              status: 200,
              body: envelope([secret({ id: "exact" })], {
                result_info: { page: 2, total_pages: 2 },
              }),
            },
          ],
          captured,
        ),
      ),
    );
  });

  it.effect("reports absence after the declared final page", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const metadata = yield* destination.find({
        accountId: "account-1",
        storeId: "store-1",
        secretName: "SYNTHETIC_TOKEN",
      });
      assert.isUndefined(metadata);
      assert.strictEqual(captured.length, 2);
    }).pipe(
      Effect.provide(
        makeLayer(
          [
            {
              status: 200,
              body: envelope([secret({ name: "OTHER" })], {
                result_info: { page: 1, total_pages: 2 },
              }),
            },
            {
              status: 200,
              body: envelope([], { result_info: { page: 2, total_pages: 2 } }),
            },
          ],
          captured,
        ),
      ),
    );
  });

  it.effect("fails closed when an empty page declares more pages", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const error = yield* Effect.flip(
        destination.find({
          accountId: "account-1",
          storeId: "store-1",
          secretName: "SYNTHETIC_TOKEN",
        }),
      );
      assert.ok(isDestinationError(error));
      assert.strictEqual(error.code, "destination-failure");
    }).pipe(
      Effect.provide(
        makeLayer(
          [
            {
              status: 200,
              body: envelope([], { result_info: { page: 1, total_pages: 2 } }),
            },
          ],
          captured,
        ),
      ),
    );
  });

  it.effect("fails closed on malformed pagination metadata", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const error = yield* Effect.flip(
        destination.find({
          accountId: "account-1",
          storeId: "store-1",
          secretName: "SYNTHETIC_TOKEN",
        }),
      );
      assert.ok(isDestinationError(error));
      assert.strictEqual(error.code, "destination-failure");
    }).pipe(
      Effect.provide(
        makeLayer(
          [
            {
              status: 200,
              body: envelope([secret({ name: "OTHER" })], {
                result_info: { page: 0, total_pages: 1 },
              }),
            },
          ],
          captured,
        ),
      ),
    );
  });

  it.effect("fails instead of reporting absence at the pagination bound", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const error = yield* Effect.flip(
        destination.find({
          accountId: "account-1",
          storeId: "store-1",
          secretName: "SYNTHETIC_TOKEN",
        }),
      );
      assert.ok(isDestinationError(error));
      assert.strictEqual(error.code, "destination-failure");
      assert.strictEqual(captured.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer(
          [
            {
              status: 200,
              body: envelope([secret({ name: "OTHER" })], {
                result_info: { page: 1, total_pages: 101 },
              }),
            },
          ],
          captured,
        ),
      ),
    );
  });

  it.effect("creates with Cloudflare's one-element array body", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const metadata = yield* destination.create(
        { accountId: "account-1", storeId: "store-1" },
        {
          name: "SYNTHETIC_TOKEN",
          value: "synthetic-plaintext",
          scopes: ["workers"],
          comment: "marker",
        },
      );
      assert.strictEqual(metadata.secretId, "secret-1");
      assert.deepEqual(captured[0]?.body, [
        {
          name: "SYNTHETIC_TOKEN",
          value: "synthetic-plaintext",
          scopes: ["workers"],
          comment: "marker",
        },
      ]);
    }).pipe(Effect.provide(makeLayer([{ status: 200, body: envelope([secret()]) }], captured)));
  });

  it.effect("maps create conflict without decoding an error body", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const error = yield* Effect.flip(
        destination.create(
          { accountId: "account-1", storeId: "store-1" },
          { name: "name", value: "value", scopes: ["workers"], comment: "marker" },
        ),
      );
      assert.ok(isDestinationError(error));
      assert.strictEqual(error.code, "conflict");
    }).pipe(Effect.provide(makeLayer([{ status: 409, body: "not-json" }], captured)));
  });

  it.effect("patches and deletes only the exact encoded secret ID", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const key = { accountId: "account-1", storeId: "store-1", secretId: "secret/one" };
      yield* destination.patch(key, {
        value: "rotated",
        scopes: ["workers"],
        comment: "new-marker",
      });
      yield* destination.delete(key);
      assert.strictEqual(captured[0]?.method, "PATCH");
      assert.match(captured[0]?.url ?? "", /secrets\/secret%2Fone$/u);
      assert.strictEqual(captured[1]?.method, "DELETE");
      assert.match(captured[1]?.url ?? "", /secrets\/secret%2Fone$/u);
    }).pipe(
      Effect.provide(
        makeLayer(
          [
            { status: 200, body: envelope(secret({ id: "secret/one" })) },
            { status: 200, body: envelope({}) },
          ],
          captured,
        ),
      ),
    );
  });

  it.effect("rejects malformed metadata as a sanitized destination failure", () => {
    const captured: CapturedRequest[] = [];
    return Effect.gen(function* () {
      const destination = yield* WriteOnlySecretDestination;
      const error = yield* Effect.flip(
        destination.read({ accountId: "account-1", storeId: "store-1", secretId: "secret-1" }),
      );
      assert.ok(isDestinationError(error));
      assert.strictEqual(error.code, "destination-failure");
      assert.strictEqual(error.secretId, "secret-1");
      assert.notInclude(JSON.stringify(error), "unexpected-plaintext");
    }).pipe(
      Effect.provide(
        makeLayer([{ status: 200, body: envelope({ value: "unexpected-plaintext" }) }], captured),
      ),
    );
  });

  it.effect("preserves interruption in a mixed transport cause", () =>
    Effect.gen(function* () {
      const client = HttpClient.make(() =>
        Effect.failCause(Cause.combine(Cause.interrupt(1), Cause.die("transport defect"))),
      );
      const layer = cloudflareWriteOnlySecretDestinationLayer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(
          Layer.succeed(
            Credentials,
            Effect.succeed({
              type: "apiToken" as const,
              apiToken: Redacted.make("synthetic-api-token"),
              apiBaseUrl: "https://api.example.test/client/v4",
            }),
          ),
        ),
      );
      const exit = yield* Effect.gen(function* () {
        const destination = yield* WriteOnlySecretDestination;
        return yield* destination.read({
          accountId: "account-1",
          storeId: "store-1",
          secretId: "secret-1",
        });
      }).pipe(Effect.provide(layer), Effect.exit);
      assert.isTrue(Exit.hasInterrupts(exit));
    }),
  );
});
