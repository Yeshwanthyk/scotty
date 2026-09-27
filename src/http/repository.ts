import { Effect, Schema } from "effect";

const Repository = Schema.Struct({ default_branch: Schema.String.check(Schema.isMinLength(1)) });
export class RepositoryFailure extends Schema.TaggedError<RepositoryFailure>()(
  "RepositoryFailure",
  {
    message: Schema.String,
  },
) {}

/** Resolve a public repository before recording a created event in the Session DO. */
export const defaultBranch = (repo: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`https://api.github.com/repos/${repo}`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "scotty-rebuild" },
        }),
      catch: () => new RepositoryFailure({ message: "GitHub repository lookup unavailable" }),
    });
    if (!response.ok)
      return yield* new RepositoryFailure({
        message: `Public repository lookup returned HTTP ${response.status}`,
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
