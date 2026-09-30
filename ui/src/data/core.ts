import { Option, Schema } from "effect";
import {
  decodeCanonicalConversationSnapshotSync,
  type CanonicalConversationSnapshot,
} from "../protocol/session/conversation";

const Session = Schema.Struct({
  identity: Schema.Struct({ id: Schema.String }),
  authority: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("stable"),
      lifecycle: Schema.String,
      // Why a stopped session stopped, and how a failed one recovers; older payloads omit them.
      stop: Schema.optional(
        Schema.NullOr(
          Schema.Struct({ reason: Schema.String, exitCode: Schema.optional(Schema.Number) }),
        ),
      ),
      failure: Schema.optional(
        Schema.NullOr(Schema.Struct({ code: Schema.String, recovery: Schema.String })),
      ),
    }),
    Schema.Struct({ kind: Schema.Literal("transitioning"), phase: Schema.String }),
  ]),
  display: Schema.Struct({
    title: Schema.String,
    repository: Schema.String,
    branch: Schema.String,
    agentKind: Schema.String,
    createdAt: Schema.String,
    activeAt: Schema.String,
  }),
  progress: Schema.Struct({
    working: Schema.Boolean,
    turns: Schema.Number,
    // When an idle running session sleeps, unless it is used first.
    sleepsAt: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
const List = Schema.Struct({ version: Schema.Literal(1), sessions: Schema.Array(Session) });
const Created = Schema.Struct({ id: Schema.String });
const Write = Schema.Struct({ status: Schema.String });
const ErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });
const decodeList = Schema.decodeUnknownOption(List);
const decodeCreated = Schema.decodeUnknownOption(Created);
const decodeWrite = Schema.decodeUnknownOption(Write);
const decodeError = Schema.decodeUnknownOption(ErrorBody);
export type Session = typeof Session.Type;

// Live frames. A session socket sends the whole view after changes; `seq` orders them.
const SessionFrame = Schema.Struct({
  kind: Schema.Literal("snapshot"),
  seq: Schema.Number,
  session: Session,
  conversation: Schema.Unknown,
});
const ListFrame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session"), session: Session }),
  Schema.Struct({ kind: Schema.Literal("removed"), id: Schema.String }),
]);
export type ListFrame = typeof ListFrame.Type;
export const decodeListFrame = (value: unknown): ListFrame | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ListFrame)(value));
export function decodeSessionFrame(
  value: unknown,
): { seq: number; session: Session; conversation: Conversation } | undefined {
  const frame = Option.getOrUndefined(Schema.decodeUnknownOption(SessionFrame)(value));
  const conversation =
    frame === undefined ? undefined : decodeCanonicalConversationSnapshotSync(frame.conversation);
  return frame === undefined || conversation === undefined
    ? undefined
    : { seq: frame.seq, session: frame.session, conversation };
}
export type Conversation = CanonicalConversationSnapshot;

export const message = (failure: unknown, fallback: string): string =>
  failure instanceof Error ? failure.message : fallback;

// A failed request keeps its status, so a caller can tell "not found" from "not reachable".
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// A Blob body (a skill zip) goes as it is; any other body is JSON.
export async function request(
  path: string,
  body?: object,
  signal?: AbortSignal,
  key?: string,
  method?: "PUT" | "PATCH" | "DELETE",
): Promise<unknown> {
  const raw = body instanceof Blob;
  const response = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      accept: "application/json",
      ...(body === undefined
        ? {}
        : { "content-type": raw ? "application/zip" : "application/json" }),
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  const value: unknown = await response.json().catch(() => {
    throw new Error("Unexpected response (" + response.status + "); try reloading");
  });
  if (!response.ok) {
    const error = Option.getOrUndefined(decodeError(value));
    throw new RequestError(
      error?.error.message ?? "Request failed (" + response.status + ")",
      response.status,
    );
  }
  return value;
}
export async function sessions(signal?: AbortSignal): Promise<ReadonlyArray<Session>> {
  const result = Option.getOrUndefined(
    decodeList(await request("/api/sessions", undefined, signal)),
  );
  if (result === undefined) throw new Error("Unreadable session list");
  return result.sessions;
}
export async function create(
  title: string,
  repo: string,
  prompt: string,
  key: string,
  agent: "codex" | "claude" = "codex",
): Promise<string> {
  const body = { title, repo, prompt, agent, provider: "cloudflare" };
  const result = Option.getOrUndefined(
    decodeCreated(await request("/api/sessions", body, undefined, key)),
  );
  if (result === undefined) throw new Error("Unreadable create response");
  return result.id;
}
export async function write(
  id: string,
  action: "steer" | "interrupt",
  turn: string,
  req: string,
  text?: string,
): Promise<string> {
  const result = Option.getOrUndefined(
    decodeWrite(
      await request(
        "/api/sessions/" + encodeURIComponent(id) + "/" + action,
        action === "steer" ? { text, turn, req } : { turn, req },
      ),
    ),
  );
  if (result === undefined) throw new Error("Unreadable write response");
  return result.status;
}

const sessionPath = (id: string) => "/api/sessions/" + encodeURIComponent(id);

// The session, or undefined when the server has no such session.
const Detail = Schema.Struct({ version: Schema.Literal(1), session: Session });
export async function session(id: string): Promise<Session | undefined> {
  let value: unknown;
  try {
    value = await request(sessionPath(id));
  } catch (failure) {
    if (failure instanceof RequestError && failure.status === 404) return undefined;
    throw failure;
  }
  const result = Option.getOrUndefined(Schema.decodeUnknownOption(Detail)(value));
  if (result === undefined) throw new Error("Unreadable session");
  return result.session;
}

// Stop and resume answer with the session; the live socket shows it, so the body is not read.
export async function lifecycle(id: string, action: "stop" | "resume"): Promise<void> {
  await request(sessionPath(id) + "/" + action, {});
}

export async function remove(id: string): Promise<void> {
  await request(sessionPath(id), undefined, undefined, undefined, "DELETE");
}

const Hatch = Schema.Struct({ url: Schema.String });
export async function hatch(id: string, port: number): Promise<string> {
  const result = Option.getOrUndefined(
    Schema.decodeUnknownOption(Hatch)(await request(sessionPath(id) + "/hatch/" + port)),
  );
  if (result === undefined) throw new Error("Unreadable preview response");
  return result.url;
}
