import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { Config, Effect } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import CredsObject from "./creds/object.js";
import { apiHandler } from "./http/api.js";
import SessionObject from "./session/object.js";

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
    return { fetch: router.asHttpEffect().pipe(Effect.orDie) };
  }),
) {}
