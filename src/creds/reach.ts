import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type CredsObject from "./object.js";

const dropped =
  "host authorization proxy-authorization cookie x-api-key x-auth-token x-github-token x-forwarded-for connection keep-alive proxy-connection te trailer transfer-encoding upgrade".split(
    " ",
  );
const clean = (incoming: Headers) => {
  const headers = new Headers(incoming);
  for (const name of (headers.get("connection") ?? "").split(","))
    if (name.trim() !== "") headers.delete(name.trim());
  for (const name of dropped) headers.delete(name);
  return headers;
};

// Reached only with the interceptor's props. Neither body is read; cancellation stays upstream.
export const reachHandler = (
  request: HttpServerRequest.HttpServerRequest,
  connection: string,
  credentials: Cloudflare.DurableObject<CredsObject>,
) =>
  Effect.gen(function* () {
    const incoming = new URL(request.url, "http://connection.internal");
    const credential = yield* credentials.getByName("owner").reachCredential(connection);
    if (
      credential === null ||
      (credential.config.kind !== "token" && credential.config.kind !== "mcp")
    )
      return HttpServerResponse.text("Not found\n", { status: 404 });
    const config = credential.config;
    const base = config.kind === "token" ? "/api/" : "/api/mcp";
    if (
      !(
        incoming.pathname === base ||
        incoming.pathname.startsWith(base.endsWith("/") ? base : `${base}/`)
      )
    )
      return HttpServerResponse.text("Not found\n", { status: 404 });
    if (config.kind === "mcp" && !["GET", "POST", "DELETE"].includes(request.method))
      return HttpServerResponse.text("Use GET, POST or DELETE\n", { status: 405 });
    const target = new URL(config.kind === "token" ? `https://${config.host}/` : config.url);
    const suffix = incoming.pathname.slice(base.length);
    target.pathname =
      config.kind === "token"
        ? `/${suffix}`
        : suffix === ""
          ? target.pathname
          : `${target.pathname.replace(/\/$/, "")}${suffix}`;
    for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value);
    const raw = yield* HttpServerRequest.toWeb(request);
    const headers = clean(raw.headers);
    const [name = "authorization", scheme] = (
      config.kind === "token" ? config.header : "Authorization: Bearer"
    ).split(": ");
    headers.set(name, scheme === undefined ? credential.secret : `${scheme} ${credential.secret}`);
    const upstream = yield* Effect.tryPromise(() =>
      fetch(target, {
        method: request.method,
        headers,
        body: raw.body,
        signal: raw.signal,
        // Do not forward a custom credential header to a redirect's host.
        redirect: "manual",
      }),
    );
    // Preserve end-to-end MCP headers and stream, while dropping hop-by-hop response headers.
    const responseHeaders = new Headers(upstream.headers);
    for (const name of (responseHeaders.get("connection") ?? "").split(","))
      if (name.trim() !== "") responseHeaders.delete(name.trim());
    for (const name of [
      "connection",
      "keep-alive",
      "proxy-connection",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "set-cookie",
    ])
      responseHeaders.delete(name);
    return HttpServerResponse.fromWeb(
      new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      }),
    );
  }).pipe(
    Effect.catchTag("UnknownError", () =>
      Effect.succeed(HttpServerResponse.text("Bad gateway\n", { status: 502 })),
    ),
  );
