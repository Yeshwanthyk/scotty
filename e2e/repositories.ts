import { Effect, Schema } from "effect";
import { access, CliFailure, client, failure, target } from "../cli/client.js";

const Catalog = Schema.Struct({
  repos: Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))),
  nextPage: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
});
const program = Effect.gen(function* () {
  const url = yield* target(process.env.SCOTTY_URL);
  const request = client({ url, token: yield* access(url) });
  const check = (ok: boolean, why: string) =>
    ok ? Effect.void : Effect.fail(failure("repositories", why, "scotty doctor"));
  const first = yield* request("/api/repositories?page=1&perPage=1", Catalog);
  yield* check(
    first.repos.length === 1 && first.nextPage === 2,
    "First GitHub page missing continuation",
  );
  const second = yield* request("/api/repositories?page=2&perPage=1", Catalog);
  yield* check(
    second.repos.length === 1 && second.repos[0] !== first.repos[0],
    "Second page repeated the first",
  );
  const all: string[] = [];
  let page: number | null = 1;
  while (page !== null) {
    const result: typeof Catalog.Type = yield* request(`/api/repositories?page=${page}`, Catalog);
    all.push(...result.repos);
    page = result.nextPage;
  }
  yield* check(
    all.includes(first.repos[0] ?? "") && all.includes(second.repos[0] ?? ""),
    "Full catalog lost paginated repositories",
  );
  for (const query of ["page=0", "page=1.5", "page=no", "perPage=0", "perPage=101"]) {
    const rejected = yield* request(`/api/repositories?${query}`, Catalog).pipe(Effect.flip);
    yield* check(rejected.code === "bad_request", `Invalid query accepted: ${query}`);
  }
  console.log(
    `Repositories: ${all.length} real GitHub repositories, pagination and invalid queries verified`,
  );
});
Effect.runPromise(program).catch((error: unknown) => {
  console.error(error instanceof CliFailure ? error.message : "Repositories e2e failed");
  process.exitCode = 1;
});
