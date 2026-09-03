export const SESSION_WIRE_VERSION = 1 as const;

export type SessionLifecycle = "warm" | "sleeping" | "failed" | "gone";
export type SessionAction = "checkpoint" | "sleep" | "resume" | "work" | "vaporize";
export type SessionTransitionAction =
  | "create"
  | "checkpoint"
  | "sleep"
  | "resume"
  | "work"
  | "evidence"
  | "hatch"
  | "down"
  | "vaporize";

export type SessionAuthority =
  | {
      readonly kind: "stable";
      readonly lifecycle: SessionLifecycle;
      readonly failure: { readonly code: string; readonly recoverable: boolean } | null;
    }
  | {
      readonly kind: "transitioning";
      readonly action: SessionTransitionAction;
      readonly phase: string;
      readonly mode: "executing" | "reconciling";
      readonly startedAt: string;
    };

export interface SessionCapabilities {
  readonly checkpoint: boolean;
  readonly sleep: boolean;
  readonly resume: boolean;
  readonly work: boolean;
  readonly vaporize: boolean;
}

export interface SessionModel {
  readonly id: string;
  readonly authority: SessionAuthority;
  readonly runtime: {
    readonly provider: "cloudflare" | "runner";
    readonly readiness: "unchecked" | "not-applicable";
  };
  readonly capabilities: SessionCapabilities;
  readonly display: {
    readonly title: string;
    readonly repository: string;
    readonly branch: string | null;
    readonly defaultBranch: string | null;
  };
  readonly times: { readonly capRemainingSeconds: number };
  readonly source: "authority" | "projection" | "fixture";
}

export interface SessionHttpFailure {
  readonly kind: "http";
  readonly status: number;
  readonly code?: string;
  readonly reason?: string;
  readonly message: string;
  readonly hint?: string;
}

export type SessionReadFailure =
  | SessionHttpFailure
  | { readonly kind: "malformed-response" }
  | { readonly kind: "network" };

export type SessionFailureClassification =
  | "conflict"
  | "wrong-state"
  | "non-warm"
  | "malformed"
  | "other";

export type SessionReadResult =
  | { readonly ok: true; readonly session: SessionModel }
  | {
      readonly ok: false;
      readonly failure: SessionReadFailure;
      readonly classification: SessionFailureClassification;
    };

export type ConsoleEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: "lifecycle-operation" | "not-warm" | "runtime-unavailable";
    };

export interface ReadSessionOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly fixture?: SessionModel;
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

const isLifecycle = (value: JsonValue | undefined): value is SessionLifecycle =>
  value === "warm" || value === "sleeping" || value === "failed" || value === "gone";

const isTransitionAction = (value: JsonValue | undefined): value is SessionTransitionAction =>
  value === "create" ||
  value === "checkpoint" ||
  value === "sleep" ||
  value === "resume" ||
  value === "work" ||
  value === "evidence" ||
  value === "hatch" ||
  value === "down" ||
  value === "vaporize";

const failureFrom = (
  value: JsonValue | undefined,
): { readonly code: string; readonly recoverable: boolean } | null | undefined => {
  if (value === null) return null;
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["code", "recoverable"]) ||
    typeof value.code !== "string" ||
    typeof value.recoverable !== "boolean"
  )
    return undefined;
  return { code: value.code, recoverable: value.recoverable };
};

const stableAuthority = (value: JsonObject): SessionAuthority | undefined => {
  const failure = failureFrom(value.failure);
  if (
    !hasOnlyKeys(value, ["kind", "lifecycle", "failure"]) ||
    value.kind !== "stable" ||
    !isLifecycle(value.lifecycle) ||
    failure === undefined
  )
    return undefined;
  return {
    kind: "stable",
    lifecycle: value.lifecycle,
    failure,
  };
};

const transitioningAuthority = (value: JsonObject): SessionAuthority | undefined => {
  if (
    !hasOnlyKeys(value, ["kind", "action", "phase", "mode", "startedAt"]) ||
    value.kind !== "transitioning" ||
    !isTransitionAction(value.action) ||
    typeof value.phase !== "string" ||
    value.phase.length === 0 ||
    (value.mode !== "executing" && value.mode !== "reconciling") ||
    typeof value.startedAt !== "string"
  )
    return undefined;
  return {
    kind: "transitioning",
    action: value.action,
    phase: value.phase,
    mode: value.mode,
    startedAt: value.startedAt,
  };
};

const authorityFrom = (value: JsonValue | undefined): SessionAuthority | undefined => {
  if (!isJsonObject(value)) return undefined;
  return value.kind === "stable" ? stableAuthority(value) : transitioningAuthority(value);
};

const identityFrom = (value: JsonValue | undefined): string | undefined =>
  isJsonObject(value) && hasOnlyKeys(value, ["id"]) && typeof value.id === "string"
    ? value.id
    : undefined;

const runtimeFrom = (value: JsonValue | undefined): SessionModel["runtime"] | undefined => {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["provider", "readiness"]) ||
    (value.provider !== "cloudflare" && value.provider !== "runner") ||
    (value.readiness !== "unchecked" && value.readiness !== "not-applicable")
  )
    return undefined;
  return { provider: value.provider, readiness: value.readiness };
};

const sameCapabilities = (actual: SessionCapabilities, expected: SessionCapabilities): boolean =>
  actual.checkpoint === expected.checkpoint &&
  actual.sleep === expected.sleep &&
  actual.resume === expected.resume &&
  actual.work === expected.work &&
  actual.vaporize === expected.vaporize;

const validSessionContract = (session: Omit<SessionModel, "source">): boolean => {
  if (
    !(session.authority.kind === "stable" && session.authority.lifecycle === "gone") &&
    session.display.branch === null
  )
    return false;
  if (session.authority.kind === "transitioning")
    return (
      session.authority.startedAt.length > 0 &&
      session.runtime.readiness === "not-applicable" &&
      sameCapabilities(session.capabilities, noCapabilities)
    );

  const { failure, lifecycle } = session.authority;
  if ((lifecycle === "failed") !== (failure !== null)) return false;

  const expected =
    lifecycle === "warm"
      ? { checkpoint: true, sleep: true, resume: false, work: true, vaporize: true }
      : lifecycle === "sleeping"
        ? { ...noCapabilities, resume: true, vaporize: true }
        : lifecycle === "failed"
          ? { ...noCapabilities, resume: failure?.recoverable === true, vaporize: true }
          : noCapabilities;
  const expectedReadiness =
    session.runtime.provider === "cloudflare" && lifecycle === "warm"
      ? "unchecked"
      : "not-applicable";
  return (
    session.runtime.readiness === expectedReadiness &&
    sameCapabilities(session.capabilities, expected)
  );
};

const capabilitiesFrom = (value: JsonValue | undefined): SessionCapabilities | undefined => {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["checkpoint", "sleep", "resume", "work", "vaporize"]) ||
    typeof value.checkpoint !== "boolean" ||
    typeof value.sleep !== "boolean" ||
    typeof value.resume !== "boolean" ||
    typeof value.work !== "boolean" ||
    typeof value.vaporize !== "boolean"
  )
    return undefined;
  return {
    checkpoint: value.checkpoint,
    sleep: value.sleep,
    resume: value.resume,
    work: value.work,
    vaporize: value.vaporize,
  };
};

const displayFrom = (value: JsonValue | undefined): SessionModel["display"] | undefined => {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["title", "repository", "branch", "defaultBranch"]) ||
    typeof value.title !== "string" ||
    typeof value.repository !== "string" ||
    !(value.branch === null || typeof value.branch === "string") ||
    !(value.defaultBranch === null || typeof value.defaultBranch === "string")
  )
    return undefined;
  return {
    title: value.title,
    repository: value.repository,
    branch: value.branch,
    defaultBranch: value.defaultBranch,
  };
};

const timesFrom = (value: JsonValue | undefined): SessionModel["times"] | undefined => {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["capRemainingSeconds"]) ||
    typeof value.capRemainingSeconds !== "number" ||
    !Number.isFinite(value.capRemainingSeconds)
  )
    return undefined;
  return { capRemainingSeconds: value.capRemainingSeconds };
};

export const decodeSessionWireValue = (
  value: unknown,
  source: "authority" | "projection",
): SessionModel | undefined => {
  if (!isJsonObject(value)) return undefined;
  const wire = value;
  if (!hasOnlyKeys(wire, ["identity", "authority", "runtime", "capabilities", "display", "times"]))
    return undefined;
  const id = identityFrom(wire.identity);
  const authority = authorityFrom(wire.authority);
  const runtime = runtimeFrom(wire.runtime);
  const capabilities = capabilitiesFrom(wire.capabilities);
  const display = displayFrom(wire.display);
  const times = timesFrom(wire.times);
  if (
    id === undefined ||
    authority === undefined ||
    runtime === undefined ||
    capabilities === undefined ||
    display === undefined ||
    times === undefined
  )
    return undefined;
  const session = {
    id,
    authority,
    runtime,
    capabilities,
    display,
    times,
  };
  return validSessionContract(session) ? { ...session, source } : undefined;
};

const normalizeWireV1 = (value: unknown): SessionModel | undefined => {
  if (
    !isJsonObject(value) ||
    !hasOnlyKeys(value, ["version", "session"]) ||
    value.version !== SESSION_WIRE_VERSION ||
    !isJsonObject(value.session)
  )
    return undefined;
  return decodeSessionWireValue(value.session, "authority");
};

const noCapabilities: SessionCapabilities = {
  checkpoint: false,
  sleep: false,
  resume: false,
  work: false,
  vaporize: false,
};

const fixture = (
  id: string,
  title: string,
  authority: SessionAuthority,
  capabilities: SessionCapabilities,
  tombstone = false,
): SessionModel => ({
  id,
  authority,
  runtime: {
    provider: "cloudflare",
    readiness:
      authority.kind === "stable" && authority.lifecycle === "warm"
        ? "unchecked"
        : "not-applicable",
  },
  capabilities,
  display: {
    title,
    repository: "personal/scotty",
    branch: tombstone ? null : `feat/${id}`,
    defaultBranch: tombstone ? null : "main",
  },
  times: { capRemainingSeconds: 9_600 },
  source: "fixture",
});

const demoFixtures = new Map<string, SessionModel>([
  [
    "warm-demo-01",
    fixture(
      "warm-demo-01",
      "TanStack UI rebuild",
      { kind: "stable", lifecycle: "warm", failure: null },
      { checkpoint: true, sleep: true, resume: false, work: true, vaporize: true },
    ),
  ],
  [
    "sleep-demo-01",
    fixture(
      "sleep-demo-01",
      "Lifecycle contract audit",
      { kind: "stable", lifecycle: "sleeping", failure: null },
      { ...noCapabilities, resume: true, vaporize: true },
    ),
  ],
  [
    "resume-demo-01",
    fixture(
      "resume-demo-01",
      "Evidence reliability",
      {
        kind: "transitioning",
        action: "resume",
        phase: "Restoring backup",
        mode: "executing",
        startedAt: "2026-09-03T15:48:00.000Z",
      },
      noCapabilities,
    ),
  ],
  [
    "failed-demo-1",
    fixture(
      "failed-demo-1",
      "Provider boundary",
      {
        kind: "stable",
        lifecycle: "failed",
        failure: { code: "runtime_missing", recoverable: true },
      },
      { ...noCapabilities, resume: true, vaporize: true },
    ),
  ],
  [
    "gone-demo-001",
    fixture(
      "gone-demo-001",
      "Navigation repro",
      { kind: "stable", lifecycle: "gone", failure: null },
      noCapabilities,
      true,
    ),
  ],
]);

export const fixtureSessionForId = (sessionId: string): SessionModel | undefined =>
  demoFixtures.get(sessionId);

export const classifySessionHttpFailure = (
  failure: SessionHttpFailure,
): SessionFailureClassification => {
  if (failure.code === "conflict") return "conflict";
  if (failure.code === "wrong_state") return "wrong-state";
  if (
    failure.reason === "session_not_warm" ||
    failure.reason === "session_operation_active" ||
    failure.reason === "pi_quiescing"
  )
    return "non-warm";
  if (failure.status === 409) return "conflict";
  return "other";
};

export const decodeSessionHttpFailure = (status: number, value: unknown): SessionHttpFailure => {
  if (isJsonObject(value) && isJsonObject(value.error))
    return {
      kind: "http",
      status,
      message:
        typeof value.error.message === "string" ? value.error.message : "Session request failed",
      ...(typeof value.error.code === "string" ? { code: value.error.code } : {}),
      ...(typeof value.error.hint === "string" ? { hint: value.error.hint } : {}),
    };
  if (isJsonObject(value) && typeof value.reason === "string")
    return {
      kind: "http",
      status,
      message: "Session request was not admitted",
      reason: value.reason,
    };
  return { kind: "http", status, message: "Session request failed" };
};

const readJson = async (response: Response): Promise<unknown> =>
  response.json().catch(() => undefined);

export const readAuthoritativeSession = async (
  sessionId: string,
  options: ReadSessionOptions = {},
): Promise<SessionReadResult> => {
  const local =
    options.fixtureFallback === true
      ? (options.fixture ?? fixtureSessionForId(sessionId))
      : undefined;
  if (local !== undefined) return { ok: true, session: local };

  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        signal: options.signal,
      },
    );
  } catch {
    return { ok: false, failure: { kind: "network" }, classification: "other" };
  }

  const body = await readJson(response);
  if (!response.ok) {
    const failure = decodeSessionHttpFailure(response.status, body);
    return { ok: false, failure, classification: classifySessionHttpFailure(failure) };
  }
  const session = normalizeWireV1(body);
  return session === undefined || session.id !== sessionId
    ? { ok: false, failure: { kind: "malformed-response" }, classification: "malformed" }
    : { ok: true, session };
};

export const refetchSessionAfterConsoleConflict = async (
  sessionId: string,
  response: Response,
  options: ReadSessionOptions = {},
): Promise<SessionReadResult | undefined> => {
  if (response.status !== 409) return undefined;
  const failure = decodeSessionHttpFailure(response.status, await readJson(response));
  if (classifySessionHttpFailure(failure) === "other") return undefined;
  return readAuthoritativeSession(sessionId, options);
};

export const decideConsoleEligibility = (session: SessionModel): ConsoleEligibility => {
  if (session.authority.kind === "transitioning")
    return { eligible: false, reason: "lifecycle-operation" };
  if (session.authority.lifecycle !== "warm") return { eligible: false, reason: "not-warm" };
  if (session.runtime.provider !== "cloudflare")
    return { eligible: false, reason: "runtime-unavailable" };
  return { eligible: true };
};

export const availableActions = (session: SessionModel): ReadonlyArray<SessionAction> =>
  (["checkpoint", "sleep", "resume", "work", "vaporize"] as const).filter(
    (action) => session.capabilities[action],
  );
