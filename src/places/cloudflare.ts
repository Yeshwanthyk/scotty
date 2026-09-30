import type * as cf from "@cloudflare/workers-types";
import { Effect } from "effect";
import { ContainerStartFailed, type Place } from "./place.js";

// ctx.exports is typed {} without a GlobalProps declaration; its default export is the
// Worker's loopback, which takes props (work/spikes/7a/RESULT.md).
const isLoopback = (
  value: unknown,
): value is (options: {
  props: { session: string; repo: string };
}) => Parameters<cf.Container["interceptOutboundHttp"]>[1] => typeof value === "function";

export const cloudflarePlace = (container: cf.Container, exports: object): Place => ({
  start: (egress) =>
    Effect.gen(function* () {
      // A new container needs the interceptor; Alchemy's wrapper drops this promise.
      const loopback: unknown = Reflect.get(exports, "default");
      if (!isLoopback(loopback)) return yield* Effect.die("no ctx.exports.default");
      const fetcher = loopback({ props: egress });
      yield* Effect.tryPromise(() =>
        Promise.all([
          container.interceptOutboundHttp("github.internal", fetcher),
          container.interceptOutboundHttp("files.internal", fetcher),
        ]),
      ).pipe(Effect.mapError(() => new ContainerStartFailed()));
      yield* Effect.try({
        try: () => container.start({ enableInternet: true }),
        catch: () => new ContainerStartFailed(),
      });
    }),
  running: () => container.running,
  port: (port) => container.getTcpPort(port),
  destroy: () => Effect.promise(() => container.destroy()),
});
