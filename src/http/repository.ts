import { Effect, Schema } from "effect";

const Repository = Schema.Struct({ default_branch: Schema.String.check(Schema.isMinLength(1)) });
export class RepositoryFailure extends Schema.TaggedError<RepositoryFailure>()(
  "RepositoryFailure",
  {
    message: Schema.String,
    // GitHub says the repository doesn't exist, or the token can't see it.
    missing: Schema.optionalKey(Schema.Literal(true)),
  },
) {}

/** Resolve a repository the token can reach before recording a created event in the Session DO. */
export const defaultBranch = (repo: string, token: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`https://api.github.com/repos/${repo}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "scotty-rebuild",
          },
        }),
      catch: () => new RepositoryFailure({ message: "GitHub repository lookup unavailable" }),
    });
    if (!response.ok)
      return yield* new RepositoryFailure({
        message: `GitHub repository lookup returned HTTP ${response.status}`,
        ...(response.status === 404 ? { missing: true as const } : {}),
      });
    const json: unknown = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: () => new RepositoryFailure({ message: "Invalid GitHub repository response" }),
    });
    const decoded = yield* Schema.decodeUnknownEffect(Repository)(json).pipe(
      Effect.mapError(
        () => new RepositoryFailure({ message: "Invalid GitHub repository response" }),
      ),
    );
    return decoded.default_branch;
  });
