import {
  decodeSessionHttpFailure,
  decodeSessionWireValue,
  SESSION_WIRE_VERSION,
  type SessionModel,
  type SessionReadFailure,
} from "./session-reader";

export interface SessionListProjection {
  readonly projectedAt: string;
  readonly session: SessionModel;
}

export type SessionListReadResult =
  | { readonly ok: true; readonly projections: ReadonlyArray<SessionListProjection> }
  | { readonly ok: false; readonly failure: SessionReadFailure };

export interface ReadSessionListOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly fixture?: ReadonlyArray<SessionModel>;
  readonly fixtureFallback?: boolean;
  readonly signal?: AbortSignal;
}

type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

const isJsonValue = (value: unknown): value is JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonValue);
};

const isJsonObject = (value: unknown): value is JsonObject =>
  isJsonValue(value) && value !== null && !Array.isArray(value) && typeof value === "object";

const hasOnlyKeys = (value: JsonObject, keys: ReadonlyArray<string>): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const fixtureResult = (
  fixture: ReadonlyArray<SessionModel> | undefined,
): SessionListReadResult | undefined =>
  fixture === undefined
    ? undefined
    : {
        ok: true,
        projections: fixture.map((session) => ({
          projectedAt: "2026-09-03T16:00:00.000Z",
          session,
        })),
      };

export const decodeSessionListResponse = (
  value: unknown,
): ReadonlyArray<SessionListProjection> | undefined => {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["version", "sessions"]) ||
    value.version !== SESSION_WIRE_VERSION ||
    !Array.isArray(value.sessions)
  )
    return undefined;

  const projections: SessionListProjection[] = [];
  const identities = new Set<string>();
  for (const item of value.sessions) {
    if (
      !isJsonObject(item) ||
      !hasOnlyKeys(item, [
        "identity",
        "authority",
        "runtime",
        "capabilities",
        "display",
        "times",
        "projection",
      ]) ||
      !isJsonObject(item.projection) ||
      !hasOnlyKeys(item.projection, ["projectedAt"]) ||
      typeof item.projection.projectedAt !== "string" ||
      !Number.isFinite(Date.parse(item.projection.projectedAt))
    )
      return undefined;
    const projectedAt = item.projection.projectedAt;
    const sessionValue = {
      identity: item.identity,
      authority: item.authority,
      runtime: item.runtime,
      capabilities: item.capabilities,
      display: item.display,
      times: item.times,
    };
    const session = decodeSessionWireValue(sessionValue, "projection");
    if (session === undefined || identities.has(session.id)) return undefined;
    identities.add(session.id);
    projections.push({ projectedAt, session });
  }
  return projections;
};

const readJson = async (response: Response): Promise<unknown> =>
  response.json().catch(() => undefined);

export const readSessionList = async (
  options: ReadSessionListOptions = {},
): Promise<SessionListReadResult> => {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)("/api/sessions", {
      headers: { accept: "application/json" },
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch {
    return (
      (options.fixtureFallback === true ? fixtureResult(options.fixture) : undefined) ?? {
        ok: false,
        failure: { kind: "network" },
      }
    );
  }

  const body = await readJson(response);
  if (!response.ok)
    return (
      (options.fixtureFallback === true ? fixtureResult(options.fixture) : undefined) ?? {
        ok: false,
        failure: decodeSessionHttpFailure(response.status, body),
      }
    );
  const projections = decodeSessionListResponse(body);
  return projections === undefined
    ? ((options.fixtureFallback === true ? fixtureResult(options.fixture) : undefined) ?? {
        ok: false,
        failure: { kind: "malformed-response" },
      })
    : { ok: true, projections };
};
