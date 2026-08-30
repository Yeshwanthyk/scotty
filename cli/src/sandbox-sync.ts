import { Effect, Schema } from "effect";
import {
  CredentialRedactedMetadataSchema,
  type CredentialName,
  type CredentialRepositories,
  type CredentialScope,
} from "../../protocol/credentials";
import type { PiAuthStore } from "../../protocol/pi-auth";
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
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  activeDigest: Schema.NullOr(SandboxDigestSchema),
});
export type SandboxRemoteConfigStatus = typeof SandboxRemoteConfigStatusSchema.Type;

export type SandboxSyncTarget = ApiRequestTarget & {
  readonly host: string;
  readonly token: string;
};

export type ScottyCredentialSyncMaterial =
  | {
      readonly name: CredentialName;
      readonly kind: "pi-auth";
      readonly scope: "global";
      readonly providers: PiAuthStore;
    }
  | {
      readonly name: CredentialName;
      readonly kind: "github-cli";
      readonly scope: CredentialScope;
      readonly repositories?: CredentialRepositories;
      readonly token: string;
    };

const CredentialRegistrySyncResultSchema = Schema.Struct({
  credentials: Schema.Array(CredentialRedactedMetadataSchema),
});
const decodeCredentialRegistrySyncResult = Schema.decodeUnknownEffect(
  CredentialRegistrySyncResultSchema,
  { onExcessProperty: "error" },
);
const decodeSandboxRemoteConfigStatus = Schema.decodeUnknownEffect(SandboxRemoteConfigStatusSchema);

const sandboxBundleActivationConflict = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_activation_conflict", message, hint, EXIT.WRONG_STATE);
const sandboxBundleUploadFailed = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_upload_failed", message, hint, EXIT.GENERIC);
const sandboxBundleUnavailable = (message: string, hint: string): CliError =>
  new CliError("sandbox_bundle_unavailable", message, hint, EXIT.GENERIC);
const credentialRegistrySyncInvalid = (): CliError =>
  new CliError(
    "credential_registry_sync_invalid",
    "Credential registry input is invalid",
    "Fix the declared Pi auth material and retry scotty sync.",
    EXIT.USAGE,
  );
const credentialRegistrySyncUnavailable = (): CliError =>
  new CliError(
    "credential_registry_sync_unavailable",
    "Credential registry is unavailable",
    "Check the Worker and network, then retry scotty sync.",
    EXIT.GENERIC,
  );
const credentialRegistrySyncConflict = (): CliError =>
  new CliError(
    "credential_registry_sync_conflict",
    "Credential registry synchronization conflicted",
    "Retry scotty sync.",
    EXIT.WRONG_STATE,
  );

const credentialRegistrySyncPartial = (): CliError =>
  new CliError(
    "credential_registry_sync_partial",
    "Credentials committed, but bundle synchronization did not complete",
    "Credentials are committed; retry scotty sync so the operation converges.",
    EXIT.GENERIC,
  );

const credentialRegistrySyncFailed = (): CliError =>
  new CliError(
    "credential_registry_sync_failed",
    "Credential registry synchronization failed",
    "Retry scotty sync.",
    EXIT.GENERIC,
  );

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

const mapCredentialTransportError = (failure: CliError): CliError => {
  if (failure.code === "network_error" || failure.code === "timeout")
    return credentialRegistrySyncUnavailable();
  if (failure.code === "auth") return failure;
  if (failure.code === "bad_request") return credentialRegistrySyncInvalid();
  if (failure.code === "conflict") return credentialRegistrySyncConflict();
  return credentialRegistrySyncFailed();
};

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

export const synchronizeCredentialRegistry = Effect.fnUntraced(function* (input: {
  readonly target: SandboxSyncTarget;
  readonly credentials: ReadonlyArray<ScottyCredentialSyncMaterial>;
}) {
  const value = yield* requestJson(input.target, "/api/credentials/sync", {
    method: "POST",
    body: JSON.stringify({
      credentials: input.credentials,
    }),
  }).pipe(Effect.mapError(mapCredentialTransportError));
  return yield* decodeCredentialRegistrySyncResult(value).pipe(
    Effect.mapError(() => credentialRegistrySyncFailed()),
  );
});

export const synchronizeCredentialedScottyToml = Effect.fnUntraced(function* (input: {
  readonly target: SandboxSyncTarget;
  readonly built: BuiltSandboxBundle;
  readonly credentials: ReadonlyArray<ScottyCredentialSyncMaterial>;
}) {
  yield* synchronizeCredentialRegistry({ target: input.target, credentials: input.credentials });
  const remote = yield* synchronizeSandboxBundle({ target: input.target, built: input.built }).pipe(
    Effect.mapError(() => credentialRegistrySyncPartial()),
  );
  return { built: input.built, remote };
});
