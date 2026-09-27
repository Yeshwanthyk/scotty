import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type CredsObject from "../creds/object.js";

const path = /^\/p\/chatgpt\/([a-z0-9-]{6,32})\/responses$/;

/** Container traffic for `http://scotty.internal/p/chatgpt/<session>`, reached through interception. */
export function chatGptHandler(
  request: HttpServerRequest.HttpServerRequest,
  credentials: Cloudflare.DurableObject<CredsObject>,
) {
  return Effect.gen(function* () {
    const url = new URL(request.url, "http://scotty.internal");
    const session = path.exec(url.pathname)?.[1];
    if (session === undefined || request.method !== "POST")
      return HttpServerResponse.empty({ status: 404 });
    const web = yield* HttpServerRequest.toWeb(request);
    const response = yield* credentials.getByName("owner").proxy(session, web);
    return HttpServerResponse.fromWeb(response);
  }).pipe(Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 502 }))));
}
