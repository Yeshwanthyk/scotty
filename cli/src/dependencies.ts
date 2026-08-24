import { isAbsolute, resolve } from "node:path";
import { Clock, Effect, Option, Result } from "effect";
import { decodeInstallationPreviewConfiguration } from "../../infra/installation";
import { CliError, EXIT, PENDING_UP_TTL_MS, type GlobalOptions } from "./core";
import {
  decodeJsonValue,
  decodePendingUp,
  decodeRawConfig,
  decodeString,
  decodeTrue,
  type Config,
  type BeamUpRequest,
  type PendingUp,
} from "./schemas";
import { CliRuntime, FileSystem } from "./services";
import { requestJson } from "./transport";
import { conflictSessionId, normalizeHost, stableUp, usage } from "./pure";
import { operationStatePath, rootCredentialPath, installationStatePath } from "./local-paths";

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
  const text = yield* fileSystem.readPrivateText(path).pipe(
    Effect.catch((error) => {
      if (error.reason === "missing") return Effect.succeed(undefined);
      if (
        error.reason === "permissions" ||
        error.reason === "not_file" ||
        error.reason === "symlink"
      )
        return Effect.fail(
          new CliError(
            "config_permissions",
            "Scotty config must be a private regular file",
            `Use a non-symlinked mode-0600 file at ${path}.`,
            EXIT.USAGE,
          ),
        );
      return Effect.fail(
        new CliError(
          "config_read_failed",
          "Could not read Scotty config",
          `Check permissions on ${path}.`,
          EXIT.GENERIC,
        ),
      );
    }),
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
  const previewBase = Option.getOrUndefined(decodeString(raw.value.previewBase));
  const previewZoneId = Option.getOrUndefined(decodeString(raw.value.previewZoneId));
  const evidenceEnabled = Option.getOrUndefined(decodeTrue(raw.value.evidenceEnabled));
  const adoptionManifestPath = Option.getOrUndefined(decodeString(raw.value.adoptionManifestPath));
  const hasPreviewInput =
    raw.value.previewBase !== undefined || raw.value.previewZoneId !== undefined;
  const hasEvidenceInput = raw.value.evidenceEnabled !== undefined;
  const preview = hasPreviewInput
    ? decodeInstallationPreviewConfiguration({ base: previewBase, zoneId: previewZoneId })
    : Option.none();
  if (
    (raw.value.version !== undefined &&
      raw.value.version !== 1 &&
      raw.value.version !== 2 &&
      raw.value.version !== 3) ||
    (hasPreviewInput &&
      ((raw.value.version !== 2 && raw.value.version !== 3) || Option.isNone(preview))) ||
    (raw.value.version === 3 && (Option.isNone(preview) || evidenceEnabled !== true)) ||
    (hasEvidenceInput && (raw.value.version !== 3 || evidenceEnabled !== true))
  )
    return yield* new CliError(
      "invalid_config",
      "Scotty config has an invalid versioned preview or evidence configuration",
      `Fix or rerun scotty recover for ${path}.`,
      EXIT.USAGE,
    );
  return {
    ...(raw.value.version === 1 || raw.value.version === 2 || raw.value.version === 3
      ? { version: raw.value.version }
      : {}),
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
    ...(Option.isNone(preview)
      ? {}
      : { previewBase: preview.value.base, previewZoneId: preview.value.zoneId }),
    ...(evidenceEnabled === true ? { evidenceEnabled: true as const } : {}),
    ...(adoptionManifestPath === undefined ? {} : { adoptionManifestPath }),
    ...(host === undefined ? {} : { host }),
    ...(token === undefined ? {} : { token }),
  } satisfies Config;
});

export const readRootCredential = Effect.fnUntraced(function* (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
) {
  const fileSystem = yield* FileSystem;
  const path = rootCredentialPath(home, env);
  const token = yield* fileSystem
    .readPrivateText(path)
    .pipe(
      Effect.mapError(
        () =>
          new CliError(
            "config_permissions",
            "Scotty root credential must be a private regular file",
            `Run scotty recover or use a non-symlinked mode-0600 file at ${path}.`,
            EXIT.USAGE,
          ),
      ),
    );
  const normalized = token.trim();
  if (normalized.length === 0)
    return yield* new CliError(
      "invalid_config",
      "Scotty root credential is empty",
      `Run scotty recover to replace ${path}.`,
      EXIT.USAGE,
    );
  return normalized;
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

export const pendingUpRequest = Effect.fnUntraced(function* (host: string, body: BeamUpRequest) {
  const runtime = yield* CliRuntime;
  const fileSystem = yield* FileSystem;
  const fingerprint = yield* sha256Hex(JSON.stringify([host, body]));
  const path = operationStatePath(runtime.home, runtime.env, `pending-up/${fingerprint}.json`);

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

const finalizePendingUp = Effect.fnUntraced(function* (
  pending: { readonly path: string },
  output: { readonly status: string },
) {
  if (output.status !== "provisioning") yield* clearPendingUp(pending.path);
});

export const sessionAbsent = Effect.fnUntraced(function* (
  auth: { readonly host: string; readonly token: string },
  sessionId: string,
) {
  const result = yield* Effect.result(
    requestJson(auth, `/api/sessions/${encodeURIComponent(sessionId)}`),
  );
  if (Result.isFailure(result)) {
    if (result.failure.code === "not_found") return true;
    return yield* result.failure;
  }
  return false;
});

export const beamUpSession = Effect.fnUntraced(function* (
  auth: { readonly host: string; readonly token: string },
  body: BeamUpRequest,
) {
  const create = (pending: { readonly key: string; readonly path: string }) =>
    requestJson(auth, "/api/sessions", {
      method: "POST",
      headers: { "idempotency-key": pending.key },
      body: JSON.stringify(body),
    }).pipe(Effect.flatMap((raw) => Effect.fromResult(stableUp(raw, auth.host))));

  let pending = yield* pendingUpRequest(auth.host, body);
  const created = yield* Effect.result(create(pending));
  if (Result.isSuccess(created)) {
    yield* finalizePendingUp(pending, created.success.output);
    return created.success;
  }

  const failure = created.failure;
  if (failure.code !== "conflict") return yield* failure;

  const sessionId = conflictSessionId(failure.message);
  if (sessionId === undefined) {
    yield* clearPendingUp(pending.path);
    return yield* failure;
  }

  const absent = yield* Effect.result(sessionAbsent(auth, sessionId));
  if (Result.isFailure(absent) || !absent.success) {
    yield* clearPendingUp(pending.path);
    return yield* failure;
  }

  yield* clearPendingUp(pending.path);
  pending = yield* pendingUpRequest(auth.host, body);
  const retried = yield* Effect.result(create(pending));
  if (Result.isFailure(retried)) {
    if (retried.failure.code === "conflict") yield* clearPendingUp(pending.path);
    return yield* retried.failure;
  }
  yield* finalizePendingUp(pending, retried.success.output);
  return retried.success;
});

export const credentials = Effect.fnUntraced(function* (options: GlobalOptions) {
  const runtime = yield* CliRuntime;
  const fileSystem = yield* FileSystem;
  let hostValue = options.host ?? runtime.env.SCOTTY_HOST;
  let token = runtime.env.SCOTTY_TOKEN;
  if (options.tokenFile) {
    const tokenPath = isAbsolute(options.tokenFile)
      ? options.tokenFile
      : resolve(runtime.cwd, options.tokenFile);
    token = yield* fileSystem.readPrivateText(tokenPath).pipe(
      Effect.mapError(
        () =>
          new CliError(
            "token_file_invalid",
            "Scotty token file must be a readable private regular file",
            `Use a non-symlinked mode-0600 file at ${tokenPath}.`,
            EXIT.USAGE,
          ),
      ),
      Effect.map((value) =>
        value.endsWith("\r\n")
          ? value.slice(0, -2)
          : value.endsWith("\n")
            ? value.slice(0, -1)
            : value,
      ),
    );
    if (!token)
      return yield* usage(
        "Scotty token file is empty",
        "Write the root token to the private file and retry.",
      );
  }
  if (!hostValue || !token) {
    const config = yield* readConfig(installationStatePath(runtime.home, runtime.env));
    hostValue ??= config.host;
    if (token === undefined)
      token = yield* readRootCredential(runtime.home, runtime.env).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
  }
  if (!hostValue)
    return yield* usage(
      "Scotty host is not configured",
      "Run scotty init or pass --host / SCOTTY_HOST.",
    );
  if (!token)
    return yield* usage(
      "Scotty token is not configured",
      "Run scotty init or pass --token-file / SCOTTY_TOKEN.",
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
