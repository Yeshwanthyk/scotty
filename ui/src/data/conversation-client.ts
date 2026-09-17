import type { PiConsoleImage } from "../../../protocol/pi-console";
import {
  decodeCanonicalConversationSnapshotSync,
  type CanonicalConversationQueueItem,
  type CanonicalConversationSnapshot,
  type CanonicalConversationTransport,
} from "../../../protocol/conversation";

export type ConversationTransport = CanonicalConversationTransport;
export type ConversationSnapshot = CanonicalConversationSnapshot;
export type ConversationQueueItem = CanonicalConversationQueueItem;

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

type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
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

const isSafeSequence = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const decodeConversationSnapshot = decodeCanonicalConversationSnapshotSync;

export const runtimeFailureMessage = (snapshot: ConversationSnapshot | undefined): string => {
  const failure = snapshot?.runtimeFailure;
  const reason = failure
    ? `Agent runtime stopped (${failure.code.replaceAll("_", " ")}).${failure.diagnostic ? ` ${failure.diagnostic}.` : ""}`
    : "Agent runtime stopped.";
  return `${reason} Review the last tool result and session diagnostics before starting a new session; pending commands may have run.`;
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
    readonly images?: readonly PiConsoleImage[];
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
          ...(options.images?.length ? { images: options.images } : {}),
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
