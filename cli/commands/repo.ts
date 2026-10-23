import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Size } from "../../src/places/place.js";
import { Repos, RepoSize } from "../client.js";
import { bold, dim, green, output, table, usage, withClient } from "./common.js";
import { repoName } from "./sessions.js";

const list = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const api = yield* withClient;
    const repos = yield* api("/api/repos", Repos);
    yield* output(
      repos,
      repos.repos.length === 0
        ? "No repository defaults. Set one: scotty repo set <owner/repo> --size <name>"
        : table(repos.repos.map((row) => [bold(row.repo), row.size])),
    );
  }),
);

// --default goes back to standard-1 for new sessions; existing sessions keep their size.
const set = Command.make(
  "set",
  {
    repository: Argument.String("repo"),
    size: Flag.Literals("size", Size.literals).pipe(Flag.optional),
    clear: Flag.Boolean("default").pipe(Flag.withDefault(false)),
  },
  ({ repository, size, clear }) =>
    Effect.gen(function* () {
      if (clear === Option.isSome(size))
        return yield* usage("Pass --size <name> or --default, not both", "repo");
      const repo = yield* repoName(repository, "repo");
      const api = yield* withClient;
      const path = `/api/repos/${repo}`;
      const saved = Option.isSome(size)
        ? yield* api(path, RepoSize, { method: "PUT", body: { size: size.value } })
        : yield* api(path, RepoSize, { method: "DELETE" });
      yield* output(
        saved,
        [
          saved.size === null
            ? `${green("✓")} New sessions on ${bold(saved.repo)} start at the default size`
            : `${green("✓")} New sessions on ${bold(saved.repo)} start at ${bold(saved.size)}`,
          dim("Existing sessions keep their size; --size on scotty new still wins."),
        ].join("\n"),
      );
    }),
);

export const repo = Command.make("repo").pipe(Command.withSubcommands([list, set]));
