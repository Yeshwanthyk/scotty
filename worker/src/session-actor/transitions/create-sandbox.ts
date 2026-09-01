import { Clock, Context, Effect, Layer, Predicate, Result, Schema } from "effect";
import type { CredentialGrant } from "../../../../protocol/credentials";
import { SandboxBundleMaterializer } from "../../sandbox/bundle-materializer";
import { ContainerAuth } from "../../sandbox/auth";
import type { SessionRuntimeCredentials } from "../../credentials/managed";
import { SandboxRuntime, type SandboxRuntimeFailure } from "../../sandbox/runtime";
import { SandboxDigestSchema } from "../../sandbox/config-contracts";
import { sessionRoot } from "../../sandbox/workspace";
import type { RuntimeProof, SessionAuthority } from "../authority";
import { SessionActorMetadataStore, type MetadataStoreMutationError } from "../metadata-store";
import {
  CreateProviderFailure,
  CreateTransitionProvider,
  type CreateProviderContext,
  type CreateTransition,
} from "./create";

const RuntimeStateSchema = Schema.Struct({
  status: Schema.Literals(["running", "healthy", "stopping", "stopped", "stopped_with_code"]),
});
const decodeRuntimeState = Schema.decodeUnknownResult(RuntimeStateSchema, {
  onExcessProperty: "ignore",
});
const RuntimeMaterializationMarkerSchema = Schema.Struct({
  attempt: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  payloadReference: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  bundleDigest: Schema.NullOr(SandboxDigestSchema),
  runtimeGeneration: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  providerRuntimeId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  containerIncarnation: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
});
type RuntimeMaterializationMarker = typeof RuntimeMaterializationMarkerSchema.Type;
const decodeRuntimeMaterializationMarker = Schema.decodeUnknownResult(
  Schema.fromJsonString(RuntimeMaterializationMarkerSchema),
  { onExcessProperty: "error" },
);

export class CreateSandboxBoundaryFailure extends Schema.TaggedError<CreateSandboxBoundaryFailure>()(
  "CreateSandboxBoundaryFailure",
  {
    outcome: Schema.Literals(["rejected_before_admission", "unknown_after_admission"]),
    safeResultCode: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  },
) {}

export interface CreateSandboxResolvedInput {
  readonly payloadReference: string;
  readonly runtimeGeneration: string;
  readonly sandboxBundleDigest: string | null;
  readonly githubHandle: string;
  readonly credentials: SessionRuntimeCredentials;
  readonly grants: ReadonlyArray<CredentialGrant>;
}

export interface CreateSandboxPreparedWorkspace {
  readonly workspaceId: string;
  readonly defaultBranch: string;
  readonly repositoryExists: boolean;
}

interface CreateSandboxBoundaryShape {
  readonly resolve: (
    authority: SessionAuthority,
    transition: CreateTransition,
    payloadReference: string,
  ) => Effect.Effect<CreateSandboxResolvedInput, CreateSandboxBoundaryFailure>;
  readonly prepareWorkspace: (
    authority: SessionAuthority,
    transition: CreateTransition,
    input: CreateSandboxResolvedInput,
  ) => Effect.Effect<CreateSandboxPreparedWorkspace, CreateSandboxBoundaryFailure>;
  readonly observeWorkspace: (
    authority: SessionAuthority,
    transition: CreateTransition,
    input: CreateSandboxResolvedInput,
  ) => Effect.Effect<CreateSandboxPreparedWorkspace | null, CreateSandboxBoundaryFailure>;
}

/**
 * Host-owned create inputs which cannot live in lifecycle authority: credential handles,
 * configured bundle identity, and the persisted Scotty runtime generation. Implementations must
 * fence every result to the supplied attempt and payload reference.
 */
export class CreateSandboxBoundary extends Context.Service<
  CreateSandboxBoundary,
  CreateSandboxBoundaryShape
>()("scotty/SessionActor/CreateSandboxBoundary") {}

export const createSandboxBoundaryLayer = (
  boundary: CreateSandboxBoundaryShape,
): Layer.Layer<CreateSandboxBoundary> =>
  Layer.succeed(CreateSandboxBoundary)(CreateSandboxBoundary.of(boundary));

const timestamp = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

const failure = (
  outcome: CreateProviderFailure["outcome"],
  safeResultCode: string,
  observedAt: string,
): CreateProviderFailure => new CreateProviderFailure({ outcome, safeResultCode, observedAt });

const beforeTransitionDeadline = Effect.fnUntraced(function* <A, E, R>(
  context: CreateProviderContext,
  safeResultCode: string,
  effect: Effect.Effect<A, E, R>,
) {
  const now = yield* Clock.currentTimeMillis;
  const deadline = Date.parse(context.transition.deadlineAt);
  const remaining = Math.max(1, deadline - now);
  return yield* effect.pipe(
    Effect.timeoutOrElse({
      duration: remaining,
      orElse: () =>
        Effect.fail(
          failure("unknown_after_admission", safeResultCode, new Date(now).toISOString()),
        ),
    }),
  );
});

const mapBoundaryFailure = (
  error: CreateSandboxBoundaryFailure,
  observedAt: string,
): CreateProviderFailure => failure(error.outcome, error.safeResultCode, observedAt);

const mapRuntimeFailure = (
  error: SandboxRuntimeFailure,
  safeResultCode: string,
  observedAt: string,
): CreateProviderFailure =>
  failure(
    error.reason === "transport" ? "unknown_after_admission" : "rejected_before_admission",
    safeResultCode,
    observedAt,
  );

const mapMetadataFailure = (
  error: MetadataStoreMutationError,
  observedAt: string,
): CreateProviderFailure =>
  failure(
    Predicate.isTagged(error, "MetadataStoreMutationOutcomeUnknown")
      ? "unknown_after_admission"
      : "rejected_before_admission",
    Predicate.isTagged(error, "MetadataStoreMutationOutcomeUnknown")
      ? "create_metadata_outcome_unknown"
      : "create_metadata_rejected",
    observedAt,
  );

const resolveInput = Effect.fnUntraced(function* (
  boundary: CreateSandboxBoundary["Service"],
  context: CreateProviderContext,
) {
  const observedAt = yield* timestamp;
  const input = yield* boundary
    .resolve(context.authority, context.transition, context.payload.reference)
    .pipe(Effect.mapError((error) => mapBoundaryFailure(error, observedAt)));
  if (input.payloadReference !== context.payload.reference || input.runtimeGeneration.length === 0)
    return yield* failure(
      "rejected_before_admission",
      "create_sandbox_input_fence_mismatch",
      observedAt,
    );
  return input;
});

const runtimeProof = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  context: CreateProviderContext,
  runtimeGeneration: string,
) {
  const observedAt = yield* timestamp;
  if (context.authority.session.execution.provider !== "cloudflare")
    return yield* failure(
      "rejected_before_admission",
      "create_runtime_provider_mismatch",
      observedAt,
    );
  const state = yield* runtime
    .getState()
    .pipe(
      Effect.mapError((error) =>
        mapRuntimeFailure(error, "create_runtime_state_unknown", observedAt),
      ),
    );
  const decoded = decodeRuntimeState(state);
  if (
    Result.isFailure(decoded) ||
    (decoded.success.status !== "running" && decoded.success.status !== "healthy")
  )
    return yield* failure("rejected_before_admission", "create_runtime_not_running", observedAt);
  const placementId = yield* runtime
    .getContainerPlacementId()
    .pipe(
      Effect.mapError((error) =>
        mapRuntimeFailure(error, "create_container_placement_unknown", observedAt),
      ),
    );
  if (placementId === null || placementId.length === 0)
    return yield* failure(
      "unknown_after_admission",
      "create_container_placement_unobserved",
      observedAt,
    );
  return {
    providerRuntimeId: context.authority.session.execution.runtimeName,
    runtimeGeneration,
    containerIncarnation: placementId,
  } satisfies RuntimeProof;
});

const currentRuntime = (
  context: CreateProviderContext,
  observedAt: string,
): Effect.Effect<RuntimeProof, CreateProviderFailure> => {
  const runtime = context.transition.proof.readiness.runtime;
  return runtime === null
    ? Effect.fail(failure("rejected_before_admission", "create_runtime_proof_missing", observedAt))
    : Effect.succeed(runtime);
};

const runtimeMaterializationMarkerPath = (sessionId: string): string =>
  `${sessionRoot(sessionId)}/.scotty/create-runtime-materialized.json`;

const lookupPayload = Effect.fnUntraced(function* (
  metadataStore: SessionActorMetadataStore["Service"],
  authority: SessionAuthority,
  transition: CreateTransition,
) {
  const observedAt = yield* timestamp;
  const metadata = yield* metadataStore
    .read(authority)
    .pipe(
      Effect.mapError(() =>
        failure("rejected_before_admission", "create_metadata_unavailable", observedAt),
      ),
    );
  const privateInput = metadata?.privateCreateInput;
  if (
    privateInput === undefined ||
    privateInput === null ||
    privateInput.attempt !== transition.attempt
  )
    return yield* failure(
      "rejected_before_admission",
      "create_private_payload_unavailable",
      observedAt,
    );
  return privateInput.payload;
});

export const createSandboxTransitionProviderLayer: Layer.Layer<
  CreateTransitionProvider,
  never,
  | CreateSandboxBoundary
  | SessionActorMetadataStore
  | SandboxBundleMaterializer
  | ContainerAuth
  | SandboxRuntime
> = Layer.effect(
  CreateTransitionProvider,
  Effect.gen(function* () {
    const boundary = yield* CreateSandboxBoundary;
    const metadataStore = yield* SessionActorMetadataStore;
    const materializer = yield* SandboxBundleMaterializer;
    const auth = yield* ContainerAuth;
    const runtime = yield* SandboxRuntime;

    const recordCredentialGrants = Effect.fnUntraced(function* (
      context: CreateProviderContext,
      input: CreateSandboxResolvedInput,
      observedAt: string,
    ) {
      const metadata = yield* metadataStore
        .read(context.authority)
        .pipe(
          Effect.mapError(() =>
            failure("rejected_before_admission", "create_metadata_unavailable", observedAt),
          ),
        );
      yield* metadataStore
        .recordObservation(context.authority, {
          _tag: "CredentialGrants",
          value: {
            attempt: context.transition.attempt,
            payloadReference: context.payload.reference,
            observedAt: metadata?.createObservations.credentialGrants?.observedAt ?? observedAt,
            grants: input.grants,
          },
        })
        .pipe(Effect.mapError((error) => mapMetadataFailure(error, observedAt)));
    });

    const recordWorkspace = Effect.fnUntraced(function* (
      context: CreateProviderContext,
      prepared: CreateSandboxPreparedWorkspace,
      observedAt: string,
    ) {
      yield* metadataStore
        .recordObservation(context.authority, {
          _tag: "Workspace",
          value: {
            attempt: context.transition.attempt,
            payloadReference: context.payload.reference,
            observedAt,
            workspaceId: prepared.workspaceId,
            repository: context.authority.session.repository,
            defaultBranch: prepared.defaultBranch,
            repositoryExists: prepared.repositoryExists,
          },
        })
        .pipe(Effect.mapError((error) => mapMetadataFailure(error, observedAt)));
      return {
        _tag: "WorkspacePrepared" as const,
        workspaceId: prepared.workspaceId,
        observedAt,
        resultCode: "create_workspace_prepared",
      };
    });

    const prepareWorkspace = Effect.fnUntraced(function* (context: CreateProviderContext) {
      const input = yield* resolveInput(boundary, context);
      const observedAt = yield* timestamp;
      yield* recordCredentialGrants(context, input, observedAt);
      const prepared = yield* boundary
        .prepareWorkspace(context.authority, context.transition, input)
        .pipe(
          Effect.mapError((error) => mapBoundaryFailure(error, observedAt)),
          (effect) => beforeTransitionDeadline(context, "create_workspace_timeout", effect),
        );
      return yield* recordWorkspace(context, prepared, observedAt);
    });

    const recordBundle = Effect.fnUntraced(function* (
      context: CreateProviderContext,
      digest: string | null,
      observedAt: string,
    ) {
      if (digest === null) return;
      yield* metadataStore
        .recordObservation(context.authority, {
          _tag: "Bundle",
          value: {
            attempt: context.transition.attempt,
            payloadReference: context.payload.reference,
            observedAt,
            digest,
          },
        })
        .pipe(Effect.mapError((error) => mapMetadataFailure(error, observedAt)));
    });

    const runtimeMaterializedResult = Effect.fnUntraced(function* (
      context: CreateProviderContext,
      digest: string | null,
      proof: RuntimeProof,
      observedAt: string,
    ) {
      yield* recordBundle(context, digest, observedAt);
      return {
        _tag: "RuntimeMaterialized" as const,
        runtime: proof,
        observedAt,
        resultCode: "create_runtime_materialized",
      };
    });

    const materializeRuntime = Effect.fnUntraced(function* (context: CreateProviderContext) {
      const input = yield* resolveInput(boundary, context);
      const observedAt = yield* timestamp;
      const materialized = yield* beforeTransitionDeadline(
        context,
        "create_bundle_materialization_timeout",
        materializer.materialize({
          sessionId: context.authority.session.id,
          digest: input.sandboxBundleDigest,
        }),
      ).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "CreateProviderFailure")
            ? error
            : failure(
                error.reason === "runtime" || error.reason === "upstream"
                  ? "unknown_after_admission"
                  : "rejected_before_admission",
                `create_bundle_${error.reason}`,
                observedAt,
              ),
        ),
      );
      const metadata = yield* metadataStore
        .read(context.authority)
        .pipe(
          Effect.mapError(() =>
            failure("rejected_before_admission", "create_metadata_unavailable", observedAt),
          ),
        );
      const initialPrompt = metadata?.privateCreateInput?.initialPrompt;
      if (initialPrompt === undefined)
        return yield* failure(
          "rejected_before_admission",
          "create_private_payload_unavailable",
          observedAt,
        );
      const seedOptions = {
        initialPrompt,
        items: materialized.items,
        bundleRoot: materialized.bundleRoot,
      };
      yield* beforeTransitionDeadline(
        context,
        "create_runtime_seed_timeout",
        auth.seed(context.authority.session.id, input.credentials, seedOptions),
      ).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "CreateProviderFailure")
            ? error
            : mapRuntimeFailure(error, "create_runtime_seed_failed", observedAt),
        ),
      );
      yield* beforeTransitionDeadline(
        context,
        "create_runtime_preflight_timeout",
        auth.preflight(context.authority.session.id, input.credentials, seedOptions),
      ).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "CreateProviderFailure")
            ? error
            : mapRuntimeFailure(error, "create_runtime_preflight_failed", observedAt),
        ),
      );
      const proof = yield* runtimeProof(runtime, context, input.runtimeGeneration);
      const marker: RuntimeMaterializationMarker = {
        attempt: context.transition.attempt,
        payloadReference: context.payload.reference,
        bundleDigest: materialized.digest,
        runtimeGeneration: proof.runtimeGeneration,
        providerRuntimeId: proof.providerRuntimeId,
        containerIncarnation: proof.containerIncarnation,
      };
      yield* beforeTransitionDeadline(
        context,
        "create_runtime_marker_timeout",
        runtime.mkdir(`${sessionRoot(context.authority.session.id)}/.scotty`, {
          recursive: true,
        }),
      ).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "CreateProviderFailure")
            ? error
            : mapRuntimeFailure(error, "create_runtime_marker_directory_failed", observedAt),
        ),
      );
      yield* beforeTransitionDeadline(
        context,
        "create_runtime_marker_timeout",
        runtime.writeFile(
          runtimeMaterializationMarkerPath(context.authority.session.id),
          `${JSON.stringify(marker)}\n`,
        ),
      ).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "CreateProviderFailure")
            ? error
            : mapRuntimeFailure(error, "create_runtime_marker_write_unknown", observedAt),
        ),
      );
      return yield* runtimeMaterializedResult(context, materialized.digest, proof, observedAt);
    });

    const confirmRuntimeReady = Effect.fnUntraced(function* (context: CreateProviderContext) {
      const input = yield* resolveInput(boundary, context);
      const observedAt = yield* timestamp;
      const proof = yield* runtimeProof(runtime, context, input.runtimeGeneration);
      return {
        _tag: "RuntimeReadyConfirmed" as const,
        runtime: proof,
        observedAt,
        resultCode: "create_runtime_ready",
      };
    });

    const startSupervisor = Effect.fnUntraced(function* (context: CreateProviderContext) {
      const input = yield* resolveInput(boundary, context);
      const observedAt = yield* timestamp;
      const processId = yield* beforeTransitionDeadline(
        context,
        "create_supervisor_start_timeout",
        auth.startPiSession(context.authority.session.id, input.credentials),
      ).pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "CreateProviderFailure")
            ? error
            : mapRuntimeFailure(error, "create_supervisor_start_unknown", observedAt),
        ),
      );
      return {
        _tag: "SupervisorStarted" as const,
        processId,
        observedAt,
        resultCode: "create_supervisor_started",
      };
    });

    const confirmSupervisorReady = Effect.fnUntraced(function* (context: CreateProviderContext) {
      const observedAt = yield* timestamp;
      const runtimeProofValue = yield* currentRuntime(context, observedAt);
      const health = yield* auth
        .readPiSessionHealth(context.authority.session.id)
        .pipe(
          Effect.mapError((error) =>
            mapRuntimeFailure(error, "create_supervisor_health_failed", observedAt),
          ),
        );
      return {
        _tag: "SupervisorReadyConfirmed" as const,
        supervisor: {
          processId: health.processId,
          supervisorEpoch: health.epoch,
          runtimeGeneration: runtimeProofValue.runtimeGeneration,
          containerIncarnation: runtimeProofValue.containerIncarnation,
        },
        observedAt,
        resultCode: "create_supervisor_ready",
      };
    });

    const verifyTransport = Effect.fnUntraced(function* (context: CreateProviderContext) {
      const observedAt = yield* timestamp;
      const runtimeProofValue = yield* currentRuntime(context, observedAt);
      const supervisor = context.transition.proof.readiness.supervisor;
      if (supervisor === null)
        return yield* failure(
          "rejected_before_admission",
          "create_supervisor_proof_missing",
          observedAt,
        );
      const snapshot = yield* auth
        .verifyPiSessionSnapshot(context.authority.session.id, supervisor.supervisorEpoch)
        .pipe(
          Effect.mapError((error) =>
            mapRuntimeFailure(error, "create_transport_verification_failed", observedAt),
          ),
        );
      if (snapshot.processId !== supervisor.processId)
        return yield* failure(
          "rejected_before_admission",
          "create_transport_process_mismatch",
          observedAt,
        );
      return {
        _tag: "TransportVerified" as const,
        transport: {
          transportId: `pi:${snapshot.processId}`,
          supervisorEpoch: snapshot.epoch,
          runtimeGeneration: runtimeProofValue.runtimeGeneration,
          containerIncarnation: runtimeProofValue.containerIncarnation,
        },
        observedAt,
        resultCode: "create_transport_verified",
      };
    });

    const reconcile = Effect.fnUntraced(function* (context: CreateProviderContext) {
      if (context.transition.phase === "IntentCommitted") {
        const observedAt = yield* timestamp;
        return {
          _tag: "PayloadResolved" as const,
          observedAt,
          resultCode: "create_payload_reconciled",
        };
      }
      if (context.transition.phase === "WorkspacePreparing") {
        const input = yield* resolveInput(boundary, context);
        const observedAt = yield* timestamp;
        yield* recordCredentialGrants(context, input, observedAt);
        const prepared = yield* boundary
          .observeWorkspace(context.authority, context.transition, input)
          .pipe(Effect.mapError((error) => mapBoundaryFailure(error, observedAt)));
        return prepared === null
          ? yield* failure(
              "unknown_after_admission",
              "create_workspace_reconciliation_unknown",
              observedAt,
            )
          : yield* recordWorkspace(context, prepared, observedAt);
      }
      if (context.transition.phase === "RuntimeMaterializing") {
        const input = yield* resolveInput(boundary, context);
        const observedAt = yield* timestamp;
        const markerBytes = yield* runtime
          .readFile(runtimeMaterializationMarkerPath(context.authority.session.id), 4_096)
          .pipe(
            Effect.mapError(() =>
              failure(
                "unknown_after_admission",
                "create_runtime_materialization_marker_unobserved",
                observedAt,
              ),
            ),
          );
        const decoded = decodeRuntimeMaterializationMarker(new TextDecoder().decode(markerBytes));
        if (
          Result.isFailure(decoded) ||
          decoded.success.attempt !== context.transition.attempt ||
          decoded.success.payloadReference !== context.payload.reference ||
          decoded.success.bundleDigest !== input.sandboxBundleDigest ||
          decoded.success.runtimeGeneration !== input.runtimeGeneration
        )
          return yield* failure(
            "unknown_after_admission",
            "create_runtime_materialization_marker_mismatch",
            observedAt,
          );
        const proof = yield* runtimeProof(runtime, context, input.runtimeGeneration);
        if (
          decoded.success.providerRuntimeId !== proof.providerRuntimeId ||
          decoded.success.containerIncarnation !== proof.containerIncarnation
        )
          return yield* failure(
            "unknown_after_admission",
            "create_runtime_materialization_runtime_mismatch",
            observedAt,
          );
        return yield* runtimeMaterializedResult(
          context,
          decoded.success.bundleDigest,
          proof,
          observedAt,
        );
      }
      if (context.transition.phase === "SupervisorStarting") {
        const observedAt = yield* timestamp;
        const health = yield* auth
          .readPiSessionHealth(context.authority.session.id)
          .pipe(
            Effect.mapError((error) =>
              mapRuntimeFailure(
                error,
                "create_supervisor_start_reconciliation_unknown",
                observedAt,
              ),
            ),
          );
        return {
          _tag: "SupervisorStarted" as const,
          processId: health.processId,
          observedAt,
          resultCode: "create_supervisor_start_reconciled",
        };
      }
      if (context.transition.phase === "RuntimeReady") return yield* confirmRuntimeReady(context);
      if (context.transition.phase === "SupervisorReady")
        return yield* confirmSupervisorReady(context);
      if (context.transition.phase === "TransportVerifying") return yield* verifyTransport(context);
      const observedAt = yield* timestamp;
      return yield* failure(
        "unknown_after_admission",
        "create_reconciliation_requires_decisive_observation",
        observedAt,
      );
    });

    return CreateTransitionProvider.of({
      lookupPayload: (authority, transition) => lookupPayload(metadataStore, authority, transition),
      prepareWorkspace,
      materializeRuntime,
      confirmRuntimeReady,
      startSupervisor,
      confirmSupervisorReady,
      verifyTransport,
      reconcile,
    });
  }),
);
