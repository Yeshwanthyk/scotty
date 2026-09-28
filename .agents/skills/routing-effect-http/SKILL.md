---
name: routing-effect-http
description: Routes Scotty HTTP with Effect's unstable HTTP modules inside Alchemy's Worker. Use when adding an /api route, handling a request in the Worker or a DO, or calling an outside HTTP service.
---

# Route Effect HTTP

## Inbound

- The Worker's `HttpRouter` (`src/worker.ts`) sends `/api/*` to `apiHandler`; add a route there, not a second router. Static assets answer every other path on the Worker's own host, so a new route lives under `/api/`. Routing by Host happens before that and only for: Hatch preview hosts (`<port>-<id>.<base>`), and loopback traffic from a container (`files.internal` to the attach handler, everything else to the git handler).
- A handler takes an `HttpServerRequest` and returns an `HttpServerResponse`. Decode path, query, headers and body at the top of the handler (see `decoding-effect-boundaries`).
- Map typed failures to the stable error body `{ error: { code, message, hint } }` in one place per handler.
- Native `Request`, `Response`, WebSocket upgrades, streams and DO methods keep their host signatures; convert with `HttpServerRequest.toWeb` / `HttpServerResponse.fromWeb` at the edge.
- Identity for loopback traffic (the container's `github.internal` and `files.internal`) comes only from the execution context's `props`, never from the request.

## Outbound

- Domain HTTP uses `HttpClient.HttpClient` with `HttpClientRequest`, provided by `FetchHttpClient.layer` (see `src/creds/oauth.ts`). Decode every response body with Schema before use.
- Raw `fetch` is for streaming proxies that forward a body untouched (`src/creds/git.ts`) and for host APIs that demand a fetch function.
- A real token enters a request only inside `src/creds/`, and never reaches a log line, error or response.

The HTTP modules are unstable. Before changing an import or combinator, find it in `vendor/effect/packages/effect/src/unstable/http/` and its tests, and the Worker bridge in `vendor/alchemy`.
