import { join } from "node:path";
import { Clock, Effect, Option, Result } from "effect";
import { CliError, EXIT, PENDING_UP_TTL_MS, type GlobalOptions, type JsonObject } from "./core";
import {
  decodeJsonValue,
  decodePendingUp,
  decodeRawConfig,
  decodeString,
  type Config,
  type PendingUp,
} from "./schemas";
import { CliRuntime, FileSystem } from "./services";
import { normalizeHost, usage } from "./pure";

export { cliLayer, defaultDependencies, type CliDependencies } from "./services";

const unexpected = (): CliError =>
  new CliError(
    "internal_error",
    "Scotty failed unexpectedly",
    "Retry with --json; if it persists, inspect the local error and Worker logs.",
    EXIT.GENERIC,
  );

export const readConfig = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem;
  const text = yield* fileSystem
    .readText(path)
    .pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.fail(
              new CliError(
                "config_read_failed",
                "Could not read Scotty config",
                `Check permissions on ${path}.`,
                EXIT.GENERIC,
              ),
            ),
      ),
    );
  if (text === undefined) return {};
  const json = decodeJsonValue(text);
  const raw = Option.isSome(json) ? decodeRawConfig(json.value) : Option.none();
  if (Option.isNone(raw))
    return yield* new CliError(
      "invalid_config",
      "Scotty config is not valid JSON",
      `Fix or rerun scotty init for ${path}.`,
      EXIT.USAGE,
    );
  const host = Option.getOrUndefined(decodeString(raw.value.host));
  const token = Option.getOrUndefined(decodeString(raw.value.token));
  const installationName = Option.getOrUndefined(decodeString(raw.value.installationName));
  const profile = Option.getOrUndefined(decodeString(raw.value.profile));
  const stackName = Option.getOrUndefined(decodeString(raw.value.stackName));
  const stage = Option.getOrUndefined(decodeString(raw.value.stage));
  const accountId = Option.getOrUndefined(decodeString(raw.value.accountId));
  const workerName = Option.getOrUndefined(decodeString(raw.value.workerName));
  const runnerWorkerName = Option.getOrUndefined(decodeString(raw.value.runnerWorkerName));
  const containerName = Option.getOrUndefined(decodeString(raw.value.containerName));
  const kvTitle = Option.getOrUndefined(decodeString(raw.value.kvTitle));
  const backupBucketName = Option.getOrUndefined(decodeString(raw.value.backupBucketName));
  const adoptionManifestPath = Option.getOrUndefined(decodeString(raw.value.adoptionManifestPath));
  return {
    ...(raw.value.version === 1 ? { version: 1 as const } : {}),
    ...(installationName === undefined ? {} : { installationName }),
    ...(profile === undefined ? {} : { profile }),
    ...(stackName === undefined ? {} : { stackName }),
    ...(stage === undefined ? {} : { stage }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(workerName === undefined ? {} : { workerName }),
    ...(runnerWorkerName === undefined ? {} : { runnerWorkerName }),
    ...(containerName === undefined ? {} : { containerName }),
    ...(kvTitle === undefined ? {} : { kvTitle }),
    ...(backupBucketName === undefined ? {} : { backupBucketName }),
    ...(adoptionManifestPath === undefined ? {} : { adoptionManifestPath }),
    ...(host === undefined ? {} : { host }),
    ...(token === undefined ? {} : { token }),
  } satisfies Config;
});

export const secureWrite = Effect.fnUntraced(function* (path: string, data: string) {
  const fileSystem = yield* FileSystem;
  return yield* fileSystem.writeSecure(path, data);
});

export const sha256Hex = (value: string): Effect.Effect<string, CliError> =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    catch: unexpected,
  }).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

export const readPendingUp = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem;
  const text = yield* fileSystem
    .readText(path)
    .pipe(
      Effect.catch((error) =>
        error.code === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(unexpected()),
      ),
    );
  if (text === undefined) return { exists: false };
  const json = decodeJsonValue(text);
  if (Option.isNone(json)) return { exists: true };
  const decoded = decodePendingUp(json.value);
  return Option.isSome(decoded) ? { exists: true, value: decoded.value } : { exists: true };
});

export const pendingUpRequest = Effect.fnUntraced(function* (host: string, body: JsonObject) {
  const runtime = yield* CliRuntime;
  const fileSystem = yield* FileSystem;
  const fingerprint = yield* sha256Hex(JSON.stringify([host, body]));
  const path = join(runtime.home, ".scotty", "pending-up", `${fingerprint}.json`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const stored = yield* readPendingUp(path);
    const createdAt = stored.value ? Date.parse(stored.value.createdAt) : Number.NaN;
    if (
      stored.value &&
      /^[0-9a-f-]{36}$/u.test(stored.value.key) &&
      Number.isFinite(createdAt) &&
      nowMillis - createdAt >= 0 &&
      nowMillis - createdAt < PENDING_UP_TTL_MS
    )
      return { key: stored.value.key, path };
    if (stored.exists)
      yield* fileSystem
        .remove(path)
        .pipe(
          Effect.catch((error) =>
            error.code === "ENOENT" ? Effect.void : Effect.fail(unexpected()),
          ),
        );

    const pending = {
      version: 1,
      key: crypto.randomUUID(),
      createdAt: new Date(nowMillis).toISOString(),
    } satisfies PendingUp;
    const written = yield* Effect.result(
      fileSystem.writeExclusive(path, `${JSON.stringify(pending)}\n`),
    );
    if (Result.isSuccess(written)) return { key: pending.key, path };
    if (written.failure.code !== "EEXIST") return yield* unexpected();
  }
  return yield* new CliError(
    "pending_request_conflict",
    "Could not establish a replay-safe session request",
    "Retry after the other Scotty up command finishes.",
    EXIT.GENERIC,
  );
});

export const clearPendingUp = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem;
  return yield* fileSystem
    .remove(path)
    .pipe(
      Effect.catch((error) => (error.code === "ENOENT" ? Effect.void : Effect.fail(unexpected()))),
    );
});

export const credentials = Effect.fnUntraced(function* (options: GlobalOptions) {
  const runtime = yield* CliRuntime;
  let hostValue = options.host ?? runtime.env.SCOTTY_HOST;
  let token = options.token ?? runtime.env.SCOTTY_TOKEN;
  if (!hostValue || !token) {
    const config = yield* readConfig(join(runtime.home, ".scotty.json"));
    hostValue ??= config.host;
    token ??= config.token;
  }
  if (!hostValue)
    return yield* usage(
      "Scotty host is not configured",
      "Run scotty init or pass --host / SCOTTY_HOST.",
    );
  if (!token)
    return yield* usage(
      "Scotty token is not configured",
      "Run scotty init or pass --token / SCOTTY_TOKEN.",
    );
  return { host: yield* Effect.fromResult(normalizeHost(hostValue)), token };
});

export const appendOnce = Effect.fnUntraced(function* (
  path: string,
  marker: string,
  content: string,
) {
  const fileSystem = yield* FileSystem;
  return yield* fileSystem.appendOnce(path, marker, content);
});
