import { Context, Data, Effect, Layer, Option } from "effect";
import {
  decodeJsonValue,
  decodeSessionProjection,
  decodeWorkspaceCreationMarker,
  SESSION_KV_PREFIX,
  WORKSPACE_CREATION_KV_PREFIX,
  type SessionProjection as SessionProjectionRecord,
  type StatsResponse,
  type WorkspaceCreationMarker,
} from "./contracts";
import { listProjectionValues } from "./projection-list";

type StatsProjectionOperation = "get" | "list" | "put";

export class StatsProjectionFailure extends Data.TaggedError("StatsProjectionFailure")<{
  readonly operation: StatsProjectionOperation;
}> {}

export interface StatsProjectionPage {
  readonly keys: ReadonlyArray<string>;
  readonly cursor?: string;
}

export interface StatsProjectionStorage {
  readonly get: (key: string) => Promise<unknown | null>;
  readonly list: (prefix: string, cursor?: string) => Promise<StatsProjectionPage>;
  readonly put: (key: string, value: string) => Promise<void>;
}

interface StatsProjectionShape {
  readonly recordCreation: (
    marker: WorkspaceCreationMarker,
  ) => Effect.Effect<void, StatsProjectionFailure>;
  readonly read: Effect.Effect<StatsResponse, StatsProjectionFailure>;
}

export class StatsProjection extends Context.Service<StatsProjection, StatsProjectionShape>()(
  "scotty/StatsProjection",
) {}

export const kvStatsProjectionStorage = (namespace: KVNamespace): StatsProjectionStorage => ({
  get: (key) => namespace.get(key, "text"),
  list: (prefix, cursor) =>
    namespace.list({ prefix, cursor }).then((page) => ({
      keys: page.keys.map((key) => key.name),
      cursor: page.list_complete ? undefined : page.cursor,
    })),
  put: (key, value) => namespace.put(key, value),
});

export const statsProjectionLayer = (
  storage: StatsProjectionStorage,
): Layer.Layer<StatsProjection> => Layer.succeed(StatsProjection)(makeStatsProjection(storage));

export const recordWorkspaceCreation = (
  marker: WorkspaceCreationMarker,
): Effect.Effect<void, StatsProjectionFailure, StatsProjection> =>
  Effect.flatMap(StatsProjection, (projection) => projection.recordCreation(marker));

export const readStats: Effect.Effect<StatsResponse, StatsProjectionFailure, StatsProjection> =
  Effect.flatMap(StatsProjection, (projection) => projection.read);

const makeStatsProjection = (storage: StatsProjectionStorage): StatsProjectionShape => {
  const failure = (operation: StatsProjectionOperation): StatsProjectionFailure =>
    new StatsProjectionFailure({ operation });
  const reader = (prefix: string) => ({
    get: storage.get,
    list: (cursor?: string) => storage.list(prefix, cursor),
  });

  return StatsProjection.of({
    recordCreation: (marker) =>
      Effect.tryPromise({
        try: () =>
          storage.put(`${WORKSPACE_CREATION_KV_PREFIX}${marker.sessionId}`, JSON.stringify(marker)),
        catch: () => failure("put"),
      }),
    read: Effect.gen(function* () {
      const { markers, sessions } = yield* Effect.all(
        {
          markers: listProjectionValues({
            storage: reader(WORKSPACE_CREATION_KV_PREFIX),
            decode: decodeMarker,
            compare: compareMarkerCreation,
            onGetError: () => failure("get"),
            onListError: () => failure("list"),
          }),
          sessions: listProjectionValues({
            storage: reader(SESSION_KV_PREFIX),
            decode: decodeSession,
            compare: (left, right) => left.id.localeCompare(right.id),
            onGetError: () => failure("get"),
            onListError: () => failure("list"),
          }),
        },
        { concurrency: 2 },
      );
      return aggregateStats(markers, sessions);
    }),
  });
};

export function aggregateStats(
  markers: ReadonlyArray<WorkspaceCreationMarker>,
  sessions: ReadonlyArray<SessionProjectionRecord>,
): StatsResponse {
  const orderedMarkers = [...markers].sort(compareMarkerCreation);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const projectsByIdentity = new Map<
    string,
    {
      repository: string;
      workspacesCreated: number;
      warmNow: number;
      stoppedNow: number;
      lastCreated: string;
    }
  >();
  let warmNow = 0;
  let stoppedNow = 0;

  for (const marker of orderedMarkers) {
    const identity = marker.repository.toLocaleLowerCase("en-US");
    const existing = projectsByIdentity.get(identity);
    const project = existing ?? {
      repository: marker.repository,
      workspacesCreated: 0,
      warmNow: 0,
      stoppedNow: 0,
      lastCreated: marker.createdAt,
    };
    project.workspacesCreated += 1;
    if (Date.parse(marker.createdAt) > Date.parse(project.lastCreated))
      project.lastCreated = marker.createdAt;

    const status = sessionsById.get(marker.sessionId)?.status;
    if (status === "warm") {
      project.warmNow += 1;
      warmNow += 1;
    } else if (status === "stopped") {
      project.stoppedNow += 1;
      stoppedNow += 1;
    }
    projectsByIdentity.set(identity, project);
  }

  const projects = [...projectsByIdentity.values()].sort(
    (left, right) =>
      Date.parse(right.lastCreated) - Date.parse(left.lastCreated) ||
      left.repository.localeCompare(right.repository),
  );
  return {
    trackingSince: orderedMarkers[0]?.createdAt ?? null,
    overall: {
      workspacesCreated: orderedMarkers.length,
      projects: projects.length,
      warmNow,
      stoppedNow,
    },
    projects,
  };
}

const decodeMarker = (key: string, value: unknown): WorkspaceCreationMarker | undefined => {
  if (!key.startsWith(WORKSPACE_CREATION_KV_PREFIX)) return undefined;
  const expectedSessionId = key.slice(WORKSPACE_CREATION_KV_PREFIX.length);
  const json = typeof value === "string" ? decodeJsonValue(value) : Option.some(value);
  if (Option.isNone(json)) return undefined;
  const decoded = decodeWorkspaceCreationMarker(json.value);
  if (
    Option.isNone(decoded) ||
    decoded.value.sessionId !== expectedSessionId ||
    !isTimestamp(decoded.value.createdAt)
  )
    return undefined;
  return decoded.value;
};

const decodeSession = (key: string, value: unknown): SessionProjectionRecord | undefined => {
  if (!key.startsWith(SESSION_KV_PREFIX)) return undefined;
  const expectedSessionId = key.slice(SESSION_KV_PREFIX.length);
  const json = typeof value === "string" ? decodeJsonValue(value) : Option.some(value);
  if (Option.isNone(json)) return undefined;
  const decoded = decodeSessionProjection(json.value);
  if (
    Option.isNone(decoded) ||
    decoded.value.id !== expectedSessionId ||
    !isTimestamp(decoded.value.createdAt) ||
    !isTimestamp(decoded.value.updatedAt) ||
    !isTimestamp(decoded.value.hardCapAt) ||
    !isTimestamp(decoded.value.projectedAt)
  )
    return undefined;
  return decoded.value;
};

const compareMarkerCreation = (
  left: WorkspaceCreationMarker,
  right: WorkspaceCreationMarker,
): number =>
  Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
  left.sessionId.localeCompare(right.sessionId);

const isTimestamp = (value: string): boolean => Number.isFinite(Date.parse(value));
