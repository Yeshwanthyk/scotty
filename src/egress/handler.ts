import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ConnectionName, InternalConnectionName } from "../creds/connections.js";
import { gitHandler } from "../creds/git.js";
import { gitHubApiHandler } from "../creds/github-api.js";
import type CredsObject from "../creds/object.js";
import { reachHandler } from "../creds/reach.js";
import type SessionObject from "../session/object.js";
import { attach } from "./files.js";
import { EgressToken } from "./token.js";

/** What a container's request is for: the place it asked for, already chosen. */
export type Target =
  | { readonly kind: "git" }
  | { readonly kind: "files" }
  | { readonly kind: "github-api" }
  | { readonly kind: "connection"; readonly name: string };

/** Everything the egress handler reaches on a session's behalf. */
export interface Upstreams {
  readonly sessions: Cloudflare.DurableObject<SessionObject>;
  readonly credentials: Cloudflare.DurableObject<CredsObject>;
  readonly bucket: Cloudflare.R2.ReadWriteBucketClient;
}

/**
 * The one egress handler. Cloudflare's interceptors and `/egress` both end here, with the
 * session and repository they proved and the target they chose.
 */
export const egress = (
  request: HttpServerRequest.HttpServerRequest,
  scope: { readonly session: string; readonly repo: string },
  target: Target,
  upstreams: Upstreams,
) => {
  switch (target.kind) {
    case "connection":
      return reachHandler(request, target.name, upstreams.credentials).pipe(Effect.orDie);
    case "github-api":
      return gitHubApiHandler(request, upstreams.credentials).pipe(Effect.orDie);
    case "files":
      return attach(request, scope.session, upstreams.sessions, upstreams.bucket).pipe(
        Effect.orDie,
      );
    case "git":
      return gitHandler(request, scope.repo, upstreams.credentials).pipe(Effect.orDie);
  }
};

// Set by the Cloudflare place when it routes a container's built-in or connection egress here
// (`src/places/cloudflare.ts`). The Worker reads them only from the loopback's props.
export const LoopbackProps = Schema.Struct({
  session: Schema.String,
  repo: Schema.String,
  connection: Schema.optionalKey(ConnectionName),
  api: Schema.optionalKey(Schema.Literal("github")),
});

/** A Cloudflare interceptor's target: from its props, and for the shared fetcher, the host. */
export const loopbackTarget = (
  props: typeof LoopbackProps.Type,
  host: string | undefined,
): Target =>
  props.connection !== undefined
    ? { kind: "connection", name: props.connection }
    : props.api === "github"
      ? { kind: "github-api" }
      : host === "files.internal"
        ? { kind: "files" }
        : { kind: "git" };

// `/egress/<session>/<host><path>`: the session the token was minted for, then the host and path
// the container asked for.
const egressPath = /^\/egress\/([a-z0-9-]{6,32})\/([a-z0-9.-]{1,253})(\/.*)$/;
export const egressPrefix = "/egress/";
export const egressHeader = "x-scotty-egress";

const hostTarget = (host: string, connections: readonly string[]): Target | undefined => {
  if (host === "github.internal") return { kind: "git" };
  if (host === "files.internal") return { kind: "files" };
  if (host === "api.github.com") return { kind: "github-api" };
  const name = Schema.decodeUnknownOption(InternalConnectionName)(
    host.endsWith(".internal") ? host.slice(0, -".internal".length) : undefined,
  );
  return Option.isSome(name) && connections.includes(name.value)
    ? { kind: "connection", name: name.value }
    : undefined;
};

const notFound = () => HttpServerResponse.text("Not found\n", { status: 404 });
const refused = () => HttpServerResponse.text("Egress token refused\n", { status: 401 });

/**
 * `/egress` for places outside Cloudflare. The token in `x-scotty-egress` must be one the Creds
 * DO minted for this session's current gen; it is dropped before the request goes anywhere.
 */
export const egressRoute = (request: HttpServerRequest.HttpServerRequest, upstreams: Upstreams) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "https://scotty.internal");
    const [, session, host, path] = egressPath.exec(url.pathname) ?? [];
    if (session === undefined || host === undefined || path === undefined) return notFound();
    const token = Schema.decodeUnknownOption(EgressToken)(request.headers[egressHeader]);
    if (Option.isNone(token)) return refused();
    const granted = yield* upstreams.credentials
      .getByName("owner")
      .checkEgress(session, token.value)
      .pipe(Effect.option);
    if (Option.isNone(granted)) return HttpServerResponse.text("Bad gateway\n", { status: 502 });
    if (granted.value === null) return refused();
    const target = hostTarget(host, granted.value.connections);
    if (target === undefined) return notFound();
    const raw = yield* HttpServerRequest.toWeb(request);
    const headers = new Headers(raw.headers);
    headers.delete(egressHeader);
    headers.set("host", host);
    const scheme = host === "api.github.com" ? "https" : "http";
    const inner = new Request(`${scheme}://${host}${path}${url.search}`, {
      method: raw.method,
      headers,
      body: raw.body,
      signal: raw.signal,
      redirect: "manual",
    });
    return yield* egress(
      HttpServerRequest.fromWeb(inner),
      { session, repo: granted.value.repo },
      target,
      upstreams,
    );
  }).pipe(Effect.orDie);
