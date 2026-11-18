import type * as cf from "@cloudflare/workers-types";
import { Effect, Option, Schema } from "effect";
import { PlaceFailed, type Exit, type Place, type Port } from "./place.js";

import { isLoopback } from "../loopback.js";

const ExitStatus = Schema.Struct({ exitCode: Schema.Int });
const inactivityTimeout = 900_000;

const accepted: (response: object) => WebSocket | undefined = function accepted(response) {
  const candidate: unknown = Reflect.get(response, "webSocket");
  if (
    !(candidate instanceof WebSocket) ||
    !("accept" in candidate) ||
    typeof candidate.accept !== "function"
  )
    return undefined;
  candidate.accept();
  return candidate;
};

const tcpPort: (container: cf.Container, port: number) => Port = (container, port) => ({
  fetch: (url, init) => container.getTcpPort(port).fetch(url, init),
  socket: (url, headers, signal) => {
    const pending = container
      .getTcpPort(port)
      .fetch(url, { headers: { ...headers, Upgrade: "websocket" } });
    signal.addEventListener("abort", () =>
      pending.then(
        (late) => {
          accepted(late)?.close();
        },
        () => undefined,
      ),
    );
    return pending.then((response) => (signal.aborted ? undefined : accepted(response)));
  },
});

/**
 * The Session DO's own container. It never rests: pause destroys it and answers `gone`, so every
 * wake makes a new one and restores the save. The handle is the session id, since a Session DO
 * has one container.
 */
export const cloudflarePlace: (container: cf.Container, exports: object) => Place = (
  container,
  exports,
) => {
  const destroy = (op: "create" | "pause" | "remove") =>
    Effect.tryPromise({
      try: async () => {
        if (container.running) await container.destroy();
      },
      catch: () => new PlaceFailed({ op }),
    });
  return {
    create: (input) =>
      Effect.gen(function* () {
        yield* destroy("create");
        const loopback: unknown = Reflect.get(exports, "default");
        if (!isLoopback(loopback)) return yield* Effect.die("no ctx.exports.default");
        const fetcher = loopback({ props: { session: input.session, repo: input.repo } });
        yield* Effect.tryPromise({
          try: () =>
            Promise.all([
              container.interceptOutboundHttp("github.internal", fetcher),
              container.interceptOutboundHttp("files.internal", fetcher),
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
          catch: () => new PlaceFailed({ op: "create" }),
        });
        const image = container.images["session"];
        if (image === undefined) return yield* Effect.die("no session image in the image map");
        yield* Effect.try({
          try: () =>
            container.start({
              image,
              instance: input.size,
              enableInternet: true,
              env: { SCOTTY_SUPERVISOR_KEY: input.key },
            }),
          catch: () => new PlaceFailed({ op: "create" }),
        });
        return input.session;
      }),
    pause: () => destroy("pause").pipe(Effect.as("gone" as const)),
    resume: () => Effect.succeed("gone" as const),
    remove: () => destroy("remove"),
    status: () => Effect.sync(() => (container.running ? "running" : "gone")),
    port: (_handle, port) => tcpPort(container, port),
    tunnel: false,
    watch: () =>
      Effect.tryPromise({
        try: () => container.setInactivityTimeout(inactivityTimeout),
        catch: () => new PlaceFailed({ op: "watch" }),
      }).pipe(
        Effect.as(
          Effect.tryPromise({ try: () => container.monitor(), catch: (cause) => cause }).pipe(
            Effect.match({
              onSuccess: () => ({ reason: "exited" }) satisfies Exit,
              onFailure: (cause) =>
                Option.match(Schema.decodeUnknownOption(ExitStatus)(cause), {
                  onNone: () => ({ reason: "lost" }),
                  onSome: ({ exitCode }) => ({ reason: "crashed", exitCode }),
                }) satisfies Exit,
            }),
          ),
        ),
      ),
  };
};
