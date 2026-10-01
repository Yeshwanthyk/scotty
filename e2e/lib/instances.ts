import { BunServices } from "@effect/platform-bun";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { failure } from "../../cli/client.js";

const Instances = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String })),
);

// The stage's container instances as Cloudflare lists them, named by session id.
export const instances = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const app = process.env.SCOTTY_CONTAINER_APP_ID ?? "";
  const child = yield* spawner.spawn(
    ChildProcess.make("npx", ["wrangler", "containers", "instances", app, "--json"], {
      stdin: "ignore",
      stderr: "ignore",
    }),
  );
  const json = yield* child.stdout.pipe(Stream.decodeText(), Stream.mkString);
  return yield* Schema.decodeUnknownEffect(Instances)(json);
}).pipe(
  Effect.scoped,
  Effect.provide(BunServices.layer),
  Effect.mapError(() =>
    failure("setup", "Could not list container instances", "export SCOTTY_CONTAINER_APP_ID=<id>"),
  ),
);
