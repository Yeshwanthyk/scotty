import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type CredsObject from "./object.js";

const path =
  /^\/api\/git\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const services = ["git-upload-pack", "git-receive-pack"];
// Credentials from the container and hop-by-hop headers never reach GitHub.
const dropped =
  "host authorization proxy-authorization cookie x-api-key x-github-token x-forwarded-for connection keep-alive proxy-connection te trailer transfer-encoding upgrade".split(
    " ",
  );
const rateLimited = (headers: Headers) =>
  headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0";
const forbidden = () => HttpServerResponse.text("Forbidden\n", { status: 403 });

// A push's ref-update commands are the pkt-lines before the first flush-pkt; every one must
// target refs/heads/scotty/*. A body that is only a flush-pkt is git's auth probe.
const scottyRefsOnly = (body: Uint8Array) => {
  const text = new TextDecoder("latin1");
  let offset = 0;
  while (offset + 4 <= body.length) {
    const size = text.decode(body.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(size)) return false;
    const length = Number.parseInt(size, 16);
    if (length === 0) return true;
    if (length < 4 || offset + length > body.length) return false;
    const line = text.decode(body.subarray(offset + 4, offset + length)).split("\0")[0] ?? "";
    offset += length;
    if (line.startsWith("shallow ")) continue;
    if (!line.trimEnd().split(" ")[2]?.startsWith("refs/heads/scotty/")) return false;
  }
  return false;
};

/** Git smart HTTP for one session's repository, reached only through the container interceptor. */
export const gitHandler = (
  request: HttpServerRequest.HttpServerRequest,
  repo: string,
  credentials: Cloudflare.DurableObject<CredsObject>,
) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://github.internal");
    const match = path.exec(url.pathname);
    const [, target, route] = match ?? [];
    if (route === undefined || target?.toLowerCase() !== repo.toLowerCase()) return forbidden();
    const service = route === "info/refs" ? url.searchParams.get("service") : route;
    if (service === null || !services.includes(service)) return forbidden();
    if (request.method !== (route === "info/refs" ? "GET" : "POST")) return forbidden();
    const raw = yield* HttpServerRequest.toWeb(request);
    let body: ReadableStream | ArrayBuffer | null = raw.body;
    if (route === "git-receive-pack") {
      if (raw.headers.has("content-encoding")) return forbidden();
      const bytes = yield* Effect.tryPromise(() => raw.arrayBuffer());
      if (!scottyRefsOnly(new Uint8Array(bytes))) return forbidden();
      body = bytes;
    }
    const token = yield* credentials.getByName("owner").gitHubToken();
    if (token === null)
      return HttpServerResponse.text("GitHub is not signed in\n", { status: 401 });
    const headers = new Headers(raw.headers);
    for (const name of dropped) headers.delete(name);
    headers.set("authorization", `Basic ${btoa(`x-access-token:${token}`)}`);
    const upstream = yield* Effect.tryPromise(() =>
      fetch(`https://github.com/${repo}.git/${route}${url.search}`, {
        method: request.method,
        headers,
        body,
      }),
    );
    // GitHub signals some rate limits with 403; the workspace retries only 429, so a 403 that
    // means "no access" fails at once.
    if (upstream.status === 403 && rateLimited(upstream.headers))
      return HttpServerResponse.text("GitHub rate limit\n", { status: 429 });
    return HttpServerResponse.fromWeb(upstream);
  }).pipe(
    // A body or upstream that fails mid-request is a bad gateway git can report, not a crash.
    Effect.catchTag("UnknownError", () =>
      Effect.succeed(HttpServerResponse.text("Bad gateway\n", { status: 502 })),
    ),
  );
