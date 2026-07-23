import { Clock, Context, Data, DateTime, Effect, Layer, Option } from "effect";
import {
  decodeJsonValue,
  decodeRepoProjection,
  REPO_KV_PREFIX,
  type RepoProjection as RepoProjectionRecord,
  type RepoView,
} from "./contracts";

type RepoProjectionOperation = "get" | "list" | "put";

export class RepoProjectionFailure extends Data.TaggedError("RepoProjectionFailure")<{
  readonly operation: RepoProjectionOperation;
}> {}

export interface RepoProjectionPage {
  readonly keys: ReadonlyArray<string>;
  readonly cursor?: string;
}

export interface RepoProjectionStorage {
  readonly get: (key: string) => Promise<unknown | null>;
  readonly list: (cursor?: string) => Promise<RepoProjectionPage>;
  readonly put: (key: string, value: string) => Promise<void>;
}

interface RepoProjectionShape {
  readonly upsert: (
    repo: string,
    defaultBranch: string,
  ) => Effect.Effect<void, RepoProjectionFailure>;
  readonly list: Effect.Effect<ReadonlyArray<RepoView>, RepoProjectionFailure>;
}

export class RepoProjection extends Context.Service<RepoProjection, RepoProjectionShape>()(
  "scotty/RepoProjection",
) {}

export const kvRepoProjectionStorage = (namespace: KVNamespace): RepoProjectionStorage => ({
  get: (key) => namespace.get(key, "text"),
  list: (cursor) =>
    namespace.list({ prefix: REPO_KV_PREFIX, cursor }).then((page) => ({
      keys: page.keys.map((key) => key.name),
      cursor: page.list_complete ? undefined : page.cursor,
    })),
  put: (key, value) => namespace.put(key, value),
});

export const repoProjectionLayer = (storage: RepoProjectionStorage): Layer.Layer<RepoProjection> =>
  Layer.succeed(RepoProjection)(makeRepoProjection(storage));

export const trackRepoBestEffort = (
  repo: string,
  defaultBranch: string,
): Effect.Effect<void, never, RepoProjection> =>
  Effect.flatMap(RepoProjection, (projection) => projection.upsert(repo, defaultBranch)).pipe(
    Effect.ignore,
  );

export const listRepoProjections: Effect.Effect<
  ReadonlyArray<RepoView>,
  RepoProjectionFailure,
  RepoProjection
> = Effect.flatMap(RepoProjection, (projection) => projection.list);

const makeRepoProjection = (storage: RepoProjectionStorage): RepoProjectionShape => {
  const failure = (operation: RepoProjectionOperation): RepoProjectionFailure =>
    new RepoProjectionFailure({ operation });

  return RepoProjection.of({
    upsert: Effect.fnUntraced(function* (repo, defaultBranch) {
      const now = yield* Clock.currentTimeMillis;
      const projection: RepoProjectionRecord = {
        version: 1,
        repo,
        defaultBranch,
        lastUsedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      };
      yield* Effect.tryPromise({
        try: () => storage.put(`${REPO_KV_PREFIX}${repo}`, JSON.stringify(projection)),
        catch: () => failure("put"),
      });
    }),
    list: Effect.gen(function* () {
      const repositories: Array<RepoView> = [];
      let cursor: string | undefined;
      do {
        const page = yield* Effect.tryPromise({
          try: () => storage.list(cursor),
          catch: () => failure("list"),
        });
        const values = yield* Effect.all(
          page.keys.map((key) =>
            Effect.tryPromise({
              try: () => storage.get(key),
              catch: () => failure("get"),
            }).pipe(Effect.map((value) => decodeProjection(key, value))),
          ),
          { concurrency: "unbounded" },
        );
        for (const value of values) {
          if (value !== undefined) repositories.push(toRepoView(value));
        }
        cursor = page.cursor;
      } while (cursor !== undefined);

      repositories.sort(
        (left, right) => Date.parse(right.lastUsedAt) - Date.parse(left.lastUsedAt),
      );
      return repositories;
    }),
  });
};

const decodeProjection = (key: string, value: unknown): RepoProjectionRecord | undefined => {
  if (!key.startsWith(REPO_KV_PREFIX)) return undefined;
  const expectedRepo = key.slice(REPO_KV_PREFIX.length);
  const json = typeof value === "string" ? decodeJsonValue(value) : Option.some(value);
  if (Option.isNone(json)) return undefined;
  const decoded = decodeRepoProjection(json.value);
  if (
    Option.isNone(decoded) ||
    decoded.value.repo !== expectedRepo ||
    !Number.isFinite(Date.parse(decoded.value.lastUsedAt))
  )
    return undefined;
  return decoded.value;
};

const toRepoView = (projection: RepoProjectionRecord): RepoView => ({
  repo: projection.repo,
  defaultBranch: projection.defaultBranch,
  lastUsedAt: projection.lastUsedAt,
});
