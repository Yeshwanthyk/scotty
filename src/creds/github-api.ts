import type * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Option, Schema } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type CredsObject from "./object.js";
import { clean } from "./reach.js";
import { proxied } from "./github.js";

const Query = Schema.Struct({ query: Schema.String });
const Graphql = Schema.fromJsonString(Schema.Union([Query, Schema.Array(Query)]));
const RefCreate = Schema.fromJsonString(Schema.Struct({ ref: Schema.String }));
const refMutations =
  /\b(createRef|updateRef|updateRefs|deleteRef|createCommitOnBranch|mergeBranch|updatePullRequestBranch|createBranchProtectionRule|updateBranchProtectionRule|deleteBranchProtectionRule)\b/;
const repo = String.raw`^/(?:repos/[^/]+/[^/]+|repositories/[^/]+)`;
const reads = ["GET", "HEAD"];

const scottyOnly =
  "Scotty refuses writes that move a branch outside scotty/*; push a scotty/* branch and merge a pull request";

/**
 * Why a request to api.github.com is refused, or null to send it. Routes match the decoded path
 * with its slashes collapsed, in any case, so no spelling GitHub accepts gets past; a branch name
 * keeps its case. `body` is read only for the writes whose ref is in it.
 */
export const refusal: (method: string, pathname: string, body: () => string) => string | null = (
  method,
  pathname,
  body,
) => {
  let path: string;
  try {
    path = decodeURIComponent(pathname).replace(/\/{2,}/g, "/");
  } catch {
    return "Bad path";
  }
  if (/^\/graphql\/?$/i.test(path)) {
    if (method !== "POST") return "Use POST for GraphQL";
    const parsed = Schema.decodeUnknownOption(Graphql)(body());
    if (Option.isNone(parsed)) return "Bad GraphQL request";
    const queries = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    return queries.some((item) => refMutations.test(item.query)) ? scottyOnly : null;
  }
  if (reads.includes(method)) return null;
  const at = (pattern: string) => new RegExp(`${repo}${pattern}`, "i").exec(path);
  if (at("/contents(/|$)") || at("/merges/?$") || at("/merge-upstream/?$")) return scottyOnly;
  if (at("/branches/") || at(String.raw`/pulls/\d+/update-branch/?$`)) return scottyOnly;
  if (at("/git/refs/?$")) {
    const ref = Schema.decodeUnknownOption(RefCreate)(body());
    return Option.isSome(ref) && ref.value.ref.startsWith("refs/heads/scotty/") ? null : scottyOnly;
  }
  const ref = at("/git/refs/(.*)$")?.[1];
  if (ref !== undefined) return ref.startsWith("heads/scotty/") ? null : scottyOnly;
  return null;
};

const badGateway = () => HttpServerResponse.text("Bad gateway\n", { status: 502 });
const forbidden = (message: string) =>
  HttpServerResponse.jsonUnsafe(
    { message, documentation_url: "https://docs.github.com/rest" },
    { status: 403 },
  );

/** The GitHub API for a session's gh, reached only through the HTTPS interceptor. */
export const gitHubApiHandler = (
  request: HttpServerRequest.HttpServerRequest,
  credentials: Cloudflare.DurableObject<CredsObject>,
) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "https://api.github.com");
    const raw = yield* HttpServerRequest.toWeb(request);
    const inspected = /graphql|\/git\/refs\/?$/i.test(url.pathname) && !reads.includes(raw.method);
    if (inspected && raw.headers.has("content-encoding")) return forbidden("Send the body plain");
    const bytes = inspected ? yield* Effect.tryPromise(() => raw.arrayBuffer()) : null;
    const text = bytes === null ? "" : new TextDecoder().decode(bytes);
    const why = refusal(raw.method, url.pathname, () => text);
    if (why !== null) return forbidden(why);
    const headers = clean(raw.headers);
    headers.delete("x-http-method-override");
    const answer = yield* credentials.getByName("owner").gitHubProxy({
      target: "api",
      path: `${url.pathname}${url.search}`,
      method: raw.method,
      headers: [...headers],
      body: bytes === null ? raw.body : new Response(bytes).body,
    });
    if (answer.kind === "signed-out")
      return HttpServerResponse.text("GitHub is not signed in\n", { status: 401 });
    if (answer.kind !== "response") return badGateway();
    return HttpServerResponse.fromWeb(proxied(answer));
  }).pipe(Effect.catch(() => Effect.succeed(badGateway())));
