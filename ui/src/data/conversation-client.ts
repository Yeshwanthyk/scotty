import type { ConversationTurn, ToolActivity } from "../domain/conversation";

const MAX_TURNS = 100;
const MAX_TOOLS_PER_TURN = 32;
const MAX_TEXT_LENGTH = 16 * 1024;
const MAX_TOOL_VALUE_LENGTH = 1_200;
const MAX_ELAPSED_SECONDS = 7 * 24 * 60 * 60;
const utf8Encoder = new TextEncoder();

type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

interface ConversationTurnObject extends JsonObject {
  readonly id: string;
  readonly state: "completed" | "streaming" | "failed" | "aborted";
  readonly user: string;
  readonly assistant: string;
  readonly tools: ReadonlyArray<JsonValue>;
  readonly activitySummary?: string;
  readonly elapsedSeconds?: number;
}

export interface ConversationTransport {
  readonly epoch: string;
  readonly baseSequence: number;
  readonly sequence: number;
  readonly sessionRevision: number;
}

export interface ConversationSnapshot {
  readonly runtimeStopped?: boolean;
  readonly followUpAvailable?: boolean;
  readonly followUpBlocked?: boolean;
  readonly version: 1;
  readonly transport: ConversationTransport;
  readonly turns: ReadonlyArray<ConversationTurn>;
  readonly queue: {
    readonly steer: ReadonlyArray<ConversationQueueItem>;
    readonly followUp: ReadonlyArray<ConversationQueueItem>;
  };
  readonly truncated: { readonly turns: boolean; readonly values: boolean };
}

export interface ConversationQueueItem {
  readonly id: string;
  readonly text: string;
}

export type ConversationFailure =
  | { readonly kind: "network"; readonly message: string }
  | {
      readonly kind: "http";
      readonly status: number;
      readonly code?: string;
      readonly message: string;
      readonly hint?: string;
    }
  | { readonly kind: "malformed-response"; readonly message: string };

export type ConversationReadResult =
  | { readonly ok: true; readonly snapshot: ConversationSnapshot }
  | { readonly ok: false; readonly failure: ConversationFailure };

export const isConversationLifecycleMismatch = (failure: ConversationFailure): boolean =>
  failure.kind === "http" && failure.status === 409 && failure.code === "wrong_state";

export type ConversationSteerResult =
  | { readonly ok: true; readonly status: "accepted" }
  | {
      readonly ok: false;
      readonly failure:
        | ConversationFailure
        | { readonly kind: "stale" | "unavailable" | "ambiguous"; readonly message: string };
    };

export type ConversationInterruptResult =
  | { readonly ok: true; readonly status: "accepted" }
  | {
      readonly ok: false;
      readonly failure:
        | ConversationFailure
        | { readonly kind: "stale" | "unavailable" | "ambiguous"; readonly message: string };
    };

export interface ConversationRequestOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
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

const hasExactKeys = (value: JsonObject, keys: ReadonlyArray<string>): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
};

const isSafeSequence = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isBoundedText = (value: JsonValue | undefined, maximum = MAX_TEXT_LENGTH): value is string =>
  typeof value === "string" && utf8Encoder.encode(value).byteLength <= maximum;

const decodeTransport = (value: JsonValue | undefined): ConversationTransport | undefined => {
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, ["epoch", "baseSequence", "sequence", "sessionRevision"]) ||
    !isBoundedText(value.epoch, 256) ||
    value.epoch.length === 0 ||
    !isSafeSequence(value.baseSequence) ||
    !isSafeSequence(value.sequence) ||
    !isSafeSequence(value.sessionRevision) ||
    value.baseSequence > value.sequence
  )
    return undefined;
  return {
    epoch: value.epoch,
    baseSequence: value.baseSequence,
    sequence: value.sequence,
    sessionRevision: value.sessionRevision,
  };
};

const decodeTool = (value: JsonValue): ToolActivity | undefined => {
  if (
    !isJsonObject(value) ||
    !hasExactKeys(
      value,
      value.output === undefined
        ? ["id", "state", "label", "invocation"]
        : ["id", "state", "label", "invocation", "output"],
    ) ||
    !isBoundedText(value.id, 256) ||
    value.id.length === 0 ||
    (value.state !== "completed" &&
      value.state !== "running" &&
      value.state !== "failed" &&
      value.state !== "cancelled") ||
    !isBoundedText(value.label) ||
    !isBoundedText(value.invocation, MAX_TOOL_VALUE_LENGTH) ||
    (value.output !== undefined && !isBoundedText(value.output, MAX_TOOL_VALUE_LENGTH))
  )
    return undefined;
  return {
    id: value.id,
    state: value.state,
    label: value.label,
    invocation: value.invocation,
    ...(value.output === undefined ? {} : { output: value.output }),
  };
};

const expectedTurnKeys = (value: JsonObject): ReadonlyArray<string> => [
  "id",
  "state",
  "user",
  "assistant",
  "tools",
  ...(value.activitySummary === undefined ? [] : ["activitySummary"]),
  ...(value.elapsedSeconds === undefined ? [] : ["elapsedSeconds"]),
];

const validElapsedSeconds = (value: JsonValue | undefined): boolean =>
  value === undefined ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_ELAPSED_SECONDS);

const validTurnShape = (value: JsonObject): value is ConversationTurnObject =>
  hasExactKeys(value, expectedTurnKeys(value)) &&
  isBoundedText(value.id, 256) &&
  value.id.length > 0 &&
  (value.state === "completed" ||
    value.state === "streaming" ||
    value.state === "failed" ||
    value.state === "aborted") &&
  isBoundedText(value.user) &&
  isBoundedText(value.assistant) &&
  (value.activitySummary === undefined || isBoundedText(value.activitySummary)) &&
  validElapsedSeconds(value.elapsedSeconds) &&
  Array.isArray(value.tools) &&
  value.tools.length <= MAX_TOOLS_PER_TURN;

const decodeTurn = (value: JsonValue): ConversationTurn | undefined => {
  if (!isJsonObject(value) || !validTurnShape(value) || !Array.isArray(value.tools))
    return undefined;
  const tools = value.tools.map(decodeTool);
  if (tools.some((tool) => tool === undefined)) return undefined;
  return {
    id: value.id,
    state: value.state,
    user: value.user,
    assistant: value.assistant,
    tools: tools.filter((tool): tool is ToolActivity => tool !== undefined),
    ...(value.activitySummary === undefined ? {} : { activitySummary: value.activitySummary }),
    ...(value.elapsedSeconds === undefined ? {} : { elapsedSeconds: value.elapsedSeconds }),
  };
};

const decodeQueueItem = (value: JsonValue): ConversationQueueItem | undefined => {
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, ["id", "text"]) ||
    !isBoundedText(value.id, 256) ||
    value.id.length === 0 ||
    !isBoundedText(value.text)
  )
    return undefined;
  return { id: value.id, text: value.text };
};

const hasConversationSnapshotKeys = (value: JsonObject): boolean =>
  hasExactKeys(value, [
    "version",
    "transport",
    "turns",
    "queue",
    "truncated",
    ...(value.runtimeStopped === undefined ? [] : ["runtimeStopped"]),
    ...(value.followUpAvailable === undefined ? [] : ["followUpAvailable"]),
    ...(value.followUpBlocked === undefined ? [] : ["followUpBlocked"]),
  ]) &&
  (value.runtimeStopped === undefined || typeof value.runtimeStopped === "boolean") &&
  (value.followUpAvailable === undefined || typeof value.followUpAvailable === "boolean") &&
  (value.followUpBlocked === undefined || typeof value.followUpBlocked === "boolean");

const decodeFollowUpCapabilities = (value: JsonObject) => ({
  ...(typeof value.runtimeStopped === "boolean" ? { runtimeStopped: value.runtimeStopped } : {}),
  ...(typeof value.followUpAvailable === "boolean"
    ? { followUpAvailable: value.followUpAvailable }
    : {}),
  ...(typeof value.followUpBlocked === "boolean" ? { followUpBlocked: value.followUpBlocked } : {}),
});

export const decodeConversationSnapshot = (value: unknown): ConversationSnapshot | undefined => {
  if (
    !isJsonObject(value) ||
    !hasConversationSnapshotKeys(value) ||
    value.version !== 1 ||
    !Array.isArray(value.turns) ||
    value.turns.length > MAX_TURNS ||
    !isJsonObject(value.queue) ||
    !hasExactKeys(value.queue, ["steer", "followUp"]) ||
    !Array.isArray(value.queue.steer) ||
    !Array.isArray(value.queue.followUp) ||
    value.queue.steer.length > 100 ||
    value.queue.followUp.length > 100 ||
    !isJsonObject(value.truncated) ||
    !hasExactKeys(value.truncated, ["turns", "values"]) ||
    typeof value.truncated.turns !== "boolean" ||
    typeof value.truncated.values !== "boolean"
  )
    return undefined;
  const transport = decodeTransport(value.transport);
  const turns = value.turns.map(decodeTurn);
  const steer = value.queue.steer.map(decodeQueueItem);
  const followUp = value.queue.followUp.map(decodeQueueItem);
  if (
    transport === undefined ||
    turns.some((turn) => turn === undefined) ||
    steer.some((item) => item === undefined) ||
    followUp.some((item) => item === undefined)
  )
    return undefined;
  return {
    version: 1,
    transport,
    ...decodeFollowUpCapabilities(value),
    turns: turns.filter((turn): turn is ConversationTurn => turn !== undefined),
    queue: {
      steer: steer.filter((item): item is ConversationQueueItem => item !== undefined),
      followUp: followUp.filter((item): item is ConversationQueueItem => item !== undefined),
    },
    truncated: { turns: value.truncated.turns, values: value.truncated.values },
  };
};

const readJson = async (response: Response): Promise<unknown> =>
  response.json().catch(() => undefined);

const decodeHttpFailureBody = (response: Response, body: unknown): ConversationFailure => {
  if (isJsonObject(body) && isJsonObject(body.error))
    return {
      kind: "http",
      status: response.status,
      ...(typeof body.error.code === "string" ? { code: body.error.code } : {}),
      message:
        typeof body.error.message === "string"
          ? body.error.message
          : "The conversation is unavailable.",
      ...(typeof body.error.hint === "string" ? { hint: body.error.hint } : {}),
    };
  return { kind: "http", status: response.status, message: "The conversation is unavailable." };
};

const decodeHttpFailure = async (response: Response): Promise<ConversationFailure> =>
  decodeHttpFailureBody(response, await readJson(response));

export const readConversation = async (
  sessionId: string,
  options: ConversationRequestOptions = {},
): Promise<ConversationReadResult> => {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      `/api/sessions/${encodeURIComponent(sessionId)}/conversation`,
      {
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: options.signal,
      },
    );
  } catch {
    return { ok: false, failure: { kind: "network", message: "Scotty could not be reached." } };
  }
  if (!response.ok) return { ok: false, failure: await decodeHttpFailure(response) };
  const snapshot = decodeConversationSnapshot(await readJson(response));
  return snapshot === undefined
    ? {
        ok: false,
        failure: {
          kind: "malformed-response",
          message: "Scotty returned an unreadable conversation snapshot.",
        },
      }
    : { ok: true, snapshot };
};

const outcomeMessage = (status: "stale" | "unavailable" | "ambiguous"): string =>
  status === "stale"
    ? "The session changed before delivery. Review the latest conversation and send again."
    : status === "ambiguous"
      ? "Delivery could not be confirmed. Check the conversation before sending again."
      : "The session cannot accept that message right now.";

const decodeSteerOutcome = (
  body: unknown,
  sessionId: string,
): ConversationSteerResult | undefined => {
  if (
    !isJsonObject(body) ||
    body.id !== sessionId ||
    (body.status !== "stale" && body.status !== "unavailable" && body.status !== "ambiguous")
  )
    return undefined;
  return {
    ok: false,
    failure: { kind: body.status, message: outcomeMessage(body.status) },
  };
};

export const steerConversation = async (
  sessionId: string,
  message: string,
  options: ConversationRequestOptions & {
    readonly deliverAs?: "followUp";
    readonly clientUserMessageId?: string;
  } = {},
): Promise<ConversationSteerResult> => {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      `/api/sessions/${encodeURIComponent(sessionId)}/steer`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(options.clientUserMessageId === undefined
            ? {}
            : { "idempotency-key": options.clientUserMessageId }),
        },
        body: JSON.stringify({
          message,
          ...(options.deliverAs === undefined ? {} : { deliverAs: options.deliverAs }),
        }),
        signal: options.signal,
      },
    );
  } catch {
    return { ok: false, failure: { kind: "network", message: "Scotty could not be reached." } };
  }
  if (!response.ok) {
    const body = await readJson(response);
    return (
      decodeSteerOutcome(body, sessionId) ?? {
        ok: false,
        failure: decodeHttpFailureBody(response, body),
      }
    );
  }
  const body = await readJson(response);
  if (!isJsonObject(body) || body.id !== sessionId || typeof body.status !== "string")
    return {
      ok: false,
      failure: {
        kind: "malformed-response",
        message: "Scotty returned an unreadable delivery result.",
      },
    };
  if (body.status === "accepted") return { ok: true, status: "accepted" };
  const outcome = decodeSteerOutcome(body, sessionId);
  if (outcome !== undefined) return outcome;
  return {
    ok: false,
    failure: {
      kind: "malformed-response",
      message: "Scotty returned an unknown delivery result.",
    },
  };
};

const interruptUnconfirmedMessage =
  "The stop request could not be confirmed. Inspect the latest conversation before retrying.";

const interruptOutcomeMessage = (status: "stale" | "unavailable" | "ambiguous"): string =>
  status === "stale"
    ? "The session changed before the turn could be stopped. Review the latest conversation."
    : status === "ambiguous"
      ? interruptUnconfirmedMessage
      : "That turn has already finished or cannot be stopped.";

const decodeInterruptOutcome = (
  body: unknown,
  sessionId: string,
): ConversationInterruptResult | undefined => {
  if (
    !isJsonObject(body) ||
    body.id !== sessionId ||
    (body.status !== "stale" && body.status !== "unavailable" && body.status !== "ambiguous")
  )
    return undefined;
  return {
    ok: false,
    failure: { kind: body.status, message: interruptOutcomeMessage(body.status) },
  };
};

export const interruptConversation = async (
  sessionId: string,
  turnId: string | undefined,
  sessionRevision: number,
  options: ConversationRequestOptions = {},
): Promise<ConversationInterruptResult> => {
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          ...(turnId === undefined ? {} : { turnId }),
          sessionRevision,
        }),
        signal: options.signal,
      },
    );
  } catch {
    return { ok: false, failure: { kind: "ambiguous", message: interruptUnconfirmedMessage } };
  }
  const body = await readJson(response);
  if (!response.ok)
    return (
      decodeInterruptOutcome(body, sessionId) ?? {
        ok: false,
        failure: decodeHttpFailureBody(response, body),
      }
    );
  if (
    !isJsonObject(body) ||
    body.id !== sessionId ||
    body.status !== "accepted" ||
    !isSafeSequence(body.sessionRevision)
  )
    return {
      ok: false,
      failure: {
        kind: "ambiguous",
        message: interruptUnconfirmedMessage,
      },
    };
  return { ok: true, status: "accepted" };
};
