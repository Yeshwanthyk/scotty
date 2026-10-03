import type * as cf from "@cloudflare/workers-types";
import { Effect } from "effect";
import { ContainerStartFailed, type Place } from "./place.js";

import { isLoopback } from "../loopback.js";

export const cloudflarePlace = (container: cf.Container, exports: object): Place => ({
  start: (egress) =>
    Effect.gen(function* () {
      // A new container needs the interceptor; Alchemy's wrapper drops this promise.
      const loopback: unknown = Reflect.get(exports, "default");
      if (!isLoopback(loopback)) return yield* Effect.die("no ctx.exports.default");
      const fetcher = loopback({ props: { session: egress.session, repo: egress.repo } });
      yield* Effect.tryPromise(() =>
        Promise.all([
          container.interceptOutboundHttp("github.internal", fetcher),
          container.interceptOutboundHttp("files.internal", fetcher),
          ...egress.connections.map((connection) =>
            container.interceptOutboundHttp(
              `${connection}.internal`,
              loopback({ props: { session: egress.session, repo: egress.repo, connection } }),
            ),
          ),
        ]),
      ).pipe(Effect.mapError(() => new ContainerStartFailed()));
      yield* Effect.try({
        try: () => container.start({ enableInternet: true }),
        catch: () => new ContainerStartFailed(),
      });
    }),
  running: () => Effect.sync(() => container.running),
  port: (port) => container.getTcpPort(port),
  destroy: () => Effect.promise(() => container.destroy()),
});
