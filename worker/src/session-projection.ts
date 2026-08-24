import { Clock, Context, Data, Effect, Layer, Option } from "effect";
import {
  decodeJsonValue,
  decodeSessionProjection,
  SESSION_KV_PREFIX,
  toProjection,
  toSessionView,
  type SessionControlAuthority,
  type SessionView,
} from "./contracts";
import { listProjectionValues } from "./projection-list";

type ProjectionOperation = "delete" | "get" | "list" | "put";

export class SessionProjectionFailure extends Data.TaggedError("SessionProjectionFailure")<{
  readonly operation: ProjectionOperation;
}> {}

export interface SessionProjectionPage {
  readonly keys: ReadonlyArray<string>;
  readonly cursor?: string;
}

export interface SessionProjectionStorage {
  readonly delete: (key: string) => Promise<void>;
  readonly get: (key: string) => Promise<unknown | null>;
  readonly list: (cursor?: string) => Promise<SessionProjectionPage>;
  readonly put: (key: string, value: string) => Promise<void>;
}

interface SessionProjectionShape {
  readonly project: (
    authority: SessionControlAuthority,
  ) => Effect.Effect<void, SessionProjectionFailure>;
  readonly remove: (id: string) => Effect.Effect<void, SessionProjectionFailure>;
  readonly list: Effect.Effect<ReadonlyArray<SessionView>, SessionProjectionFailure>;
}

export class SessionProjection extends Context.Service<SessionProjection, SessionProjectionShape>()(
  "scotty/SessionProjection",
) {}

export const kvSessionProjectionStorage = (namespace: KVNamespace): SessionProjectionStorage => ({
  delete: (key) => namespace.delete(key),
  get: (key) => namespace.get(key, "text"),
  list: (cursor) =>
    namespace.list({ prefix: SESSION_KV_PREFIX, cursor }).then((page) => ({
      keys: page.keys.map((key) => key.name),
      cursor: page.list_complete ? undefined : page.cursor,
    })),
  put: (key, value) => namespace.put(key, value),
});

export const sessionProjectionLayer = (
  storage: SessionProjectionStorage,
): Layer.Layer<SessionProjection> =>
  Layer.succeed(SessionProjection)(makeSessionProjection(storage));

export const projectSessionBestEffort = (
  authority: SessionControlAuthority,
): Effect.Effect<void, never, SessionProjection> =>
  Effect.flatMap(SessionProjection, (projection) =>
    authority.record.status === "gone"
      ? projection.remove(authority.record.id)
      : projection.project(authority),
  ).pipe(Effect.ignore);

export const removeSessionProjection = (
  id: string,
): Effect.Effect<void, SessionProjectionFailure, SessionProjection> =>
  Effect.flatMap(SessionProjection, (projection) => projection.remove(id));

export const listSessionProjections: Effect.Effect<
  ReadonlyArray<SessionView>,
  SessionProjectionFailure,
  SessionProjection
> = Effect.flatMap(SessionProjection, (projection) => projection.list);

const makeSessionProjection = (storage: SessionProjectionStorage): SessionProjectionShape => {
  const failure = (operation: ProjectionOperation): SessionProjectionFailure =>
    new SessionProjectionFailure({ operation });

  const remove = (id: string): Effect.Effect<void, SessionProjectionFailure> =>
    Effect.tryPromise({
      try: () => storage.delete(`${SESSION_KV_PREFIX}${id}`),
      catch: () => failure("delete"),
    });

  return SessionProjection.of({
    project: Effect.fnUntraced(function* (authority) {
      const now = new Date(yield* Clock.currentTimeMillis);
      const key = `${SESSION_KV_PREFIX}${authority.record.id}`;
      const existing = yield* Effect.tryPromise({
        try: () => storage.get(key),
        catch: () => failure("get"),
      });
      const decodedExisting = decodeProjection(key, existing);
      if (decodedExisting !== undefined && decodedExisting.revision > authority.revision) return;
      // Cloudflare KV has no compare-and-swap. The revision makes stale projections detectable;
      // authoritative reads and repair must overwrite any stale value observed after a race.
      yield* Effect.tryPromise({
        try: () =>
          storage.put(key, JSON.stringify(toProjection(authority.record, authority.revision, now))),
        catch: () => failure("put"),
      });
    }),
    remove,
    list: Effect.gen(function* () {
      const projections = yield* listProjectionValues({
        storage,
        decode: decodeProjection,
        compare: (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
        onGetError: () => failure("get"),
        onListError: () => failure("list"),
      });
      const now = yield* Clock.currentTimeMillis;
      return projections.map((projection) => toSessionView(projection, now));
    }),
  });
};

const decodeProjection = (key: string, value: unknown) => {
  if (!key.startsWith(SESSION_KV_PREFIX)) return undefined;
  const expectedId = key.slice(SESSION_KV_PREFIX.length);
  const json = typeof value === "string" ? decodeJsonValue(value) : Option.some(value);
  if (Option.isNone(json)) return undefined;
  const decoded = decodeSessionProjection(json.value);
  if (Option.isNone(decoded) || decoded.value.id !== expectedId) return undefined;
  if (
    !isTimestamp(decoded.value.createdAt) ||
    !isTimestamp(decoded.value.updatedAt) ||
    !isTimestamp(decoded.value.hardCapAt) ||
    !isTimestamp(decoded.value.projectedAt) ||
    (decoded.value.lastAgentEventAt !== undefined && !isTimestamp(decoded.value.lastAgentEventAt))
  )
    return undefined;
  return decoded.value;
};

const isTimestamp = (value: string): boolean => Number.isFinite(Date.parse(value));
