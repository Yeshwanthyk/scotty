import type * as cf from "@cloudflare/workers-types";
import { Effect } from "effect";
import { ContainerDestroyFailed, ContainerStartFailed, type Place } from "./place.js";

import { isLoopback } from "../loopback.js";

export const cloudflarePlace = (container: cf.Container, exports: object): Place => ({
  start: (input) =>
    Effect.gen(function* () {
      // A new container needs the interceptor; Alchemy's wrapper drops this promise.
      const loopback: unknown = Reflect.get(exports, "default");
      if (!isLoopback(loopback)) return yield* Effect.die("no ctx.exports.default");
      const fetcher = loopback({ props: { session: input.session, repo: input.repo } });
      yield* Effect.tryPromise(() =>
        Promise.all([
          container.interceptOutboundHttp("github.internal", fetcher),
          container.interceptOutboundHttp("files.internal", fetcher),
          // gh: TLS ends at Cloudflare, so the Worker can swap in the token and check the request.
          container.interceptOutboundHttps(
            "api.github.com",
            loopback({ props: { session: input.session, repo: input.repo, api: "github" } }),
          ),
          ...input.connections.map((connection) =>
            container.interceptOutboundHttp(
              `${connection}.internal`,
              loopback({ props: { session: input.session, repo: input.repo, connection } }),
            ),
          ),
        ]),
      ).pipe(Effect.mapError(() => new ContainerStartFailed()));
      // The deployer names the release's image `session` in the Worker's image map. A start
      // without `instance` gets `lite`, so the size is always named.
      const image = container.images["session"];
      if (image === undefined) return yield* Effect.die("no session image in the image map");
      yield* Effect.try({
        try: () => container.start({ image, instance: input.size, enableInternet: true }),
        catch: () => new ContainerStartFailed(),
      });
    }),
  running: () => Effect.sync(() => container.running),
  port: (port) => container.getTcpPort(port),
  destroy: () =>
    Effect.tryPromise({
      try: () => container.destroy(),
      catch: () => new ContainerDestroyFailed(),
    }),
});
