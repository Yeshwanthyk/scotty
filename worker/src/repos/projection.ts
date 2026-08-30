import { Clock, Context, Data, DateTime, Effect, Layer, Option } from "effect";
import {
  compareRepositoryRegistryEntries,
  type RepositoryRegistryEntry,
} from "../../../protocol/repository";
import {
  decodeRepoProjection,
  REPO_KV_PREFIX,
  type RepoProjection as RepoProjectionRecord,
  type RepoView,
} from "../session/contracts";
import { decodeJsonValue } from "../shared/json";
import { listProjectionValues } from "../shared/projection-list";

type RepoProjectionOperation = "delete" | "get" | "list" | "put";

export class RepoProjectionFailure extends Data.TaggedError("RepoProjectionFailure")<{
  readonly operation: RepoProjectionOperation;
}> {}

export interface RepoProjectionPage {
  readonly keys: ReadonlyArray<string>;
  readonly cursor?: string;
}

export interface RepoProjectionStorage {
  readonly delete: (key: string) => Promise<void>;
  readonly get: (key: string) => Promise<unknown | null>;
  readonly list: (cursor?: string) => Promise<RepoProjectionPage>;
  readonly put: (key: string, value: string) => Promise<void>;
}

interface RepoProjectionShape {
  readonly forget: (repo: string) => Effect.Effect<void, RepoProjectionFailure>;
  readonly upsert: (
    repo: string,
    defaultBranch: string,
  ) => Effect.Effect<void, RepoProjectionFailure>;
  readonly upsertEntry: (
    entry: RepositoryRegistryEntry,
  ) => Effect.Effect<void, RepoProjectionFailure>;
  readonly rebuild: (
    entries: ReadonlyArray<RepositoryRegistryEntry>,
  ) => Effect.Effect<void, RepoProjectionFailure>;
  readonly matches: (
    entries: ReadonlyArray<RepositoryRegistryEntry>,
  ) => Effect.Effect<boolean, RepoProjectionFailure>;
  readonly list: Effect.Effect<ReadonlyArray<RepoView>, RepoProjectionFailure>;
}

export class RepoProjection extends Context.Service<RepoProjection, RepoProjectionShape>()(
  "scotty/RepoProjection",
) {}

export const kvRepoProjectionStorage = (namespace: KVNamespace): RepoProjectionStorage => ({
  delete: (key) => namespace.delete(key),
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

export const projectRepoEntryBestEffort = (
  entry: RepositoryRegistryEntry,
): Effect.Effect<void, never, RepoProjection> =>
  Effect.flatMap(RepoProjection, (projection) => projection.upsertEntry(entry)).pipe(Effect.ignore);

export const rebuildRepoProjection = (
  entries: ReadonlyArray<RepositoryRegistryEntry>,
): Effect.Effect<void, RepoProjectionFailure, RepoProjection> =>
  Effect.flatMap(RepoProjection, (projection) => projection.rebuild(entries));

export const repoProjectionMatches = (
  entries: ReadonlyArray<RepositoryRegistryEntry>,
): Effect.Effect<boolean, RepoProjectionFailure, RepoProjection> =>
  Effect.flatMap(RepoProjection, (projection) => projection.matches(entries));

export const listRepoProjections: Effect.Effect<
  ReadonlyArray<RepoView>,
  RepoProjectionFailure,
  RepoProjection
> = Effect.flatMap(RepoProjection, (projection) => projection.list);

export const forgetRepoProjection = (
  repo: string,
): Effect.Effect<void, RepoProjectionFailure, RepoProjection> =>
  Effect.flatMap(RepoProjection, (projection) => projection.forget(repo));

const makeRepoProjection = (storage: RepoProjectionStorage): RepoProjectionShape => {
  const failure = (operation: RepoProjectionOperation): RepoProjectionFailure =>
    new RepoProjectionFailure({ operation });

  return RepoProjection.of({
    forget: Effect.fnUntraced(function* (repo) {
      const identity = repo.toLocaleLowerCase("en-US");
      const matchingKeys: Array<string> = [];
      let cursor: string | undefined;
      do {
        const page = yield* Effect.tryPromise({
          try: () => storage.list(cursor),
          catch: () => failure("list"),
        });
        for (const key of page.keys) {
          if (
            key.startsWith(REPO_KV_PREFIX) &&
            key.slice(REPO_KV_PREFIX.length).toLocaleLowerCase("en-US") === identity
          )
            matchingKeys.push(key);
        }
        cursor = page.cursor;
      } while (cursor !== undefined);

      yield* Effect.forEach(
        matchingKeys,
        (key) =>
          Effect.tryPromise({
            try: () => storage.delete(key),
            catch: () => failure("delete"),
          }),
        { concurrency: "unbounded", discard: true },
      );
    }),
    upsert: Effect.fnUntraced(function* (repo, defaultBranch) {
      const now = yield* Clock.currentTimeMillis;
      const projection: RepoProjectionRecord = {
        repo,
        defaultBranch,
        lastUsedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      };
      yield* Effect.tryPromise({
        try: () => storage.put(`${REPO_KV_PREFIX}${repo}`, JSON.stringify(projection)),
        catch: () => failure("put"),
      });
    }),
    upsertEntry: Effect.fnUntraced(function* (entry) {
      const projection: RepoProjectionRecord = {
        ...entry,
      };
      yield* Effect.tryPromise({
        try: () => storage.put(`${REPO_KV_PREFIX}${entry.repo}`, JSON.stringify(projection)),
        catch: () => failure("put"),
      });
    }),
    rebuild: Effect.fnUntraced(function* (entries) {
      const keys: Array<string> = [];
      let cursor: string | undefined;
      do {
        const page = yield* Effect.tryPromise({
          try: () => storage.list(cursor),
          catch: () => failure("list"),
        });
        for (const key of page.keys) if (key.startsWith(REPO_KV_PREFIX)) keys.push(key);
        cursor = page.cursor;
      } while (cursor !== undefined);

      yield* Effect.forEach(
        keys,
        (key) =>
          Effect.tryPromise({
            try: () => storage.delete(key),
            catch: () => failure("delete"),
          }),
        { concurrency: "unbounded", discard: true },
      );

      yield* Effect.forEach(
        [...entries].sort(compareRepositoryRegistryEntries),
        (entry) => {
          const projection: RepoProjectionRecord = { ...entry };
          return Effect.tryPromise({
            try: () => storage.put(`${REPO_KV_PREFIX}${entry.repo}`, JSON.stringify(projection)),
            catch: () => failure("put"),
          });
        },
        { concurrency: "unbounded", discard: true },
      );
    }),
    matches: Effect.fnUntraced(function* (entries) {
      const expected = new Map(entries.map((entry) => [entry.repo, entry]));
      const keys: Array<string> = [];
      let cursor: string | undefined;
      do {
        const page = yield* Effect.tryPromise({
          try: () => storage.list(cursor),
          catch: () => failure("list"),
        });
        for (const key of page.keys) {
          if (!key.startsWith(REPO_KV_PREFIX)) continue;
          keys.push(key);
        }
        cursor = page.cursor;
      } while (cursor !== undefined);
      if (keys.length !== entries.length) return false;
      for (const key of keys) {
        const expectedEntry = expected.get(key.slice(REPO_KV_PREFIX.length));
        if (expectedEntry === undefined) return false;
        const value = yield* Effect.tryPromise({
          try: () => storage.get(key),
          catch: () => failure("get"),
        });
        const decoded = decodeProjection(key, value);
        if (
          decoded === undefined ||
          decoded.repo !== expectedEntry.repo ||
          decoded.defaultBranch !== expectedEntry.defaultBranch ||
          decoded.lastUsedAt !== expectedEntry.lastUsedAt ||
          decoded.addedAt !== expectedEntry.addedAt
        )
          return false;
      }
      return true;
    }),
    list: Effect.gen(function* () {
      const projections = yield* listProjectionValues({
        storage,
        decode: decodeProjection,
        compare: compareRepositoryRegistryEntries,
        onGetError: () => failure("get"),
        onListError: () => failure("list"),
      });
      return projections.map(toRepoView);
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
  ...(projection.addedAt === undefined ? {} : { addedAt: projection.addedAt }),
  lastUsedAt: projection.lastUsedAt,
});
