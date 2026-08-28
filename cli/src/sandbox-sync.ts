import { Effect, Schema } from "effect";
import { CliError, EXIT } from "./core";
import { invalidResponse } from "./pure";
import {
  sandboxArchiveInvalid,
  sandboxBundleTooLarge,
  SandboxDigestSchema,
  type BuiltSandboxBundle,
} from "./sandbox-bundle";
import { type ApiRequestTarget, apiRequest, decodeJson, requestJson } from "./transport";

export const SandboxRemoteConfigStatusSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  activeDigest: Schema.NullOr(SandboxDigestSchema),
});
export type SandboxRemoteConfigStatus = typeof SandboxRemoteConfigStatusSchema.Type;

export type SandboxSyncTarget = ApiRequestTarget & {
  readonly host: string;
  readonly token: string;
};

const decodeSandboxRemoteConfigStatus = Schema.decodeUnknownEffect(SandboxRemoteConfigStatusSchema);

const sandboxBundleActivationConflict = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_activation_conflict", message, hint, EXIT.WRONG_STATE);

const sandboxBundleUploadFailed = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_upload_failed", message, hint, EXIT.GENERIC);

const sandboxBundleUnavailable = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_unavailable", message, hint, EXIT.GENERIC);

const mapSyncTransportError = (failure: CliError): CliError => {
  if (failure.code === "network_error" || failure.code === "timeout")
    return sandboxBundleUnavailable(failure.message, failure.hint);
  if (failure.code === "conflict")
    return sandboxBundleActivationConflict(failure.message, failure.hint);
  if (failure.code === "upstream") return sandboxBundleUploadFailed(failure.message, failure.hint);
  if (failure.code === "bad_request") {
    const lower = failure.message.toLowerCase();
    if (lower.includes("size") || lower.includes("limit") || lower.includes("exceed"))
      return sandboxBundleTooLarge(failure.message, failure.hint);
    return sandboxArchiveInvalid(failure.message, failure.hint);
  }
  return failure;
};

const withSyncTransportError = <A, R>(
  program: Effect.Effect<A, CliError, R>,
): Effect.Effect<A, CliError, R> => program.pipe(Effect.mapError(mapSyncTransportError));

const decodeStatusJson = Effect.fnUntraced(function* (value: unknown) {
  return yield* decodeSandboxRemoteConfigStatus(value).pipe(
    Effect.mapError(() => invalidResponse("Server returned invalid sandbox configuration")),
  );
});

const remoteSnapshot = (
  built: BuiltSandboxBundle,
  status: SandboxRemoteConfigStatus,
): { readonly status: "synchronized" | "diverged"; readonly activeDigest: string | null } => ({
  status: status.activeDigest === built.digest ? "synchronized" : "diverged",
  activeDigest: status.activeDigest,
});

const fetchRemoteConfiguration = Effect.fnUntraced(function* (target: SandboxSyncTarget) {
  const json = yield* withSyncTransportError(requestJson(target, "/api/sandbox/configuration"));
  return yield* decodeStatusJson(json);
});

const uploadSandboxBundle = Effect.fnUntraced(function* (
  target: SandboxSyncTarget,
  built: BuiltSandboxBundle,
  expectedRevision: number,
) {
  const { bytes } = yield* withSyncTransportError(
    apiRequest(target, `/api/sandbox/bundles/${built.digest}`, {
      method: "PUT",
      headers: {
        "content-type": "application/gzip",
        "if-match": String(expectedRevision),
        "idempotency-key": crypto.randomUUID(),
      },
      // lint-allow-double-cast: boundary: fetch BodyInit typings reject Uint8Array<ArrayBufferLike> views that Bun and Workers accept at runtime
      body: built.archive as unknown as BodyInit,
    }),
  );
  const json = yield* decodeJson(bytes);
  return yield* decodeStatusJson(json);
});

export const synchronizeSandboxBundle = Effect.fnUntraced(function* (input: {
  readonly target: SandboxSyncTarget;
  readonly built: BuiltSandboxBundle;
}) {
  const configuration = yield* fetchRemoteConfiguration(input.target);
  if (configuration.activeDigest === input.built.digest)
    return remoteSnapshot(input.built, configuration);
  const uploaded = yield* uploadSandboxBundle(input.target, input.built, configuration.revision);
  return remoteSnapshot(input.built, uploaded);
});

export const synchronizeScottyToml = Effect.fnUntraced(function* (input: {
  readonly built: BuiltSandboxBundle;
  readonly target: SandboxSyncTarget;
}) {
  const remote = yield* synchronizeSandboxBundle({ target: input.target, built: input.built });
  return { built: input.built, remote };
});
