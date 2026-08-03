# Cloudflare inbound TCP and gRPC source notes

**Research cutoff:** 2026-08-03

**Purpose:** determine what Cloudflare has publicly specified well enough for Scotty to rely on, separately for inbound Worker TCP, bidirectional gRPC to Containers, and Worker-hosted / Worker-originated gRPC.

**Result:** the public runtime source contains important implementation and type evidence, but Cloudflare's public product documentation still describes the requested capabilities as unavailable or does not describe them at all. Treat the new product claims as **unverified/private-beta** until Cloudflare publishes the missing production contracts or grants documented beta access.

## Evidence policy and snapshots

Capability statements below use only primary Cloudflare material: Cloudflare documentation and blog posts, and Cloudflare-owned public repositories, types, samples, commits, and source. Scotty repository files are used only to assess integration impact.

The public pages cited below do not expose a reliable per-page “last updated” date in their source frontmatter. To make the evidence reproducible, documentation statements are pinned to this repository snapshot:

- [`cloudflare/cloudflare-docs@a809ff0`](https://github.com/cloudflare/cloudflare-docs/tree/a809ff05841f6abbcfe0c185cbd5225ef9572d21), committed **2026-08-03 13:57:50 UTC**.
- [`cloudflare/workerd@05e8689`](https://github.com/cloudflare/workerd/tree/05e868985ed7496ee7e162c22bce4f8a3f206038), release commit **2026-08-03 01:03:22 UTC**.
- [`cloudflare/containers@788237a`](https://github.com/cloudflare/containers/tree/788237af2d89396eb47b8ba974f7c3ccc16f53d0), committed **2026-06-18 17:42:13 UTC**.

Two older official announcements establish history, not the new production contract:

- [Introducing Socket Workers](https://blog.cloudflare.com/introducing-socket-workers/), published **2021-11-15**, described a future Socket Worker model.
- [Workers TCP socket API: connect() to databases](https://blog.cloudflare.com/workers-tcp-socket-api-connect-databases/), published **2023-05-16**, launched outbound TCP and said inbound TCP/UDP support was planned. The current TCP docs still link this article as “coming soon.”

No official public changelog, documentation page, blog post, example, or source comment was located that specifies the newly claimed Spectrum-to-Worker or gRPC product contracts. An announcement is not treated as an API contract.

## Status summary

| Area                                                   | Public evidence                                                                                                           | Production status supported by public evidence                                                                                                                        | Scotty decision                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Spectrum → Worker `connect(socket)`                    | Exact handler and socket types, runtime dispatch, and a local `workerd --experimental` sample are public.                 | **Unverified/private-beta.** Public Worker docs still say inbound TCP is impossible / coming soon, and public Spectrum docs only route TCP/UDP directly to an origin. | Do not build or alter Scotty's ingress around it yet.                           |
| Full-duplex bidirectional gRPC served from a Container | `workerd` has generic bidirectional HTTP body/response plumbing. The public Containers package exposes HTTP `fetch` APIs. | **Unverified/private-beta.** No public Container gRPC API, configuration, example, compatibility gate, or limits were found.                                          | Do not replace the current Pi HTTP/SSE transport yet.                           |
| Worker serves unary or server-streaming gRPC           | No public gRPC-server-specific Worker API or routing contract was found.                                                  | **Unverified/private-beta.** Existing gRPC docs cover proxied endpoints, not a Worker implementation.                                                                 | Keep HTTP/SSE public routes unchanged.                                          |
| Worker calls a gRPC server                             | Public `cf.grpcWeb` type and `auto_grpc_convert` flag describe edge conversion of outbound gRPC-Web to gRPC.              | **Experimental / not publicly productized.** The flag has no enable date, is marked `$experimental`, and has no public product docs or example.                       | A future adapter is plausible, but not a supported production dependency today. |

---

## 1. Inbound TCP: a Worker's `connect(socket)` handler reached through Spectrum

### 1.1 Exact public runtime API

The generated Worker types define this handler:

```ts
type ExportedHandlerConnectHandler<Env = unknown, Props = unknown> = (
  socket: Socket,
  env: Env,
  ctx: ExecutionContext<Props>,
) => void | Promise<void>;

interface ExportedHandler<Env = unknown, /* … */ Props = unknown> {
  fetch?: ExportedHandlerFetchHandler<Env, /* … */ Props>;
  connect?: ExportedHandlerConnectHandler<Env, Props>;
  // …
}
```

Evidence: [`types/generated-snapshot/index.d.ts` lines 495–500 and 533–542](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/generated-snapshot/index.d.ts#L495-L542). The same generated file gives Durable Objects an optional method:

```ts
interface DurableObject {
  fetch(request: Request): Response | Promise<Response>;
  connect?(socket: Socket): void | Promise<void>;
  // …
}
```

Evidence: [`index.d.ts` lines 592–595](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/generated-snapshot/index.d.ts#L592-L595).

The public binding-side API that can initiate a connection to a fetcher is:

```ts
type Fetcher<
  T extends Rpc.EntrypointBranded | undefined = undefined,
  Reserved extends string = never,
> = (T extends Rpc.EntrypointBranded
  ? Rpc.Provider<T, Reserved | "fetch" | "connect">
  : unknown) & {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  connect(address: SocketAddress | string, options?: SocketOptions): Socket;
};
```

Evidence: [`index.d.ts` lines 2193–2200](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/generated-snapshot/index.d.ts#L2193-L2200). This proves a public runtime dispatch surface; it does **not** specify Spectrum's production routing to it.

The delivered `Socket` surface is:

```ts
interface Socket {
  get readable(): ReadableStream;
  get writable(): WritableStream;
  get closed(): Promise<void>;
  get opened(): Promise<SocketInfo>;
  get upgraded(): boolean;
  get secureTransport(): "on" | "off" | "starttls";
  close(): Promise<void>;
  startTls(options?: TlsOptions): Socket;
}

interface SocketInfo {
  remoteAddress?: string;
  localAddress?: string;
}
```

Evidence: [`index.d.ts` lines 3782–3807](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/generated-snapshot/index.d.ts#L3782-L3807).

The source says that for an inbound handler, `localAddress` is the CONNECT authority (`host:port`) supplied to `fetcher.connect(...)`; outbound sockets leave it empty. Evidence: [`sockets.h` lines 31–41](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/api/sockets.h#L31-L41). The current dispatch passes no `remoteAddress`, so the public source does not establish client-IP delivery to the handler: [`global-scope.c++` lines 215–224](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/api/global-scope.c%2B%2B#L215-L224).

### 1.2 Dates and maturity gates

The implementation entered the public runtime in [`04e4c46` — “EW-9330 TCP connect handler support”](https://github.com/cloudflare/workerd/commit/04e4c4660011bb9812ba4538f826b4169cbf0334), committed **2026-03-23 22:29:18 UTC**.

Related public fixes were committed later:

- [`258bbb9` — populate `localAddress`](https://github.com/cloudflare/workerd/commit/258bbb9471f3698596987a5d60078713719de168), **2026-04-30 14:26:07 UTC**.
- [`1b4ddbf` — neuter the stream when the handler promise settles](https://github.com/cloudflare/workerd/commit/1b4ddbf9aa5a223563dd3a52b2acaf4aada045ba), **2026-05-14 10:53:09 UTC**.

The public local-runtime sample uses:

```capnp
sockets = [
  (name = "http", address = "*:8080", http = (), service = "main"),
  (name = "tcp", address = "*:8081", tcp = (), service = "main")
];

compatibilityFlags = ["nodejs_compat_v2", "experimental"];
compatibilityDate = "2026-03-01";
```

Evidence: [`samples/tcp-ingress/config.capnp`](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/samples/tcp-ingress/config.capnp). Its handler simply executes `await socket.readable.pipeTo(socket.writable)`: [`worker.js`](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/samples/tcp-ingress/worker.js). The README explicitly launches local workerd with `--experimental`: [`samples/tcp-ingress/README.md`](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/samples/tcp-ingress/README.md).

That `compatibilityDate` belongs to the sample. It is **not** a documented Cloudflare production enable date. The actual `experimental` flag is a catch-all `workerdExperimental` gate whose source says:

> “Experimental, do not use.”
>
> “WARNING: Any feature blocked by this flag is subject to change at any time, including removal.”

Evidence: [`compatibility-date.capnp` lines 259–271](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/io/compatibility-date.capnp#L259-L271). No dedicated compatibility date or public production flag for inbound `connect` was found.

### 1.3 Runtime limitations established by source

The public dispatch implementation establishes these constraints for the experimental path:

- ES-module exported-handler syntax is required; Service Worker syntax fails with “Connect ingress is not currently supported with Service Workers syntax.”
- The runtime requires `workerdExperimental`.
- The connection is accepted before the handler is called.
- The stream is neutered after the handler's returned promise settles, so the returned promise owns the useful connection lifetime; moving work only to `ctx.waitUntil()` does not extend the socket.
- If there is no exported handler, dispatch fails.
- Inbound TLS is not implemented in this path. The entrypoint source rejects `settings.useTls` with “Incoming CONNECT with TLS not supported.”

Evidence: [`global-scope.c++` lines 184–239](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/api/global-scope.c%2B%2B#L184-L239) and [`worker-entrypoint.c++` lines 630–653](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/io/worker-entrypoint.c%2B%2B#L630-L653).

These are `workerd` implementation facts, not a promise that Cloudflare's edge product will expose precisely the same TLS or routing behavior.

### 1.4 Spectrum and account prerequisites: documented baseline versus missing beta contract

Cloudflare's current Spectrum documentation says:

> “Custom TCP/UDP applications require an Enterprise plan with Spectrum as a paid add-on.”

Evidence: [Spectrum overview](https://developers.cloudflare.com/spectrum/) and [`spectrum/index.mdx` lines 26–36](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/spectrum/index.mdx#L26-L36).

The get-started page gives the broader plan baseline: Spectrum is available on paid plans; Pro and Business support selected protocols, while Enterprise supports all TCP/UDP traffic. Evidence: [Get started](https://developers.cloudflare.com/spectrum/get-started/) and [`get-started.mdx` lines 13–17](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/spectrum/get-started.mdx#L13-L17).

However, today's documented TCP application model is still edge-to-origin:

> “Select TCP/UDP if you want to proxy directly to the origin. If you want to set up products like CDN, Workers, or Bot management, you need to select HTTP/HTTPS.”

Evidence: [Spectrum configuration options](https://developers.cloudflare.com/spectrum/reference/configuration-options/) and [`configuration-options.mdx` lines 10–23](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/spectrum/reference/configuration-options.mdx#L10-L23).

At the same snapshot, Worker documentation says:

> “Support for handling inbound TCP connections is coming soon. Currently, it is not possible to make an inbound TCP connection to your Worker…”

Evidence: [TCP sockets considerations](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/#considerations), [`tcp-sockets.mdx` lines 187–194](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/workers/runtime-apis/tcp-sockets.mdx#L187-L194), and the [protocol matrix](https://developers.cloudflare.com/workers/reference/protocols/) / [`protocols.mdx` lines 11–18](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/workers/reference/protocols.mdx#L11-L18).

The public [Workers beta table](https://developers.cloudflare.com/workers/platform/betas/) lists “TCP Sockets” as public beta but links the outbound socket docs; it does not separately list inbound TCP or Spectrum ingress. Evidence: [`betas.mdx` lines 11–25](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/workers/platform/betas.mdx#L11-L25).

Therefore the following Spectrum-to-Worker details are **unverified/private-beta**:

- required account plan and whether the ordinary Enterprise paid add-on rules apply;
- waitlist, entitlement, or account-team enablement process;
- Spectrum API or dashboard fields that select a Worker / Durable Object rather than an origin;
- DNS, anycast IP, port, and port-range rules for this target type;
- edge TLS termination, passthrough, SNI, and `startTls()` behavior;
- Proxy Protocol and original client-address delivery;
- connection, duration, CPU, memory, billing, and abuse limits;
- retries, code-deploy behavior, Durable Object routing/hibernation, and disconnect semantics;
- authentication and authorization hooks before the raw stream reaches JavaScript.

**Conclusion for (1):** the handler is real public runtime code, but the claimed Spectrum product route is not a public contract. Scotty must not infer production availability from the types or local sample.

---

## 2. Full-duplex bidirectional gRPC served from Cloudflare Containers

### 2.1 What public source does establish

`workerd` contains generic full-duplex HTTP streaming plumbing. Its `RequestInit` source says the Fetch standard currently defines `duplex: "half"`, while the runtime's model is “full”; the option itself is ignored and might later need a compatibility flag. Evidence: [`http.h` lines 597–609](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/api/http.h#L597-L609).

The outbound request implementation says:

> “We want to support bidirectional streaming, so we actually don't want to wait for the request to finish before we deliver the response to the app.”

It pumps the request body as a wait-until task while awaiting the response. Evidence: [`http.c++` lines 1692–1721](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/api/http.c%2B%2B#L1692-L1721).

The incoming request path keeps the request body valid while proxying the response “in the case of bidirectional streaming.” Evidence: [`global-scope.c++` lines 435–449](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/api/global-scope.c%2B%2B#L435-L449).

This proves generic runtime work needed by bidirectional protocols. It does **not** identify gRPC, Containers, HTTP/2 framing at the container boundary, or a Cloudflare product entitlement.

The current public Containers helper exposes ordinary HTTP fetch APIs:

The helper documents the call forms `containerFetch(request, port?)` and `containerFetch(url, init?, port?)`. Its exact implementation signature is:

```ts
public async containerFetch(
  requestOrUrl: Request | string | URL,
  portOrInit?: number | RequestInit,
  portParam?: number
): Promise<Response>
```

Its implementation obtains `this.container.getTcpPort(port)` and calls `tcpPort.fetch(containerUrl, request)`. Evidence: [`cloudflare/containers` `container.ts` lines 1151–1206](https://github.com/cloudflare/containers/blob/788237af2d89396eb47b8ba974f7c3ccc16f53d0/src/lib/container.ts#L1151-L1206). The package README describes `fetch` and `containerFetch` as forwarding HTTP requests: [`README.md` lines 147–170](https://github.com/cloudflare/containers/blob/788237af2d89396eb47b8ba974f7c3ccc16f53d0/README.md#L147-L170).

No `grpc`, gRPC example, gRPC type, or gRPC configuration appears in that public Containers repository snapshot.

### 2.2 Current documented routing model

Cloudflare's Container lifecycle documentation says every Container request first passes through a Worker. It also says:

> “Because all Container requests are passed through a Worker, end-users cannot make non-HTTP TCP or UDP requests to a Container instance.”

Evidence: [Container architecture](https://developers.cloudflare.com/containers/platform-details/architecture/) and [`architecture.mdx` lines 21–33](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/containers/platform-details/architecture.mdx#L21-L33).

That statement does not itself rule out gRPC, which is HTTP-based. It does establish that public clients do not directly address the Container's listening socket under the documented model.

The public Container-to-Worker connection guide describes plain HTTP outbound handlers and virtual HTTP hostnames, not gRPC. Evidence: [Connect to Workers and bindings](https://developers.cloudflare.com/containers/platform-details/workers-connections/) and [`workers-connections.mdx` lines 11–20](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/containers/platform-details/workers-connections.mdx#L11-L20).

### 2.3 Missing production contract

No public primary source was found for any of the following Container gRPC details; each is **unverified/private-beta**:

- whether the Container receives native HTTP/2 gRPC, gRPC-Web, or an edge-translated form;
- whether `ctx.container.getTcpPort(port).fetch()`, `Container.fetch()`, or another API is required;
- exact Worker or Container handler signatures beyond generic Fetch;
- accepted gRPC libraries and protocol features;
- client-, server-, and bidirectional-stream cancellation and half-close semantics;
- backpressure and maximum message / stream / connection sizes;
- trailers, status metadata, compression, health checking, reflection, and deadlines;
- TLS and ALPN termination points;
- compatibility date or flag;
- Wrangler or Alchemy configuration;
- availability, account plan, region, billing, quotas, and beta access;
- interaction with Container sleep, rollout, relocation, and Durable Object lifecycle.

The `workerd` bidirectional-streaming comments are not enough to fill in any of these product-level blanks.

**Conclusion for (2):** generic full-duplex plumbing exists in public runtime source, but no public full-duplex Container gRPC contract exists at the research cutoff. Scotty should treat the capability as private beta rather than infer a transport from implementation comments.

---

## 3. Workers serving unary/server-streaming gRPC and calling gRPC servers

These are separate directions and have different evidence.

### 3.1 Serving unary or server-streaming gRPC from a Worker

No gRPC-server-specific Worker API, type, sample, compatibility flag, changelog, or documentation was found in the public Cloudflare corpus at the pinned snapshots.

Workers do have the generic Fetch handler:

```ts
type ExportedHandlerFetchHandler<Env = unknown, CfHostMetadata = unknown, Props = unknown> = (
  request: Request<CfHostMetadata, IncomingRequestCfProperties<CfHostMetadata>>,
  env: Env,
  ctx: ExecutionContext<Props>,
) => Response | Promise<Response>;
```

Evidence: [`index.d.ts` lines 485–494](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/generated-snapshot/index.d.ts#L485-L494). Public source also supports streaming response bodies generally. Neither fact specifies that native inbound gRPC is routed to `fetch`, how gRPC frames or trailers are represented, or which streaming modes are product-supported. Those details must not be inferred.

Cloudflare's existing [gRPC connections](https://developers.cloudflare.com/network/grpc-connections/) page describes protecting **proxied gRPC endpoints**, not implementing an endpoint inside a Worker. Its documented requirements are:

- endpoint listens on port 443;
- TLS and HTTP/2;
- HTTP/2 advertised over ALPN;
- `Content-Type: application/grpc` or `application/grpc+<message type>`;
- a proxied hostname;
- at least Full SSL/TLS mode;
- the zone's **Network → gRPC** toggle enabled.

Evidence: [`grpc-connections.mdx` lines 11–52](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/network/grpc-connections.mdx#L11-L52). If gRPC is disabled on the zone, the page says Cloudflare returns `403 Forbidden`.

Those requirements are useful baseline questions for a beta, but the page does not say they activate Worker-hosted gRPC. Therefore Worker unary and server-streaming serving remain **unverified/private-beta**, including:

- ingress-to-`fetch` mapping;
- request / response body and trailer representation;
- permitted streaming modes and half-close behavior;
- routing by Worker route versus Custom Domain;
- need for the zone gRPC toggle;
- compatibility date / flags and account entitlement;
- limits, billing, observability, cancellation, retries, and error mapping.

### 3.2 Calling a gRPC server from a Worker

This direction has a narrow public type and flag.

The request `cf` properties define:

```ts
/**
 * Controls whether an outbound gRPC-web subrequest from this Worker is
 * converted to gRPC at the Cloudflare edge.
 *
 * - "passthrough": forward the subrequest unchanged as gRPC-web (default).
 * - "convert": convert the gRPC-web subrequest to gRPC at the edge.
 *
 * Provides per-request control over the same edge conversion behavior
 * gated by the `auto_grpc_convert` compatibility flag.
 */
grpcWeb?: "passthrough" | "convert";
```

Evidence: [`types/defines/cf.d.ts` lines 78–88](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/defines/cf.d.ts#L78-L88), also emitted in [`generated-snapshot/index.d.ts` lines 12377–12387](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/generated-snapshot/index.d.ts#L12377-L12387).

The compatibility schema declares:

```capnp
autoGrpcConvert @178 :Bool
    $compatEnableFlag("auto_grpc_convert")
    $neededByFl
    $experimental;
# When enabled, a Worker's outbound gRPC-web subrequest is converted to gRPC at
# the edge.
```

Evidence: [`compatibility-date.capnp` lines 1563–1569](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/io/compatibility-date.capnp#L1563-L1569).

The type and flag were added by [`6978520` — “Add auto_grpc_convert compat flag () and cf.grpcWeb type”](https://github.com/cloudflare/workerd/commit/69785205d3039210b514580634b93b4742a97f12), committed **2026-06-12 19:15:17 UTC**.

Maturity constraints:

- There is **no** `$compatEnableDate`; activation is by the explicit `auto_grpc_convert` flag.
- The schema marks it `$experimental` and `$neededByFl`.
- The public `workerd` tree contains the flag and type text but no conversion implementation, test, or example. The documented behavior explicitly occurs “at the Cloudflare edge,” so local `workerd` support must not be inferred.
- No public Cloudflare product documentation or changelog entry describes enabling the flag, supported gRPC-Web variants, streaming support, destinations, origin requirements, errors, limits, or account access.

Consequently, the only defensible API shape is an outbound **gRPC-Web request** with edge conversion selected globally by `auto_grpc_convert` and/or per request with `cf.grpcWeb: "convert"`. It is **not** evidence of a native Node/Go-style gRPC client API in Workers.

### 3.3 Existing proxied-gRPC limitations

For ordinary proxied gRPC endpoints, Cloudflare documents these limitations:

- WAF runs only header inspection during connection establishment; Managed Rules do not inspect gRPC stream content.
- Cloudflare Access does not support gRPC through Cloudflare's reverse proxy; enabled gRPC traffic is ignored by Access, so Cloudflare recommends disabling gRPC on sensitive Access-protected origins or adding another authentication mechanism.
- The page includes an additional Cloudflare Tunnel gRPC limitation via shared documentation.

Evidence: [`grpc-connections.mdx` lines 24–32](https://github.com/cloudflare/cloudflare-docs/blob/a809ff05841f6abbcfe0c185cbd5225ef9572d21/src/content/docs/network/grpc-connections.mdx#L24-L32).

These are documented for proxied endpoints. Whether every limitation applies identically to Worker-hosted or Container-hosted beta gRPC is **unverified**.

**Conclusion for (3):** Worker gRPC serving has no public contract. Outbound gRPC-Web-to-gRPC conversion has an exact but experimental public type and flag, without a public production enablement contract.

---

## Scotty impact

### Current relevant boundaries

Scotty's current design keeps authoritative session state and credentials in the Sandbox Durable Object. Its public control and terminal routes are authenticated HTTP/SSE, and the Container-side Pi transport is reached through `ctx.container.getTcpPort(PI_SESSION_PORT).fetch(...)`. The runner transport uses an outbound Worker connection rather than exposing an inbound runner port.

Relevant repository evidence reviewed for this note:

- [`protocol/pi-console.ts`](../../protocol/pi-console.ts)
- [`pi-scotty/src/transport.ts`](../../pi-scotty/src/transport.ts)
- [`worker/src/index.ts`](../../worker/src/index.ts)
- [`worker/src/session.ts`](../../worker/src/session.ts)
- [`worker/src/runner-transport.ts`](../../worker/src/runner-transport.ts)
- [`desktop/README.md`](../../desktop/README.md)
- [`PLAN.md`](../../PLAN.md), [`IMPLEMENTATION_DAG.md`](../../IMPLEMENTATION_DAG.md), [`EFFECT_V4_MIGRATION.md`](../../EFFECT_V4_MIGRATION.md), and [`PORTABLE_EXECUTION_PLAN.md`](../../PORTABLE_EXECUTION_PLAN.md)

### Decision now

1. **Do not change Scotty's public routes or transport yet.** The evidence does not support a stable deployable configuration for any of the three new paths.
2. **Do not treat `getTcpPort(...).fetch()` as raw public TCP.** It remains an internal Worker/DO-to-Container Fetch boundary.
3. **Do not expose runner inbound ports.** A future Spectrum handler would not automatically improve the current outbound runner trust model.
4. **Preserve the Sandbox DO as authority.** TCP or gRPC can eventually be a transport adapter, never the owner of session state or credentials.
5. **Preserve browser HTTP/SSE.** Even if native gRPC becomes stable for desktop/CLI or Worker-to-Container traffic, the browser-facing compatibility and authentication contract remains separate.

### Evidence required before a Scotty spike can proceed

Obtain all of the following from a public Cloudflare contract or beta documentation supplied with explicit access:

- a production Spectrum configuration that targets a Worker or Durable Object;
- plan/entitlement, compatibility date/flags, and local-development story;
- TLS, client identity, authentication, connection lifetime, deploy, and limit semantics for `connect(socket)`;
- a Container gRPC example proving simultaneous request/response streaming through the exact production binding used by Scotty;
- Worker gRPC server mapping, trailers, status, cancellation, and streaming-mode contract;
- an outbound conversion example proving `auto_grpc_convert` / `cf.grpcWeb` availability and failure behavior;
- Alchemy v2 public resource/binding support or a justified minimal custom provider;
- contract tests for cancellation, backpressure, reconnect/replay, container restart, DO relocation, and credential isolation;
- a deployed canary before any existing HTTP/SSE or runner transport is retired.

Until then, the useful result of this research is a **watch list**, not an implementation dependency.

## Primary-source index

### Cloudflare documentation

- [Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Workers protocols](https://developers.cloudflare.com/workers/reference/protocols/)
- [Workers betas](https://developers.cloudflare.com/workers/platform/betas/)
- [Spectrum overview](https://developers.cloudflare.com/spectrum/)
- [Spectrum get started](https://developers.cloudflare.com/spectrum/get-started/)
- [Spectrum configuration options](https://developers.cloudflare.com/spectrum/reference/configuration-options/)
- [Spectrum protocols per plan](https://developers.cloudflare.com/spectrum/protocols-per-plan/)
- [Spectrum settings by plan](https://developers.cloudflare.com/spectrum/reference/settings-by-plan/)
- [Container architecture](https://developers.cloudflare.com/containers/platform-details/architecture/)
- [Container connections to Workers/bindings](https://developers.cloudflare.com/containers/platform-details/workers-connections/)
- [gRPC connections](https://developers.cloudflare.com/network/grpc-connections/)

### Cloudflare source, types, and examples

- [`cloudflare/workerd` release snapshot](https://github.com/cloudflare/workerd/tree/05e868985ed7496ee7e162c22bce4f8a3f206038)
- [TCP handler implementation commit](https://github.com/cloudflare/workerd/commit/04e4c4660011bb9812ba4538f826b4169cbf0334)
- [TCP ingress sample](https://github.com/cloudflare/workerd/tree/05e868985ed7496ee7e162c22bce4f8a3f206038/samples/tcp-ingress)
- [Generated Worker types](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/generated-snapshot/index.d.ts)
- [`connect` dispatch implementation](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/api/global-scope.c%2B%2B#L184-L239)
- [Compatibility schema](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/src/workerd/io/compatibility-date.capnp)
- [`cf.grpcWeb` type](https://github.com/cloudflare/workerd/blob/05e868985ed7496ee7e162c22bce4f8a3f206038/types/defines/cf.d.ts#L78-L88)
- [gRPC conversion type/flag commit](https://github.com/cloudflare/workerd/commit/69785205d3039210b514580634b93b4742a97f12)
- [`cloudflare/containers` snapshot](https://github.com/cloudflare/containers/tree/788237af2d89396eb47b8ba974f7c3ccc16f53d0)

### Official historical announcements

- [Introducing Socket Workers — 2021-11-15](https://blog.cloudflare.com/introducing-socket-workers/)
- [Workers TCP socket API: connect() to databases — 2023-05-16](https://blog.cloudflare.com/workers-tcp-socket-api-connect-databases/)
