import type { Container } from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import type CredsObject from "../creds/object.js";

/** Plain HTTP virtual host intercepted inside Cloudflare before public Access. */
export const chatGptBaseUrl = "http://scotty.internal/p/chatgpt";

export function installChatGptEgress(
  container: Container,
  credentials: Cloudflare.DurableObject<CredsObject>,
  session: string,
) {
  const stub = credentials.getByName("owner");
  const binding = Cloudflare.fromCloudflareFetcher({
    fetch: (request: Request) => Effect.runPromise(stub.proxy(session, request)),
    connect: () => {
      throw new Error("No TCP access on the credential binding");
    },
  });
  return Effect.tryPromise({
    try: () => container.interceptOutboundHttp("scotty.internal", binding.raw),
    catch: () => new Error("Internal ChatGPT interception failed"),
  });
}
