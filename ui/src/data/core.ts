import { Option, Schema } from "effect";
import {
  decodeCanonicalConversationSnapshotSync,
  type CanonicalConversationSnapshot,
} from "../protocol/session/conversation";

const Session = Schema.Struct({
  identity: Schema.Struct({ id: Schema.String }),
  authority: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("stable"), lifecycle: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("transitioning"), phase: Schema.String }),
  ]),
  display: Schema.Struct({
    title: Schema.String,
    repository: Schema.String,
    branch: Schema.String,
    prompt: Schema.String,
    agentKind: Schema.String,
    stoppedAt: Schema.NullOr(Schema.String),
    createdAt: Schema.String,
    activeAt: Schema.String,
    origin: Schema.NullOr(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("hook"),
          connection: Schema.String,
          delivery: Schema.String,
          key: Schema.optionalKey(Schema.String),
        }),
        Schema.Struct({ kind: Schema.Literal("api"), key: Schema.String }),
      ]),
    ),
  }),
  progress: Schema.Struct({ working: Schema.Boolean, turns: Schema.Number }),
});
const List = Schema.Struct({ version: Schema.Literal(1), sessions: Schema.Array(Session) });
const Detail = Schema.Struct({ version: Schema.Literal(1), session: Session });
const Created = Schema.Struct({ id: Schema.String });
const Write = Schema.Struct({ status: Schema.String });
const ErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });
const decodeList = Schema.decodeUnknownOption(List);
const decodeDetail = Schema.decodeUnknownOption(Detail);
const decodeCreated = Schema.decodeUnknownOption(Created);
const decodeWrite = Schema.decodeUnknownOption(Write);
const decodeError = Schema.decodeUnknownOption(ErrorBody);
export type Session = typeof Session.Type;
export type Conversation = CanonicalConversationSnapshot;

export const message = (failure: unknown, fallback: string): string =>
  failure instanceof Error ? failure.message : fallback;

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
    throw new Error(error?.error.message ?? "Request failed (" + response.status + ")");
  }
  return value;
}
// With `search`, the server matches the whole first prompt, key and connection too.
export async function sessions(signal?: AbortSignal, search = ""): Promise<ReadonlyArray<Session>> {
  const query = search === "" ? "" : `?q=${encodeURIComponent(search)}`;
  const result = Option.getOrUndefined(
    decodeList(await request(`/api/sessions${query}`, undefined, signal)),
  );
  if (result === undefined) throw new Error("Unreadable session list");
  return result.sessions;
}
export async function session(id: string, signal?: AbortSignal): Promise<Session> {
  const result = Option.getOrUndefined(
    decodeDetail(await request("/api/sessions/" + encodeURIComponent(id), undefined, signal)),
  );
  if (result === undefined) throw new Error("Unreadable session");
  return result.session;
}
export async function conversation(id: string, signal?: AbortSignal): Promise<Conversation> {
  const result = decodeCanonicalConversationSnapshotSync(
    await request("/api/sessions/" + encodeURIComponent(id) + "/conversation", undefined, signal),
  );
  if (result === undefined) throw new Error("Unreadable conversation");
  return result;
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

// Stop and resume answer with the session; the next poll shows it, so the body is not read.
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
