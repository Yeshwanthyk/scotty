import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext, Stack } from "alchemy";
import { Config, Effect, Option, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { fireRun } from "./automations/fire.js";
import CredsObject from "./creds/object.js";
import {
  egress,
  egressPrefix,
  egressRoute,
  LoopbackProps,
  loopbackTarget,
} from "./egress/handler.js";
import { hookHandler, hookPath } from "./hooks/handler.js";
import { apiHandler, hatchPort } from "./http/api.js";
import { mcpHandler } from "./mcp/server.js";
import SessionObject, { SessionArtifacts } from "./session/object.js";

// Set by the Creds DO's alarm when it hands over an automation run to fire.
const RunProps = Schema.Struct({ run: Schema.String });
// A preview host is `<port>-<session id>.<SCOTTY_HATCH_BASE>`.
const hatchLabel = /^(\d{1,5})-([a-z0-9-]{6,32})$/;
const terminalPath = /^\/api\/sessions\/([a-z0-9-]{6,32})\/terminal$/;
// The session list's live socket, or one session's.
const livePath = /^\/api\/sessions\/(?:([a-z0-9-]{6,32})\/)?live$/;
const isFetcher = (value: unknown): value is Cloudflare.Fetcher["raw"] =>
  typeof value === "object" &&
  value !== null &&
  "fetch" in value &&
  typeof value.fetch === "function";

export default class ScottyWorker extends Cloudflare.Worker<ScottyWorker>()(
  "ScottyWorker",
  Effect.gen(function* () {
    // Props are evaluated in the deployed bundle, where only the runtime uses them; deploy/deployer.ts
    // makes the resources these describe.
    const email = yield* Config.String("SCOTTY_OWNER_EMAIL").pipe(Config.withDefault(""));
    const host = yield* Config.String("SCOTTY_HOST").pipe(Config.withDefault(""));
    const zoneId = yield* Config.String("SCOTTY_HATCH_ZONE_ID").pipe(Config.withDefault(""));
    const { stage } = yield* Stack;
    return {
      name: `scotty-${stage}`,
      main: import.meta.url,
      domain: { name: host, zoneId },
      compatibility: {
        date: "2026-09-01",
        flags: ["enable_request_signal", "global_fetch_strictly_public"],
      },
      assets: {
        directory: "./ui/dist",
        notFoundHandling: "single-page-application",
        // Preview hosts must reach the Worker, not the SPA fallback; the UI is served via ASSETS.
        runWorkerFirst: true,
      },
      access: {
        policies: [{ decision: "allow" as const, include: [{ email: { email } }] }],
      },
    };
  }),
  Effect.gen(function* () {
    const sessions = yield* SessionObject;
    const credentials = yield* CredsObject;
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(SessionArtifacts);
    const env = yield* Cloudflare.WorkerEnvironment;
    const hatchBase = yield* Config.String("SCOTTY_HATCH_BASE");
    // Scotty's own host is under the preview base too, but is never a preview.
    const selfHost = yield* Config.String("SCOTTY_HOST");
    const router = yield* HttpRouter.make;
    yield* router.add("*", "/api/*", (request) =>
      apiHandler(request, sessions, credentials, bucket, hatchBase).pipe(
        Effect.orDie,
        Effect.provide(RuntimeContext.phantom),
      ),
    );
    // Sender-signed, not Access-signed: Access bypasses this path alone.
    yield* router.add("*", "/hooks/*", (request) =>
      Effect.gen(function* () {
        const name = hookPath.exec(new URL(request.url, "https://scotty.internal").pathname)?.[1];
        if (name === undefined) return HttpServerResponse.text("Not found", { status: 404 });
        return yield* hookHandler(request, name, sessions, credentials);
      }).pipe(Effect.orDie, Effect.provide(RuntimeContext.phantom)),
    );
    const api = router.asHttpEffect().pipe(Effect.orDie);
    const upstreams = { sessions, credentials, bucket };
    return {
      fetch: Effect.gen(function* () {
        const exec = yield* Cloudflare.WorkerExecutionContext;
        const run = Schema.decodeUnknownOption(RunProps)(exec.raw.props);
        if (Option.isSome(run))
          return yield* fireRun(sessions, credentials.getByName("owner"), run.value.run).pipe(
            Effect.as(HttpServerResponse.empty()),
            Effect.orDie,
          );
        const props = Schema.decodeUnknownOption(LoopbackProps)(exec.raw.props);
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (Option.isSome(props))
          return yield* egress(
            request,
            props.value,
            loopbackTarget(props.value, request.headers["host"]),
            upstreams,
          );
        const host = request.headers["host"] ?? "";
        if (host !== selfHost && host.endsWith(`.${hatchBase}`)) {
          const label = hatchLabel.exec(host.slice(0, -hatchBase.length - 1));
          if (label?.[1] === undefined || label[2] === undefined || !hatchPort(Number(label[1])))
            return HttpServerResponse.text("Not found", { status: 404 });
          return yield* sessions.getByName(label[2]).fetch(request).pipe(Effect.orDie);
        }
        const url = new URL(request.url, "https://scotty.internal");
        const terminal = terminalPath.exec(url.pathname)?.[1];
        const live = livePath.exec(url.pathname);
        // A page on another site can't open these sockets, or change anything through the API, with the owner's Access cookie.
        const origin = request.headers["origin"];
        const foreign = origin !== undefined && origin !== `https://${host}`;
        if (
          foreign &&
          url.pathname.startsWith("/api/") &&
          request.method !== "GET" &&
          request.method !== "HEAD"
        )
          return HttpServerResponse.text("Forbidden", { status: 403 });
        if (url.pathname.startsWith(egressPrefix)) return yield* egressRoute(request, upstreams);
        // Access Managed OAuth signs MCP clients in on its own app for this path.
        if (url.pathname === "/mcp") {
          if (foreign) return HttpServerResponse.text("Forbidden", { status: 403 });
          return yield* mcpHandler(request, sessions, credentials, bucket, hatchBase).pipe(
            Effect.orDie,
          );
        }
        if (terminal !== undefined) {
          if (foreign) return HttpServerResponse.text("Forbidden", { status: 403 });
          return yield* sessions.getByName(terminal).fetch(request).pipe(Effect.orDie);
        }
        if (live !== null && request.method === "GET") {
          if (foreign) return HttpServerResponse.text("Forbidden", { status: 403 });
          const owner = credentials.getByName("owner");
          const id = live[1];
          if (id === undefined) return yield* owner.fetch(request).pipe(Effect.orDie);
          if (!(yield* owner.hasSession(id).pipe(Effect.orDie)))
            return HttpServerResponse.text("Not found", { status: 404 });
          return yield* sessions.getByName(id).fetch(request).pipe(Effect.orDie);
        }
        if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/hooks/"))
          return yield* api;
        const assets: unknown = env["ASSETS"];
        if (!isFetcher(assets)) return yield* Effect.die("ASSETS binding missing");
        return yield* Cloudflare.fromCloudflareFetcher(assets).fetch(request).pipe(Effect.orDie);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
