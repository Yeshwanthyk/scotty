import type * as cf from "@cloudflare/workers-types";
import { Effect, Option, Schema } from "effect";
import { PlaceFailed, type Exit, type Place, type Port } from "./place.js";

import { isLoopback } from "../loopback.js";

// workerd rejects monitor() with the exit code when a container exits non-zero.
const ExitStatus = Schema.Struct({ exitCode: Schema.Int });
// How long a container outlives its evicted Session DO; longer than the watch deadline, so the
// alarm wakes the Session DO before Cloudflare stops the container.
const inactivityTimeout = 900_000;

// Accepts and returns the upgraded socket on a response, if the far end accepted the upgrade.
function accepted(response: object): WebSocket | undefined {
  const candidate: unknown = Reflect.get(response, "webSocket");
  if (
    !(candidate instanceof WebSocket) ||
    !("accept" in candidate) ||
    typeof candidate.accept !== "function"
  )
    return undefined;
  candidate.accept();
  return candidate;
}

const tcpPort = (container: cf.Container, port: number): Port => ({
  fetch: (url, init) => container.getTcpPort(port).fetch(url, init),
  socket: (url, headers, signal) => {
    const pending = container
      .getTcpPort(port)
      .fetch(url, { headers: { ...headers, Upgrade: "websocket" } });
    // A dial given up on still resolves later; close that socket.
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
export const cloudflarePlace = (container: cf.Container, exports: object): Place => {
  const destroy = (op: "create" | "pause" | "remove") =>
    Effect.tryPromise({
      try: async () => {
        if (container.running) await container.destroy();
      },
      catch: () => new PlaceFailed({ op }),
    });
  return {
    // A running container is from a create whose reply was lost, or from a generation that
    // stopped without its place answering; either way the new one replaces it, so there is
    // still one machine.
    create: (input) =>
      Effect.gen(function* () {
        yield* destroy("create");
        // A new container needs the interceptor; Alchemy's wrapper drops this promise.
        const loopback: unknown = Reflect.get(exports, "default");
        if (!isLoopback(loopback)) return yield* Effect.die("no ctx.exports.default");
        const fetcher = loopback({ props: { session: input.session, repo: input.repo } });
        yield* Effect.tryPromise({
          try: () =>
            Promise.all([
              container.interceptOutboundHttp("github.internal", fetcher),
              container.interceptOutboundHttp("files.internal", fetcher),
              // gh: TLS ends at Cloudflare, so the Worker can swap in the token and check it.
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
        // The deployer names the release's image `session` in the Worker's image map. A start
        // without `instance` gets `lite`, so the size is always named.
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
    // monitor() settles at once for a container not yet placed, so the Session DO watches only
    // once the supervisor answered. The inactivity timeout keeps the container running while the
    // Session DO is evicted, until the watch deadline's alarm brings it back.
    watch: () =>
      Effect.tryPromise({
        try: () => container.setInactivityTimeout(inactivityTimeout),
        catch: () => new PlaceFailed({ op: "watch" }),
      }).pipe(
        Effect.as(
          // monitor() resolves on a clean exit and rejects with the exit code on a crash. Any
          // other rejection (the Session DO losing its link to the container) says nothing.
          Effect.tryPromise({ try: () => container.monitor(), catch: (cause) => cause }).pipe(
            Effect.match({
              onSuccess: (): Exit => ({ reason: "exited" }),
              onFailure: (cause): Exit =>
                Option.match(Schema.decodeUnknownOption(ExitStatus)(cause), {
                  onNone: () => ({ reason: "lost" }),
                  onSome: ({ exitCode }) => ({ reason: "crashed", exitCode }),
                }),
            }),
          ),
        ),
      ),
  };
};
