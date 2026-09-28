import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { Config, Effect, Option, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { gitHandler } from "./creds/git.js";
import CredsObject from "./creds/object.js";
import { apiHandler, hatchPort } from "./http/api.js";
import SessionObject from "./session/object.js";

// Set by the Session DO when it routes its container's github.internal traffic here.
const LoopbackProps = Schema.Struct({ session: Schema.String, repo: Schema.String });
// A preview host is `<port>-<session id>.<SCOTTY_HATCH_BASE>`.
const hatchLabel = /^(\d{1,5})-([a-z0-9-]{6,32})$/;
const isFetcher = (value: unknown): value is Cloudflare.Fetcher["raw"] =>
  typeof value === "object" && value !== null && "fetch" in value;

export default class ScottyWorker extends Cloudflare.Worker<ScottyWorker>()(
  "ScottyWorker",
  Effect.gen(function* () {
    // Props are evaluated in the deployed bundle too, where deploy env vars are absent.
    // alchemy.run.ts rejects a missing value before any deploy, so the default is runtime-only.
    const email = yield* Config.String("SCOTTY_OWNER_EMAIL").pipe(Config.withDefault(""));
    return {
      main: import.meta.url,
      compatibility: { date: "2026-09-01" },
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
    const env = yield* Cloudflare.WorkerEnvironment;
    const hatchBase = yield* Config.String("SCOTTY_HATCH_BASE");
    const router = yield* HttpRouter.make;
    yield* router.add("*", "/api/*", (request) =>
      apiHandler(request, sessions, credentials, hatchBase).pipe(
        Effect.orDie,
        Effect.provide(RuntimeContext.phantom),
      ),
    );
    const api = router.asHttpEffect().pipe(Effect.orDie);
    return {
      fetch: Effect.gen(function* () {
        const exec = yield* Cloudflare.WorkerExecutionContext;
        const props = Schema.decodeUnknownOption(LoopbackProps)(exec.raw.props);
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (Option.isSome(props))
          return yield* gitHandler(request, props.value.repo, credentials).pipe(Effect.orDie);
        const host = request.headers["host"] ?? "";
        if (host.endsWith(`.${hatchBase}`)) {
          const label = hatchLabel.exec(host.slice(0, -hatchBase.length - 1));
          if (label?.[1] === undefined || label[2] === undefined || !hatchPort(Number(label[1])))
            return HttpServerResponse.text("Not found", { status: 404 });
          return yield* sessions.getByName(label[2]).fetch(request).pipe(Effect.orDie);
        }
        if (new URL(request.url, "https://scotty.internal").pathname.startsWith("/api/"))
          return yield* api;
        const assets: unknown = env["ASSETS"];
        if (!isFetcher(assets)) return yield* Effect.die("ASSETS binding missing");
        return yield* Cloudflare.fromCloudflareFetcher(assets).fetch(request).pipe(Effect.orDie);
      }),
    };
  }),
) {}
