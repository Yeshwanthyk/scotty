import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schema } from "effect";
import { failure } from "./client.js";

const Hostname = Schema.String.check(Schema.isPattern(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/));

// What `scotty init` asked, so `deploy` and every other command need no environment.
// Names and ids only; never a token. Scotty is served at https://<host>, previews at
// https://<port>-<id>.<domain>. Resource names start with `scotty-<stage>`.
export const Config = Schema.Struct({
  stage: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,19}$/)),
  email: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/)),
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  domain: Hostname,
  zoneId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  host: Hostname,
});
export type Config = typeof Config.Type;

export const configPath = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "scotty",
  "config.json",
);

// Undefined when there is no config yet; a config that doesn't decode is a setup error.
export const readConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(configPath))) return undefined;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Config))(
    yield* fs.readFileString(configPath),
  );
}).pipe(
  Effect.provide(BunServices.layer),
  Effect.mapError(() =>
    failure("setup", `${configPath} is not a valid Scotty config`, "scotty init", 3),
  ),
);

export const writeConfig = (config: Config) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirname(configPath), { recursive: true });
    yield* fs.writeFileString(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError(() => failure("setup", `Could not write ${configPath}`, "scotty init", 3)),
  );

export const removeConfig = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(configPath, { force: true });
}).pipe(
  Effect.provide(BunServices.layer),
  Effect.mapError(() => failure("setup", `Could not remove ${configPath}`, "scotty teardown", 3)),
);
