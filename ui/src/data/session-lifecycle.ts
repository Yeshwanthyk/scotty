import {
  classifySessionHttpFailure,
  decodeSessionHttpFailure,
  type SessionFailureClassification,
  type SessionHttpFailure,
  type SessionLifecycle,
  type SessionReadFailure,
} from "./session-reader";

export type SessionLifecycleAction = "checkpoint" | "sleep" | "resume" | "vaporize";

export interface SessionMutationSuccess {
  readonly action: SessionLifecycleAction;
  readonly id: string;
  readonly status: SessionLifecycle;
}

export type SessionMutationResult =
  | { readonly ok: true; readonly value: SessionMutationSuccess }
  | {
      readonly ok: false;
      readonly failure: SessionReadFailure;
      readonly classification: SessionFailureClassification;
    };

export interface MutateSessionOptions {
  readonly fetch?: typeof globalThis.fetch;
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

const expectedStatusFor = (action: SessionLifecycleAction): SessionLifecycle =>
  action === "sleep" ? "sleeping" : action === "vaporize" ? "gone" : "warm";

/**
 * Mutation responses are not the UI authority. Validate the identity and the
 * endpoint's decisive terminal status before allowing the caller to treat a
 * 2xx body as an admitted lifecycle result.
 */
export const decodeSessionMutationSuccess = (
  value: unknown,
  sessionId: string,
  action: SessionLifecycleAction,
): SessionMutationSuccess | undefined => {
  if (!isJsonObject(value) || value.id !== sessionId || value.status !== expectedStatusFor(action))
    return undefined;
  return { action, id: sessionId, status: value.status };
};

const readJson = async (response: Response): Promise<unknown> =>
  response.json().catch(() => undefined);

const mutationPath = (sessionId: string, action: SessionLifecycleAction): string =>
  action === "vaporize"
    ? `/api/sessions/${encodeURIComponent(sessionId)}`
    : `/api/sessions/${encodeURIComponent(sessionId)}/${action}`;

const mutationMethod = (action: SessionLifecycleAction): "POST" | "DELETE" =>
  action === "vaporize" ? "DELETE" : "POST";

const malformedResult = (): SessionMutationResult => ({
  ok: false,
  failure: { kind: "malformed-response" },
  classification: "malformed",
});

const httpResult = (failure: SessionHttpFailure): SessionMutationResult => ({
  ok: false,
  failure,
  classification: classifySessionHttpFailure(failure),
});

export const mutateSessionLifecycle = async (
  sessionId: string,
  action: SessionLifecycleAction,
  options: MutateSessionOptions = {},
): Promise<SessionMutationResult> => {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(mutationPath(sessionId, action), {
      method: mutationMethod(action),
      headers: { accept: "application/json" },
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch {
    return {
      ok: false,
      failure: { kind: "network" },
      classification: "other",
    };
  }

  const body = await readJson(response);
  if (!response.ok) return httpResult(decodeSessionHttpFailure(response.status, body));

  const value = decodeSessionMutationSuccess(body, sessionId, action);
  return value === undefined ? malformedResult() : { ok: true, value };
};
