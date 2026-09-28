import * as Cloudflare from "alchemy/Cloudflare";
import { RuntimeContext } from "alchemy";
import { Config, Effect, Exit, Option, Schema, SchemaTransformation } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { gitHandler } from "./creds/git.js";
import CredsObject from "./creds/object.js";
import { apiHandler, hatchPort } from "./http/api.js";
import SessionObject, { SessionArtifacts } from "./session/object.js";

// Set by the Session DO when it routes its container's github.internal and files.internal
// traffic here.
const LoopbackProps = Schema.Struct({ session: Schema.String, repo: Schema.String });
// A preview host is `<port>-<session id>.<SCOTTY_HATCH_BASE>`.
const hatchLabel = /^(\d{1,5})-([a-z0-9-]{6,32})$/;
// scotty-attach uploads: one of these types, at most 25 MB, name and caption URI-encoded.
const FileType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/webm",
  "video/mp4",
]);
const FileSize = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 25 * 1024 * 1024 }),
);
const encoded = (max: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max)),
      SchemaTransformation.stringFromUriComponent,
    ),
  );
const FileLabel = Schema.Struct({
  "x-scotty-name": encoded(255),
  "x-scotty-caption": Schema.optionalKey(encoded(2000)),
});
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
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(SessionArtifacts);
    const env = yield* Cloudflare.WorkerEnvironment;
    const hatchBase = yield* Config.String("SCOTTY_HATCH_BASE");
    const router = yield* HttpRouter.make;
    yield* router.add("*", "/api/*", (request) =>
      apiHandler(request, sessions, credentials, bucket, hatchBase).pipe(
        Effect.orDie,
        Effect.provide(RuntimeContext.phantom),
      ),
    );
    const api = router.asHttpEffect().pipe(Effect.orDie);
    // The bytes reach R2 before the Session DO records the file, so no event names missing bytes.
    const attach = (request: HttpServerRequest.HttpServerRequest, session: string) =>
      Effect.gen(function* () {
        const reply = (status: number, text: string) =>
          HttpServerResponse.text(`${text}\n`, { status });
        if (request.method !== "PUT") return reply(405, "Use PUT");
        const type = Schema.decodeUnknownOption(FileType)(request.headers["content-type"]);
        if (Option.isNone(type))
          return reply(415, "Type must be png, jpeg, webp, gif, webm or mp4");
        const size = Schema.decodeUnknownOption(FileSize)(request.headers["content-length"]);
        if (Option.isNone(size)) return reply(413, "File must be 1 byte to 25 MB");
        const label = Schema.decodeUnknownOption(FileLabel)(request.headers);
        if (Option.isNone(label)) return reply(400, "Bad file name or caption");
        const file = crypto.randomUUID().replaceAll("-", "");
        const body = (yield* HttpServerRequest.toWeb(request)).body;
        const stored = yield* Effect.exit(
          bucket.put(`files/${session}/${file}`, body, {
            httpMetadata: { contentType: type.value },
          }),
        );
        if (Exit.isFailure(stored)) return reply(502, "Could not store the file");
        const name = label.value["x-scotty-name"];
        const caption = label.value["x-scotty-caption"];
        const recorded = yield* Effect.exit(
          sessions.getByName(session).attach({
            file,
            name,
            type: type.value,
            size: size.value,
            ...(caption === undefined ? {} : { caption }),
          }),
        );
        if (Exit.isFailure(recorded)) return reply(502, "Could not record the file");
        return reply(200, `Attached: ${name}`);
      });
    return {
      fetch: Effect.gen(function* () {
        const exec = yield* Cloudflare.WorkerExecutionContext;
        const props = Schema.decodeUnknownOption(LoopbackProps)(exec.raw.props);
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (Option.isSome(props) && request.headers["host"] === "files.internal")
          return yield* attach(request, props.value.session).pipe(Effect.orDie);
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
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
