import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { Config, Effect } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import CredsObject from "./creds/object.js";
import { apiHandler } from "./http/api.js";
import { chatGptHandler } from "./http/chatgpt.js";
import SessionObject, { SessionContainer } from "./session/object.js";

export default class ScottyWorker extends Cloudflare.Worker<ScottyWorker>()(
  "ScottyWorker",
  Effect.gen(function* () {
    const email = yield* Config.String("SCOTTY_OWNER_EMAIL");
    return {
      main: import.meta.url,
      compatibility: { date: "2026-09-01" },
      assets: { directory: "./ui/dist" },
      // Same key as the DO binding: Alchemy checks migrations per logical id, and a second id
      // for the one SessionObject class makes it re-create the class (docs/design.md "Deploy").
      env: { SessionObject: SessionContainer },
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
    yield* router.add("*", "/p/chatgpt/*", (request) =>
      chatGptHandler(request, credentials).pipe(Effect.provide(RuntimeContext.phantom)),
    );
    return { fetch: router.asHttpEffect().pipe(Effect.orDie) };
  }),
) {}
