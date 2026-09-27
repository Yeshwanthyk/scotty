import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { Config, Effect, Option, Schema } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { gitHandler } from "./creds/git.js";
import CredsObject from "./creds/object.js";
import { apiHandler } from "./http/api.js";
import SessionObject from "./session/object.js";

// Set by the Session DO when it routes its container's github.internal traffic here.
const LoopbackProps = Schema.Struct({ session: Schema.String, repo: Schema.String });

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
        runWorkerFirst: ["/api/*"],
      },
      access: {
        policies: [{ decision: "allow" as const, include: [{ email: { email } }] }],
      },
    };
  }),
  Effect.gen(function* () {
    const sessions = yield* SessionObject;
    const credentials = yield* CredsObject;
    const router = yield* HttpRouter.make;
    yield* router.add("*", "/api/*", (request) =>
      apiHandler(request, sessions, credentials).pipe(
        Effect.orDie,
        Effect.provide(RuntimeContext.phantom),
      ),
    );
    const api = router.asHttpEffect().pipe(Effect.orDie);
    return {
      fetch: Effect.gen(function* () {
        const exec = yield* Cloudflare.WorkerExecutionContext;
        const props = Schema.decodeUnknownOption(LoopbackProps)(exec.raw.props);
        if (Option.isNone(props)) return yield* api;
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* gitHandler(request, props.value.repo, credentials).pipe(Effect.orDie);
      }),
    };
  }),
) {}
