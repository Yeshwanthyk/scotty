import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Option, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { ConnectionName, InternalConnectionName } from "../creds/connections.js";
import { gitHandler } from "../creds/git.js";
import { gitHubApiHandler } from "../creds/github-api.js";
import type CredsObject from "../creds/object.js";
import { reachHandler } from "../creds/reach.js";
import type SessionObject from "../session/object.js";
import { attach } from "./files.js";

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
 * The one egress handler. Cloudflare's interceptors and the tunnel both end here, with the
 * session and repository in loopback props and the target they chose.
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

export const LoopbackProps = Schema.Struct({
  session: Schema.String,
  repo: Schema.String,
  connection: Schema.optionalKey(ConnectionName),
  api: Schema.optionalKey(Schema.Literal("github")),
});

/** A Cloudflare interceptor's target: from its props, and for the shared fetcher, the host. */
export const loopbackTarget: (
  props: typeof LoopbackProps.Type,
  host: string | undefined,
) => Target = (props, host) =>
  props.connection !== undefined
    ? { kind: "connection", name: props.connection }
    : props.api === "github"
      ? { kind: "github-api" }
      : host === "files.internal"
        ? { kind: "files" }
        : { kind: "git" };

/** The loopback props for a host a session reached through the tunnel, or none for any other host. */
export const tunnelProps: (
  host: string,
  connections: readonly string[],
) => { readonly connection?: string; readonly api?: "github" } | undefined = (
  host,
  connections,
) => {
  if (host === "github.internal" || host === "files.internal") return {};
  if (host === "api.github.com") return { api: "github" };
  const name = Schema.decodeUnknownOption(InternalConnectionName)(
    host.endsWith(".internal") ? host.slice(0, -".internal".length) : undefined,
  );
  return Option.isSome(name) && connections.includes(name.value)
    ? { connection: name.value }
    : undefined;
};
