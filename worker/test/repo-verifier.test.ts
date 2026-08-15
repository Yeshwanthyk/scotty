import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { makeRepoVerifierForClient, RepoVerifierFailure } from "../src/repo-verifier";

const TOKEN = "real-github-token-that-must-not-escape";
const REPO = "owner/project";

const runWith = (
  response: Response | "transport",
  requestSeen: (request: HttpClientRequest.HttpClientRequest) => void = () => undefined,
  repo = REPO,
) => {
  const client = HttpClient.make((request) => {
    requestSeen(request);
    if (response === "transport")
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "network failure" }),
        }),
      );
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return makeRepoVerifierForClient(client).verify(repo, TOKEN);
};

const failureReason = (result: Result.Result<unknown, RepoVerifierFailure>): RepoVerifierFailure =>
  Result.match(result, {
    onFailure: (failure) => failure,
    onSuccess: () => assert.fail("expected a verifier failure"),
  });

describe("RepoVerifier", () => {
  it.effect("accepts an authenticated 200 with a valid default branch", () =>
    Effect.gen(function* () {
      let request: HttpClientRequest.HttpClientRequest | undefined;
      const result = yield* runWith(
        Response.json({ id: 1, default_branch: "trunk", private: true }),
        (value) => {
          request = value;
        },
      );

      assert.deepStrictEqual(result, { exists: true, defaultBranch: "trunk" });
      assert.strictEqual(request?.url, "https://api.github.com/repos/owner/project");
      assert.strictEqual(request?.headers.authorization, `Bearer ${TOKEN}`);
    }),
  );

  it.effect("returns missing only for an authenticated 404", () =>
    Effect.gen(function* () {
      let authorization: string | undefined;
      const result = yield* runWith(new Response(null, { status: 404 }), (request) => {
        authorization = request.headers.authorization;
      });

      assert.deepStrictEqual(result, { exists: false });
      assert.strictEqual(authorization, `Bearer ${TOKEN}`);
    }),
  );

  for (const [status, reason] of [
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limit"],
    [500, "server"],
    [503, "server"],
  ] as const) {
    it.effect(`classifies GitHub ${status} as a typed verifier failure`, () =>
      Effect.gen(function* () {
        const response = new Response(null, {
          status,
          headers: status === 403 ? { "x-ratelimit-remaining": "1" } : undefined,
        });
        const result = yield* Effect.result(runWith(response));

        const error = failureReason(result);
        assert.strictEqual(error.reason, reason);
        assert.strictEqual(error.status, status);
        assert.notInclude(JSON.stringify(error), TOKEN);
      }),
    );
  }

  it.effect("classifies an exhausted rate limit separately", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        runWith(new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } })),
      );
      assert.strictEqual(failureReason(result).reason, "rate_limit");
    }),
  );

  it.effect("redacts transport and malformed response failures", () =>
    Effect.gen(function* () {
      const transport = yield* Effect.result(runWith("transport"));
      assert.strictEqual(failureReason(transport).reason, "transport");
      assert.notInclude(JSON.stringify(failureReason(transport)), TOKEN);

      const malformed = yield* Effect.result(runWith(new Response("{not-json", { status: 200 })));
      assert.strictEqual(failureReason(malformed).reason, "malformed_response");
      assert.notInclude(JSON.stringify(failureReason(malformed)), TOKEN);
    }),
  );

  for (const body of [
    {},
    { default_branch: "" },
    { default_branch: "  " },
    { default_branch: "-bad" },
    { default_branch: ".bad" },
    { default_branch: "@" },
    { default_branch: "trailing/" },
  ]) {
    it.effect(`rejects an invalid default_branch response (${JSON.stringify(body)})`, () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(runWith(Response.json(body)));
        assert.strictEqual(failureReason(result).reason, "malformed_response");
      }),
    );
  }

  for (const repo of ["./project", "../project", "owner/.", "owner/.."]) {
    it.effect(`rejects a URL-normalizing repository path (${repo})`, () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          runWith(Response.json({ default_branch: "main" }), undefined, repo),
        );
        assert.strictEqual(failureReason(result).reason, "unexpected_status");
      }),
    );
  }
});
