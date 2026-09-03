export const DEFAULT_HARD_CAP_SECONDS = 4 * 60 * 60;
export const MIN_HARD_CAP_SECONDS = 60;
export const MAX_HARD_CAP_SECONDS = 24 * 60 * 60;

const SESSION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,31}$/u;
const REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/u;
const CREATE_RESPONSE_KEYS = ["id", "title", "url", "branch", "provider", "status"] as const;
const CREATE_ERROR_CODES = [
  "bad_request",
  "auth",
  "not_found",
  "wrong_state",
  "conflict",
  "upstream",
  "internal",
] as const;
const SESSION_STATUSES = ["booting", "warm", "sleeping", "failed", "gone"] as const;

type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type CreateSessionStatus = (typeof SESSION_STATUSES)[number];
export type CreateSessionErrorCode = (typeof CREATE_ERROR_CODES)[number];

export interface CreateSessionDraft {
  readonly title: string;
  readonly repository: string;
  readonly prompt: string;
  readonly hardCapSeconds?: string;
}

export interface CreateSessionPayload {
  readonly title: string;
  readonly repo: string;
  readonly prompt: string;
  readonly provider: "cloudflare";
  readonly hardCapSeconds?: number;
}

export type CreateSessionField = "title" | "repository" | "prompt" | "hardCapSeconds";

export type CreateSessionDraftResult =
  | { readonly ok: true; readonly payload: CreateSessionPayload }
  | {
      readonly ok: false;
      readonly field: CreateSessionField;
      readonly message: string;
    };

export interface CreateSessionSuccess {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly path: string;
  readonly branch: string;
  readonly provider: "cloudflare";
  readonly status: CreateSessionStatus;
}

export type CreateSessionFailure =
  | { readonly kind: "network"; readonly message: string }
  | {
      readonly kind: "http";
      readonly status: number;
      readonly code?: CreateSessionErrorCode;
      readonly message: string;
      readonly hint?: string;
    }
  | { readonly kind: "malformed-response"; readonly message: string };

export type CreateSessionResult =
  | { readonly ok: true; readonly session: CreateSessionSuccess }
  | { readonly ok: false; readonly failure: CreateSessionFailure };

export interface CreateSessionOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly idempotencyKey?: string;
  readonly origin?: string;
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

const hasExactKeys = (value: JsonObject, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
};

const isRepository = (value: string): boolean => {
  const segments = value.split("/");
  return (
    segments.length === 2 &&
    segments.every(
      (segment) => REPOSITORY_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..",
    )
  );
};

const isCreateSessionStatus = (value: unknown): value is CreateSessionStatus =>
  typeof value === "string" && SESSION_STATUSES.some((status) => status === value);

const isCreateSessionErrorCode = (value: unknown): value is CreateSessionErrorCode =>
  typeof value === "string" && CREATE_ERROR_CODES.some((code) => code === value);

const originFor = (origin: string): string | undefined => {
  try {
    return new URL(origin).origin;
  } catch {
    return undefined;
  }
};

const browserOrigin = (): string | undefined =>
  typeof window === "undefined" ? undefined : window.location.origin;

const pathFor = (value: unknown, id: string, origin: string): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value, origin);
    const path = `/s/${encodeURIComponent(id)}`;
    if (
      url.origin !== origin ||
      url.pathname !== path ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      url.username.length > 0 ||
      url.password.length > 0
    )
      return undefined;
    return path;
  } catch {
    return undefined;
  }
};

/** Build the exact body accepted by POST /api/sessions from the visible form draft. */
export const buildCreateSessionPayload = (draft: CreateSessionDraft): CreateSessionDraftResult => {
  const title = draft.title.trim();
  if (title.length === 0) return { ok: false, field: "title", message: "Enter a session title." };
  if (title.length > 120)
    return { ok: false, field: "title", message: "Use 120 characters or fewer for the title." };

  const repo = draft.repository.trim();
  if (!isRepository(repo))
    return {
      ok: false,
      field: "repository",
      message: "Enter a repository as owner/name.",
    };
  if (repo.length > 200)
    return {
      ok: false,
      field: "repository",
      message: "Use 200 characters or fewer for the repository.",
    };

  const prompt = draft.prompt.replace(/\r\n?/gu, "\n").trim();
  if (prompt.length === 0)
    return { ok: false, field: "prompt", message: "Describe what Codex should do." };
  if (prompt.length > 64_000)
    return {
      ok: false,
      field: "prompt",
      message: "Use 64,000 characters or fewer for the prompt.",
    };

  const rawCap = draft.hardCapSeconds?.trim() ?? "";
  if (rawCap.length === 0)
    return { ok: true, payload: { title, repo, prompt, provider: "cloudflare" } };
  const hardCapSeconds = Number(rawCap);
  if (
    !Number.isInteger(hardCapSeconds) ||
    hardCapSeconds < MIN_HARD_CAP_SECONDS ||
    hardCapSeconds > MAX_HARD_CAP_SECONDS
  )
    return {
      ok: false,
      field: "hardCapSeconds",
      message: `Choose a limit between ${MIN_HARD_CAP_SECONDS} and ${MAX_HARD_CAP_SECONDS} seconds.`,
    };
  return {
    ok: true,
    payload: { title, repo, prompt, provider: "cloudflare", hardCapSeconds },
  };
};

/** Decode the public create response and reject any response that can redirect elsewhere. */
export const decodeCreateSessionResponse = (
  value: unknown,
  origin: string,
): CreateSessionSuccess | undefined => {
  if (!isJsonObject(value) || !hasExactKeys(value, CREATE_RESPONSE_KEYS)) return undefined;
  const id = value.id;
  const title = value.title;
  const responseUrl = value.url;
  const branch = value.branch;
  const responseOrigin = originFor(origin);
  if (
    typeof id !== "string" ||
    !SESSION_ID_PATTERN.test(id) ||
    typeof title !== "string" ||
    title.trim().length === 0 ||
    title.length > 120 ||
    typeof branch !== "string" ||
    branch.trim().length === 0 ||
    typeof responseUrl !== "string" ||
    value.provider !== "cloudflare" ||
    !isCreateSessionStatus(value.status) ||
    responseOrigin === undefined
  )
    return undefined;
  const path = pathFor(responseUrl, id, responseOrigin);
  if (path === undefined) return undefined;
  return {
    id,
    title,
    url: responseUrl,
    path,
    branch,
    provider: "cloudflare",
    status: value.status,
  };
};

const readJson = async (response: Response): Promise<unknown> =>
  response.json().catch(() => undefined);

const failureFromResponse = async (
  response: Response,
): Promise<Extract<CreateSessionFailure, { readonly kind: "http" }>> => {
  const body = await readJson(response);
  if (isJsonObject(body) && isJsonObject(body.error)) {
    const message =
      typeof body.error.message === "string" ? body.error.message : "Session creation failed.";
    return {
      kind: "http",
      status: response.status,
      message,
      ...(isCreateSessionErrorCode(body.error.code) ? { code: body.error.code } : {}),
      ...(typeof body.error.hint === "string" ? { hint: body.error.hint } : {}),
    };
  }
  return { kind: "http", status: response.status, message: "Session creation failed." };
};

export const createSessionIdempotencyKey = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `scotty-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const createSession = async (
  payload: CreateSessionPayload,
  options: CreateSessionOptions = {},
): Promise<CreateSessionResult> => {
  const fetcher = options.fetch ?? globalThis.fetch;
  const key = options.idempotencyKey ?? createSessionIdempotencyKey();
  let response: Response;
  try {
    response = await fetcher("/api/sessions", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch {
    return { ok: false, failure: { kind: "network", message: "Scotty could not be reached." } };
  }

  if (!response.ok) return { ok: false, failure: await failureFromResponse(response) };
  const body = await readJson(response);
  const origin = originFor(options.origin ?? browserOrigin() ?? "");
  const session = origin === undefined ? undefined : decodeCreateSessionResponse(body, origin);
  return session === undefined
    ? {
        ok: false,
        failure: {
          kind: "malformed-response",
          message: "Scotty returned an unexpected session response.",
        },
      }
    : { ok: true, session };
};
