import { Context, Data, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { isRepositoryIdentity, RepositoryDefaultBranchSchema } from "../../protocol/repository";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GitHubRepositorySchema = Schema.Struct({
  default_branch: RepositoryDefaultBranchSchema,
});
const decodeGitHubRepository = Schema.decodeUnknownEffect(GitHubRepositorySchema, {
  onExcessProperty: "ignore",
});

export type VerifiedRepository =
  | { readonly exists: true; readonly defaultBranch: string }
  | { readonly exists: false };

export type RepoVerifierFailureReason =
  | "invalid_input"
  | "missing_credential"
  | "unauthorized"
  | "forbidden"
  | "rate_limit"
  | "server"
  | "unexpected_status"
  | "transport"
  | "malformed_response";

/** A redacted, typed failure from the GitHub repository verification boundary. */
export class RepoVerifierFailure extends Data.TaggedError("RepoVerifierFailure")<{
  readonly reason: RepoVerifierFailureReason;
  readonly status?: number;
}> {}

interface RepoVerifierShape {
  readonly verify: (
    repo: string,
    githubToken: string,
  ) => Effect.Effect<VerifiedRepository, RepoVerifierFailure>;
}

export class RepoVerifier extends Context.Service<RepoVerifier, RepoVerifierShape>()(
  "scotty/RepoVerifier",
) {}

const failure = (reason: RepoVerifierFailureReason, status?: number): RepoVerifierFailure =>
  new RepoVerifierFailure({
    reason,
    ...(status === undefined ? {} : { status }),
  });

const classifyStatus = (status: number, rateLimitRemaining: string | null) => {
  if (status === 401) return failure("unauthorized", status);
  if (status === 403)
    return failure(rateLimitRemaining === "0" ? "rate_limit" : "forbidden", status);
  if (status === 429) return failure("rate_limit", status);
  if (status >= 500 && status <= 599) return failure("server", status);
  return failure("unexpected_status", status);
};

const makeRepoVerifier = (client: HttpClient.HttpClient): RepoVerifierShape => ({
  verify: Effect.fnUntraced(function* (repo, githubToken) {
    if (!isRepositoryIdentity(repo)) return yield* failure("invalid_input");
    if (githubToken.length === 0) return yield* failure("missing_credential");

    const request = HttpClientRequest.bearerToken(
      HttpClientRequest.get(
        `${GITHUB_API_ORIGIN}/repos/${repo
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": "scotty",
          },
        },
      ),
      githubToken,
    );
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => failure("transport")));
    if (response.status === 404) return { exists: false };
    if (response.status !== 200)
      return yield* classifyStatus(response.status, response.headers["x-ratelimit-remaining"]);

    const body = yield* response.json.pipe(Effect.mapError(() => failure("malformed_response")));
    const decoded = yield* decodeGitHubRepository(body).pipe(
      Effect.mapError(() => failure("malformed_response")),
    );
    return { exists: true, defaultBranch: decoded.default_branch };
  }),
});

/** Production repository verification backed by Effect's FetchHttpClient layer. */
export const repoVerifierLayer: Layer.Layer<RepoVerifier, never, HttpClient.HttpClient> =
  Layer.effect(RepoVerifier, Effect.map(HttpClient.HttpClient, makeRepoVerifier));

/** Exposed for unit tests and small host adapters that provide their own HTTP client. */
export const makeRepoVerifierForClient = makeRepoVerifier;
