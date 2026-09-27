import type {
  Container,
  DurableObjectState,
  ExportedHandler,
  Fetcher,
} from "@cloudflare/workers-types";
import { Effect } from "effect";

declare module "@cloudflare/workers-types" {
  namespace Cloudflare {
    // Types `ctx.exports.default`: the loopback Fetcher for this Worker's own fetch handler.
    interface GlobalProps {
      mainModule: { default: ExportedHandler };
    }
  }
}

/** Plain HTTP virtual host, intercepted inside Cloudflare and never sent through public Access. */
export const chatGptBaseUrl = (session: string) => `http://scotty.internal/p/chatgpt/${session}`;

/** Routes the container's `scotty.internal` traffic to this Worker's `/p/chatgpt` route. */
export function installChatGptEgress(container: Container, state: DurableObjectState) {
  const worker: Fetcher = state.exports.default;
  return Effect.tryPromise({
    try: () => container.interceptOutboundHttp("scotty.internal", worker),
    catch: () => new Error("Internal ChatGPT interception failed"),
  });
}
