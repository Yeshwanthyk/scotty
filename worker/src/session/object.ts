import { Sandbox as BaseSandbox, streamFile } from "@cloudflare/sandbox";
import {
  decodePiConsoleCommandPromise,
  decodePiConsoleRelaySnapshot,
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_MAX_RESPONSE_BYTES,
  PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER,
  PI_CONSOLE_PROXY_PREFIX,
  type PiConsoleCommand,
  type PiConsoleStaleCommand,
  type PiConsoleUnavailable,
} from "../../../protocol/pi-console";
import { sessionTerminalId } from "../../../protocol/session-terminal";
import { parseManagedHandle, type ManagedHandle } from "../../../protocol/credentials";
import {
  Clock,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Result,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BackupStore, backupStoreLayer } from "../backups/store";
import {
  ArtifactStore,
  artifactStoreLayer,
  r2ArtifactStoreCapabilities,
  type PreparedEvidenceFrame,
} from "../evidence/artifact-store";
import { ContainerEvidenceRecorder, containerEvidenceRecorderLayer } from "../evidence/recorder";
import { EvidenceStore, evidenceStoreLayer } from "../evidence/store";
import {
  HatchStore,
  durableObjectHatchStateStorage,
  hatchStoreLayer,
  type HatchCleanupAuthority,
  type HatchRestoreFence,
  type HatchWebSocketAuthorization,
} from "../hatch/store";
import {
  EVIDENCE_JOB_TIMEOUT_MILLIS,
  EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER,
  EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER,
  EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
  EvidenceArtifactError,
  EvidenceStateError,
  decodeBrowserEvidenceJobEffect,
  decodeCompleteEvidenceStepPublication,
  decodeCompleteEvidenceVideoPublication,
  decodeEvidenceIdentifier,
  decodeEvidencePreviewAdmission,
  decodeEvidencePreviewIngressBytes,
  decodeEvidencePreviewRequestId,
  publicEvidenceSummaryProjection,
  type BrowserEvidenceJob,
  type BrowserEvidenceResult,
  type CompleteEvidenceStepPublication,
  type EvidenceActiveJob,
  type EvidenceArtifact,
  type EvidenceJobSummary,
  type EvidencePreviewAdmission,
  type EvidencePreviewPermitAdmission,
  type EvidenceStepResult,
  type EvidenceTerminalStatus,
  type ExposedEvidencePreview,
  type PublicEvidenceJobSummary,
} from "../evidence/contracts";
import type { Bindings } from "../shared/bindings";
import {
  HATCH_MAX_CONCURRENT_SOCKETS,
  HATCH_MAX_WEBSOCKET_AGGREGATE_BYTES,
  HATCH_MAX_WEBSOCKET_MESSAGE_BYTES,
  HATCH_MAX_WEBSOCKET_MESSAGES,
  HATCH_PRIVATE_CLAIMED_HEADER,
  HATCH_PRIVATE_READINESS_CLAIMED_HEADER,
  HATCH_PRIVATE_READINESS_HEADER,
  HATCH_PRIVATE_REQUEST_HEADER,
  HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER,
  HATCH_PRIVATE_WEBSOCKET_HEADER,
  HATCH_RESERVED_RESPONSE_BYTES,
  HATCH_READINESS_PATH,
  HATCH_WEBSOCKET_ABSOLUTE_MILLIS,
  HATCH_WEBSOCKET_ADMISSION_MILLIS,
  HATCH_WEBSOCKET_IDLE_MILLIS,
  HatchStateError,
  decodeEnsureHatchInput,
  decodeHatchBrowserClientId,
  decodeHatchCookieDigest,
  decodeHatchCleanupRetry,
  decodeHatchHostRoute,
  decodeHatchIngressBytes,
  decodeHatchIdentifier,
  decodeHatchRequestAdmission,
  decodeHatchRequestId,
  decodeHatchWebSocketAdmission,
  decodeHatchWebSocketId,
  hatchOrigin,
  publicHatchStatusProjection,
  sameHatchAuthorization,
  type HatchCleanupRetry,
  type HatchCleanupTarget,
  type HatchHostRoute,
  type HatchRecord,
  type HatchRequestPermit,
  type HatchRestoreDescriptor,
  type HatchRouteAuthorization,
  type HatchWebSocketPermit,
  type IssuedHatchPermit,
  type PublicHatchStatus,
} from "../hatch/contracts";
import { sha256Hex } from "../shared/digest";
import {
  EvidenceWorkflowControl,
  EvidenceWorkflowControlError,
  runEvidenceWorkflow,
} from "../evidence/workflow";
import {
  ContainerAuth,
  containerAuthLayer,
  PI_SESSION_PORT,
  PI_SESSION_TOKEN_HEADER,
  piSessionTransportToken,
} from "../sandbox/auth";
import {
  credentialGrantHasHandle,
  credentialKindForHandle,
  decodeSessionCredentialAccessResult,
  githubManagedHandle,
  selectPiAuthGrant,
  sessionRuntimeCredentials,
} from "../credentials/managed";
import { readBoundedUtf8Body } from "../shared/bounded-http";
import { decodeJsonValue } from "../shared/json";
import { CREDENTIAL_REGISTRY_OBJECT_NAME } from "../credentials/object";
import {
  decodeCredentialRegistryGrantResult,
  decodeCredentialRegistryResolvedCredentialResult,
} from "../credentials/contracts";
import {
  badRequest,
  conflict,
  decodeContainerSessionRequest,
  notFound,
  ScottyError,
  wrongState,
  type CreateSessionInput,
  type DownArchive,
  type DownManifest,
  type SessionCredentialGrant,
  type SessionProjection as SessionListProjection,
  type SessionRecord,
  type SessionView,
  SESSION_KV_PREFIX,
} from "./contracts";
import {
  assessSessionDeploymentReadiness,
  type SessionDeploymentReadiness,
} from "../../../protocol/session-deployment-safety";
import type { CreateIdempotencyDigestMetadata } from "../session-actor/metadata";
import { ALLOWED_HOSTS, denyOutbound, makeOutboundByHost } from "../egress/worker";
import { inspectPassiveSession, scottyErrorResponse, steerPassiveSession } from "./passive";
import {
  durableObjectSessionAuxiliaryStorage,
  durableObjectSessionActorMetadataStorage,
  durableObjectSessionActorStorage,
  makeSessionControlGate,
  readDurableObjectSessionActorDiagnostics,
  sessionRecordFromActor,
  type SessionControlGate,
} from "./store";
import type { SessionActorDiagnostics } from "../session-actor/diagnostics";
import { ActorStore, actorStoreLayer, type ActorStoreSnapshot } from "../session-actor/store";
import { SessionActor, sessionActorLayer } from "../session-actor/actor";
import {
  actorAlarmId,
  ActorAlarmOutcomeUnknown,
  actorAlarmSchedulerLayer,
} from "../session-actor/alarm";
import { actorEffectRunnerLayer } from "../session-actor/effect-runner";
import { sessionProviderEffectExecutorLayer } from "../session-actor/provider-executor";
import {
  CreateSandboxBoundary,
  CreateSandboxBoundaryFailure,
  createSandboxTransitionProviderLayer,
} from "../session-actor/transitions/create-sandbox";
import {
  backupLifecycleSandboxLayerWithHatch,
  checkpointSandboxTransitionProviderLayer,
  resumeSandboxTransitionProviderLayer,
  sandboxRuntimeStopLayer,
  sleepSandboxTransitionProviderLayer,
} from "../session-actor/transitions/backup-lifecycle-sandbox";
import {
  RecoverySandbox,
  recoveryRuntimeDestroyLayer,
  recoverySandboxLayer,
} from "../session-actor/transitions/recovery-sandbox";
import {
  VaporizeProviderFailure,
  VaporizeTransitionProvider,
  type VaporizeProviderResult,
} from "../session-actor/transitions/vaporize";
import {
  SessionActorMetadataStore,
  sessionActorMetadataStoreLayer,
} from "../session-actor/metadata-store";
import type { SessionActorMetadata } from "../session-actor/metadata";
import {
  CreateController,
  CreateControllerBoundaryFailure,
  createControllerLayer,
  createHardCapControllerLayer,
  createMetadataControllerFromStoresLayer,
  type CreateHardCapFence,
  type CreateControllerRequest,
} from "../session-actor/create-controller";
import {
  LifecycleController,
  lifecycleControllerLayer,
  type LifecycleCommandKind,
} from "../session-actor/lifecycle-controller";
import {
  WarmWorkController,
  warmWorkControllerLayer,
  type WarmWorkLease,
} from "../session-actor/transitions/warm-work";
import {
  AuthorityStateSchema,
  StableStateSchema,
  TransitionSchema,
  type ReadinessProgress,
  type SessionAuthority,
} from "../session-actor/authority";
import { sessionProjectionFromActor, sessionViewFromActor } from "../session-actor/public-view";
import { uiSessionResponseFromActor, type UiSessionResponse } from "../ui/session-view";
import {
  hardCapDrainAt,
  SESSION_SCHEDULE_CALLBACKS,
  sessionAllowsRuntimeAccess,
} from "./lifecycle";
import {
  errorName,
  SandboxRuntime,
  sandboxRuntimeLayer,
  shellQuote,
  type SandboxWriteContent,
} from "../sandbox/runtime";
import {
  sandboxBundleMaterializerLayer,
  SandboxBundleMaterializer,
} from "../sandbox/bundle-materializer";
import { r2SandboxBundleCapabilities, sandboxBundleStoreLayer } from "../sandbox/bundle-store";
import { SANDBOX_CONFIG_OBJECT_NAME } from "../sandbox/config-object";
import {
  kvSessionProjectionStorage,
  SessionProjection,
  sessionProjectionLayer,
} from "./projection";
import { RolloutDiscovery, rolloutDiscoveryLayer } from "../runner/discovery";
import { RepoVerifier, repoVerifierLayer } from "../repos/verifier";
import { sessionRoot, Workspace, workspaceLayer } from "../sandbox/workspace";
import {
  durableObjectSandboxRuntimeIncarnationStore,
  type SandboxRuntimeIncarnationStore,
} from "../sandbox/runtime-incarnation-store";
import {
  findGitWorktreeChange,
  listGitWorktreeChanges,
  readGitWorktreePatch,
} from "../changes/git";
import { parseChangedPath, type ChangedFilePatch, type ChangedFiles } from "../changes/contracts";

type ActorRequestRecovery =
  | { readonly _tag: "NotNeeded"; readonly snapshot: ActorStoreSnapshot }
  | { readonly _tag: "Contended"; readonly snapshot: ActorStoreSnapshot }
  | { readonly _tag: "Recovered"; readonly provenSnapshot: ActorStoreSnapshot };

const expectedRecoveredStable = (
  authority: SessionAuthority,
  expectedKind: LifecycleCommandKind | "Create",
): boolean => {
  if (!AuthorityStateSchema.guards.Stable(authority.state)) return false;
  const stable = authority.state.stable;
  if (StableStateSchema.guards.Failed(stable)) return true;
  return expectedKind === "Sleep"
    ? StableStateSchema.guards.Sleeping(stable)
    : StableStateSchema.guards.Warm(stable);
};

const provesRecoveredTransition = (
  snapshot: ActorStoreSnapshot,
  expectedKind: LifecycleCommandKind | "Create",
  transitionNonce: string,
): boolean => {
  const authority = snapshot.authority;
  if (authority === undefined) return false;
  if (AuthorityStateSchema.guards.Transitioning(authority.state))
    return (
      authority.state.transition.nonce === transitionNonce &&
      Predicate.isTagged(authority.state.transition, expectedKind)
    );
  const journal = snapshot.journalTail;
  return (
    expectedRecoveredStable(authority, expectedKind) &&
    journal?.eventType === "completed" &&
    journal.transitionKind === expectedKind &&
    journal.transitionNonce === transitionNonce
  );
};

const ABANDONED_OPERATION_MS = 5 * 60_000;
const ACTIVITY_OBSERVATION_TTL_MS = 90_000;
const PASSIVE_PI_CONSOLE_MAX_HEADER_BYTES = 8 * 1024;
const PASSIVE_PI_CONSOLE_REQUEST_HEADERS = ["accept", "content-type", "last-event-id"] as const;
const EVIDENCE_PREVIEW_BASE_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EVIDENCE_CLEANUP_RETRY_SECONDS = 5;
const EVIDENCE_PREVIEW_HOST_TIMEOUT_MILLIS = 5_000;
const HATCH_PUBLIC_ROUTE_TIMEOUT_MILLIS = 10_000;
const SANDBOX_PREVIEW_PROXY_HEADER = "x-sandbox-preview-proxy";
const SANDBOX_PREVIEW_PORT_HEADER = "x-sandbox-preview-port";
const SANDBOX_PREVIEW_TOKEN_HEADER = "x-sandbox-preview-token";
const SANDBOX_PREVIEW_SANDBOX_ID_HEADER = "x-sandbox-preview-sandbox-id";
const PREVIEW_PORT_PATTERN = /^(?:[1-9][0-9]{3,4})$/u;

const authorizesHatchReadiness = (
  hatch: HatchRecord | undefined,
  route: HatchHostRoute & { readonly marker: string },
): hatch is HatchRecord => {
  if (
    hatch === undefined ||
    hatch.sessionId !== route.sessionId ||
    hatch.service.port !== route.port ||
    hatch.routeNonce !== route.routeNonce ||
    hatch.desiredStatus !== "open" ||
    hatch.runtimeEpoch === undefined
  )
    return false;
  return (
    (hatch.observedStatus === "starting" &&
      hatch.exposure === "unexpose_pending" &&
      hatch.transitionNonce === route.marker) ||
    (hatch.observedStatus === "running" &&
      hatch.exposure === "active" &&
      hatch.routeNonce === route.marker)
  );
};

const adaptSandboxWriteFile = (
  sandbox: Pick<Sandbox, "writeFile">,
  path: string,
  content: SandboxWriteContent,
): Promise<unknown> =>
  content instanceof Uint8Array
    ? sandbox.writeFile(path, new Blob([Uint8Array.from(content)]).stream())
    : sandbox.writeFile(path, content);

const deniedEvidencePreviewResponse = (): Response =>
  new Response("Not found", {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });

const copyBoundedPassivePiConsoleHeaders = (source: Headers): Headers => {
  const headers = new Headers();
  const encoder = new TextEncoder();
  for (const name of PASSIVE_PI_CONSOLE_REQUEST_HEADERS) {
    const value = source.get(name);
    if (value !== null && encoder.encode(value).byteLength <= PASSIVE_PI_CONSOLE_MAX_HEADER_BYTES)
      headers.set(name, value);
  }
  return headers;
};

export const decodeSandboxFileStream = (
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> => {
  const chunks = streamFile(source);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(typeof next.value === "string" ? encoder.encode(next.value) : next.value);
    },
    async cancel() {
      // oxlint-disable-next-line scotty/no-error-constructor -- boundary: ReadableStream cancellation interrupts the Cloudflare SDK async generator with a native Error
      await chunks.throw(new Error("Beam-down response stream canceled")).then(
        () => undefined,
        () => undefined,
      );
    },
  });
};

type SandboxServices =
  | ActorStore
  | ArtifactStore
  | BackupStore
  | ContainerEvidenceRecorder
  | ContainerAuth
  | EvidenceStore
  | HatchStore
  | RolloutDiscovery
  | SandboxBundleMaterializer
  | SandboxRuntime
  | SessionProjection
  | RepoVerifier
  | SessionActor
  | SessionActorMetadataStore
  | CreateController
  | LifecycleController
  | WarmWorkController
  | RecoverySandbox
  | Workspace;

const ActorAlarmFenceSchema = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["deadline", "reconcile"])),
  alarmId: Schema.String,
  revision: Schema.Int,
  transitionNonce: Schema.String,
  attempt: Schema.String,
  expectedPhase: Schema.String,
  expectedDeadlineAt: Schema.String,
  correlationId: Schema.String,
});
const decodeActorAlarmFence = Schema.decodeUnknownOption(ActorAlarmFenceSchema, {
  onExcessProperty: "error",
});

const CreateHardCapFenceSchema = Schema.Struct({
  sessionId: Schema.String,
  generation: Schema.String,
  deadlineAt: Schema.String,
});
const decodeCreateHardCapFence = Schema.decodeUnknownOption(CreateHardCapFenceSchema, {
  onExcessProperty: "error",
});

const CreateHardCapDrainFenceSchema = Schema.Struct({
  sessionId: Schema.String,
  generation: Schema.String,
  deadlineAt: Schema.String,
  drainAt: Schema.String,
});
const decodeCreateHardCapDrainFence = Schema.decodeUnknownOption(CreateHardCapDrainFenceSchema, {
  onExcessProperty: "error",
});
type CreateHardCapDrainFence = typeof CreateHardCapDrainFenceSchema.Type;

const isMatchingHardCapDrain = (
  authority: SessionAuthority | undefined,
  fence: CreateHardCapDrainFence,
): authority is SessionAuthority =>
  authority !== undefined &&
  authority.session.id === fence.sessionId &&
  authority.hardCap.generation === fence.generation &&
  authority.hardCap.deadlineAt === fence.deadlineAt &&
  hardCapDrainAt(authority.hardCap.deadlineAt, authority.hardCap.durationSeconds) === fence.drainAt;

const isWarmAuthority = (authority: SessionAuthority): boolean =>
  AuthorityStateSchema.guards.Stable(authority.state) &&
  StableStateSchema.guards.Warm(authority.state.stable);

const isTerminalDrainAuthority = (authority: SessionAuthority): boolean =>
  AuthorityStateSchema.guards.Stable(authority.state) &&
  !StableStateSchema.guards.Warm(authority.state.stable);

const isVaporizingAuthority = (authority: SessionAuthority): boolean =>
  AuthorityStateSchema.guards.Transitioning(authority.state) &&
  TransitionSchema.guards.Vaporize(authority.state.transition);

const isMatchingVaporizeHardCap = (
  authority: SessionAuthority | undefined,
  fence: CreateHardCapFence,
): boolean =>
  authority !== undefined &&
  authority.session.id === fence.sessionId &&
  authority.hardCap.generation === fence.generation &&
  authority.hardCap.deadlineAt === fence.deadlineAt &&
  AuthorityStateSchema.guards.Transitioning(authority.state) &&
  TransitionSchema.guards.Vaporize(authority.state.transition);

const vaporizeObservedAt = Effect.map(Clock.currentTimeMillis, (now) =>
  new Date(now).toISOString(),
);

const vaporizeUnknown = (safeResultCode: string) => () =>
  Effect.flatMap(
    vaporizeObservedAt,
    (observedAt) =>
      new VaporizeProviderFailure({
        outcome: "unknown_after_admission",
        safeResultCode,
        observedAt,
      }),
  );

const vaporizeRejected = (safeResultCode: string) =>
  Effect.flatMap(
    vaporizeObservedAt,
    (observedAt) =>
      new VaporizeProviderFailure({
        outcome: "rejected_before_admission",
        safeResultCode,
        observedAt,
      }),
  );

const vaporizeResult = (
  tag: VaporizeProviderResult["_tag"],
  resultCode: string,
): Effect.Effect<VaporizeProviderResult> =>
  Effect.map(vaporizeObservedAt, (observedAt) => ({ _tag: tag, observedAt, resultCode }));

const actorReadiness = (authority: SessionAuthority): ReadinessProgress | null => {
  if (AuthorityStateSchema.guards.Stable(authority.state))
    return StableStateSchema.guards.Warm(authority.state.stable)
      ? authority.state.stable.readiness
      : null;
  const proof = authority.state.transition.proof;
  return "readiness" in proof ? proof.readiness : null;
};

interface EvidenceDeadlinePayload {
  readonly nonce: string;
  readonly deadlineAt: string;
}

const EvidenceRetentionPayloadSchema = Schema.Struct({ expiresAt: Schema.String });
type EvidenceRetentionPayload = typeof EvidenceRetentionPayloadSchema.Type;
const decodeEvidenceRetentionPayload = Schema.decodeUnknownOption(EvidenceRetentionPayloadSchema, {
  onExcessProperty: "error",
});

export interface PassivePiConsoleRelay {
  readonly fetch: (input: {
    readonly sessionId: SessionRecord["id"];
    readonly request: Request;
  }) => Promise<Response>;
}

export interface TerminalSessionControl {
  readonly delete: (terminalId: string) => Promise<void>;
}

export interface SandboxEffectOptions {
  readonly actorRequestRecoveryAfterResume?: () => Promise<void>;
  readonly actorRequestRecoveryBeforeResume?: () => Promise<void>;
  readonly clock?: Clock.Clock;
  readonly containerEvidenceRecorder?: ContainerEvidenceRecorder["Service"];
  readonly evidencePreviewHostTimeoutMillis?: number;
  readonly hatchPublicProbe?: (
    url: string,
    marker: string,
    signal: AbortSignal,
  ) => Promise<Response>;
  readonly passivePiConsoleRelay?: PassivePiConsoleRelay;
  readonly previewRequestForwarder?: (request: Request) => Promise<Response>;
  readonly hatchRequestForwarder?: (request: Request) => Promise<Response>;
  readonly terminalSessionControl?: TerminalSessionControl;
  readonly repoVerifier?: RepoVerifier["Service"];
}

export const SANDBOX_TEST_ACCEPT_EVIDENCE = Symbol("scotty.test.acceptEvidence");
export const SANDBOX_TEST_EXPOSE_EVIDENCE = Symbol("scotty.test.exposeEvidence");
export const SANDBOX_TEST_COMPLETE_EVIDENCE_STEP = Symbol("scotty.test.completeEvidenceStep");
export const SANDBOX_TEST_FINALIZE_EVIDENCE = Symbol("scotty.test.finalizeEvidence");

type HostOperation = "destroy" | "expose" | "schedule" | "stop" | "unexpose";

class HostOperationFailure extends Data.TaggedError("HostOperationFailure")<{
  readonly operation: HostOperation;
  readonly cause: unknown;
}> {}

interface InFlightCreate {
  readonly id: string;
  readonly keyDigest: string | undefined;
  readonly inputDigest: string | undefined;
  readonly promise: Promise<SessionView>;
}

interface InFlightPreviewRequest {
  readonly operationNonce: string;
  readonly controller: AbortController;
}

interface ActorPassiveConsoleAuthority {
  readonly _tag: "Actor";
  readonly authority: SessionAuthority;
  readonly metadata: SessionActorMetadata;
  readonly revision: number;
}

type PassiveConsoleAuthority = ActorPassiveConsoleAuthority;

const hostEffect = <A>(
  operation: HostOperation,
  evaluate: () => Promise<A>,
): Effect.Effect<A, HostOperationFailure> =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new HostOperationFailure({ operation, cause }),
  });

interface BoundedHostPromise<A> {
  readonly result: Promise<A>;
  readonly reconciliation: Promise<void>;
}

interface InFlightPreviewExposure {
  readonly reconciliation: Promise<void>;
  background: Promise<void> | undefined;
}

const boundedHostPromise = <A>(
  evaluate: () => Promise<A>,
  timeoutMillis: number,
  signal?: AbortSignal,
): BoundedHostPromise<A> => {
  let resolveReconciliation = (): void => undefined;
  const reconciliation = new Promise<void>((resolve) => {
    resolveReconciliation = resolve;
  });
  const result = new Promise<A>((resolve, reject) => {
    let waiting = true;
    const finishWaiting = (): void => {
      waiting = false;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const stopWaiting = (cause: unknown): void => {
      if (!waiting) return;
      finishWaiting();
      // oxlint-disable-next-line scotty/no-promise-reject -- boundary: native Sandbox timeout or abort must settle before Effect can reconcile the late host mutation
      reject(cause);
    };
    const abort = (): void => stopWaiting("interrupted");
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native Sandbox preview mutations need a real host timeout and late reconciliation outside Effect interruption
    const timeout = setTimeout(() => stopWaiting("timeout"), timeoutMillis);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    void Promise.resolve()
      .then(evaluate)
      .then(
        (value) => {
          if (waiting) {
            finishWaiting();
            resolve(value);
            resolveReconciliation();
            return;
          }
          resolveReconciliation();
        },
        (cause) => {
          if (waiting) {
            finishWaiting();
            // oxlint-disable-next-line scotty/no-promise-reject -- boundary: the native Sandbox rejection is forwarded once into the surrounding Effect.tryPromise adapter
            reject(cause);
          }
          resolveReconciliation();
        },
      );
  });
  return { result, reconciliation };
};

const boundedHostResult = <A>(evaluate: () => Promise<A>, timeoutMillis: number): Promise<A> =>
  boundedHostPromise(evaluate, timeoutMillis).result;

interface HatchWebSocketMessage {
  readonly data: string | ArrayBuffer;
  readonly bytes: number;
}

const normalizeHatchWebSocketMessage = async (
  value: unknown,
): Promise<HatchWebSocketMessage | undefined> => {
  if (typeof value === "string")
    return { data: value, bytes: new TextEncoder().encode(value).byteLength };
  if (value instanceof ArrayBuffer) return { data: value, bytes: value.byteLength };
  if (value instanceof Blob) {
    if (value.size > HATCH_MAX_WEBSOCKET_MESSAGE_BYTES) return undefined;
    const data = await value.arrayBuffer();
    return { data, bytes: data.byteLength };
  }
  return undefined;
};

const decodeEvidenceArtifactError = Schema.decodeUnknownOption(EvidenceArtifactError);
const decodeEvidenceStateError = Schema.decodeUnknownOption(EvidenceStateError);

const MissingTerminalSessionErrorSchema = Schema.Struct({
  errorResponse: Schema.Struct({
    code: Schema.Literal("INTERNAL_ERROR"),
    context: Schema.Struct({
      sessionId: Schema.String,
      originalError: Schema.Literal("Session not found"),
    }),
    httpStatus: Schema.Literal(500),
  }),
});
const decodeMissingTerminalSessionError = Schema.decodeUnknownOption(
  MissingTerminalSessionErrorSchema,
);

const isMissingTerminalSessionError = (error: unknown, terminalId: string): boolean => {
  const decoded = decodeMissingTerminalSessionError(error);
  return Option.isSome(decoded) && decoded.value.errorResponse.context.sessionId === terminalId;
};

const evidenceControlFailureCode = (error: unknown) => {
  const artifactError = decodeEvidenceArtifactError(error);
  if (Option.isSome(artifactError)) {
    if (artifactError.value.reason === "invalid_png") return "artifact_invalid" as const;
    if (artifactError.value.reason === "over_budget") return "artifact_over_budget" as const;
    return "artifact_put_unknown" as const;
  }
  const stateError = decodeEvidenceStateError(error);
  if (Option.isSome(stateError) && stateError.value.reason === "over_budget")
    return "artifact_over_budget" as const;
  return "interrupted" as const;
};

const evidenceStepPublication = (input: CompleteEvidenceStepPublication) => ({
  index: input.index,
  startedAt: input.startedAt,
  completedAt: input.completedAt,
  offsetMillis: input.offsetMillis,
  assertions: input.assertions,
});

interface EvidenceStepFrameOutcome {
  readonly artifact?: EvidenceArtifact;
  readonly failure?: EvidenceArtifactError;
}

const evidenceStepFrameSucceeded = (artifact?: EvidenceArtifact): EvidenceStepFrameOutcome =>
  artifact === undefined ? {} : { artifact };

const evidenceStepFrameFailed = (failure: EvidenceArtifactError): EvidenceStepFrameOutcome => ({
  failure,
});

const evidenceArtifactRetentionFailure = (cause: unknown): EvidenceArtifactError =>
  new EvidenceArtifactError({ operation: "put", reason: "put_unknown", cause });

const reportEvidenceControlFailure = (operation: string, error: unknown): void => {
  const artifactError = decodeEvidenceArtifactError(error);
  console.error("Evidence control failed", {
    operation,
    error: errorName(error),
    ...(Option.isNone(artifactError)
      ? {}
      : {
          artifactOperation: artifactError.value.operation,
          artifactReason: artifactError.value.reason,
        }),
  });
};

interface PendingHatchRestore {
  readonly hatch: HatchRecord;
  readonly operationNonce: string;
  readonly runtimeEpoch: string;
  readonly restoreFence: HatchRestoreFence;
}

interface PendingHatchWebSocket {
  readonly authorization: HatchWebSocketAuthorization;
  readonly expiresAtMillis: number;
}

type HatchWebSocketForwardingRoute = HatchHostRoute & { readonly socketId: string };

interface TrackedHatchWebSocket {
  readonly authorization: HatchWebSocketAuthorization;
  readonly close: (code: number, reason: string) => void;
}

export class Sandbox extends BaseSandbox<Bindings> {
  override sleepAfter = "60m";
  interceptHttps = true;
  enableInternet = false;
  allowedHosts = [...ALLOWED_HOSTS];
  private readonly layer: Layer.Layer<SandboxServices>;
  private readonly clock: Clock.Clock | undefined;
  private readonly passivePiConsoleRelay: PassivePiConsoleRelay;
  private readonly previewRequestForwarder: (request: Request) => Promise<Response>;
  private readonly hatchRequestForwarder: (request: Request) => Promise<Response>;
  private readonly rawContainer: DurableObjectState["container"];
  private readonly sessionControlGate: SessionControlGate;
  private readonly terminalSessionControl: TerminalSessionControl;
  private readonly evidenceEnabled: boolean;
  private readonly localE2E: boolean;
  private readonly runtimeIncarnationStore: SandboxRuntimeIncarnationStore;
  private readonly actorRequestRecoveryAfterResume: () => Promise<void>;
  private readonly actorRequestRecoveryBeforeResume: () => Promise<void>;
  private readonly evidencePreviewHostTimeoutMillis: number;
  private readonly hatchPublicProbe: (
    url: string,
    marker: string,
    signal: AbortSignal,
  ) => Promise<Response>;
  private readonly previewBase: string | undefined;
  // This only coalesces work inside one live DO instance. Durable createPhase remains authoritative
  // after eviction or a crash.
  private createInFlight: InFlightCreate | undefined;
  private readonly activeActorMutationNonces = new Set<string>();
  private readonly previewExposureReconciliations = new Map<string, InFlightPreviewExposure>();
  private readonly previewRequests = new Map<string, InFlightPreviewRequest>();
  private readonly hatchRequests = new Map<string, AbortController>();
  private readonly hatchWebSocketAdmissions = new Map<string, PendingHatchWebSocket>();
  private readonly hatchWebSockets = new Map<string, TrackedHatchWebSocket>();

  constructor(ctx: DurableObjectState<{}>, env: Bindings, options: SandboxEffectOptions = {}) {
    super(ctx, env);
    this.clock = options.clock;
    this.rawContainer = ctx.container;
    this.evidenceEnabled = env.SCOTTY_EVIDENCE_ENABLED === "true";
    this.localE2E = env.SCOTTY_LOCAL_E2E === "1";
    this.runtimeIncarnationStore = durableObjectSandboxRuntimeIncarnationStore(
      // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning Sandbox provider-observation adapter
      ctx.storage,
    );
    this.evidencePreviewHostTimeoutMillis =
      options.evidencePreviewHostTimeoutMillis ?? EVIDENCE_PREVIEW_HOST_TIMEOUT_MILLIS;
    this.actorRequestRecoveryAfterResume =
      options.actorRequestRecoveryAfterResume ?? (() => Promise.resolve());
    this.actorRequestRecoveryBeforeResume =
      options.actorRequestRecoveryBeforeResume ?? (() => Promise.resolve());
    this.hatchPublicProbe =
      options.hatchPublicProbe ??
      ((url, marker, signal) =>
        // oxlint-disable-next-line scotty/no-raw-fetch -- boundary: public Hatch readiness must traverse DNS, TLS, and the Worker route
        fetch(url, {
          method: "HEAD",
          headers: { [HATCH_PRIVATE_READINESS_HEADER]: marker },
          redirect: "manual",
          signal,
        }));
    this.previewBase =
      env.SCOTTY_PREVIEW_BASE !== undefined &&
      EVIDENCE_PREVIEW_BASE_PATTERN.test(env.SCOTTY_PREVIEW_BASE)
        ? env.SCOTTY_PREVIEW_BASE
        : undefined;
    this.passivePiConsoleRelay = options.passivePiConsoleRelay ?? {
      fetch: (input) => this.fetchNativePassivePiConsole(input),
    };
    this.previewRequestForwarder =
      options.previewRequestForwarder ?? ((request) => this.forwardSandboxPreviewRequest(request));
    this.hatchRequestForwarder =
      options.hatchRequestForwarder ?? ((request) => this.forwardSandboxPreviewRequest(request));
    this.sessionControlGate = makeSessionControlGate();
    const terminalSessionControl = options.terminalSessionControl ?? {
      delete: (terminalId: string) => this.deleteSession(terminalId).then(() => undefined),
    };
    this.terminalSessionControl = {
      delete: (terminalId) =>
        terminalSessionControl.delete(terminalId).then(
          () => undefined,
          (cause: unknown) => {
            if (isMissingTerminalSessionError(cause, terminalId)) return;
            // oxlint-disable-next-line scotty/no-promise-reject -- boundary: preserve the native Sandbox terminal deletion rejection
            return Promise.reject(cause);
          },
        ),
    };

    const auxiliaryStorage = durableObjectSessionAuxiliaryStorage(
      // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning authoritative state adapters
      ctx.storage,
      this.sessionControlGate,
    );
    const actorStore = actorStoreLayer(
      durableObjectSessionActorStorage(
        // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into the actor's sole authority adapter
        ctx.storage,
        this.sessionControlGate,
      ),
    );
    const actorMetadata = sessionActorMetadataStoreLayer(
      durableObjectSessionActorMetadataStorage(
        // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires non-lifecycle Create metadata through the same control gate as actor authority
        ctx.storage,
        this.sessionControlGate,
      ),
    );
    const evidence = evidenceStoreLayer(auxiliaryStorage);
    const hatch = hatchStoreLayer(
      durableObjectHatchStateStorage(
        // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: constructor wires Durable Object storage into its owning Hatch authority adapter
        ctx.storage,
        this.sessionControlGate,
      ),
    );
    const artifacts = artifactStoreLayer(r2ArtifactStoreCapabilities(env.ARTIFACT_BUCKET));
    const sessionProjection = sessionProjectionLayer(kvSessionProjectionStorage(env.SESSIONS));
    const runtimeAccess = Effect.flatMap(ActorStore, (actor) =>
      Effect.flatMap(actor.read, (snapshot) => {
        const authority = snapshot.authority;
        if (authority === undefined)
          return Effect.fail(
            new ScottyError("internal", "Session actor authority is unavailable", {
              httpStatus: 500,
              exitCode: 1,
            }),
          );
        if (AuthorityStateSchema.guards.Transitioning(authority.state)) {
          const transition = authority.state.transition;
          return TransitionSchema.guards.Vaporize(transition)
            ? Effect.fail(conflict("Session lifecycle transition does not allow runtime access"))
            : Effect.void;
        }
        return StableStateSchema.guards.Warm(authority.state.stable)
          ? Effect.void
          : Effect.fail(
              wrongState(
                StableStateSchema.guards.Sleeping(authority.state.stable)
                  ? "sleeping"
                  : StableStateSchema.guards.Failed(authority.state.stable)
                    ? "failed"
                    : "gone",
                "access",
              ),
            );
      }),
    ).pipe(
      Effect.mapError((failure) =>
        Predicate.isTagged(failure, "ScottyError")
          ? failure
          : new ScottyError("internal", "Session actor authority is unavailable", {
              httpStatus: 500,
              exitCode: 1,
            }),
      ),
      Effect.provide(actorStore),
    );
    const runtimeCapabilities = {
      getState: () => this.getState(),
      getContainerIncarnationId: async () => {
        const placementId = await this.getContainerPlacementId();
        if (typeof placementId === "string" && placementId.length > 0) return placementId;
        if (!this.localE2E) return placementId;
        return this.runtimeIncarnationStore.readLocal();
      },
      exec: (command: string, execOptions?: Parameters<SandboxRuntime["Service"]["exec"]>[1]) =>
        this.exec(command, execOptions),
      mkdir: (path: string, mkdirOptions?: { readonly recursive?: boolean }) =>
        this.mkdir(path, mkdirOptions),
      readFileStream: (path: string) =>
        this.readFile(path, { encoding: "none" }).then((result) => result.content),
      writeFile: (path: string, content: SandboxWriteContent) =>
        adaptSandboxWriteFile(this, path, content),
      setEnvVars: (envVars: Record<string, string | undefined>) => this.setEnvVars(envVars),
      startProcess: (
        command: string,
        processOptions?: Parameters<SandboxRuntime["Service"]["startProcess"]>[1],
      ) => this.startProcess(command, processOptions),
      getProcess: (processId: string) => this.getProcess(processId),
      fetchPort: (
        path: string,
        port: number,
        method: "GET" | "POST",
        headers?: Readonly<Record<string, string>>,
      ) =>
        this.containerFetch(
          new Request(`http://127.0.0.1:${port}${path}`, { method, headers }),
          port,
        ),
    };
    const runtime = sandboxRuntimeLayer(runtimeCapabilities, runtimeAccess, {
      fetchPortReadiness: env.SCOTTY_LOCAL_E2E === "1",
    });
    const runtimeAndContainerAuth = Layer.merge(
      runtime,
      containerAuthLayer.pipe(Layer.provide(runtime)),
    );
    const backupCapabilities = {
      createBackup: (backupOptions: Parameters<Sandbox["createBackup"]>[0]) =>
        this.createBackup(backupOptions),
      restoreBackup: (directoryBackup: Parameters<Sandbox["restoreBackup"]>[0]) =>
        this.restoreBackup(directoryBackup),
      deleteBackup: (backupId: string) => this.deleteBackup(backupId),
    };
    const backup = backupStoreLayer(backupCapabilities, runtimeAccess);
    const evidenceRecorder =
      options.containerEvidenceRecorder === undefined
        ? containerEvidenceRecorderLayer.pipe(Layer.provide(runtime))
        : Layer.succeed(ContainerEvidenceRecorder)(options.containerEvidenceRecorder);
    const bundleStore = sandboxBundleStoreLayer(
      r2SandboxBundleCapabilities(env.SANDBOX_BUNDLE_BUCKET),
    );
    const materializer = sandboxBundleMaterializerLayer.pipe(
      Layer.provide(Layer.merge(runtime, bundleStore)),
    );
    const repoVerifier =
      options.repoVerifier === undefined
        ? repoVerifierLayer.pipe(Layer.provide(FetchHttpClient.layer))
        : Layer.succeed(RepoVerifier)(options.repoVerifier);
    const workspace = workspaceLayer.pipe(Layer.provide(runtime));

    const createBoundary = Layer.effect(
      CreateSandboxBoundary,
      Effect.gen(function* () {
        const actorMetadataStore = yield* SessionActorMetadataStore;
        const verifier = yield* RepoVerifier;
        const workspaceService = yield* Workspace;

        const rejectBoundary = (
          safeResultCode: string,
          outcome: CreateSandboxBoundaryFailure["outcome"] = "rejected_before_admission",
        ): CreateSandboxBoundaryFailure =>
          new CreateSandboxBoundaryFailure({ outcome, safeResultCode });

        return CreateSandboxBoundary.of({
          resolve: Effect.fnUntraced(function* (authority, transition, payloadReference) {
            const metadata = yield* actorMetadataStore
              .read(authority)
              .pipe(Effect.mapError(() => rejectBoundary("create_metadata_unavailable")));
            if (
              metadata?.privateCreateInput?.attempt !== transition.attempt ||
              metadata.privateCreateInput.payload.reference !== payloadReference
            )
              return yield* rejectBoundary("create_private_payload_fence_mismatch");

            const config = yield* Effect.tryPromise({
              try: () => env.SANDBOX_CONFIG.getByName(SANDBOX_CONFIG_OBJECT_NAME).status(),
              catch: () => rejectBoundary("create_sandbox_config_unavailable"),
            });
            if (!config.ok) return yield* rejectBoundary("create_sandbox_config_unavailable");

            const registry = env.CREDENTIALS?.getByName(CREDENTIAL_REGISTRY_OBJECT_NAME);
            if (registry === undefined)
              return yield* rejectBoundary("create_credential_registry_unavailable");
            const issued = yield* Effect.tryPromise({
              try: () =>
                registry.issueGrants({
                  sessionId: authority.session.id,
                  repository: authority.session.repository,
                }),
              catch: () =>
                rejectBoundary(
                  "create_credential_grant_outcome_unknown",
                  "unknown_after_admission",
                ),
            });
            if (!issued.ok) return yield* rejectBoundary("create_credential_grant_rejected");
            const decoded = decodeCredentialRegistryGrantResult(issued.value);
            if (
              Result.isFailure(decoded) ||
              decoded.success.sessionId !== authority.session.id ||
              Result.isFailure(selectPiAuthGrant(decoded.success.grants))
            )
              return yield* rejectBoundary("create_credential_grant_invalid");
            const githubHandle = githubManagedHandle(decoded.success.grants);
            if (githubHandle === undefined)
              return yield* rejectBoundary("create_credential_grant_invalid");
            return {
              payloadReference,
              runtimeGeneration: transition.attempt,
              sandboxBundleDigest: config.value.activeDigest,
              githubHandle,
              credentials: sessionRuntimeCredentials(decoded.success.grants),
              grants: decoded.success.grants,
            };
          }),
          prepareWorkspace: Effect.fnUntraced(function* (authority, transition, input) {
            const metadata = yield* actorMetadataStore
              .read(authority)
              .pipe(Effect.mapError(() => rejectBoundary("create_metadata_unavailable")));
            if (
              metadata?.privateCreateInput?.attempt !== transition.attempt ||
              metadata.privateCreateInput.payload.reference !== input.payloadReference
            )
              return yield* rejectBoundary("create_private_payload_fence_mismatch");
            const registry = env.CREDENTIALS?.getByName(CREDENTIAL_REGISTRY_OBJECT_NAME);
            if (registry === undefined)
              return yield* rejectBoundary("create_credential_registry_unavailable");
            const resolved = yield* Effect.tryPromise({
              try: () =>
                registry.resolveGithubCliCredential({
                  repository: authority.session.repository,
                }),
              catch: () => rejectBoundary("create_repository_credential_unavailable"),
            });
            if (!resolved.ok)
              return yield* rejectBoundary("create_repository_credential_unavailable");
            const decodedCredential = decodeCredentialRegistryResolvedCredentialResult(
              resolved.value,
            );
            if (Result.isFailure(decodedCredential))
              return yield* rejectBoundary("create_repository_credential_invalid");
            if (githubManagedHandle(input.grants) !== input.githubHandle)
              return yield* rejectBoundary("create_credential_grant_invalid");
            const credential = Redacted.make(decodedCredential.success.value);
            const verified = yield* verifier
              .verify(authority.session.repository, Redacted.value(credential))
              .pipe(
                Effect.mapError(() => rejectBoundary("create_repository_verification_failed")),
                Effect.ensuring(Effect.sync(() => void Redacted.wipeUnsafe(credential))),
              );
            if (!verified.exists && !metadata.createRepositoryIfMissing)
              return yield* rejectBoundary("create_repository_not_found");

            const now = transition.lastProgressAt;
            const workspaceRecord: SessionRecord = {
              id: authority.session.id,
              title: authority.session.title,
              status: "booting",
              operation: {
                kind: "create",
                nonce: transition.nonce,
                startedAt: transition.startedAt,
                createPhase: "runtime",
              },
              execution: { provider: "cloudflare" },
              provider: "cloudflare",
              repo: authority.session.repository,
              repoExistsAtCreate: verified.exists,
              defaultBranch: verified.exists ? verified.defaultBranch : "main",
              branch: metadata.branch,
              createdAt: authority.session.createdAt,
              updatedAt: now,
              hardCapAt: metadata.hardCap.deadlineAt,
              hardCapDurationSeconds: metadata.hardCap.durationSeconds,
              ownedBackupIds: [],
              sandboxBundle: { digest: input.sandboxBundleDigest },
              credentialGrant: { sessionId: authority.session.id, grants: input.grants },
            };
            const prepared = yield* workspaceService
              .prepare(workspaceRecord, input.githubHandle, verified)
              .pipe(
                Effect.mapError((error) =>
                  error.reason === "transport"
                    ? rejectBoundary("create_workspace_outcome_unknown", "unknown_after_admission")
                    : rejectBoundary("create_workspace_failed"),
                ),
              );
            return {
              workspaceId: prepared.root,
              defaultBranch: prepared.defaultBranch,
              repositoryExists: prepared.repoExists,
            };
          }),
          // No existing provider observation proves the whole mutation yet. Remaining
          // reconciling is truthful; replaying workspace preparation or seed/preflight is not.
          observeWorkspace: () => Effect.succeed(null),
        });
      }),
    ).pipe(Layer.provide(Layer.mergeAll(actorMetadata, repoVerifier, workspace)));

    const actorAlarms = actorAlarmSchedulerLayer((fence) =>
      Effect.tryPromise({
        try: () =>
          this.schedule(
            fence.kind === "reconcile" ? 5 : new Date(fence.expectedDeadlineAt),
            "sessionActorDeadline",
            fence,
          ),
        catch: () =>
          new ActorAlarmOutcomeUnknown({
            alarmId: fence.alarmId,
            transitionNonce: fence.transitionNonce,
            attempt: fence.attempt,
          }),
      }).pipe(Effect.asVoid),
    );
    const createProvider = createSandboxTransitionProviderLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          createBoundary,
          actorMetadata,
          materializer,
          runtimeAndContainerAuth,
          runtime,
        ),
      ),
    );
    const actorRuntimeStop = sandboxRuntimeStopLayer({ requestStop: () => this.stop() });
    const backupLifecycleSandbox = backupLifecycleSandboxLayerWithHatch({
      afterPiStopped: (input) =>
        this.cleanupHatchProgram(input.operationNonce, "sleeping", false, "operation").pipe(
          Effect.asVoid,
          Effect.provide(hatch),
        ),
      beforeSupervisorStart: (input) =>
        this.prepareHatchRestoreProgram(input.operationNonce).pipe(
          Effect.asVoid,
          Effect.provide(Layer.mergeAll(actorStore, hatch)),
        ),
      afterSupervisorReady: (input) =>
        this.completePreparedHatchRestoreProgram(
          input.operationNonce,
          input.runtimeGeneration,
          input.transitionFence,
        ).pipe(Effect.provide(Layer.mergeAll(hatch, runtime))),
    }).pipe(Layer.provide(Layer.mergeAll(backup, runtimeAndContainerAuth, actorRuntimeStop)));
    const checkpointProvider = checkpointSandboxTransitionProviderLayer.pipe(
      Layer.provide(Layer.merge(backupLifecycleSandbox, actorMetadata)),
    );
    const sleepProvider = sleepSandboxTransitionProviderLayer.pipe(
      Layer.provide(Layer.merge(backupLifecycleSandbox, actorMetadata)),
    );
    const resumeProvider = resumeSandboxTransitionProviderLayer.pipe(
      Layer.provide(Layer.merge(backupLifecycleSandbox, actorMetadata)),
    );
    const recoveryDestroy = recoveryRuntimeDestroyLayer({ destroy: () => this.destroy() });
    const recovery = recoverySandboxLayer.pipe(
      Layer.provide(Layer.mergeAll(runtimeAndContainerAuth, recoveryDestroy)),
    );
    const vaporizeProvider = Layer.effect(
      VaporizeTransitionProvider,
      Effect.gen({ self: this }, function* () {
        const backups = yield* BackupStore;
        const evidenceStore = yield* EvidenceStore;
        const artifactStore = yield* ArtifactStore;
        const hatchStore = yield* HatchStore;
        const metadataStore = yield* SessionActorMetadataStore;
        const projection = yield* SessionProjection;
        return VaporizeTransitionProvider.of({
          revokeRuntimeAccess: () =>
            Effect.sync(() => {
              this.deleteSchedules("expireEvidenceJob");
              this.deleteSchedules("expireRetainedEvidence");
              this.deleteSchedules("retryHatchCleanup");
            }).pipe(
              Effect.andThen(vaporizeResult("RuntimeAccessRevoked", "runtime_access_revoked")),
            ),
          closeHatch: ({ transition }) =>
            this.cleanupHatchProgram(transition.nonce, "gone", true, "operation").pipe(
              Effect.provideService(HatchStore, hatchStore),
              Effect.andThen(hatchStore.clearAfterVaporize(transition.nonce)),
              Effect.andThen(vaporizeResult("HatchAbsent", "hatch_absent_confirmed")),
              Effect.catch(vaporizeUnknown("hatch_absence_unknown")),
            ),
          interruptEvidence: () =>
            Effect.gen({ self: this }, function* () {
              const stateResult = yield* Effect.result(evidenceStore.read);
              if (Result.isFailure(stateResult)) {
                if (stateResult.failure.reason !== "invalid") return yield* stateResult.failure;
                return yield* vaporizeResult("EvidenceInterrupted", "evidence_interrupted");
              }
              const state = stateResult.success;
              const active = state.activeJob;
              if (active !== undefined) {
                yield* Effect.result(
                  this.cleanupEvidencePreviewProgram(active.operationNonce, "interrupted").pipe(
                    Effect.provideService(EvidenceStore, evidenceStore),
                  ),
                );
              }
              return yield* vaporizeResult("EvidenceInterrupted", "evidence_interrupted");
            }).pipe(Effect.catch(vaporizeUnknown("evidence_interruption_unknown"))),
          destroyRuntime: ({ authority }) =>
            authority.session.execution.provider === "runner"
              ? vaporizeRejected("runner_vaporize_not_enabled")
              : Effect.tryPromise({
                  try: () => this.destroy(),
                  catch: () => undefined,
                }).pipe(
                  Effect.catch(vaporizeUnknown("runtime_destroy_outcome_unknown")),
                  Effect.andThen(vaporizeResult("RuntimeAbsent", "runtime_absent_confirmed")),
                ),
          deleteBackups: ({ transition }) =>
            Effect.gen(function* () {
              for (const backupId of new Set(transition.proof.ownedBackupIds))
                yield* backups.delete(backupId);
              return yield* vaporizeResult("BackupsAbsent", "backups_absent_confirmed");
            }).pipe(Effect.catch(vaporizeUnknown("backup_absence_unknown"))),
          deleteEvidence: ({ transition }) =>
            Effect.gen(function* () {
              const stateResult = yield* Effect.result(evidenceStore.read);
              if (Result.isFailure(stateResult)) {
                if (stateResult.failure.reason !== "invalid") return yield* stateResult.failure;
                return yield* vaporizeResult("EvidenceAbsent", "evidence_absent_confirmed");
              }
              const state = stateResult.success;
              const hasEvidenceAuthority =
                state.activeJob !== undefined ||
                state.jobs.length > 0 ||
                state.artifacts.length > 0 ||
                state.pendingDeletes.length > 0;
              if (!hasEvidenceAuthority)
                return yield* vaporizeResult("EvidenceAbsent", "evidence_absent_confirmed");
              const pending = yield* evidenceStore.prepareVaporizeDeletes(transition.nonce);
              for (const artifact of pending) {
                yield* artifactStore.deleteArtifact(artifact);
                yield* evidenceStore.confirmDelete(artifact.objectKey);
              }
              return yield* vaporizeResult("EvidenceAbsent", "evidence_absent_confirmed");
            }).pipe(Effect.catch(vaporizeUnknown("evidence_absence_unknown"))),
          releaseGrants: ({ authority }) =>
            Effect.gen({ self: this }, function* () {
              const metadata = yield* metadataStore.read(authority);
              const grants = metadata?.createObservations.credentialGrants?.grants ?? [];
              if (grants.length > 0) {
                const registry = this.env.CREDENTIALS?.getByName(CREDENTIAL_REGISTRY_OBJECT_NAME);
                if (registry === undefined)
                  return yield* vaporizeRejected("credential_registry_unavailable");
                const released = yield* Effect.tryPromise({
                  try: () => registry.release({ sessionId: authority.session.id, grants }),
                  catch: () => undefined,
                });
                if (!released.ok || !released.value.released)
                  return yield* vaporizeUnknown("credential_release_unconfirmed")();
              }
              yield* metadataStore.deleteForVaporize(authority);
              return yield* vaporizeResult("GrantsReleased", "owned_authority_released");
            }).pipe(Effect.catch(vaporizeUnknown("owned_authority_release_unknown"))),
          confirmAbsence: ({ authority }) =>
            Effect.gen({ self: this }, function* () {
              const metadata = yield* metadataStore.read(authority);
              if (metadata !== undefined) return yield* vaporizeUnknown("metadata_still_present")();
              yield* projection.remove(authority.session.id);
              return yield* vaporizeResult("AbsenceConfirmed", "owned_state_absent_confirmed");
            }).pipe(Effect.catch(vaporizeUnknown("absence_confirmation_unknown"))),
        });
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(backup, evidence, artifacts, hatch, actorMetadata, sessionProjection),
      ),
    );
    const providerExecutor = sessionProviderEffectExecutorLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          createProvider,
          checkpointProvider,
          sleepProvider,
          resumeProvider,
          vaporizeProvider,
        ),
      ),
    );
    const actorRunner = actorEffectRunnerLayer.pipe(
      Layer.provide(Layer.merge(actorAlarms, providerExecutor)),
    );
    const actor = sessionActorLayer.pipe(Layer.provide(Layer.merge(actorStore, actorRunner)));
    const hardCap = createHardCapControllerLayer((fence) =>
      Effect.gen({ self: this }, function* () {
        const finalFence: CreateHardCapFence = {
          sessionId: fence.sessionId,
          generation: fence.generation,
          deadlineAt: fence.deadlineAt,
        };
        const schedule = (at: string, callback: string, payload: unknown) =>
          Effect.tryPromise({
            try: () => this.schedule(new Date(at), callback, payload).then(() => undefined),
            catch: () =>
              new CreateControllerBoundaryFailure({
                boundary: "hard_cap",
                code: "schedule_outcome_unknown",
              }),
          });
        yield* schedule(fence.deadlineAt, "sessionActorHardCap", finalFence);
        const drainAt = hardCapDrainAt(fence.deadlineAt, fence.durationSeconds);
        yield* schedule(drainAt, "sessionActorHardCapDrain", { ...finalFence, drainAt });
      }),
    );
    const lifecycleController = lifecycleControllerLayer.pipe(
      Layer.provide(Layer.mergeAll(actorStore, actor, hardCap)),
    );
    const warmWorkController = warmWorkControllerLayer.pipe(
      Layer.provide(Layer.merge(actorStore, actor)),
    );
    const metadataController = createMetadataControllerFromStoresLayer.pipe(
      Layer.provide(Layer.merge(actorMetadata, actorStore)),
    );
    const createController = createControllerLayer.pipe(
      Layer.provide(Layer.mergeAll(actor, hardCap, metadataController)),
    );

    this.layer = Layer.mergeAll(
      actorStore,
      actorMetadata,
      actor,
      createController,
      lifecycleController,
      warmWorkController,
      recovery,
      evidence,
      hatch,
      artifacts,
      sessionProjection,
      backup,
      runtimeAndContainerAuth,
      rolloutDiscoveryLayer.pipe(Layer.provide(runtime)),
      workspace,
      evidenceRecorder,
      materializer,
      repoVerifier,
    );
  }

  private readonly readActorHostRecordProgram = Effect.fnUntraced(function* () {
    const actorStore = yield* ActorStore;
    const snapshot = yield* actorStore.read;
    const authority = snapshot.authority;
    if (authority === undefined) return undefined;
    const metadataStore = yield* SessionActorMetadataStore;
    const metadata = yield* metadataStore.read(authority);
    if (metadata === undefined) return undefined;
    return sessionRecordFromActor(
      authority,
      metadata,
      snapshot.journalTail?.timestamp ?? authority.session.createdAt,
    );
  });

  private readonly requireRecordProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const actorRecord = yield* this.readActorHostRecordProgram();
    if (actorRecord !== undefined) return actorRecord;
    return yield* notFound("unknown");
  });

  private readonly readRecordProgram = Effect.fnUntraced(function* (this: Sandbox) {
    return yield* this.readActorHostRecordProgram();
  });

  private readonly resolveGithubCliCredentialProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    repository: string,
    sessionId: string,
  ) {
    const registry = this.env.CREDENTIALS?.getByName(CREDENTIAL_REGISTRY_OBJECT_NAME);
    if (registry === undefined)
      return yield* this.upstreamError("Credential registry is unavailable", undefined, sessionId);
    const resolved = yield* Effect.tryPromise({
      try: () => registry.resolveGithubCliCredential({ repository }),
      catch: (cause) =>
        this.upstreamError("Repository credential resolution failed", cause, sessionId),
    });
    if (!resolved.ok)
      return yield* this.upstreamError(
        "Repository credential resolution failed",
        resolved.error,
        sessionId,
      );
    const decoded = decodeCredentialRegistryResolvedCredentialResult(resolved.value);
    if (Result.isFailure(decoded))
      return yield* this.upstreamError(
        "Repository credential resolution failed",
        "invalid_response",
        sessionId,
      );
    return Redacted.make(decoded.success.value);
  });

  private readonly currentRuntimeEpochProgram = Effect.fnUntraced(function* (this: Sandbox) {
    if (this.rawContainer?.running !== true)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const actor = yield* ActorStore;
    const snapshot = yield* actor.read;
    const authority = snapshot.authority;
    if (authority !== undefined) {
      const readiness = AuthorityStateSchema.guards.Stable(authority.state)
        ? StableStateSchema.guards.Warm(authority.state.stable)
          ? authority.state.stable.readiness
          : undefined
        : "readiness" in authority.state.transition.proof
          ? authority.state.transition.proof.readiness
          : undefined;
      if (readiness?.runtime !== null && readiness?.runtime !== undefined)
        return readiness.runtime.runtimeGeneration;
    }
    return yield* new EvidenceStateError({ reason: "preview_unavailable" });
  });

  private readonly verifyPublicHatchRouteProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    hatch: HatchRecord,
    operationNonce?: string,
  ) {
    const previewBase = this.previewBase;
    if (previewBase === undefined)
      return yield* new HatchStateError({
        reason: "invalid_state",
        message: "Hatch routing is unavailable",
      });
    const origin = hatchOrigin(
      { sessionId: hatch.sessionId, port: hatch.service.port, routeNonce: hatch.routeNonce },
      previewBase,
    );
    const marker = operationNonce ?? hatch.routeNonce;
    const response = yield* Effect.tryPromise({
      try: (signal) => this.hatchPublicProbe(`${origin}${HATCH_READINESS_PATH}`, marker, signal),
      catch: () =>
        new HatchStateError({
          reason: "invalid_state",
          message: "Hatch public route is unreachable",
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: HATCH_PUBLIC_ROUTE_TIMEOUT_MILLIS,
        orElse: () =>
          Effect.fail(
            new HatchStateError({
              reason: "invalid_state",
              message: "Hatch public route readiness timed out",
            }),
          ),
      }),
    );
    if (
      response.status !== 204 ||
      response.headers.get("cache-control") !== "no-store" ||
      response.headers.get("x-robots-tag") !== "noindex, nofollow, noarchive" ||
      response.headers.get(HATCH_PRIVATE_READINESS_HEADER) !== "ready"
    )
      return yield* new HatchStateError({
        reason: "invalid_state",
        message: "Hatch public route did not reach Scotty",
      });
  });

  private readonly healthCheckAndExposeHatchProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    hatch: HatchRecord,
    operationNonce: string,
    runtimeEpoch: string,
    restoreFence?: HatchRestoreFence,
  ) {
    const previewBase = this.previewBase;
    if (previewBase === undefined)
      return yield* new HatchStateError({
        reason: "invalid_state",
        message: "Hatch routing is unavailable",
      });
    const runtime = yield* SandboxRuntime;
    const healthStatus = yield* runtime.fetchPortStatus(
      hatch.service.healthPath,
      hatch.service.port,
      "GET",
    );
    if (healthStatus < 200 || healthStatus > 399)
      return yield* new HatchStateError({
        reason: "invalid_state",
        message: "Hatch service health check failed",
      });
    const exposed = yield* hostEffect("expose", () =>
      this.exposePort(hatch.service.port, {
        hostname: previewBase,
        token: hatch.routeNonce,
        name: `hatch-${hatch.hatchId}`,
      }),
    );
    const expectedOrigin = hatchOrigin(
      { sessionId: hatch.sessionId, port: hatch.service.port, routeNonce: hatch.routeNonce },
      previewBase,
    );
    const exposedOrigin = yield* Effect.try({
      try: () => new URL(exposed.url).origin,
      catch: () =>
        new HatchStateError({ reason: "invalid_state", message: "Hatch exposure is invalid" }),
    });
    if (exposedOrigin !== expectedOrigin)
      return yield* new HatchStateError({
        reason: "invalid_state",
        message: "Hatch exposure host did not match authority",
      });
    yield* this.verifyPublicHatchRouteProgram(hatch, operationNonce);
    const store = yield* HatchStore;
    return yield* store.publishRunning(
      operationNonce,
      hatch.hatchId,
      hatch.generation,
      runtimeEpoch,
      restoreFence,
    );
  });

  private readonly prepareHatchRestoreProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    operationNonce: string,
  ) {
    const store = yield* HatchStore;
    const state = yield* store.read;
    if (state.primary === undefined || state.primary.desiredStatus !== "open") return undefined;
    const runtimeEpoch = yield* this.currentRuntimeEpochProgram();
    const hatch = yield* store.beginRestore({ operationNonce, runtimeEpoch });
    return hatch === undefined ? undefined : { hatch, operationNonce, runtimeEpoch };
  });

  private readonly completeHatchRestoreProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    pending: PendingHatchRestore,
  ) {
    const restored = yield* Effect.result(
      this.healthCheckAndExposeHatchProgram(
        pending.hatch,
        pending.operationNonce,
        pending.runtimeEpoch,
        pending.restoreFence,
      ),
    );
    if (Result.isSuccess(restored)) return;
    const cleanup = yield* Effect.result(
      this.cleanupHatchProgram(pending.operationNonce, "failed", false, {
        kind: "restore_operation",
        hatchId: pending.hatch.hatchId,
        generation: pending.hatch.generation,
        runtimeEpoch: pending.runtimeEpoch,
      }),
    );
    if (Result.isFailure(cleanup))
      yield* hostEffect("schedule", () =>
        this.schedule(5, "retryHatchCleanup", {
          operationNonce: pending.operationNonce,
          target: "failed",
          closeDesired: false,
        } satisfies HatchCleanupRetry),
      ).pipe(Effect.ignore);
    return yield* restored.failure;
  });

  private readonly completePreparedHatchRestoreProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    operationNonce: string,
    runtimeEpoch: string,
    restoreFence: HatchRestoreFence,
  ) {
    const store = yield* HatchStore;
    const state = yield* store.read;
    const hatch = state.primary;
    if (hatch === undefined || hatch.desiredStatus !== "open") return;
    if (
      hatch.observedStatus === "running" &&
      hatch.exposure === "active" &&
      hatch.publicReadyAt !== undefined &&
      hatch.runtimeEpoch === runtimeEpoch &&
      hatch.transitionNonce === undefined &&
      hatch.cleanup === undefined
    )
      return;
    const descriptor = yield* store.restoreDescriptor;
    if (
      descriptor === undefined ||
      hatch.hatchId !== descriptor.hatchId ||
      hatch.generation !== descriptor.generation ||
      hatch.transitionNonce !== operationNonce ||
      descriptor.runtimeEpoch !== runtimeEpoch ||
      hatch.runtimeEpoch !== runtimeEpoch
    )
      return yield* new HatchStateError({
        reason: "lease_changed",
        message: "Hatch transition changed",
      });
    yield* this.completeHatchRestoreProgram({
      hatch,
      operationNonce,
      runtimeEpoch,
      restoreFence,
    });
  });

  private readonly ensureScottyHatchProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    value: unknown,
  ) {
    const decoded = decodeEnsureHatchInput(value);
    if (Option.isNone(decoded)) return yield* badRequest("Hatch configuration is invalid");
    const previewBase = this.previewBase;
    if (previewBase === undefined)
      return yield* wrongState("warm", "hatch", "Hatch routing is not configured");
    const initial = yield* this.requireRecordProgram();
    if (
      initial.status !== "warm" ||
      initial.execution.provider !== "cloudflare" ||
      this.rawContainer?.running !== true
    )
      return yield* wrongState(initial.status, "hatch", "Hatch requires a warm Cloudflare runtime");
    const expectedRoot = `${sessionRoot(initial.id)}/`;
    if (
      decoded.value.service.workingDirectory !== sessionRoot(initial.id) &&
      !decoded.value.service.workingDirectory.startsWith(expectedRoot)
    )
      return yield* badRequest("Hatch working directory must belong to this session");
    const evidenceState = yield* Effect.flatMap(EvidenceStore, (store) => store.read);
    if (
      evidenceState.activeJob?.port === decoded.value.service.port &&
      (evidenceState.activeJob.exposure === "active" ||
        evidenceState.activeJob.exposure === "unexpose_pending")
    )
      return yield* conflict("Hatch cannot expose the active evidence service port");
    const operation = yield* this.admitWarmWorkProgram("Hatch");
    let cleanupRequired = false;
    let cleanupOutcomeUnknown = false;
    const result = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        const runtimeEpoch = yield* this.currentRuntimeEpochProgram();
        const hatch = yield* HatchStore;
        const beginning = yield* hatch.beginEnsure({
          sessionId: initial.id,
          operationNonce: operation.nonce,
          hatchId: `hatch-${randomToken(8)}`,
          routeNonce: `h${randomToken(7)}`,
          runtimeEpoch,
          service: decoded.value.service,
        });
        if (!beginning.needsExposure) {
          cleanupRequired = true;
          const ready = yield* this.requireReadyHatchServiceProgram({
            sessionId: beginning.hatch.sessionId,
            hatchId: beginning.hatch.hatchId,
            generation: beginning.hatch.generation,
            port: beginning.hatch.service.port,
            routeNonce: beginning.hatch.routeNonce,
            runtimeEpoch,
          });
          if (!ready)
            return yield* new HatchStateError({
              reason: "invalid_state",
              message: "Hatch public route is unavailable",
            });
          return yield* hatch.publicStatus;
        }
        cleanupRequired = true;
        const running = yield* this.healthCheckAndExposeHatchProgram(
          beginning.hatch,
          operation.nonce,
          runtimeEpoch,
        );
        return publicHatchStatusProjection({ primary: running });
      }),
    );
    if (Result.isFailure(result) && cleanupRequired) {
      const cleanup = yield* Effect.result(
        this.cleanupHatchProgram(operation.nonce, "failed", false, "operation"),
      );
      cleanupOutcomeUnknown = Result.isFailure(cleanup);
      if (cleanupOutcomeUnknown)
        yield* hostEffect("schedule", () =>
          this.schedule(5, "retryHatchCleanup", {
            operationNonce: operation.nonce,
            target: "failed",
            closeDesired: false,
          } satisfies HatchCleanupRetry),
        );
    }
    if (cleanupOutcomeUnknown)
      yield* this.reconcileWarmWorkProgram(operation, "hatch_cleanup_outcome_unknown");
    else
      yield* this.settleWarmWorkProgram(
        operation,
        Result.isFailure(result) ? "hatch_ensure_failed" : "hatch_ensure_complete",
      );
    if (Result.isFailure(result)) return yield* this.hatchControlError(result.failure);
    return result.success;
  });

  private readonly hatchControlError = (failure: unknown): ScottyError => {
    if (isHatchStateError(failure)) {
      const { reason } = failure;
      if (reason === "conflict" || reason === "lease_changed")
        return conflict("Hatch state changed during the operation");
      if (reason === "invalid_state" || reason === "runtime_changed")
        return wrongState("warm", "hatch", "Hatch is unavailable for the current runtime");
    }
    return this.upstreamError("Hatch operation failed", failure);
  };

  private closeTrackedHatchWebSockets(code: number, reason: string): void {
    this.hatchWebSocketAdmissions.clear();
    for (const socket of this.hatchWebSockets.values()) socket.close(code, reason);
    this.hatchWebSockets.clear();
  }

  private readonly cleanupHatchProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    operationNonce: string,
    target: HatchCleanupTarget,
    closeDesired: boolean,
    authority: HatchCleanupAuthority,
  ) {
    const hatch = yield* HatchStore;
    const currentResult = yield* Effect.result(hatch.read);
    if (Result.isFailure(currentResult)) {
      if (target === "gone" && authority === "operation") {
        yield* hatch.clearUnreadableAfterVaporize(operationNonce);
        return true;
      }
      return yield* currentResult.failure;
    }
    const current = currentResult.success;
    if (current.primary === undefined) return false;
    const pending = yield* hatch.beginCleanup(operationNonce, target, closeDesired, authority);
    if (pending === undefined) return false;
    yield* Effect.sync(() => {
      this.closeTrackedHatchWebSockets(1001, "Hatch authority revoked");
      for (const controller of this.hatchRequests.values()) controller.abort();
      this.hatchRequests.clear();
    });
    if (pending.exposure === "unexpose_pending" && this.rawContainer?.running === true)
      yield* hostEffect("unexpose", () => this.unexposePort(pending.service.port));
    yield* hatch.completeCleanup(operationNonce, target);
    return true;
  });

  private readonly closeScottyHatchProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.requireRecordProgram();
    if (record.status !== "warm") return yield* wrongState(record.status, "hatch");
    const operation = yield* this.admitWarmWorkProgram("Hatch");
    const closed = yield* Effect.result(
      this.cleanupHatchProgram(operation.nonce, "stopped", true, "operation"),
    );
    const scheduled = Result.isFailure(closed)
      ? yield* Effect.result(
          hostEffect("schedule", () =>
            this.schedule(5, "retryHatchCleanup", {
              operationNonce: operation.nonce,
              target: "stopped",
              closeDesired: true,
            } satisfies HatchCleanupRetry),
          ),
        )
      : Result.succeed(undefined);
    if (Result.isFailure(closed) || Result.isFailure(scheduled))
      yield* this.reconcileWarmWorkProgram(operation, "hatch_close_outcome_unknown");
    else yield* this.settleWarmWorkProgram(operation, "hatch_close_complete");
    if (Result.isFailure(scheduled))
      return yield* this.upstreamError("Hatch cleanup retry scheduling failed", scheduled.failure);
    if (Result.isFailure(closed)) return yield* this.hatchControlError(closed.failure);
    return yield* Effect.flatMap(HatchStore, (store) => store.publicStatus);
  });

  private readonly retryHatchCleanupProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: HatchCleanupRetry,
  ) {
    const state = yield* Effect.flatMap(HatchStore, (store) => store.read);
    if (
      state.primary?.cleanup?.operationNonce !== payload.operationNonce ||
      state.primary.cleanup.target !== payload.target
    )
      return;
    const cleaned = yield* Effect.result(
      this.cleanupHatchProgram(
        payload.operationNonce,
        payload.target,
        payload.closeDesired,
        "scheduled",
      ),
    );
    if (Result.isFailure(cleaned))
      yield* hostEffect("schedule", () => this.schedule(5, "retryHatchCleanup", payload));
  });

  private readonly acceptDecodedScottyEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    job: BrowserEvidenceJob,
  ) {
    if (!this.evidenceEnabled)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const record = yield* this.requireRecordProgram();
    if (record.status !== "warm" || record.execution.provider !== "cloudflare")
      return yield* wrongState(
        record.status,
        "evidence",
        "Evidence requires a warm Cloudflare session",
      );
    if (this.rawContainer?.running !== true)
      return yield* wrongState(record.status, "evidence", "The Sandbox runtime is not running");
    const runtimeEpoch = yield* this.currentRuntimeEpochProgram();
    const now = yield* Clock.currentTimeMillis;
    const deadlineMillis = Math.min(
      now + EVIDENCE_JOB_TIMEOUT_MILLIS,
      Date.parse(record.hardCapAt),
    );
    if (!Number.isFinite(deadlineMillis) || deadlineMillis <= now)
      return yield* wrongState(record.status, "evidence", "The session hard cap has elapsed");
    const deadlineAt = new Date(deadlineMillis).toISOString();
    const operationNonce = randomToken(12);
    const flowHash = yield* Effect.tryPromise({
      try: () => sha256Hex(JSON.stringify({ viewport: job.viewport, steps: job.steps })),
      catch: () => new EvidenceStateError({ reason: "storage" }),
    });
    const evidence = yield* EvidenceStore;
    const admission = yield* evidence.prepareAdmission(
      {
        jobId: `job-${randomToken(8)}`,
        operationNonce,
        runtimeEpoch,
        routeNonce: randomToken(8),
        deadlineAt,
        flowHash,
        job,
      },
      record,
      runtimeEpoch,
    );
    const lease = yield* this.admitWarmWorkProgram("Evidence", {
      nonce: operationNonce,
      deadlineAt,
      evidence: {
        _tag: "Put",
        value: admission.state,
        expected: admission.expectedEvidence,
      },
    });
    const admitted = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        if (admission.capacityDeletes.length > 0) {
          yield* this.armEvidenceRetentionFailClosedProgram();
          yield* this.deleteEvidenceArtifactsProgram(admission.capacityDeletes);
          yield* this.armEvidenceRetentionFailClosedProgram();
        }
        const scheduled = yield* Effect.result(
          hostEffect("schedule", () =>
            this.schedule(new Date(deadlineAt), "expireEvidenceJob", {
              nonce: operationNonce,
              deadlineAt,
            } satisfies EvidenceDeadlinePayload),
          ),
        );
        if (Result.isSuccess(scheduled)) return admission.active;
        yield* evidence.interrupt(operationNonce, "interrupted");
        return yield* this.upstreamError("Evidence deadline scheduling failed", scheduled.failure);
      }),
    );
    if (Result.isSuccess(admitted)) return admitted.success;
    yield* this.reconcileWarmWorkProgram(lease, "evidence_admission_outcome_unknown");
    return yield* admitted.failure;
  });

  private readonly acceptScottyEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    value: unknown,
  ) {
    const job = yield* decodeBrowserEvidenceJobEffect(value).pipe(
      Effect.mapError(() => badRequest("Evidence job is invalid")),
    );
    return yield* this.acceptDecodedScottyEvidenceJobProgram(job);
  });

  private abortPreviewRequests(operationNonce: string): void {
    for (const [requestId, request] of this.previewRequests) {
      if (request.operationNonce !== operationNonce) continue;
      request.controller.abort();
      this.previewRequests.delete(requestId);
    }
  }

  private readonly reconcileLateEvidenceExposureProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    port: number,
    deadlineAt: string,
  ) {
    const evidence = yield* EvidenceStore;
    const reconciled = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* hostEffect("unexpose", () =>
          boundedHostResult(() => this.unexposePort(port), this.evidencePreviewHostTimeoutMillis),
        );
        yield* evidence.closePreview(nonce);
      }),
    );
    if (Result.isSuccess(reconciled)) return;
    const scheduled = yield* Effect.result(
      hostEffect("schedule", () =>
        this.schedule(EVIDENCE_CLEANUP_RETRY_SECONDS, "expireEvidenceJob", {
          nonce,
          deadlineAt,
        } satisfies EvidenceDeadlinePayload),
      ),
    );
    yield* Effect.sync(() =>
      console.error("Late evidence exposure cleanup remains authoritative and pending", {
        error: errorName(reconciled.failure),
        retryScheduled: Result.isSuccess(scheduled),
      }),
    );
  });

  private startLateEvidenceExposureReconciliation(
    nonce: string,
    exposure: InFlightPreviewExposure,
    port: number,
    deadlineAt: string,
  ): void {
    if (exposure.background !== undefined) return;
    const background = exposure.reconciliation.then(() =>
      this.#run(this.reconcileLateEvidenceExposureProgram(nonce, port, deadlineAt)),
    );
    exposure.background = background;
    this.ctx.waitUntil(background);
    const forget = (): void => {
      if (this.previewExposureReconciliations.get(nonce) === exposure)
        this.previewExposureReconciliations.delete(nonce);
    };
    void background.then(forget, forget);
  }

  private readonly cleanupEvidencePreviewProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    interruptionReason?: "deadline" | "interrupted",
  ) {
    const evidence = yield* EvidenceStore;
    const revoked = yield* evidence.revokePreview(nonce, interruptionReason);
    yield* Effect.sync(() => this.abortPreviewRequests(nonce));
    const exposure = this.previewExposureReconciliations.get(nonce);
    if (exposure !== undefined) {
      yield* Effect.sync(() =>
        this.startLateEvidenceExposureReconciliation(
          nonce,
          exposure,
          revoked.port,
          revoked.deadlineAt,
        ),
      );
      return yield* new HostOperationFailure({
        operation: "expose",
        cause: "reconciliation_pending",
      });
    }
    if (revoked.exposure === "unexpose_pending") {
      yield* hostEffect("unexpose", () =>
        boundedHostResult(
          () => this.unexposePort(revoked.port),
          this.evidencePreviewHostTimeoutMillis,
        ),
      );
      return yield* evidence.closePreview(nonce);
    }
    return revoked;
  });

  private readonly exposeScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
  ) {
    if (Option.isNone(decodeEvidenceIdentifier(nonce)))
      return yield* badRequest("Evidence operation nonce is invalid");
    if (!this.evidenceEnabled)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const previewBase = this.previewBase;
    if (previewBase === undefined)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    const active = state.activeJob;
    if (active?.operationNonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });
    if (this.rawContainer?.running !== true)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const runtimeEpoch = yield* this.currentRuntimeEpochProgram();
    if (runtimeEpoch !== active.runtimeEpoch)
      return yield* new EvidenceStateError({ reason: "preview_unavailable" });
    const record = yield* this.requireRecordProgram();
    const canonicalOrigin = `https://${active.port}-${record.id}-${active.routeNonce}.${previewBase}`;
    yield* evidence.beginPreviewExposure(nonce, {
      runtimeEpoch,
      runtimeRunning: this.rawContainer?.running === true,
    });
    const cookieSecret = randomToken(32);
    const cookieDigest = yield* Effect.tryPromise({
      try: () => sha256Hex(cookieSecret),
      catch: () => new EvidenceStateError({ reason: "preview_unavailable" }),
    });
    const nowMillis = yield* Clock.currentTimeMillis;
    const remainingMillis = Date.parse(active.deadlineAt) - nowMillis;
    const exposureTimeoutMillis = Math.max(
      0,
      Math.min(this.evidencePreviewHostTimeoutMillis, remainingMillis),
    );
    let pendingExposure: InFlightPreviewExposure | undefined;
    const exposed = yield* Effect.result(
      Effect.tryPromise({
        try: (signal) => {
          const bounded = boundedHostPromise(
            () =>
              this.exposePort(active.port, {
                hostname: previewBase,
                token: active.routeNonce,
                name: `evidence-${active.jobId}`,
              }),
            exposureTimeoutMillis,
            signal,
          );
          pendingExposure = { reconciliation: bounded.reconciliation, background: undefined };
          this.previewExposureReconciliations.set(nonce, pendingExposure);
          return bounded.result;
        },
        catch: (cause) => new HostOperationFailure({ operation: "expose", cause }),
      }),
    );
    if (Result.isFailure(exposed)) {
      yield* Effect.result(this.cleanupEvidencePreviewProgram(nonce, "interrupted"));
      return yield* Effect.fail(exposed.failure);
    }
    if (
      pendingExposure !== undefined &&
      this.previewExposureReconciliations.get(nonce) === pendingExposure
    )
      this.previewExposureReconciliations.delete(nonce);
    const exposedOrigin = yield* Effect.result(
      Effect.try({
        try: () => new URL(exposed.success.url).origin,
        catch: () => new EvidenceStateError({ reason: "preview_unavailable" }),
      }),
    );
    const published =
      Result.isSuccess(exposedOrigin) && exposedOrigin.success === canonicalOrigin
        ? yield* Effect.result(
            evidence.publishPreviewExposure(nonce, {
              runtimeEpoch,
              cookieDigest,
              runtimeRunning: this.rawContainer?.running === true,
            }),
          )
        : Result.fail(new EvidenceStateError({ reason: "preview_unavailable" }));
    if (Result.isFailure(published)) {
      yield* Effect.result(this.cleanupEvidencePreviewProgram(nonce, "interrupted"));
      return yield* published.failure;
    }
    return {
      origin: canonicalOrigin,
      cookieSecret,
      expiresAt: published.success.deadlineAt,
    } satisfies ExposedEvidencePreview;
  });

  private readonly admitScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    value: unknown,
  ) {
    const decoded = decodeEvidencePreviewAdmission(value);
    if (!this.evidenceEnabled || Option.isNone(decoded) || this.rawContainer?.running !== true)
      return undefined;
    const runtimeEpoch = yield* Effect.result(this.currentRuntimeEpochProgram());
    if (Result.isFailure(runtimeEpoch)) return undefined;
    const cookieDigest = yield* Effect.result(
      Effect.tryPromise({
        try: () => sha256Hex(decoded.value.cookieSecret),
        catch: () => new EvidenceStateError({ reason: "preview_unavailable" }),
      }),
    );
    if (Result.isFailure(cookieDigest)) return undefined;
    return yield* Effect.flatMap(EvidenceStore, (store) =>
      store.admitPreview({
        requestId: randomToken(16),
        sessionId: decoded.value.sessionId,
        port: decoded.value.port,
        routeNonce: decoded.value.routeNonce,
        runtimeEpoch: runtimeEpoch.success,
        cookieDigest: cookieDigest.success,
        ingressBytes: decoded.value.ingressBytes,
        runtimeRunning: this.rawContainer?.running === true,
      }),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
  });

  private readonly adjustScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    requestId: string,
    ingressBytes: number,
  ) {
    const evidence = yield* EvidenceStore;
    return yield* evidence.adjustPreview(requestId, ingressBytes);
  });

  private readonly claimScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    requestId: string,
    route: { readonly sessionId: string; readonly port: number; readonly routeNonce: string },
  ) {
    const runtimeEpoch = yield* Effect.result(this.currentRuntimeEpochProgram());
    if (Result.isFailure(runtimeEpoch)) return undefined;
    return yield* Effect.flatMap(EvidenceStore, (store) =>
      store.claimPreview({
        requestId,
        ...route,
        runtimeEpoch: runtimeEpoch.success,
        runtimeRunning: this.rawContainer?.running === true,
      }),
    ).pipe(Effect.catch(() => Effect.succeed(undefined)));
  });

  private readonly settleScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    requestId: string,
    responseBytes: number,
  ) {
    const evidence = yield* EvidenceStore;
    yield* evidence.settlePreview(requestId, responseBytes);
  });

  private readonly cancelScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    requestId: string,
  ) {
    const evidence = yield* EvidenceStore;
    yield* evidence.cancelPreview(requestId);
  });

  private readonly expireScottyEvidencePreviewProgram = Effect.fnUntraced(function* (
    requestId: string,
  ) {
    const evidence = yield* EvidenceStore;
    yield* evidence.expirePreview(requestId);
  });

  private readonly expireEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: EvidenceDeadlinePayload,
  ) {
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    if (
      state.activeJob?.operationNonce !== payload.nonce ||
      state.activeJob.deadlineAt !== payload.deadlineAt
    )
      return;
    const cleaned = yield* Effect.result(
      this.cleanupEvidencePreviewProgram(payload.nonce, "deadline"),
    );
    if (Result.isFailure(cleaned)) {
      yield* hostEffect("schedule", () =>
        this.schedule(EVIDENCE_CLEANUP_RETRY_SECONDS, "expireEvidenceJob", payload),
      );
      return;
    }
    yield* evidence.interrupt(payload.nonce, "deadline");
  });

  private readonly deleteEvidenceArtifactsProgram = Effect.fnUntraced(function* (
    artifacts: ReadonlyArray<EvidenceArtifact>,
  ) {
    const evidence = yield* EvidenceStore;
    const artifactStore = yield* ArtifactStore;
    for (const artifact of artifacts) {
      yield* artifactStore.deleteArtifact(artifact);
      yield* evidence.confirmDelete(artifact.objectKey);
    }
  });

  private readonly reconcileEvidenceDeletesProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    yield* this.deleteEvidenceArtifactsProgram(
      state.artifacts.filter((artifact) => artifact.status === "delete_pending"),
    );
  });

  private readonly scheduleEvidenceRetentionAtProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    expiresAt: string,
  ) {
    const scheduled = yield* Effect.result(
      hostEffect("schedule", () =>
        this.schedule(new Date(expiresAt), "expireRetainedEvidence", {
          expiresAt,
        } satisfies EvidenceRetentionPayload),
      ),
    );
    if (Result.isSuccess(scheduled)) return;
    const inserted = yield* this.hasScheduledEvidenceRetentionAtProgram(expiresAt);
    if (!inserted) return yield* scheduled.failure;
  });

  private readonly nextEvidenceRetentionAtProgram = Effect.fnUntraced(function* (
    promoting?: EvidenceArtifact,
  ) {
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    const nowMillis = yield* Clock.currentTimeMillis;
    const needsRetry = state.artifacts.some(
      (artifact) =>
        artifact.objectKey !== promoting?.objectKey &&
        (artifact.status === "delete_pending" || Date.parse(artifact.expiresAt) <= nowMillis),
    );
    const activeDeadlineMillis = Date.parse(state.activeJob?.deadlineAt ?? "");
    const nextAtMillis = needsRetry
      ? Number.isFinite(activeDeadlineMillis) && activeDeadlineMillis > nowMillis
        ? activeDeadlineMillis
        : nowMillis + EVIDENCE_CLEANUP_RETRY_SECONDS * 1_000
      : Math.min(
          ...state.artifacts
            .filter((artifact) => artifact.status === "available")
            .map((artifact) => Date.parse(artifact.expiresAt)),
          ...(promoting === undefined ? [] : [Date.parse(promoting.expiresAt)]),
        );
    return Number.isFinite(nextAtMillis) ? new Date(nextAtMillis).toISOString() : undefined;
  });

  private readonly armEvidenceRetentionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    promoting?: EvidenceArtifact,
  ) {
    const expiresAt = yield* this.nextEvidenceRetentionAtProgram(promoting);
    if (expiresAt === undefined || (yield* this.hasScheduledEvidenceRetentionProgram())) return;
    yield* this.scheduleEvidenceRetentionAtProgram(expiresAt);
  });

  private readonly armFutureEvidenceRetentionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const expiresAt = yield* this.nextEvidenceRetentionAtProgram();
    if (expiresAt === undefined) return;
    const nowMillis = yield* Clock.currentTimeMillis;
    if (yield* this.hasScheduledEvidenceRetentionProgram(nowMillis)) return;
    yield* this.scheduleEvidenceRetentionAtProgram(expiresAt);
  });

  private readonly hasScheduledEvidenceRetentionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    afterMillis?: number,
  ) {
    const schedules = yield* Effect.tryPromise({
      try: () => this.listSchedules<EvidenceRetentionPayload>("expireRetainedEvidence"),
      catch: (cause) => new HostOperationFailure({ operation: "schedule", cause }),
    });
    return schedules.some(
      (schedule) => afterMillis === undefined || schedule.time * 1_000 > afterMillis,
    );
  });

  private readonly hasScheduledEvidenceRetentionAtProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    expiresAt: string,
  ) {
    const schedules = yield* Effect.tryPromise({
      try: () => this.listSchedules<EvidenceRetentionPayload>("expireRetainedEvidence"),
      catch: (cause) => new HostOperationFailure({ operation: "schedule", cause }),
    });
    const expectedTime = Math.floor(Date.parse(expiresAt) / 1_000);
    return schedules.some((schedule) => schedule.time === expectedTime);
  });

  private readonly armEvidenceRetentionFailClosedProgram = Effect.fnUntraced(
    function* (this: Sandbox) {
      const firstAttempt = yield* Effect.result(this.armEvidenceRetentionProgram());
      if (Result.isSuccess(firstAttempt)) return;
      yield* Effect.sync(() => reportEvidenceControlFailure("retention", firstAttempt.failure));
      yield* Effect.sleep("1 second");
      yield* this.armEvidenceRetentionProgram().pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second") }),
      );
    },
  );

  private readonly armFutureEvidenceRetentionFailClosedProgram = Effect.fnUntraced(
    function* (this: Sandbox) {
      const firstAttempt = yield* Effect.result(this.armFutureEvidenceRetentionProgram());
      if (Result.isSuccess(firstAttempt)) return;
      yield* Effect.sync(() =>
        reportEvidenceControlFailure("future_retention", firstAttempt.failure),
      );
      yield* Effect.sleep("1 second");
      yield* this.armFutureEvidenceRetentionProgram().pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second") }),
      );
    },
  );

  private readonly expireRetainedEvidenceProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    payload: unknown,
  ) {
    const decoded = decodeEvidenceRetentionPayload(payload);
    if (Option.isNone(decoded) || !Number.isFinite(Date.parse(decoded.value.expiresAt))) return;
    const evidence = yield* EvidenceStore;
    // The pinned Container host deletes the executing row after this callback returns. Insert its
    // sole future successor first; interruption before insertion leaves the current alarm retryable.
    yield* this.armFutureEvidenceRetentionFailClosedProgram();
    const reconciled = yield* Effect.result(
      Effect.gen({ self: this }, function* () {
        yield* evidence.prepareExpiredDeletes;
        yield* this.reconcileEvidenceDeletesProgram();
      }),
    );
    if (Result.isFailure(reconciled))
      yield* Effect.sync(() =>
        console.error("Evidence retention reconciliation remains authoritative and pending", {
          error: errorName(reconciled.failure),
        }),
      );
  });

  private readonly writeEvidenceStepFrameProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    prepared: PreparedEvidenceFrame,
  ) {
    const artifactStore = yield* ArtifactStore;
    yield* this.armEvidenceRetentionProgram().pipe(
      Effect.mapError(evidenceArtifactRetentionFailure),
    );
    const artifact = yield* artifactStore.writeFrame(prepared);
    yield* this.armEvidenceRetentionProgram(artifact).pipe(
      Effect.mapError(evidenceArtifactRetentionFailure),
    );
    return artifact;
  });

  private readonly discardEvidenceStepFrameProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    artifact: EvidenceArtifact,
    jobId: string,
    message: string,
  ) {
    const evidence = yield* EvidenceStore;
    const pending = yield* evidence.requestVerifiedDelete(artifact, "abandoned");
    if (pending !== undefined) {
      const deleted = yield* Effect.result(this.deleteEvidenceArtifactsProgram([pending]));
      if (Result.isFailure(deleted))
        yield* Effect.sync(() =>
          console.error(message, {
            jobId,
            frameId: pending.frameId,
            error: errorName(deleted.failure),
          }),
        );
    }
    yield* this.armEvidenceRetentionFailClosedProgram();
  });

  private readonly prepareEvidenceStepFrameProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    sessionId: string,
    jobId: string,
    input: CompleteEvidenceStepPublication,
  ) {
    const frame = input.frame;
    if (frame === undefined) return evidenceStepFrameSucceeded();
    const artifactStore = yield* ArtifactStore;
    const preparedResult = yield* Effect.result(
      artifactStore.prepareFrame({
        sessionId,
        jobId,
        frameId: frame.frameId,
        bytes: frame.bytes,
        capturedAt: frame.capturedAt,
        offsetMillis: frame.offsetMillis,
      }),
    );
    if (Result.isFailure(preparedResult)) return evidenceStepFrameFailed(preparedResult.failure);
    const prepared = preparedResult.success;
    const evidence = yield* EvidenceStore;
    yield* evidence.prepareArtifactUpload(nonce, input.index, prepared.artifact);
    const published = yield* Effect.result(this.writeEvidenceStepFrameProgram(prepared));
    if (Result.isSuccess(published)) return evidenceStepFrameSucceeded(published.success);
    yield* this.discardEvidenceStepFrameProgram(
      prepared.artifact,
      jobId,
      "Unpublished evidence frame deletion remains authoritative and pending",
    );
    return evidenceStepFrameFailed(published.failure);
  });

  private readonly completeScottyEvidenceStepProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    value: unknown,
  ) {
    if (Option.isNone(decodeEvidenceIdentifier(nonce)))
      return yield* badRequest("Evidence operation nonce is invalid");
    const input = yield* decodeCompleteEvidenceStepPublication(value).pipe(
      Effect.mapError(() => badRequest("Evidence step publication is invalid")),
    );
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    const active = state.activeJob;
    if (active?.operationNonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });
    const record = yield* this.requireRecordProgram();
    if (record.operation?.kind !== "evidence" || record.operation.nonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });

    const failedAssertion = input.assertions.some((assertion) => !assertion.passed);
    const frame = yield* this.prepareEvidenceStepFrameProgram(
      nonce,
      record.id,
      active.jobId,
      input,
    );
    if (frame.failure !== undefined && !failedAssertion) return yield* frame.failure;

    const artifact = frame.artifact;
    const publication = evidenceStepPublication(input);
    const completed = yield* Effect.result(
      evidence.completeStep(nonce, {
        ...publication,
        ...(artifact === undefined ? {} : { artifact }),
      }),
    );
    if (Result.isSuccess(completed)) return completed.success;
    if (artifact === undefined) return yield* completed.failure;

    yield* this.discardEvidenceStepFrameProgram(
      artifact,
      active.jobId,
      "Failed evidence frame deletion remains authoritative and pending",
    );
    if (failedAssertion) return yield* evidence.completeStep(nonce, publication);
    return yield* completed.failure;
  });

  private readonly completeScottyEvidenceVideoProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    value: unknown,
  ) {
    if (Option.isNone(decodeEvidenceIdentifier(nonce)))
      return yield* badRequest("Evidence operation nonce is invalid");
    const input = yield* decodeCompleteEvidenceVideoPublication(value).pipe(
      Effect.mapError(() => badRequest("Evidence video publication is invalid")),
    );
    const evidence = yield* EvidenceStore;
    const state = yield* evidence.read;
    const active = state.activeJob;
    if (active?.operationNonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });
    const record = yield* this.requireRecordProgram();
    if (record.operation?.kind !== "evidence" || record.operation.nonce !== nonce)
      return yield* new EvidenceStateError({ reason: "lease_changed" });
    const artifactStore = yield* ArtifactStore;
    const prepared = yield* artifactStore.prepareVideo({
      sessionId: record.id,
      jobId: active.jobId,
      artifactId: input.artifactId,
      bytes: input.bytes,
      capturedAt: input.capturedAt,
      offsetMillis: input.offsetMillis,
    });
    yield* evidence.prepareVideoUpload(nonce, prepared.artifact);
    const published = yield* Effect.result(
      this.armEvidenceRetentionProgram().pipe(
        Effect.andThen(artifactStore.writeArtifact(prepared)),
        Effect.tap((artifact) => this.armEvidenceRetentionProgram(artifact)),
        Effect.flatMap((artifact) => evidence.completeVideo(nonce, { artifact })),
      ),
    );
    if (Result.isSuccess(published)) return published.success;
    const pending = yield* evidence.requestVerifiedDelete(prepared.artifact, "abandoned");
    if (pending !== undefined) {
      const deleted = yield* Effect.result(this.deleteEvidenceArtifactsProgram([pending]));
      if (Result.isFailure(deleted))
        yield* Effect.sync(() =>
          console.error("Unpublished evidence video deletion remains authoritative and pending", {
            jobId: active.jobId,
            error: errorName(deleted.failure),
          }),
        );
    }
    yield* this.armEvidenceRetentionFailClosedProgram();
    return yield* published.failure;
  });

  private readonly finalizeScottyEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    nonce: string,
    status: EvidenceTerminalStatus,
  ) {
    const evidence = yield* EvidenceStore;
    yield* this.cleanupEvidencePreviewProgram(nonce);
    const summary = yield* evidence.finalize(nonce, status);
    const reconciled = yield* Effect.result(this.reconcileEvidenceDeletesProgram());
    if (Result.isFailure(reconciled))
      yield* Effect.sync(() =>
        console.error("Evidence artifact reconciliation remains pending", {
          jobId: summary.jobId,
          error: errorName(reconciled.failure),
        }),
      );
    yield* this.armEvidenceRetentionFailClosedProgram();
    yield* this.settleCurrentWarmWorkProgram(
      "Evidence",
      nonce,
      status === "succeeded" ? "evidence_complete" : `evidence_${status}`,
    );
    return summary;
  });

  private evidenceWorkflowControl(): EvidenceWorkflowControl["Service"] {
    return EvidenceWorkflowControl.of({
      expose: (active) =>
        this.exposeScottyEvidencePreviewProgram(active.operationNonce).pipe(
          Effect.mapError(
            (error) =>
              new EvidenceWorkflowControlError({
                operation: "expose",
                failureCode: Predicate.isTagged(error, "HostOperationFailure")
                  ? "interrupted"
                  : "unsupported",
              }),
          ),
          Effect.provide(this.layer),
        ),
      markRunning: (active) =>
        Effect.flatMap(EvidenceStore, (store) =>
          store.setPhase(active.operationNonce, "running"),
        ).pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new EvidenceWorkflowControlError({
                operation: "mark_running",
                failureCode: "interrupted",
              }),
          ),
          Effect.provide(this.layer),
        ),
      completeStep: (active, input) =>
        this.completeScottyEvidenceStepProgram(active.operationNonce, input).pipe(
          Effect.asVoid,
          Effect.tapError((error) =>
            Effect.sync(() => reportEvidenceControlFailure("complete_step", error)),
          ),
          Effect.mapError(
            (error) =>
              new EvidenceWorkflowControlError({
                operation: "complete_step",
                failureCode: evidenceControlFailureCode(error),
              }),
          ),
          Effect.provide(this.layer),
        ),
      completeVideo: (active, input) =>
        this.completeScottyEvidenceVideoProgram(active.operationNonce, input).pipe(
          Effect.asVoid,
          Effect.tapError((error) =>
            Effect.sync(() => reportEvidenceControlFailure("complete_video", error)),
          ),
          Effect.mapError(
            (error) =>
              new EvidenceWorkflowControlError({
                operation: "complete_video",
                failureCode: evidenceControlFailureCode(error),
              }),
          ),
          Effect.provide(this.layer),
        ),
      recordFailure: (active, failure, diagnostic) =>
        Effect.flatMap(EvidenceStore, (store) =>
          store.recordFailure(active.operationNonce, failure, diagnostic),
        ).pipe(
          Effect.asVoid,
          Effect.mapError(
            () =>
              new EvidenceWorkflowControlError({
                operation: "record_failure",
                failureCode: failure.code,
              }),
          ),
          Effect.provide(this.layer),
        ),
      finalize: (active, status) =>
        this.finalizeScottyEvidenceJobProgram(active.operationNonce, status).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => reportEvidenceControlFailure("finalize", error)),
          ),
          Effect.mapError(
            () =>
              new EvidenceWorkflowControlError({
                operation: "finalize",
                failureCode: "interrupted",
              }),
          ),
          Effect.provide(this.layer),
        ),
    });
  }

  private readonly runScottyEvidenceJobProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    value: unknown,
  ) {
    const job = yield* decodeBrowserEvidenceJobEffect(value).pipe(
      Effect.mapError(() => badRequest("Evidence job is invalid")),
    );
    const active = yield* this.acceptDecodedScottyEvidenceJobProgram(job);
    const hatchState = yield* Effect.result(Effect.flatMap(HatchStore, (store) => store.read));
    const primary = Result.isSuccess(hatchState) ? hatchState.success.primary : undefined;
    const portConflictsWithHatch =
      primary?.service.port === job.port &&
      (primary.desiredStatus === "open" ||
        primary.exposure === "active" ||
        primary.exposure === "unexpose_pending");
    const preflightFailure = Result.isFailure(hatchState)
      ? ({ code: "interrupted" } as const)
      : portConflictsWithHatch
        ? ({ code: "port_conflict" } as const)
        : undefined;
    const record = yield* this.requireRecordProgram();
    return yield* runEvidenceWorkflow({
      active,
      job,
      summaryUrl: `/s/${record.id}/evidence/${active.jobId}`,
      ...(preflightFailure === undefined ? {} : { preflightFailure }),
    }).pipe(Effect.provideService(EvidenceWorkflowControl, this.evidenceWorkflowControl()));
  });

  private readonly assertRuntimeAccessProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.readRecordProgram();
    if (!sessionAllowsRuntimeAccess(record))
      return yield* conflict("Session destruction is already in progress");
    return record;
  });

  private readonly prepareTerminalAccessProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.requireRecordProgram();
    if (record.status !== "warm")
      return yield* wrongState(
        record.status,
        "access",
        record.status === "sleeping"
          ? "Resume the session from Home before opening the terminal"
          : undefined,
      );
    if (!sessionAllowsRuntimeAccess(record))
      return yield* conflict("Session destruction is already in progress");
    if (record.operation)
      return yield* conflict(`Session is already running ${record.operation.kind}`);
    if (record.execution.provider !== "cloudflare")
      return yield* wrongState(record.status, "access", "This session uses the runner runtime");
    const grant = record.credentialGrant;
    if (grant === undefined)
      return yield* this.upstreamError(
        "Session credential grant is unavailable",
        undefined,
        record.id,
      );
    const containerAuth = yield* ContainerAuth;
    yield* containerAuth.ensureTerminal(record.id, sessionRuntimeCredentials(grant.grants));
    return record;
  });

  private readonly restartScottyTerminalProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.prepareTerminalAccessProgram();
    yield* Effect.tryPromise({
      try: () => this.terminalSessionControl.delete(sessionTerminalId(record.id)),
      catch: (cause) => this.upstreamError("Terminal restart failed", cause, record.id),
    });
  });

  private readonly preparePiSessionAccessProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const record = yield* this.requireRecordProgram();
    if (record.status !== "warm")
      return yield* wrongState(
        record.status,
        "access",
        record.status === "sleeping"
          ? "Resume the session from Home before opening the worklog"
          : undefined,
      );
    if (!sessionAllowsRuntimeAccess(record))
      return yield* conflict("Session destruction is already in progress");
    if (record.operation)
      return yield* conflict(`Session is already running ${record.operation.kind}`);
    if (record.execution.provider !== "cloudflare")
      return yield* wrongState(record.status, "access", "This session uses the runner runtime");
    const containerAuth = yield* ContainerAuth;
    const grant = record.credentialGrant;
    if (grant === undefined)
      return yield* this.upstreamError(
        "Session credential grant is unavailable",
        undefined,
        record.id,
      );
    yield* containerAuth.ensurePiSession(record.id, sessionRuntimeCredentials(grant.grants));
  });

  private readonly actorSessionStateFromSnapshotProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    snapshot: ActorStoreSnapshot,
  ) {
    const metadataStore = yield* SessionActorMetadataStore;
    const authority = snapshot.authority;
    if (authority === undefined) return yield* notFound("unknown");
    if (
      AuthorityStateSchema.guards.Stable(authority.state) &&
      StableStateSchema.guards.Gone(authority.state.stable)
    )
      return yield* notFound(authority.session.id);
    const metadata = yield* metadataStore
      .read(authority)
      .pipe(
        Effect.mapError((failure) =>
          this.upstreamError(
            "Session actor metadata is unavailable",
            failure,
            authority.session.id,
          ),
        ),
      );
    if (metadata === undefined)
      return yield* new ScottyError("internal", "Session actor metadata is unavailable", {
        httpStatus: 500,
        exitCode: 1,
      });
    const now = yield* Clock.currentTimeMillis;
    const projectedAt = { iso: new Date(now).toISOString(), epochMillis: now };
    const updatedAt = snapshot.journalTail?.timestamp ?? authority.session.createdAt;
    const projection = yield* Effect.fromResult(
      sessionProjectionFromActor(authority, metadata, updatedAt, projectedAt),
    ).pipe(
      Effect.mapError((failure) =>
        this.upstreamError(
          "Session public projection is unavailable",
          failure,
          authority.session.id,
        ),
      ),
    );
    const view = yield* Effect.fromResult(
      sessionViewFromActor(authority, metadata, updatedAt, projectedAt),
    ).pipe(
      Effect.mapError((failure) =>
        this.upstreamError("Session public view is unavailable", failure, authority.session.id),
      ),
    );
    return { authority, metadata, projection, view };
  });

  private readonly readActorSessionStateProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const store = yield* ActorStore;
    const snapshot = yield* store.read.pipe(
      Effect.mapError((failure) =>
        this.upstreamError("Session actor authority is unavailable", failure),
      ),
    );
    return yield* this.actorSessionStateFromSnapshotProgram(snapshot);
  });

  private readonly publishSessionProjectionBestEffortProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    projection: SessionListProjection,
  ) {
    yield* Effect.tryPromise({
      try: () =>
        this.env.SESSIONS.put(`${SESSION_KV_PREFIX}${projection.id}`, JSON.stringify(projection)),
      catch: () => undefined,
    }).pipe(Effect.ignore);
  });

  private readonly publishActorSessionProjectionBestEffortProgram = Effect.fnUntraced(
    function* (this: Sandbox) {
      const state = yield* Effect.result(this.readActorSessionStateProgram());
      if (Result.isFailure(state)) return;
      yield* this.publishSessionProjectionBestEffortProgram(state.success.projection);
    },
  );

  private readonly recoverTransitioningActorForRequestProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    expectedKind: LifecycleCommandKind | "Create",
  ) {
    const store = yield* ActorStore;
    const before = yield* store.read;
    const authority = before.authority;
    if (authority === undefined || !AuthorityStateSchema.guards.Transitioning(authority.state))
      return { _tag: "NotNeeded" as const, snapshot: before } satisfies ActorRequestRecovery;
    const transition = authority.state.transition;
    if (!Predicate.isTagged(transition, expectedKind))
      return { _tag: "Contended" as const, snapshot: before } satisfies ActorRequestRecovery;
    yield* Effect.promise(() => this.actorRequestRecoveryBeforeResume());
    const afterResume = this.actorRequestRecoveryAfterResume;
    const recovered = yield* this.withExclusiveActorMutation(
      transition.nonce,
      Effect.gen(function* () {
        const actor = yield* SessionActor;
        const now = yield* Clock.currentTimeMillis;
        const timestamp = new Date(now).toISOString();
        const correlationId = crypto.randomUUID();
        yield* actor.resume({
          timestamp,
          correlationId,
          expectedTransition: {
            revision: authority.revision,
            transitionNonce: transition.nonce,
            attempt: transition.attempt,
            expectedPhase: transition.phase,
          },
          ...(now >= Date.parse(transition.deadlineAt)
            ? {
                fence: {
                  kind: "deadline" as const,
                  alarmId: actorAlarmId(
                    "deadline",
                    transition.nonce,
                    transition.attempt,
                    transition.deadlineAt,
                  ),
                  revision: authority.revision,
                  transitionNonce: transition.nonce,
                  attempt: transition.attempt,
                  expectedPhase: transition.phase,
                  expectedDeadlineAt: transition.deadlineAt,
                  correlationId,
                },
              }
            : {}),
        });
        yield* Effect.promise(() => afterResume());
        const snapshot = yield* store.read;
        return provesRecoveredTransition(snapshot, expectedKind, transition.nonce)
          ? { _tag: "Recovered" as const, provenSnapshot: snapshot }
          : { _tag: "Contended" as const, snapshot };
      }),
    );
    return recovered === undefined
      ? ({ _tag: "Contended" as const, snapshot: before } satisfies ActorRequestRecovery)
      : recovered;
  });

  private readonly withExclusiveActorMutation = <A, E, R>(
    nonce: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | undefined, E, R> =>
    Effect.sync(() => {
      if (this.activeActorMutationNonces.has(nonce)) return false;
      this.activeActorMutationNonces.add(nonce);
      return true;
    }).pipe(
      Effect.flatMap((acquired) =>
        acquired
          ? effect.pipe(
              Effect.ensuring(Effect.sync(() => this.activeActorMutationNonces.delete(nonce))),
            )
          : Effect.succeed(undefined),
      ),
    );

  private readonly withActiveActorMutation = <A, E, R>(
    nonce: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.sync(() => this.activeActorMutationNonces.add(nonce)).pipe(
      Effect.flatMap(() => effect),
      Effect.ensuring(Effect.sync(() => this.activeActorMutationNonces.delete(nonce))),
    );

  private readonly cancelSessionSchedulesAfterGoneProgram = Effect.fnUntraced(
    function* (this: Sandbox) {
      const store = yield* ActorStore;
      const snapshot = yield* store.read;
      yield* Effect.sync(() => this.cancelAllSessionSchedulesIfGone(snapshot.authority));
    },
  );

  private readonly createScottySessionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    input: CreateSessionInput,
    id: string,
    idempotency?: CreateIdempotencyDigestMetadata,
  ) {
    if (input.provider === "runner")
      return yield* new ScottyError(
        "bad_request",
        "Runner-backed sessions require a native Pi transport and cannot be created yet",
        { httpStatus: 400, exitCode: 2 },
      );
    const controller = yield* CreateController;
    const now = yield* Clock.currentTimeMillis;
    const nowIso = new Date(now).toISOString();
    const request: CreateControllerRequest = {
      session: {
        id,
        title: input.title,
        repository: input.repo,
        execution: { provider: "cloudflare", runtimeName: id },
        createdAt: nowIso,
      },
      branch: `scotty/${id}`,
      createRepositoryIfMissing: input.newRepo,
      initialPrompt: input.prompt,
      payloadReference: crypto.randomUUID(),
      ...(idempotency === undefined ? {} : { idempotency }),
      correlationId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      attempt: crypto.randomUUID(),
      timestamp: nowIso,
      transitionDeadlineAt: new Date(now + ABANDONED_OPERATION_MS).toISOString(),
      hardCap: {
        durationSeconds: input.hardCapSeconds,
        deadlineAt: new Date(now + input.hardCapSeconds * 1_000).toISOString(),
        generation: crypto.randomUUID(),
      },
    };
    const recoverCreateReplay = Effect.fnUntraced(function* (sandbox: Sandbox) {
      const recovered = yield* sandbox.recoverTransitioningActorForRequestProgram("Create");
      if (Predicate.isTagged(recovered, "Contended")) return { _tag: "Contended" as const };
      const authority = Predicate.isTagged(recovered, "Recovered")
        ? recovered.provenSnapshot.authority
        : recovered.snapshot.authority;
      if (
        authority !== undefined &&
        AuthorityStateSchema.guards.Transitioning(authority.state) &&
        Predicate.isTagged(authority.state.transition, "Create")
      )
        return {
          _tag: "Available" as const,
          outcome: {
            _tag: "InProgress" as const,
            replay: true,
            authority,
            mode: authority.state.transition.mode,
            phase: authority.state.transition.phase,
          },
        };
      return { _tag: "Available" as const, outcome: yield* controller.create(request) };
    });
    const outcome = yield* this.withActiveActorMutation(
      request.nonce,
      controller.create(request).pipe(
        Effect.flatMap((initial) => {
          if (!Predicate.isTagged(initial, "InProgress") || !initial.replay)
            return Effect.succeed(initial);
          return recoverCreateReplay(this).pipe(
            Effect.map((recovered) =>
              Predicate.isTagged(recovered, "Contended") ? initial : recovered.outcome,
            ),
          );
        }),
      ),
    ).pipe(
      Effect.mapError((failure) => {
        if (
          Predicate.isTagged(failure, "CreateControllerConflict") ||
          Predicate.isTagged(failure, "MetadataStoreConflict")
        )
          return conflict("Create idempotency key was already used with different input");
        if (Predicate.isTagged(failure, "CreateControllerRejected"))
          return failure.code === "runner_create_disabled"
            ? new ScottyError("bad_request", "Runner-backed session creation is disabled", {
                httpStatus: 400,
                exitCode: 2,
              })
            : new ScottyError("bad_request", "Session creation was rejected", {
                httpStatus: 400,
                exitCode: 2,
              });
        return this.upstreamError("Session setup failed", failure, id);
      }),
    );
    yield* this.publishActorSessionProjectionBestEffortProgram();
    if (Predicate.isTagged(outcome, "Failed")) {
      if (outcome.code === "create_repository_not_found")
        return yield* new ScottyError(
          "not_found",
          `GitHub repository ${input.repo} was not found; pass --new-repo to initialize it`,
          { httpStatus: 404, exitCode: 3 },
        );
      return yield* this.upstreamError("Session setup failed", outcome.code, id);
    }
    if (Predicate.isTagged(outcome, "InProgress"))
      return yield* this.upstreamError(
        "Session setup outcome is being reconciled",
        outcome.phase,
        id,
      );
    const publicState = yield* this.readActorSessionStateProgram();
    yield* Effect.tryPromise({
      try: () =>
        this.env.SESSIONS.put(
          `${SESSION_KV_PREFIX}${publicState.projection.id}`,
          JSON.stringify(publicState.projection),
        ),
      catch: () => undefined,
    }).pipe(Effect.ignore);
    return publicState.view;
  });

  private readonly actorVaporizeProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const store = yield* ActorStore;
    const actor = yield* SessionActor;
    const before = yield* store.read;
    const authority = before.authority;
    if (authority === undefined)
      return yield* new ScottyError("not_found", "Session not found", {
        httpStatus: 404,
        exitCode: 3,
      });
    if (
      AuthorityStateSchema.guards.Stable(authority.state) &&
      StableStateSchema.guards.Gone(authority.state.stable)
    ) {
      yield* Effect.sync(() => this.cancelAllSessionSchedules());
      return { id: authority.session.id, status: "gone" as const };
    }

    const now = yield* Clock.currentTimeMillis;
    const timestamp = new Date(now).toISOString();
    if (
      AuthorityStateSchema.guards.Transitioning(authority.state) &&
      TransitionSchema.guards.Vaporize(authority.state.transition)
    ) {
      yield* actor.resume({ timestamp, correlationId: crypto.randomUUID() });
    } else {
      yield* actor.handle({
        _tag: "VaporizeCommand",
        expectedRevision: before.revision,
        correlationId: crypto.randomUUID(),
        nonce: crypto.randomUUID(),
        attempt: crypto.randomUUID(),
        timestamp,
        deadlineAt: new Date(now + ABANDONED_OPERATION_MS).toISOString(),
      });
    }

    const after = yield* store.read;
    const settled = after.authority;
    if (
      settled !== undefined &&
      AuthorityStateSchema.guards.Stable(settled.state) &&
      StableStateSchema.guards.Gone(settled.state.stable)
    ) {
      yield* Effect.sync(() => this.cancelAllSessionSchedules());
      return { id: settled.session.id, status: "gone" as const };
    }
    yield* this.publishActorSessionProjectionBestEffortProgram();
    const phase =
      settled !== undefined && AuthorityStateSchema.guards.Transitioning(settled.state)
        ? settled.state.transition.phase
        : "unknown";
    return yield* this.upstreamError(
      "Session vaporize outcome is being reconciled",
      phase,
      authority.session.id,
    );
  });

  private readonly actorLifecycleProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    kind: LifecycleCommandKind,
  ) {
    const controller = yield* LifecycleController;
    const recovered = yield* this.recoverTransitioningActorForRequestProgram(kind).pipe(
      Effect.mapError((failure) =>
        this.upstreamError(`Session ${kind.toLowerCase()} failed`, failure),
      ),
    );
    if (!Predicate.isTagged(recovered, "NotNeeded")) {
      if (Predicate.isTagged(recovered, "Contended")) {
        const authority = recovered.snapshot.authority;
        if (
          authority !== undefined &&
          AuthorityStateSchema.guards.Stable(authority.state) &&
          StableStateSchema.guards.Gone(authority.state.stable)
        )
          return yield* wrongState("gone", kind.toLowerCase());
        const state = yield* this.readActorSessionStateProgram();
        return yield* wrongState(state.view.status, kind.toLowerCase());
      }
      const snapshot = recovered.provenSnapshot;
      const authority = snapshot.authority;
      if (authority !== undefined && AuthorityStateSchema.guards.Transitioning(authority.state))
        return yield* this.upstreamError(
          `Session ${kind.toLowerCase()} outcome is being reconciled`,
          authority.state.transition.phase,
          authority.session.id,
        );
      if (
        authority !== undefined &&
        AuthorityStateSchema.guards.Stable(authority.state) &&
        StableStateSchema.guards.Failed(authority.state.stable)
      )
        return yield* this.upstreamError(
          `Session ${kind.toLowerCase()} failed`,
          authority.state.stable.code,
          authority.session.id,
        );
      const state = yield* this.actorSessionStateFromSnapshotProgram(snapshot);
      yield* Effect.tryPromise({
        try: () =>
          this.env.SESSIONS.put(
            `${SESSION_KV_PREFIX}${state.projection.id}`,
            JSON.stringify(state.projection),
          ),
        catch: () => undefined,
      }).pipe(Effect.ignore);
      return state.view;
    }
    const now = yield* Clock.currentTimeMillis;
    const baseRequest = {
      correlationId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      attempt: crypto.randomUUID(),
      timestamp: new Date(now).toISOString(),
      deadlineAt: new Date(now + ABANDONED_OPERATION_MS).toISOString(),
    };
    const request =
      kind === "Resume"
        ? yield* Effect.gen(function* () {
            const store = yield* ActorStore;
            const snapshot = yield* store.read;
            if (snapshot.authority === undefined)
              return yield* new ScottyError("not_found", "Session not found", {
                httpStatus: 404,
                exitCode: 3,
              });
            return {
              ...baseRequest,
              kind,
              nextHardCap: {
                durationSeconds: snapshot.authority.hardCap.durationSeconds,
                deadlineAt: new Date(
                  now + snapshot.authority.hardCap.durationSeconds * 1_000,
                ).toISOString(),
                generation: crypto.randomUUID(),
              },
            };
          })
        : { ...baseRequest, kind };
    const outcome = yield* this.withActiveActorMutation(
      request.nonce,
      controller.run(request),
    ).pipe(
      Effect.catchTag("LifecycleControllerRejected", () =>
        Effect.flatMap(this.readActorSessionStateProgram(), ({ view }) =>
          wrongState(view.status, kind.toLowerCase()),
        ),
      ),
      Effect.mapError((failure) =>
        Predicate.isTagged(failure, "ScottyError")
          ? failure
          : this.upstreamError(`Session ${kind.toLowerCase()} failed`, failure),
      ),
    );
    yield* this.publishActorSessionProjectionBestEffortProgram();
    if (Predicate.isTagged(outcome, "Reconciling"))
      return yield* this.upstreamError(
        `Session ${kind.toLowerCase()} outcome is being reconciled`,
        outcome.phase,
        outcome.authority.session.id,
      );
    if (Predicate.isTagged(outcome, "Failed"))
      return yield* this.upstreamError(
        `Session ${kind.toLowerCase()} failed`,
        outcome.code,
        outcome.authority.session.id,
      );
    const publicState = yield* this.readActorSessionStateProgram();
    yield* Effect.tryPromise({
      try: () =>
        this.env.SESSIONS.put(
          `${SESSION_KV_PREFIX}${publicState.projection.id}`,
          JSON.stringify(publicState.projection),
        ),
      catch: () => undefined,
    }).pipe(Effect.ignore);
    return publicState.view;
  });

  private readonly admitWarmWorkProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    kind: "Evidence" | "Hatch" | "Down" | "RuntimePreparation",
    options?: {
      readonly nonce?: string;
      readonly deadlineAt?: string;
      readonly evidence?: import("../session-actor/store").EvidenceMutation;
    },
  ) {
    const store = yield* ActorStore;
    const snapshot = yield* store.read;
    const authority = snapshot.authority;
    if (authority === undefined)
      return yield* new ScottyError("not_found", "Session not found", {
        httpStatus: 404,
        exitCode: 3,
      });
    const now = yield* Clock.currentTimeMillis;
    const requestedDeadline =
      options?.deadlineAt === undefined
        ? now + ABANDONED_OPERATION_MS
        : Date.parse(options.deadlineAt);
    const deadlineMillis = Math.min(
      now + ABANDONED_OPERATION_MS,
      Date.parse(authority.hardCap.deadlineAt),
      requestedDeadline,
    );
    if (!Number.isFinite(deadlineMillis) || deadlineMillis <= now)
      return yield* wrongState("warm", kind.toLowerCase(), "The session hard cap has elapsed");
    const controller = yield* WarmWorkController;
    return yield* controller
      .admit({
        kind,
        correlationId: crypto.randomUUID(),
        nonce: options?.nonce ?? crypto.randomUUID(),
        attempt: crypto.randomUUID(),
        timestamp: new Date(now).toISOString(),
        deadlineAt: new Date(deadlineMillis).toISOString(),
        evidence: options?.evidence,
      })
      .pipe(
        Effect.mapError(() =>
          conflict(`Session cannot admit ${kind.toLowerCase()} while another transition owns it`),
        ),
      );
  });

  private readonly settleWarmWorkProgram = Effect.fnUntraced(function* (
    lease: WarmWorkLease,
    resultCode: string,
  ) {
    const controller = yield* WarmWorkController;
    const now = yield* Clock.currentTimeMillis;
    return yield* controller.settle(lease, new Date(now).toISOString(), resultCode);
  });

  private readonly reconcileWarmWorkProgram = Effect.fnUntraced(function* (
    lease: WarmWorkLease,
    resultCode: string,
  ) {
    const controller = yield* WarmWorkController;
    const now = yield* Clock.currentTimeMillis;
    return yield* controller.reconcile(lease, new Date(now).toISOString(), resultCode);
  });

  private readonly settleCurrentWarmWorkProgram = Effect.fnUntraced(function* (
    kind: "Evidence" | "Hatch" | "Down" | "RuntimePreparation",
    nonce: string,
    resultCode: string,
  ) {
    const controller = yield* WarmWorkController;
    const lease = yield* controller.current(kind, nonce);
    const now = yield* Clock.currentTimeMillis;
    return yield* controller.settle(lease, new Date(now).toISOString(), resultCode);
  });

  private readonly requireChangesAccessProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const store = yield* ActorStore;
    const snapshot = yield* store.read;
    const authority = snapshot.authority;
    if (authority === undefined) return yield* notFound("unknown");
    const record = yield* this.requireRecordProgram();
    if (record.status !== "warm")
      return yield* wrongState(
        record.status,
        "review changes",
        "Changes are available only while the Cloudflare session is warm",
      );
    if (record.execution.provider !== "cloudflare")
      return yield* wrongState(record.status, "review changes", "Runner sessions are unsupported");
    if (!sessionAllowsRuntimeAccess(record))
      return yield* conflict("Session destruction is already in progress");
    if (record.operation)
      return yield* conflict(`Session is already running ${record.operation.kind}`);
    if (this.rawContainer?.running !== true)
      return yield* wrongState(
        record.status,
        "review changes",
        "The Sandbox runtime is not running",
      );
    return { record, revision: authority.revision };
  });

  private readonly listScottyChangesProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const observed = yield* this.requireChangesAccessProgram();
    const runtime = yield* SandboxRuntime;
    const changes = yield* listGitWorktreeChanges(runtime, sessionRoot(observed.record.id)).pipe(
      Effect.mapError((cause) =>
        this.upstreamError("Changed files are unavailable", cause, observed.record.id),
      ),
    );
    const current = yield* this.requireChangesAccessProgram();
    if (current.revision !== observed.revision)
      return yield* conflict("Session changed while reading changed files");
    return changes;
  });

  private readonly getScottyChangedFilePatchProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    value: unknown,
  ) {
    const path = parseChangedPath(typeof value === "string" ? value : undefined);
    if (path === undefined) return yield* badRequest("Changed file path is invalid");
    const observed = yield* this.requireChangesAccessProgram();
    const runtime = yield* SandboxRuntime;
    const file = yield* findGitWorktreeChange(runtime, sessionRoot(observed.record.id), path).pipe(
      Effect.mapError((cause) =>
        this.upstreamError("Changed files are unavailable", cause, observed.record.id),
      ),
    );
    const currentAfterLookup = yield* this.requireChangesAccessProgram();
    if (currentAfterLookup.revision !== observed.revision)
      return yield* conflict("Session changed while finding the changed file");
    if (file === undefined)
      return yield* new ScottyError("not_found", "Changed file was not found", {
        httpStatus: 404,
        exitCode: 3,
      });
    const patch = yield* readGitWorktreePatch(runtime, sessionRoot(observed.record.id), file).pipe(
      Effect.mapError((cause) =>
        this.upstreamError("Changed file patch is unavailable", cause, observed.record.id),
      ),
    );
    const current = yield* this.requireChangesAccessProgram();
    if (current.revision !== observed.revision)
      return yield* conflict("Session changed while reading the changed file patch");
    return patch;
  });

  private readonly getScottySessionProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const store = yield* ActorStore;
    const metadataStore = yield* SessionActorMetadataStore;
    const snapshot = yield* store.read.pipe(
      Effect.mapError((failure) =>
        this.upstreamError("Session actor authority is unavailable", failure),
      ),
    );
    const authority = snapshot.authority;
    if (authority === undefined) return yield* notFound("unknown");
    const metadata = yield* metadataStore
      .read(authority)
      .pipe(
        Effect.mapError((failure) =>
          this.upstreamError(
            "Session actor metadata is unavailable",
            failure,
            authority.session.id,
          ),
        ),
      );
    const gone =
      AuthorityStateSchema.guards.Stable(authority.state) &&
      StableStateSchema.guards.Gone(authority.state.stable);
    if (metadata === undefined && !gone)
      return yield* new ScottyError("internal", "Session actor metadata is unavailable", {
        httpStatus: 500,
        exitCode: 1,
      });
    const now = yield* Clock.currentTimeMillis;
    yield* this.publishActorSessionProjectionBestEffortProgram();
    return uiSessionResponseFromActor(authority, metadata, now);
  });

  private readonly getScottyActorDiagnosticsProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const diagnostics = yield* Effect.tryPromise({
      try: () =>
        // oxlint-disable-next-line scotty/no-direct-do-storage -- boundary: authenticated diagnostics read the actor's immutable authority journal without mutating it
        readDurableObjectSessionActorDiagnostics(this.ctx.storage),
      catch: (cause) => this.upstreamError("Session actor diagnostics are unavailable", cause),
    });
    if (Result.isSuccess(diagnostics)) return diagnostics.success;
    if (diagnostics.failure === "absent") return yield* notFound("unknown");
    return yield* this.upstreamError("Session actor diagnostics are invalid", undefined);
  });

  private readonly getScottyDeploymentReadinessProgram = Effect.fnUntraced(
    function* (this: Sandbox) {
      const record = yield* this.requireRecordProgram();
      const runtime =
        this.rawContainer === undefined
          ? ("unknown" as const)
          : this.rawContainer.running
            ? ("running" as const)
            : ("stopped" as const);
      const pi =
        runtime !== "running" || record.status !== "warm" || record.operation !== null
          ? runtime === "stopped"
            ? ("not_running" as const)
            : ("unknown" as const)
          : yield* Effect.tryPromise({
              try: () =>
                inspectPassiveSession({
                  fetch: (request) =>
                    this.fetchNativePassivePiConsole({ sessionId: record.id, request }),
                }),
              catch: () => undefined,
            }).pipe(
              Effect.map((response) =>
                response.status === 200 ? ("reachable" as const) : ("unreachable" as const),
              ),
              Effect.orElseSucceed(() => "unreachable" as const),
            );
      return assessSessionDeploymentReadiness({
        id: record.id,
        title: record.title,
        recordStatus: record.status,
        operation: record.operation?.kind ?? null,
        ...(record.agentState === undefined ? {} : { agentState: record.agentState }),
        ...(record.lastAgentEventAt === undefined
          ? {}
          : { lastAgentEventAt: record.lastAgentEventAt }),
        runtime,
        pi,
      });
    },
  );

  private readonly renameScottySessionProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    title: string,
  ) {
    const store = yield* ActorStore;
    const snapshot = yield* store.read;
    const authority = snapshot.authority;
    if (authority === undefined) return yield* notFound("unknown");
    if (authority.session.title !== title) {
      const actor = yield* SessionActor;
      const now = yield* Clock.currentTimeMillis;
      const handled = yield* actor.handle({
        _tag: "RenameCommand",
        expectedRevision: authority.revision,
        correlationId: crypto.randomUUID(),
        timestamp: new Date(now).toISOString(),
        title,
      });
      if (Predicate.isTagged(handled.decision, "Rejected"))
        return yield* conflict("Session cannot be renamed while a transition owns it");
    }
    const state = yield* this.readActorSessionStateProgram();
    yield* Effect.tryPromise({
      try: () =>
        this.env.SESSIONS.put(
          `${SESSION_KV_PREFIX}${state.projection.id}`,
          JSON.stringify(state.projection),
        ),
      catch: () => undefined,
    }).pipe(Effect.ignore);
    return state.view;
  });

  private readonly prepareDownArchiveProgram = Effect.fnUntraced(function* (this: Sandbox) {
    const authoritative = yield* this.requireRecordProgram();
    if (authoritative.execution.provider === "runner")
      return yield* wrongState(
        authoritative.status,
        "archive",
        "Runner lifecycle is not supported yet",
      );
    const runtime = yield* SandboxRuntime;
    const discovery = yield* RolloutDiscovery;
    const operation = yield* this.admitWarmWorkProgram("Down");
    const record = yield* this.requireRecordProgram();
    const root = sessionRoot(record.id);
    const prepared = yield* Effect.result(
      Effect.gen(function* () {
        const sha = (yield* runtime.execChecked(
          `git -C ${shellQuote(root)} rev-parse HEAD`,
        )).stdout.trim();
        const rollout = Option.getOrElse(yield* discovery.findNewestRollout(record.id), () => {
          return undefined;
        });
        const manifest: DownManifest = {
          id: record.id,
          repo: record.repo,
          branch: record.branch,
          sha,
          codexThreadId: record.codexThreadId,
          rolloutFile: rollout ? basename(rollout) : undefined,
        };
        const manifestPath = `/tmp/metadata.json`;
        const archivePath = `/tmp/scotty-${record.id}.tar`;
        yield* runtime.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        const members = [`-C /tmp ${shellQuote(basename(manifestPath))}`];
        if (rollout)
          members.push(`-C ${shellQuote(dirname(rollout))} ${shellQuote(basename(rollout))}`);
        yield* runtime.execChecked(`tar -cf ${shellQuote(archivePath)} ${members.join(" ")}`);
        return { path: archivePath, filename: `scotty-${record.id}.tar`, manifest };
      }),
    );
    if (Result.isFailure(prepared))
      yield* this.reconcileWarmWorkProgram(operation, "down_archive_outcome_unknown");
    else yield* this.settleWarmWorkProgram(operation, "down_archive_complete");
    if (Result.isFailure(prepared))
      return yield* this.upstreamError("Beam-down archive failed", prepared.failure);
    return prepared.success;
  });

  private readonly previewForwardingRoute = (
    request: Request,
  ):
    | {
        readonly requestId: string;
        readonly sessionId: string;
        readonly port: number;
        readonly routeNonce: string;
      }
    | undefined => {
    const requestId = request.headers.get(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER);
    const portValue = request.headers.get(SANDBOX_PREVIEW_PORT_HEADER);
    const sessionId = request.headers.get(SANDBOX_PREVIEW_SANDBOX_ID_HEADER);
    const routeNonce = request.headers.get(SANDBOX_PREVIEW_TOKEN_HEADER);
    if (
      request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) !== "1" ||
      requestId === null ||
      Option.isNone(decodeEvidencePreviewRequestId(requestId)) ||
      portValue === null ||
      !PREVIEW_PORT_PATTERN.test(portValue) ||
      sessionId === null ||
      !/^[0-9a-f]{12}$/u.test(sessionId) ||
      routeNonce === null ||
      !/^[a-z0-9_]{16}$/u.test(routeNonce)
    )
      return undefined;
    const port = Number(portValue);
    return Number.isSafeInteger(port) ? { requestId, sessionId, port, routeNonce } : undefined;
  };

  private async settlePreviewForward(requestId: string, responseBytes: number): Promise<void> {
    this.previewRequests.delete(requestId);
    return this.#run(this.settleScottyEvidencePreviewProgram(requestId, responseBytes));
  }

  private async expirePreviewForward(requestId: string): Promise<void> {
    this.previewRequests.delete(requestId);
    return this.#run(this.expireScottyEvidencePreviewProgram(requestId));
  }

  private async previewResponseStream(
    requestId: string,
    response: Response,
    abortController: AbortController,
    settle: (responseBytes: number) => Promise<void>,
  ): Promise<Response> {
    const body = response.body;
    if (body === null) {
      await settle(0);
      const headers = new Headers(response.headers);
      headers.set(EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER, requestId);
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const reader = body.getReader();
    let responseBytes = 0;
    let terminal = false;
    let consumerCancel = false;
    const finish = async (bytes: number): Promise<void> => {
      if (terminal) return;
      terminal = true;
      await settle(bytes);
    };
    let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const abort = (): void => {
      if (terminal || consumerCancel) return;
      void reader.cancel().then(
        () => undefined,
        () => undefined,
      );
      void finish(responseBytes).then(
        () => outputController?.error(new DOMException("Preview request ended", "AbortError")),
        (cause) => outputController?.error(cause),
      );
    };
    abortController.signal.addEventListener("abort", abort, { once: true });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        outputController = controller;
      },
      async pull(controller) {
        const next = await reader.read().then(
          (value) => ({ ok: true as const, value }),
          (cause) => ({ ok: false as const, cause }),
        );
        if (terminal) return;
        if (!next.ok) {
          await finish(responseBytes);
          controller.error(next.cause);
          return;
        }
        if (next.value.done) {
          await finish(responseBytes);
          controller.close();
          return;
        }
        const nextBytes = responseBytes + next.value.value.byteLength;
        if (nextBytes > EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES) {
          await reader.cancel().then(
            () => undefined,
            () => undefined,
          );
          await finish(EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES);
          controller.error(
            new DOMException("Preview response exceeded its limit", "QuotaExceededError"),
          );
          return;
        }
        responseBytes = nextBytes;
        controller.enqueue(next.value.value);
      },
      async cancel(reason) {
        consumerCancel = true;
        abortController.abort();
        await reader.cancel(reason).then(
          () => undefined,
          () => undefined,
        );
        await finish(responseBytes);
      },
    });
    if (abortController.signal.aborted) abort();
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set(EVIDENCE_PREVIEW_PRIVATE_CLAIMED_HEADER, requestId);
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private forwardSandboxPreviewRequest(request: Request): Promise<Response> {
    return super.fetch(request);
  }

  private async fetchEvidencePreviewRequest(request: Request): Promise<Response> {
    const isSdkPreviewRequest = request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) === "1";
    const privateRequestId = request.headers.get(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER);
    if (privateRequestId === null)
      return isSdkPreviewRequest ? deniedEvidencePreviewResponse() : super.fetch(request);
    const route = this.previewForwardingRoute(request);
    const hasForbiddenTransportHeader = [...request.headers].some(([name]) => {
      const normalized = name.toLowerCase();
      return (
        normalized === "upgrade" ||
        normalized === "connection" ||
        normalized.startsWith("sec-websocket-")
      );
    });
    if (
      route === undefined ||
      request.method.toUpperCase() === "CONNECT" ||
      request.method.toUpperCase() === "TRACE" ||
      hasForbiddenTransportHeader
    ) {
      if (Option.isSome(decodeEvidencePreviewRequestId(privateRequestId)))
        await this.cancelScottyEvidencePreviewRequest(privateRequestId);
      return deniedEvidencePreviewResponse();
    }
    const claimed = await this.#run(this.claimScottyEvidencePreviewProgram(route.requestId, route));
    if (claimed === undefined) {
      await this.cancelScottyEvidencePreviewRequest(route.requestId);
      return deniedEvidencePreviewResponse();
    }
    const abortController = new AbortController();
    this.previewRequests.set(route.requestId, {
      operationNonce: claimed.operationNonce,
      controller: abortController,
    });
    const headers = new Headers(request.headers);
    headers.delete(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER);
    const forwarded = new Request(request, { headers, signal: abortController.signal });
    const nowMillis = await this.#run(Clock.currentTimeMillis);
    const remainingMillis = Math.max(0, Date.parse(claimed.expiresAt) - nowMillis);
    let expired = false;
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: the native Sandbox.fetch/ReadableStream host callback requires a real-time abort through response completion
    const timeout = setTimeout(() => {
      expired = true;
      abortController.abort();
    }, remainingMillis);
    request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    let settled = false;
    const settle = async (responseBytes: number): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await (expired
        ? this.expirePreviewForward(route.requestId)
        : this.settlePreviewForward(route.requestId, responseBytes));
    };
    const abortResult = new Promise<{ readonly kind: "aborted" }>((resolve) => {
      abortController.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
        once: true,
      });
    });
    const upstream = this.previewRequestForwarder(forwarded).then(
      (response) => ({ kind: "response" as const, response }),
      () => ({ kind: "error" as const }),
    );
    const result = await Promise.race([upstream, abortResult]);
    if (result.kind !== "response") {
      abortController.abort();
      void upstream.then((late) => {
        if (late.kind === "response") {
          late.response.webSocket?.close(1001, "Preview request ended");
          void late.response.body?.cancel().then(
            () => undefined,
            () => undefined,
          );
        }
      });
      await settle(0);
      return deniedEvidencePreviewResponse();
    }
    if (abortController.signal.aborted) {
      await result.response.body?.cancel().then(
        () => undefined,
        () => undefined,
      );
      await settle(0);
      return deniedEvidencePreviewResponse();
    }
    if (result.response.webSocket !== null && result.response.webSocket !== undefined) {
      result.response.webSocket.close(1008, "WebSocket previews are disabled");
      await settle(0);
      return deniedEvidencePreviewResponse();
    }
    return this.previewResponseStream(route.requestId, result.response, abortController, settle);
  }

  async createScottySession(
    input: CreateSessionInput,
    id: string,
    idempotency?: CreateIdempotencyDigestMetadata,
  ): Promise<SessionView> {
    const inFlight = this.createInFlight;
    if (inFlight !== undefined) {
      if (
        idempotency !== undefined &&
        inFlight.id === id &&
        inFlight.keyDigest === idempotency.keyDigest &&
        inFlight.inputDigest === idempotency.inputDigest
      )
        return inFlight.promise;
      const afterCurrent = (): Promise<SessionView> =>
        this.createScottySession(input, id, idempotency);
      return inFlight.promise.then(afterCurrent, afterCurrent);
    }

    const promise = this.#run(this.createScottySessionProgram(input, id, idempotency));
    const flight: InFlightCreate = {
      id,
      keyDigest: idempotency?.keyDigest,
      inputDigest: idempotency?.inputDigest,
      promise,
    };
    this.createInFlight = flight;
    const clear = (): void => {
      if (this.createInFlight === flight) this.createInFlight = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  async getScottySession(): Promise<UiSessionResponse> {
    return this.#run(this.getScottySessionProgram());
  }

  async getScottyActorDiagnostics(): Promise<SessionActorDiagnostics> {
    return this.#run(this.getScottyActorDiagnosticsProgram());
  }

  async getScottyDeploymentReadiness(): Promise<SessionDeploymentReadiness> {
    return this.#run(this.getScottyDeploymentReadinessProgram());
  }

  async listScottyChanges(): Promise<ChangedFiles> {
    return this.#run(this.listScottyChangesProgram());
  }

  async getScottyChangedFilePatch(path: unknown): Promise<ChangedFilePatch> {
    return this.#run(this.getScottyChangedFilePatchProgram(path));
  }

  private readonly requireReadyHatchServiceProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    authorization: HatchRouteAuthorization,
  ) {
    const store = yield* HatchStore;
    const state = yield* store.read;
    const hatch = state.primary;
    if (
      hatch === undefined ||
      hatch.hatchId !== authorization.hatchId ||
      hatch.generation !== authorization.generation ||
      hatch.runtimeEpoch !== authorization.runtimeEpoch
    )
      return false;
    const runtime = yield* SandboxRuntime;
    const health = yield* Effect.result(
      runtime.fetchPortStatus(hatch.service.healthPath, hatch.service.port, "GET"),
    );
    if (Result.isSuccess(health) && health.success >= 200 && health.success <= 399) {
      const publicRoute = yield* Effect.result(this.verifyPublicHatchRouteProgram(hatch));
      if (Result.isFailure(publicRoute)) {
        yield* store.clearPublicReady(
          authorization.hatchId,
          authorization.generation,
          authorization.runtimeEpoch,
        );
        return false;
      }
      const confirmed = yield* Effect.result(
        store.confirmPublicReady(
          authorization.hatchId,
          authorization.generation,
          authorization.runtimeEpoch,
        ),
      );
      return Result.isSuccess(confirmed);
    }
    const operationNonce = `health-${randomToken(8)}`;
    const cleaned = yield* Effect.result(
      this.cleanupHatchProgram(operationNonce, "unhealthy", false, {
        kind: "health_check",
        hatchId: authorization.hatchId,
        generation: authorization.generation,
        runtimeEpoch: authorization.runtimeEpoch,
      }),
    );
    if (Result.isFailure(cleaned))
      yield* hostEffect("schedule", () =>
        this.schedule(5, "retryHatchCleanup", {
          operationNonce,
          target: "unhealthy",
          closeDesired: false,
        } satisfies HatchCleanupRetry),
      ).pipe(Effect.ignore);
    return false;
  });

  async getScottyHatchStatus(): Promise<PublicHatchStatus> {
    return this.#run(
      Effect.gen({ self: this }, function* () {
        yield* this.requireRecordProgram();
        const store = yield* HatchStore;
        const status = yield* store.publicStatus;
        if (status.status === "configured" && status.observedStatus === "running") {
          if (this.rawContainer?.running !== true) return { ...status, exposure: "not_exposed" };
          const route = yield* Effect.result(store.exposedRoute);
          if (Result.isFailure(route)) return { ...status, exposure: "not_exposed" };
          yield* this.requireReadyHatchServiceProgram(route.success);
          return yield* store.publicStatus;
        }
        return status;
      }),
    );
  }

  async getScottyHatchRestoreDescriptor(): Promise<HatchRestoreDescriptor | undefined> {
    if (this.rawContainer?.running !== true) return undefined;
    return this.#run(Effect.flatMap(HatchStore, (store) => store.restoreDescriptor));
  }

  async ensureScottyHatch(value: unknown): Promise<PublicHatchStatus> {
    return this.#run(this.ensureScottyHatchProgram(value));
  }

  async closeScottyHatch(): Promise<PublicHatchStatus> {
    return this.#run(this.closeScottyHatchProgram());
  }

  async getScottyHatchOpenRoute(): Promise<HatchRouteAuthorization | undefined> {
    if (this.rawContainer?.running !== true) return undefined;
    await this.getScottyHatchStatus();
    return this.#run(
      Effect.flatMap(HatchStore, (store) => store.activeRoute).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    );
  }

  async getScottyHatchRoute(value: unknown): Promise<HatchRouteAuthorization | undefined> {
    const decoded = decodeHatchHostRoute(value);
    if (Option.isNone(decoded) || this.rawContainer?.running !== true) return undefined;
    const route = await this.#run(
      Effect.result(Effect.flatMap(HatchStore, (store) => store.activeRoute)),
    );
    if (
      Result.isFailure(route) ||
      route.success.sessionId !== decoded.value.sessionId ||
      route.success.port !== decoded.value.port ||
      route.success.routeNonce !== decoded.value.routeNonce
    )
      return undefined;
    return route.success;
  }

  async issueScottyHatchPermit(
    routeValue: unknown,
    browserClientIdValue: unknown,
    cookieDigestValue: unknown,
  ): Promise<IssuedHatchPermit | undefined> {
    const route = decodeHatchHostRoute(routeValue);
    const browserClientId = decodeHatchBrowserClientId(browserClientIdValue);
    const cookieDigest = decodeHatchCookieDigest(cookieDigestValue);
    if (
      Option.isNone(route) ||
      Option.isNone(browserClientId) ||
      Option.isNone(cookieDigest) ||
      this.rawContainer?.running !== true
    )
      return undefined;
    const active = await this.getScottyHatchRoute(route.value);
    if (active === undefined) return undefined;
    return this.#run(
      Effect.flatMap(HatchStore, (store) =>
        store.issuePermit(route.value, browserClientId.value, cookieDigest.value),
      ).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
  }

  async admitScottyHatchRequest(value: unknown): Promise<HatchRequestPermit | undefined> {
    const decoded = decodeHatchRequestAdmission(value);
    if (Option.isNone(decoded) || this.rawContainer?.running !== true) return undefined;
    const routeValue = {
      sessionId: decoded.value.sessionId,
      port: decoded.value.port,
      routeNonce: decoded.value.routeNonce,
    } satisfies HatchHostRoute;
    const route = await this.getScottyHatchRoute(routeValue);
    if (route === undefined) return undefined;
    const runtimeEpoch = await this.#run(Effect.result(this.currentRuntimeEpochProgram()));
    if (Result.isFailure(runtimeEpoch) || runtimeEpoch.success !== route.runtimeEpoch)
      return undefined;
    const cookieDigest = await sha256Hex(decoded.value.cookieSecret).then(
      (digest) => digest,
      () => undefined,
    );
    if (cookieDigest === undefined) return undefined;
    return this.#run(
      Effect.flatMap(HatchStore, (store) =>
        store.admitRequest({
          requestId: randomToken(16),
          sessionId: decoded.value.sessionId,
          port: decoded.value.port,
          routeNonce: decoded.value.routeNonce,
          runtimeEpoch: runtimeEpoch.success,
          cookieDigest,
          ingressBytes: decoded.value.ingressBytes,
        }),
      ).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
  }

  async adjustScottyHatchRequest(requestId: string, ingressBytes: number): Promise<boolean> {
    if (
      Option.isNone(decodeHatchRequestId(requestId)) ||
      Option.isNone(decodeHatchIngressBytes(ingressBytes))
    )
      return false;
    return this.#run(
      Effect.flatMap(HatchStore, (store) => store.adjustRequest(requestId, ingressBytes)).pipe(
        Effect.catch(() => Effect.succeed(false)),
      ),
    );
  }

  async cancelScottyHatchRequest(requestId: string): Promise<void> {
    if (Option.isNone(decodeHatchRequestId(requestId))) return;
    this.hatchRequests.get(requestId)?.abort();
    return this.#run(
      Effect.flatMap(HatchStore, (store) => store.cancelRequest(requestId)).pipe(Effect.ignore),
    );
  }

  async admitScottyHatchWebSocket(value: unknown): Promise<HatchWebSocketPermit | undefined> {
    const decoded = decodeHatchWebSocketAdmission(value);
    const previewBase = this.previewBase;
    if (Option.isNone(decoded) || previewBase === undefined || this.rawContainer?.running !== true)
      return undefined;
    const expectedOrigin = hatchOrigin(decoded.value, previewBase);
    if (
      decoded.value.host !== new URL(expectedOrigin).hostname ||
      decoded.value.origin !== expectedOrigin
    )
      return undefined;
    const routeValue = {
      sessionId: decoded.value.sessionId,
      port: decoded.value.port,
      routeNonce: decoded.value.routeNonce,
    } satisfies HatchHostRoute;
    const active = await this.getScottyHatchRoute(routeValue);
    if (active === undefined) return undefined;
    const cookieDigest = await sha256Hex(decoded.value.cookieSecret).then(
      (digest) => digest,
      () => undefined,
    );
    if (cookieDigest === undefined) return undefined;
    const authorization = await this.#run(
      Effect.flatMap(HatchStore, (store) =>
        store.authorizeWebSocket(decoded.value, cookieDigest),
      ).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
    if (authorization === undefined) return undefined;
    const now = await this.#run(Clock.currentTimeMillis);
    for (const [socketId, admission] of this.hatchWebSocketAdmissions) {
      if (admission.expiresAtMillis <= now) this.hatchWebSocketAdmissions.delete(socketId);
    }
    if (
      this.hatchWebSocketAdmissions.size + this.hatchWebSockets.size >=
      HATCH_MAX_CONCURRENT_SOCKETS
    )
      return undefined;
    const socketId = randomToken(16);
    const expiresAtMillis = Math.min(
      Date.parse(authorization.expiresAt),
      now + HATCH_WEBSOCKET_ADMISSION_MILLIS,
    );
    if (expiresAtMillis <= now) return undefined;
    this.hatchWebSocketAdmissions.set(socketId, { authorization, expiresAtMillis });
    return {
      socketId,
      generation: authorization.generation,
      runtimeEpoch: authorization.runtimeEpoch,
      expiresAt: new Date(expiresAtMillis).toISOString(),
    };
  }

  async cancelScottyHatchWebSocket(socketId: string): Promise<void> {
    if (Option.isNone(decodeHatchWebSocketId(socketId))) return;
    this.hatchWebSocketAdmissions.delete(socketId);
    const tracked = this.hatchWebSockets.get(socketId);
    if (tracked !== undefined) tracked.close(1008, "Hatch WebSocket canceled");
  }

  async retryHatchCleanup(value: unknown): Promise<void> {
    const payload = decodeHatchCleanupRetry(value);
    if (Option.isNone(payload) || payload.value.target === "gone") return;
    return this.#run(this.retryHatchCleanupProgram(payload.value));
  }

  async [SANDBOX_TEST_ACCEPT_EVIDENCE](value: unknown): Promise<EvidenceActiveJob> {
    return this.#run(this.acceptScottyEvidenceJobProgram(value));
  }

  async runScottyEvidenceJob(value: unknown): Promise<BrowserEvidenceResult> {
    return this.#run(this.runScottyEvidenceJobProgram(value));
  }

  async [SANDBOX_TEST_EXPOSE_EVIDENCE](nonce: string): Promise<ExposedEvidencePreview> {
    return this.#run(this.exposeScottyEvidencePreviewProgram(nonce));
  }

  async admitScottyEvidencePreview(
    input: EvidencePreviewAdmission,
  ): Promise<EvidencePreviewPermitAdmission | undefined> {
    return this.#run(this.admitScottyEvidencePreviewProgram(input));
  }

  async adjustScottyEvidencePreviewRequest(
    requestId: string,
    ingressBytes: number,
  ): Promise<boolean> {
    if (
      Option.isNone(decodeEvidencePreviewRequestId(requestId)) ||
      Option.isNone(decodeEvidencePreviewIngressBytes(ingressBytes))
    )
      return false;
    return this.#run(this.adjustScottyEvidencePreviewProgram(requestId, ingressBytes));
  }

  async cancelScottyEvidencePreviewRequest(requestId: string): Promise<void> {
    if (Option.isNone(decodeEvidencePreviewRequestId(requestId))) return;
    this.previewRequests.get(requestId)?.controller.abort();
    return this.#run(this.cancelScottyEvidencePreviewProgram(requestId));
  }

  async expireScottyEvidencePreviewRequest(requestId: string): Promise<void> {
    if (Option.isNone(decodeEvidencePreviewRequestId(requestId))) return;
    this.previewRequests.get(requestId)?.controller.abort();
    return this.#run(this.expireScottyEvidencePreviewProgram(requestId));
  }

  async [SANDBOX_TEST_COMPLETE_EVIDENCE_STEP](
    nonce: string,
    input: unknown,
  ): Promise<EvidenceStepResult> {
    return this.#run(this.completeScottyEvidenceStepProgram(nonce, input));
  }

  async [SANDBOX_TEST_FINALIZE_EVIDENCE](
    nonce: string,
    status: EvidenceTerminalStatus,
  ): Promise<EvidenceJobSummary> {
    return this.#run(this.finalizeScottyEvidenceJobProgram(nonce, status));
  }

  async listScottyEvidence(): Promise<ReadonlyArray<PublicEvidenceJobSummary>> {
    return this.#run(
      Effect.map(
        Effect.flatMap(EvidenceStore, (store) => store.list),
        (jobs) => jobs.map(publicEvidenceSummaryProjection),
      ),
    );
  }

  async getScottyEvidence(jobId: string): Promise<PublicEvidenceJobSummary> {
    return this.#run(
      Effect.map(
        Effect.flatMap(EvidenceStore, (store) => store.getJob(jobId)),
        publicEvidenceSummaryProjection,
      ),
    );
  }

  async getScottyEvidenceArtifact(jobId: string, frameId: string): Promise<EvidenceArtifact> {
    return this.#run(Effect.flatMap(EvidenceStore, (store) => store.getArtifact(jobId, frameId)));
  }

  async expireEvidenceJob(payload: EvidenceDeadlinePayload): Promise<void> {
    return this.#run(this.expireEvidenceJobProgram(payload));
  }

  async expireRetainedEvidence(payload: unknown): Promise<void> {
    return this.#run(this.expireRetainedEvidenceProgram(payload));
  }

  async prepareTerminalAccess(): Promise<void> {
    return this.#run(this.prepareTerminalAccessProgram()).then(() => undefined);
  }

  async restartScottyTerminal(): Promise<void> {
    return this.#run(this.restartScottyTerminalProgram());
  }

  async preparePiSessionAccess(): Promise<void> {
    return this.#run(this.preparePiSessionAccessProgram());
  }

  private readonly passiveConsoleUnavailable = (
    reason: PiConsoleUnavailable["reason"],
    status: 409 | 503,
  ): Response =>
    Response.json(
      {
        status: "unavailable",
        reason,
        retryable: false,
      } satisfies PiConsoleUnavailable,
      { status, headers: { "cache-control": "no-store" } },
    );

  private readonly readSessionControlAuthority = () =>
    this.#run(
      Effect.result(
        Effect.gen(
          function* (this: Sandbox) {
            const actorStore = yield* ActorStore;
            const snapshot = yield* actorStore.read;
            if (snapshot.authority === undefined)
              return yield* new ScottyError("not_found", "Session actor authority is unavailable", {
                httpStatus: 404,
                exitCode: 3,
              });
            const metadataStore = yield* SessionActorMetadataStore;
            const metadata = yield* metadataStore.read(snapshot.authority);
            if (metadata === undefined)
              return yield* new ScottyError("internal", "Session actor metadata is unavailable", {
                httpStatus: 500,
                exitCode: 1,
              });
            return {
              _tag: "Actor" as const,
              authority: snapshot.authority,
              metadata,
              revision: snapshot.authority.revision,
            };
          }.bind(this),
        ),
      ),
    );

  private readonly readPassiveConsoleAuthority = async (): Promise<
    PassiveConsoleAuthority | Response
  > => {
    const read = await this.readSessionControlAuthority();
    if (Result.isFailure(read))
      return this.passiveConsoleUnavailable("session_authority_unavailable", 503);
    return read.success;
  };

  async containerSessionRequest(input: unknown): Promise<Response> {
    const decoded = decodeContainerSessionRequest(input);
    if (Option.isNone(decoded))
      return scottyErrorResponse(
        new ScottyError("bad_request", "Container session request is invalid", {
          httpStatus: 400,
          exitCode: 2,
        }),
      );

    return this.sessionControlGate.run(async () => {
      const sourceAuthority = await this.readSessionControlAuthority();
      if (Result.isFailure(sourceAuthority))
        return scottyErrorResponse(
          new ScottyError("internal", "Source session authority is unavailable", {
            httpStatus: 500,
            exitCode: 1,
          }),
        );
      const sourceAuthorityValue = sourceAuthority.success;
      const sourceWarm =
        AuthorityStateSchema.guards.Stable(sourceAuthorityValue.authority.state) &&
        StableStateSchema.guards.Warm(sourceAuthorityValue.authority.state.stable);
      if (!sourceWarm)
        return scottyErrorResponse(
          new ScottyError("wrong_state", "Source session is not available for orchestration", {
            httpStatus: 409,
            exitCode: 5,
            hint: "The source session must be warm with no active lifecycle operation.",
          }),
        );
      if (sourceAuthorityValue.authority.session.execution.provider !== "cloudflare")
        return scottyErrorResponse(
          new ScottyError("wrong_state", "Source session provider cannot orchestrate sessions", {
            httpStatus: 409,
            exitCode: 5,
          }),
        );
      const sourceId = sourceAuthorityValue.authority.session.id;
      const sourceRepository = sourceAuthorityValue.authority.session.repository;
      if (decoded.value.targetId === sourceId)
        return scottyErrorResponse(
          new ScottyError("auth", "Container session access denied", {
            httpStatus: 401,
            exitCode: 4,
          }),
        );

      const target = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(decoded.value.targetId));
      const targetSession = await Promise.resolve()
        .then(() => target.getScottySession())
        .then(Result.succeed, () => Result.fail(undefined));
      if (Result.isFailure(targetSession))
        return scottyErrorResponse(notFound(decoded.value.targetId));
      if (targetSession.success.session.display.repository !== sourceRepository)
        return scottyErrorResponse(
          new ScottyError("auth", "Container session access denied", {
            httpStatus: 401,
            exitCode: 4,
          }),
        );

      return decoded.value.action === "inspect"
        ? inspectPassiveSession(target)
        : steerPassiveSession(target, decoded.value.targetId, decoded.value.message);
    });
  }

  private readonly validatePassiveConsoleAuthority = (
    authority: PassiveConsoleAuthority,
  ): Response | undefined => {
    const state = authority.authority.state;
    if (!AuthorityStateSchema.guards.Stable(state) || !StableStateSchema.guards.Warm(state.stable))
      return this.passiveConsoleUnavailable(
        AuthorityStateSchema.guards.Transitioning(state)
          ? "session_operation_active"
          : "session_not_warm",
        409,
      );
    if (authority.authority.session.execution.provider !== "cloudflare")
      return this.passiveConsoleUnavailable("provider_unsupported", 409);
    return undefined;
  };

  private readonly stalePassiveConsoleCommand = (
    command: PiConsoleCommand,
    sessionRevision: number,
  ): Response =>
    Response.json(
      {
        status: "stale",
        expectedSessionRevision: command.expectedSessionRevision,
        sessionRevision,
        retryable: false,
      } satisfies PiConsoleStaleCommand,
      { status: 409, headers: { "cache-control": "no-store" } },
    );

  private async fetchNativePassivePiConsole(input: {
    readonly sessionId: SessionRecord["id"];
    readonly request: Request;
  }): Promise<Response> {
    const container = this.rawContainer;
    if (container === undefined || !container.running)
      return this.passiveConsoleUnavailable("provider_passive_relay_unavailable", 503);

    const authority = await this.readPassiveConsoleAuthority();
    if (
      authority instanceof Response ||
      authority.metadata.createObservations.credentialGrants === null
    )
      return this.passiveConsoleUnavailable("provider_passive_relay_unavailable", 503);
    const transportToken = await piSessionTransportToken(input.sessionId).then(
      (value) => Result.succeed(value),
      () => Result.fail(undefined),
    );
    if (Result.isFailure(transportToken))
      return this.passiveConsoleUnavailable("provider_passive_relay_unavailable", 503);

    const incomingUrl = new URL(input.request.url);
    const action = incomingUrl.pathname.slice(PI_CONSOLE_PROXY_PREFIX.length + 1);
    const targetUrl = new URL(`http://127.0.0.1:${PI_SESSION_PORT}/${action}`);
    targetUrl.search = incomingUrl.search;
    const headers = copyBoundedPassivePiConsoleHeaders(input.request.headers);
    headers.set(PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER, "1");
    headers.set(PI_SESSION_TOKEN_HEADER, transportToken.success);
    const body = input.request.method === "POST" ? await input.request.arrayBuffer() : undefined;
    const relayRequest = new Request(targetUrl, {
      method: input.request.method,
      headers,
      body,
      signal: input.request.signal,
    });

    return Promise.resolve()
      .then(() => container.getTcpPort(PI_SESSION_PORT).fetch(relayRequest))
      .then(
        (response) => {
          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete(PI_SESSION_TOKEN_HEADER);
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        },
        () => this.passiveConsoleUnavailable("provider_passive_relay_unavailable", 503),
      );
  }

  private async fetchPassivePiConsole(request: Request, action: string): Promise<Response> {
    let command: PiConsoleCommand | undefined;
    if (action === "command") {
      const text = await readBoundedUtf8Body(request, PI_CONSOLE_MAX_COMMAND_BYTES);
      if (text === undefined) return Response.json({ error: "command_too_large" }, { status: 413 });
      const json = decodeJsonValue(text);
      if (Option.isNone(json)) return Response.json({ error: "invalid_command" }, { status: 400 });
      const decoded = await decodePiConsoleCommandPromise(json.value).then(
        (value) => Result.succeed(value),
        () => Result.fail(undefined),
      );
      if (Result.isFailure(decoded))
        return Response.json({ error: "invalid_command" }, { status: 400 });
      command = decoded.success;
    }

    const relayWithCurrentAuthority = async (): Promise<Response> => {
      const authority = await this.readPassiveConsoleAuthority();
      if (authority instanceof Response) return authority;
      if (command && command.expectedSessionRevision !== authority.revision)
        return this.stalePassiveConsoleCommand(command, authority.revision);
      const unavailable = this.validatePassiveConsoleAuthority(authority);
      if (unavailable) return unavailable;
      const relay = this.passivePiConsoleRelay;
      const relayHeaders = copyBoundedPassivePiConsoleHeaders(request.headers);
      if (command) relayHeaders.set("content-type", "application/json");
      const relayRequest = new Request(request.url, {
        method: request.method,
        headers: relayHeaders,
        body: command ? JSON.stringify(command) : undefined,
        signal: request.signal,
      });
      const response = await relay.fetch({
        sessionId: authority.authority.session.id,
        request: relayRequest,
      });
      if (action !== "snapshot" || response.status !== 200) return response;

      const text = await readBoundedUtf8Body(response, PI_CONSOLE_MAX_RESPONSE_BYTES);
      if (text === undefined)
        return Response.json({ error: "response_too_large" }, { status: 502 });
      const json = decodeJsonValue(text);
      if (Option.isNone(json)) return Response.json({ error: "invalid_snapshot" }, { status: 502 });
      const decoded = await decodePiConsoleRelaySnapshot(json.value).then(
        (value) => Result.succeed(value),
        () => Result.fail(undefined),
      );
      if (Result.isFailure(decoded))
        return Response.json({ error: "invalid_snapshot" }, { status: 502 });
      const state = authority.authority.state;
      if (
        !AuthorityStateSchema.guards.Stable(state) ||
        !StableStateSchema.guards.Warm(state.stable)
      )
        return this.passiveConsoleUnavailable("session_not_warm", 409);
      const readiness = state.stable.readiness;
      const sessionRevision = await this.#run(
        Effect.gen(function* () {
          const actor = yield* SessionActor;
          const now = yield* Clock.currentTimeMillis;
          const observedAt = new Date(now).toISOString();
          yield* actor.handle({
            _tag: "ActivityObserved",
            revision: authority.revision,
            expectedRuntimeGeneration: readiness.runtime.runtimeGeneration,
            expectedSupervisorEpoch: readiness.supervisor.supervisorEpoch,
            correlationId: crypto.randomUUID(),
            timestamp: observedAt,
            activity: {
              supervisorEpoch: decoded.success.epoch,
              piSequence: decoded.success.sequence,
              state:
                decoded.success.activeTools.length > 0 ||
                decoded.success.queue.steer.length > 0 ||
                decoded.success.queue.followUp.length > 0
                  ? "working"
                  : "waiting",
              observedAt,
              expiresAt: new Date(now + ACTIVITY_OBSERVATION_TTL_MS).toISOString(),
            },
          });
          const store = yield* ActorStore;
          return (yield* store.read).revision;
        }),
      ).then(
        (revision) => revision,
        () => authority.revision,
      );
      return Response.json(
        { ...decoded.success, sessionRevision },
        { headers: { "cache-control": "no-store" } },
      );
    };

    return command === undefined
      ? relayWithCurrentAuthority()
      : this.sessionControlGate.run(relayWithCurrentAuthority);
  }

  private readonly hatchWebSocketForwardingRoute = (
    request: Request,
  ): HatchWebSocketForwardingRoute | undefined => {
    const socketId = request.headers.get(HATCH_PRIVATE_WEBSOCKET_HEADER);
    const portValue = request.headers.get(SANDBOX_PREVIEW_PORT_HEADER);
    const sessionId = request.headers.get(SANDBOX_PREVIEW_SANDBOX_ID_HEADER);
    const routeNonce = request.headers.get(SANDBOX_PREVIEW_TOKEN_HEADER);
    if (
      request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) !== "1" ||
      socketId === null ||
      Option.isNone(decodeHatchWebSocketId(socketId)) ||
      portValue === null ||
      !PREVIEW_PORT_PATTERN.test(portValue) ||
      sessionId === null ||
      routeNonce === null
    )
      return undefined;
    const decoded = decodeHatchHostRoute({ sessionId, port: Number(portValue), routeNonce });
    return Option.isSome(decoded) ? { ...decoded.value, socketId } : undefined;
  };

  private readonly isHatchWebSocketForwardRequest = (
    request: Request,
    route: HatchWebSocketForwardingRoute | undefined,
  ): route is HatchWebSocketForwardingRoute =>
    route !== undefined &&
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    request.headers
      .get("connection")
      ?.split(",")
      .some((token) => token.trim().toLowerCase() === "upgrade") === true;

  private readonly takeHatchWebSocketAdmission = (
    route: HatchWebSocketForwardingRoute,
    nowMillis: number,
  ): PendingHatchWebSocket | undefined => {
    const pending = this.hatchWebSocketAdmissions.get(route.socketId);
    this.hatchWebSocketAdmissions.delete(route.socketId);
    if (
      pending === undefined ||
      pending.expiresAtMillis <= nowMillis ||
      pending.authorization.sessionId !== route.sessionId ||
      pending.authorization.port !== route.port ||
      pending.authorization.routeNonce !== route.routeNonce
    )
      return undefined;
    return pending;
  };

  private readonly sameHatchWebSocketAuthorization = (
    current: HatchRouteAuthorization | undefined,
    expected: HatchWebSocketAuthorization,
  ): boolean => current !== undefined && sameHatchAuthorization(current, expected);

  private readonly cleanupStaleHatchWebSocket = async (response: Response): Promise<void> => {
    response.webSocket?.close(1008, "Stale Hatch WebSocket upgrade");
    await response.body?.cancel();
  };

  private bridgeHatchWebSocket(
    socketId: string,
    response: Response,
    authorization: HatchWebSocketAuthorization,
    nowMillis: number,
  ): Response | undefined {
    const upstream = response.webSocket;
    if (response.status !== 101 || upstream === null || upstream === undefined) return undefined;
    const [client, server] = Object.values(new WebSocketPair());
    let closed = false;
    let messageCount = 0;
    let aggregateBytes = 0;
    let idleTimer: ReturnType<typeof setTimeout>;
    let absoluteTimer: ReturnType<typeof setTimeout>;
    let messageTail = Promise.resolve();
    const close = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(absoluteTimer);
      if (this.hatchWebSockets.get(socketId)?.close === close)
        this.hatchWebSockets.delete(socketId);
      server.close(code, reason);
      upstream.close(code, reason);
    };
    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native WebSocket idle enforcement cannot be driven by Effect Clock callbacks
      idleTimer = setTimeout(
        () => close(1008, "Hatch WebSocket idle limit"),
        HATCH_WEBSOCKET_IDLE_MILLIS,
      );
    };
    const forward = (event: MessageEvent, destination: WebSocket): void => {
      messageTail = messageTail.then(async () => {
        if (closed) return;
        const message = await normalizeHatchWebSocketMessage(event.data);
        if (message === undefined || message.bytes > HATCH_MAX_WEBSOCKET_MESSAGE_BYTES) {
          close(1009, "Hatch WebSocket message limit");
          return;
        }
        messageCount += 1;
        aggregateBytes += message.bytes;
        if (
          messageCount > HATCH_MAX_WEBSOCKET_MESSAGES ||
          aggregateBytes > HATCH_MAX_WEBSOCKET_AGGREGATE_BYTES
        ) {
          close(1008, "Hatch WebSocket traffic limit");
          return;
        }
        resetIdle();
        destination.send(message.data);
      });
      void messageTail.then(
        () => undefined,
        () => close(1011, "Hatch WebSocket forwarding failed"),
      );
    };
    upstream.accept();
    server.accept();
    server.addEventListener("message", (event) => forward(event, upstream));
    upstream.addEventListener("message", (event) => forward(event, server));
    server.addEventListener("close", (event) => {
      const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
      close(code, event.reason);
    });
    upstream.addEventListener("close", (event) => {
      const code = event.code === 1005 || event.code === 1006 ? 1000 : event.code;
      close(code, event.reason);
    });
    server.addEventListener("error", () => close(1011, "Hatch client socket error"));
    upstream.addEventListener("error", () => close(1011, "Hatch service socket error"));
    const absoluteExpiresAt = Math.min(
      Date.parse(authorization.expiresAt),
      nowMillis + HATCH_WEBSOCKET_ABSOLUTE_MILLIS,
    );
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native WebSocket idle enforcement cannot be driven by Effect Clock callbacks
    idleTimer = setTimeout(
      () => close(1008, "Hatch WebSocket idle limit"),
      HATCH_WEBSOCKET_IDLE_MILLIS,
    );
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native WebSocket authority uses the fixed persisted permit deadline
    absoluteTimer = setTimeout(
      () => close(1008, "Hatch WebSocket duration limit"),
      Math.max(0, absoluteExpiresAt - nowMillis),
    );
    this.hatchWebSockets.set(socketId, { authorization, close });
    const headers = new Headers(response.headers);
    headers.set(HATCH_PRIVATE_WEBSOCKET_CLAIMED_HEADER, socketId);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  private readonly hatchReadinessForwardingRoute = (
    request: Request,
  ): (HatchHostRoute & { readonly marker: string }) | undefined => {
    const marker = request.headers.get(HATCH_PRIVATE_READINESS_HEADER);
    const portValue = request.headers.get(SANDBOX_PREVIEW_PORT_HEADER);
    const sessionId = request.headers.get(SANDBOX_PREVIEW_SANDBOX_ID_HEADER);
    const routeNonce = request.headers.get(SANDBOX_PREVIEW_TOKEN_HEADER);
    if (
      request.method !== "HEAD" ||
      new URL(request.url).pathname !== HATCH_READINESS_PATH ||
      request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) !== "1" ||
      marker === null ||
      Option.isNone(decodeHatchIdentifier(marker)) ||
      portValue === null ||
      !PREVIEW_PORT_PATTERN.test(portValue) ||
      sessionId === null ||
      routeNonce === null
    )
      return undefined;
    const decoded = decodeHatchHostRoute({ sessionId, port: Number(portValue), routeNonce });
    return Option.isSome(decoded) ? { ...decoded.value, marker } : undefined;
  };

  private async fetchHatchReadiness(request: Request): Promise<Response> {
    const route = this.hatchReadinessForwardingRoute(request);
    if (route === undefined || this.rawContainer?.running !== true)
      return deniedEvidencePreviewResponse();
    const state = await this.#run(
      Effect.flatMap(HatchStore, (store) => store.read).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    );
    const hatch = state?.primary;
    if (!authorizesHatchReadiness(hatch, route)) return deniedEvidencePreviewResponse();
    const runtimeEpoch = await this.#run(Effect.result(this.currentRuntimeEpochProgram()));
    if (Result.isFailure(runtimeEpoch) || runtimeEpoch.success !== hatch.runtimeEpoch)
      return deniedEvidencePreviewResponse();
    const health = await this.#run(
      Effect.result(
        Effect.flatMap(SandboxRuntime, (runtime) =>
          runtime.fetchPortStatus(hatch.service.healthPath, hatch.service.port, "GET"),
        ),
      ),
    );
    if (Result.isFailure(health) || health.success < 200 || health.success > 399)
      return deniedEvidencePreviewResponse();
    return new Response(null, {
      status: 204,
      headers: { [HATCH_PRIVATE_READINESS_CLAIMED_HEADER]: route.marker },
    });
  }

  private readonly hatchForwardingRoute = (
    request: Request,
  ): (HatchHostRoute & { readonly requestId: string }) | undefined => {
    const requestId = request.headers.get(HATCH_PRIVATE_REQUEST_HEADER);
    const portValue = request.headers.get(SANDBOX_PREVIEW_PORT_HEADER);
    const sessionId = request.headers.get(SANDBOX_PREVIEW_SANDBOX_ID_HEADER);
    const routeNonce = request.headers.get(SANDBOX_PREVIEW_TOKEN_HEADER);
    if (
      request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) !== "1" ||
      requestId === null ||
      Option.isNone(decodeHatchRequestId(requestId)) ||
      portValue === null ||
      !PREVIEW_PORT_PATTERN.test(portValue) ||
      sessionId === null ||
      routeNonce === null
    )
      return undefined;
    const decoded = decodeHatchHostRoute({ sessionId, port: Number(portValue), routeNonce });
    return Option.isSome(decoded) ? { ...decoded.value, requestId } : undefined;
  };

  private async hatchResponseStream(
    requestId: string,
    response: Response,
    abortController: AbortController,
    timeout: ReturnType<typeof setTimeout>,
  ): Promise<Response> {
    const settle = async (responseBytes: number): Promise<void> => {
      this.hatchRequests.delete(requestId);
      await this.#run(
        Effect.flatMap(HatchStore, (store) => store.settleRequest(requestId, responseBytes)).pipe(
          Effect.ignore,
        ),
      );
    };
    if (response.body === null) {
      clearTimeout(timeout);
      await settle(0);
      const headers = new Headers(response.headers);
      headers.set(HATCH_PRIVATE_CLAIMED_HEADER, requestId);
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const reader = response.body.getReader();
    let bytes = 0;
    let terminal = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const finish = async (): Promise<void> => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timeout);
      abortController.signal.removeEventListener("abort", abortStream);
      await settle(bytes);
    };
    const abortStream = (): void => {
      if (terminal) return;
      void finish().then(() =>
        reader.cancel().then(
          () => streamController?.error(new DOMException("Hatch request expired", "TimeoutError")),
          () => streamController?.error(new DOMException("Hatch request expired", "TimeoutError")),
        ),
      );
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      async pull(controller) {
        const next = await reader.read().then(
          (value) => ({ ok: true as const, value }),
          (cause) => ({ ok: false as const, cause }),
        );
        if (terminal) return;
        if (!next.ok) {
          await finish();
          controller.error(next.cause);
          return;
        }
        if (next.value.done) {
          await finish();
          controller.close();
          return;
        }
        const nextBytes = bytes + next.value.value.byteLength;
        if (nextBytes > HATCH_RESERVED_RESPONSE_BYTES) {
          await reader.cancel();
          bytes = HATCH_RESERVED_RESPONSE_BYTES;
          await finish();
          controller.error(
            new DOMException("Hatch response exceeded its limit", "QuotaExceededError"),
          );
          return;
        }
        bytes = nextBytes;
        controller.enqueue(next.value.value);
      },
      async cancel(reason) {
        abortController.signal.removeEventListener("abort", abortStream);
        abortController.abort();
        await reader.cancel(reason).then(
          () => undefined,
          () => undefined,
        );
        await finish();
      },
    });
    abortController.signal.addEventListener("abort", abortStream, { once: true });
    if (abortController.signal.aborted) abortStream();
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set(HATCH_PRIVATE_CLAIMED_HEADER, requestId);
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private async fetchHatchWebSocket(request: Request): Promise<Response> {
    const route = this.hatchWebSocketForwardingRoute(request);
    if (!this.isHatchWebSocketForwardRequest(request, route))
      return deniedEvidencePreviewResponse();
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native WebSocket upgrade admission has a fixed host deadline
    const nowMillis = Date.now();
    const pending = this.takeHatchWebSocketAdmission(route, nowMillis);
    if (pending === undefined) return deniedEvidencePreviewResponse();
    const routeValue = {
      sessionId: route.sessionId,
      port: route.port,
      routeNonce: route.routeNonce,
    } satisfies HatchHostRoute;
    const current = await this.getScottyHatchRoute(routeValue);
    if (!this.sameHatchWebSocketAuthorization(current, pending.authorization))
      return deniedEvidencePreviewResponse();
    const headers = new Headers(request.headers);
    headers.delete(HATCH_PRIVATE_WEBSOCKET_HEADER);
    const response = await this.hatchRequestForwarder(new Request(request, { headers })).then(
      (value) => value,
      () => undefined,
    );
    if (response === undefined) return deniedEvidencePreviewResponse();
    const after = await this.getScottyHatchRoute(routeValue);
    if (!this.sameHatchWebSocketAuthorization(after, pending.authorization)) {
      await this.cleanupStaleHatchWebSocket(response);
      return deniedEvidencePreviewResponse();
    }
    const bridged = this.bridgeHatchWebSocket(
      route.socketId,
      response,
      pending.authorization,
      nowMillis,
    );
    if (bridged !== undefined) return bridged;
    await response.body?.cancel();
    return deniedEvidencePreviewResponse();
  }

  private async fetchHatchRequest(request: Request): Promise<Response> {
    const route = this.hatchForwardingRoute(request);
    if (route === undefined || request.method === "CONNECT" || request.method === "TRACE")
      return deniedEvidencePreviewResponse();
    const runtimeEpoch = await this.#run(Effect.result(this.currentRuntimeEpochProgram()));
    if (Result.isFailure(runtimeEpoch)) return deniedEvidencePreviewResponse();
    const claimed = await this.#run(
      Effect.flatMap(HatchStore, (store) =>
        store.claimRequest({ ...route, runtimeEpoch: runtimeEpoch.success }),
      ).pipe(Effect.catch(() => Effect.succeed(undefined))),
    );
    if (claimed === undefined) return deniedEvidencePreviewResponse();
    const abortController = new AbortController();
    this.hatchRequests.set(route.requestId, abortController);
    const headers = new Headers(request.headers);
    headers.delete(HATCH_PRIVATE_REQUEST_HEADER);
    const forwarded = new Request(request, { headers, signal: abortController.signal });
    const remainingMillis = Math.max(
      0,
      Date.parse(claimed.expiresAt) - (await this.#run(Clock.currentTimeMillis)),
    );
    // oxlint-disable-next-line scotty/no-raw-wall-clock -- boundary: native Sandbox fetch streaming is fenced by the persisted Hatch request deadline
    const timeout = setTimeout(() => abortController.abort(), remainingMillis);
    const result = await Promise.race([
      this.hatchRequestForwarder(forwarded).then(
        (response) => ({ kind: "response" as const, response }),
        () => ({ kind: "error" as const }),
      ),
      new Promise<{ readonly kind: "aborted" }>((resolve) =>
        abortController.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), {
          once: true,
        }),
      ),
    ]);
    if (result.kind !== "response" || abortController.signal.aborted) {
      clearTimeout(timeout);
      await this.cancelScottyHatchRequest(route.requestId);
      if (result.kind === "response") await result.response.body?.cancel();
      return deniedEvidencePreviewResponse();
    }
    if (result.response.webSocket !== null && result.response.webSocket !== undefined) {
      clearTimeout(timeout);
      result.response.webSocket.close(1008, "Hatch WebSockets are disabled");
      await this.cancelScottyHatchRequest(route.requestId);
      return deniedEvidencePreviewResponse();
    }
    return this.hatchResponseStream(route.requestId, result.response, abortController, timeout);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.has(HATCH_PRIVATE_READINESS_HEADER))
      return this.fetchHatchReadiness(request);
    if (request.headers.has(HATCH_PRIVATE_WEBSOCKET_HEADER))
      return this.fetchHatchWebSocket(request);
    if (request.headers.has(HATCH_PRIVATE_REQUEST_HEADER)) return this.fetchHatchRequest(request);
    if (
      request.headers.has(EVIDENCE_PREVIEW_PRIVATE_REQUEST_HEADER) ||
      request.headers.get(SANDBOX_PREVIEW_PROXY_HEADER) === "1"
    )
      return this.fetchEvidencePreviewRequest(request);
    const incomingUrl = new URL(request.url);
    if (incomingUrl.pathname.startsWith(`${PI_CONSOLE_PROXY_PREFIX}/`)) {
      const action = incomingUrl.pathname.slice(PI_CONSOLE_PROXY_PREFIX.length + 1);
      const expectedMethod =
        action === "snapshot" || action === "events"
          ? "GET"
          : action === "command"
            ? "POST"
            : undefined;
      if (expectedMethod === undefined)
        return Response.json({ error: "not_found" }, { status: 404 });
      if (request.method !== expectedMethod)
        return Response.json({ error: "method_not_allowed" }, { status: 405 });
      return this.fetchPassivePiConsole(request, action);
    }
    return super.fetch(request);
  }

  private readonly resolveCredentialForProxyProgram = Effect.fnUntraced(function* (
    this: Sandbox,
    input: import("../credentials/managed").SessionCredentialAccess,
  ) {
    const handle = parseManagedHandle(input.handle);
    if (Option.isNone(handle)) return null;
    const actorStore = yield* ActorStore;
    const { authority } = yield* actorStore.read;
    if (authority === undefined || !allowsCredentialProxyAccess(authority)) return null;
    const metadataStore = yield* SessionActorMetadataStore;
    const metadata = yield* metadataStore.read(authority);
    if (metadata === undefined) return null;
    const grant = credentialProxyGrant(authority, metadata, handle.value, input.repository);
    if (grant === undefined) return null;
    const registry = this.env.CREDENTIALS?.getByName(CREDENTIAL_REGISTRY_OBJECT_NAME);
    if (registry === undefined)
      return yield* this.upstreamError(
        "Credential registry is unavailable",
        undefined,
        authority.session.id,
      );
    const resolved = yield* Effect.tryPromise({
      try: () =>
        registry.resolve({
          sessionId: authority.session.id,
          name: grant.name,
          kind: grant.kind,
          versionRef: grant.versionRef,
          handle: input.handle,
        }),
      catch: (cause) =>
        this.upstreamError("Credential resolution failed", cause, authority.session.id),
    });
    if (!resolved.ok)
      return yield* this.upstreamError(
        "Credential resolution failed",
        resolved.error,
        authority.session.id,
      );
    const decoded = decodeCredentialRegistryResolvedCredentialResult(resolved.value);
    if (Result.isFailure(decoded))
      return yield* this.upstreamError(
        "Credential resolution failed",
        "invalid_response",
        authority.session.id,
      );
    const credential = Redacted.make(decoded.success.value);
    const plaintext = Redacted.value(credential);
    Redacted.wipeUnsafe(credential);
    return plaintext;
  });

  async checkpointScottySession(): Promise<SessionView> {
    return this.#run(this.actorLifecycleProgram("Checkpoint"));
  }

  async sleepScottySession(): Promise<SessionView> {
    return this.#run(this.actorLifecycleProgram("Sleep"));
  }

  async resumeScottySession(): Promise<SessionView> {
    return this.#run(this.actorLifecycleProgram("Resume"));
  }

  async prepareDownArchive(): Promise<DownArchive> {
    return this.#run(this.prepareDownArchiveProgram());
  }

  async readScottyArchiveStream(path: string) {
    await this.assertRuntimeAccess();
    return decodeSandboxFileStream(await this.readFileStream(path));
  }

  async vaporizeScottySession(): Promise<{ id: string; status: "gone" }> {
    return this.#run(this.actorVaporizeProgram());
  }

  async renameScottySession(title: string): Promise<SessionView> {
    return this.#run(this.renameScottySessionProgram(title));
  }

  async resolveCredentialForProxy(input: unknown): Promise<string | null> {
    const decoded = decodeSessionCredentialAccessResult(input);
    if (Result.isFailure(decoded)) return null;
    return this.#run(this.resolveCredentialForProxyProgram(decoded.success));
  }

  async sessionActorDeadline(payload: unknown): Promise<void> {
    const fence = decodeActorAlarmFence(payload);
    if (Option.isNone(fence)) return;
    const currentFence = { ...fence.value, kind: fence.value.kind ?? ("deadline" as const) };
    return this.#run(
      Effect.gen({ self: this }, function* () {
        const now = yield* Clock.currentTimeMillis;
        const actor = yield* SessionActor;
        yield* actor.resume({
          timestamp: new Date(now).toISOString(),
          correlationId: currentFence.correlationId,
          fence: currentFence,
        });
        yield* this.publishActorSessionProjectionBestEffortProgram();
        yield* this.cancelSessionSchedulesAfterGoneProgram();
      }),
    );
  }

  async sessionActorHardCap(payload: unknown): Promise<void> {
    const fence = decodeCreateHardCapFence(payload);
    if (Option.isNone(fence)) return;
    return this.#run(
      Effect.gen({ self: this }, function* () {
        const scheduleSuccessor = Effect.tryPromise({
          try: () => this.schedule(5, "sessionActorHardCap", fence.value).then(() => undefined),
          catch: () =>
            new CreateControllerBoundaryFailure({
              boundary: "hard_cap",
              code: "schedule_outcome_unknown",
            }),
        }).pipe(Effect.retry({ schedule: Schedule.spaced("1 second") }));
        const actor = yield* SessionActor;
        const now = yield* Clock.currentTimeMillis;
        const handled = yield* Effect.result(
          actor.handle({
            _tag: "HardCapDeadlineAlarm",
            alarmId: fence.value.generation,
            expectedGeneration: fence.value.generation,
            expectedDeadlineAt: fence.value.deadlineAt,
            correlationId: crypto.randomUUID(),
            timestamp: new Date(now).toISOString(),
          }),
        );
        if (Result.isFailure(handled)) return yield* scheduleSuccessor;
        yield* this.publishActorSessionProjectionBestEffortProgram();

        const store = yield* ActorStore;
        let after = yield* store.read;
        if (yield* Effect.sync(() => this.cancelAllSessionSchedulesIfGone(after.authority))) return;
        if (isMatchingVaporizeHardCap(after.authority, fence.value)) {
          const resumed = yield* Effect.result(
            actor.resume({
              timestamp: new Date(now).toISOString(),
              correlationId: crypto.randomUUID(),
            }),
          );
          if (Result.isFailure(resumed)) return yield* scheduleSuccessor;
          yield* this.publishActorSessionProjectionBestEffortProgram();
          after = yield* store.read;
          if (yield* Effect.sync(() => this.cancelAllSessionSchedulesIfGone(after.authority)))
            return;
          if (
            after.authority !== undefined &&
            AuthorityStateSchema.guards.Transitioning(after.authority.state) &&
            TransitionSchema.guards.Vaporize(after.authority.state.transition)
          )
            return yield* scheduleSuccessor;
        }
        const authority = after.authority;
        if (
          authority === undefined ||
          authority.session.id !== fence.value.sessionId ||
          authority.hardCap.generation !== fence.value.generation ||
          authority.hardCap.deadlineAt !== fence.value.deadlineAt ||
          !AuthorityStateSchema.guards.Stable(authority.state) ||
          !StableStateSchema.guards.Failed(authority.state.stable)
        )
          return;
        const recovery = yield* RecoverySandbox;
        const destroyed = yield* Effect.result(recovery.destroyFailedRuntime(authority));
        if (Result.isFailure(destroyed)) yield* scheduleSuccessor;
      }),
    );
  }

  async sessionActorHardCapDrain(payload: unknown): Promise<void> {
    const fence = decodeCreateHardCapDrainFence(payload);
    if (Option.isNone(fence)) return;
    return this.#run(
      Effect.gen({ self: this }, function* () {
        const now = yield* Clock.currentTimeMillis;
        const drainMillis = Date.parse(fence.value.drainAt);
        const deadlineMillis = Date.parse(fence.value.deadlineAt);
        if (
          !Number.isFinite(drainMillis) ||
          !Number.isFinite(deadlineMillis) ||
          now < drainMillis ||
          now >= deadlineMillis
        )
          return;

        const store = yield* ActorStore;
        const before = yield* store.read;
        const authority = before.authority;
        if (yield* Effect.sync(() => this.cancelAllSessionSchedulesIfGone(authority))) return;
        if (!isMatchingHardCapDrain(authority, fence.value)) return;
        if (isTerminalDrainAuthority(authority) || isVaporizingAuthority(authority)) return;

        if (
          isWarmAuthority(authority) ||
          (AuthorityStateSchema.guards.Transitioning(authority.state) &&
            TransitionSchema.guards.Sleep(authority.state.transition))
        )
          yield* Effect.result(this.actorLifecycleProgram("Sleep"));

        const after = yield* store.read;
        if (yield* Effect.sync(() => this.cancelAllSessionSchedulesIfGone(after.authority))) return;
        const current = after.authority;
        if (!isMatchingHardCapDrain(current, fence.value)) return;
        if (isTerminalDrainAuthority(current) || isVaporizingAuthority(current)) return;

        const retryAt = (yield* Clock.currentTimeMillis) + 5_000;
        if (retryAt >= deadlineMillis) return;
        yield* Effect.tryPromise({
          try: () =>
            this.schedule(5, "sessionActorHardCapDrain", fence.value).then(() => undefined),
          catch: () =>
            new CreateControllerBoundaryFailure({
              boundary: "hard_cap",
              code: "schedule_outcome_unknown",
            }),
        });
      }),
    );
  }

  private enqueueRuntimeLifecycleObservation(lifecycle: "started" | "stopped"): void {
    const background = Promise.resolve()
      .then(() =>
        this.#run(
          Effect.gen({ self: this }, function* () {
            const store = yield* ActorStore;
            const snapshot = yield* store.read;
            const authority = snapshot.authority;
            if (authority === undefined) return;
            const runtime = actorReadiness(authority)?.runtime;
            if (runtime === null || runtime === undefined) return;
            const recovery = yield* RecoverySandbox;
            const fence = {
              sessionId: authority.session.id,
              providerRuntimeId: runtime.providerRuntimeId,
              runtimeGeneration: runtime.runtimeGeneration,
              correlationId: crypto.randomUUID(),
            };
            const observed =
              lifecycle === "started"
                ? yield* Effect.result(recovery.observeRuntimeStarted(fence))
                : Result.succeed(yield* recovery.observeRuntimeStoppedCallback(fence));
            if (Result.isFailure(observed)) {
              yield* Effect.sync(() =>
                console.error("Session actor runtime observation remains unknown", {
                  lifecycle,
                  resultCode: observed.failure.safeResultCode,
                }),
              );
              return;
            }
            const actor = yield* SessionActor;
            yield* actor
              .handle(observed.success)
              .pipe(Effect.catchTag("ActorStoreConflict", () => actor.handle(observed.success)));
            yield* this.publishActorSessionProjectionBestEffortProgram();
          }),
        ),
      )
      .then(
        () => undefined,
        (cause: unknown) => {
          console.error("Session actor runtime callback failed", {
            lifecycle,
            error: errorName(cause),
          });
        },
      );
    this.ctx.waitUntil(background);
  }

  override async onActivityExpired(): Promise<void> {
    return this.#run(
      Effect.gen({ self: this }, function* () {
        const store = yield* ActorStore;
        const snapshot = yield* store.read;
        if (
          snapshot.authority === undefined ||
          !AuthorityStateSchema.guards.Stable(snapshot.authority.state) ||
          !StableStateSchema.guards.Warm(snapshot.authority.state.stable)
        )
          return;
        yield* this.actorLifecycleProgram("Sleep").pipe(Effect.asVoid);
      }),
    );
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    if (this.localE2E) await this.runtimeIncarnationStore.markLocalStarted();
    this.enqueueRuntimeLifecycleObservation("started");
  }

  override async onStop(): Promise<void> {
    await super.onStop();
    if (this.localE2E) await this.runtimeIncarnationStore.clearLocal();
    this.enqueueRuntimeLifecycleObservation("stopped");
  }

  override onError(error: unknown): void {
    super.onError(error);
    this.enqueueRuntimeLifecycleObservation("started");
  }

  private cancelAllSessionSchedules(): void {
    for (const callback of SESSION_SCHEDULE_CALLBACKS) {
      this.deleteSchedules(callback);
    }
  }

  private cancelAllSessionSchedulesIfGone(authority: SessionAuthority | undefined): boolean {
    if (
      authority === undefined ||
      !AuthorityStateSchema.guards.Stable(authority.state) ||
      !StableStateSchema.guards.Gone(authority.state.stable)
    )
      return false;
    this.cancelAllSessionSchedules();
    return true;
  }

  private async requireRecord(): Promise<SessionRecord> {
    return this.#run(this.requireRecordProgram());
  }

  private async assertRuntimeAccess(): Promise<SessionRecord> {
    return this.#run(this.assertRuntimeAccessProgram());
  }

  async #run<A, E>(operation: Effect.Effect<A, E, SandboxServices>): Promise<A> {
    const provided =
      this.clock === undefined
        ? operation.pipe(Effect.provide(this.layer))
        : operation.pipe(
            Effect.provide(this.layer),
            Effect.provideService(Clock.Clock, this.clock),
          );
    // oxlint-disable-next-line scotty/no-effect-runtime-escape -- boundary: Sandbox Durable Object methods must return Promises to the Cloudflare host
    const result = await Effect.runPromise(provided.pipe(Effect.result));
    return Result.match(result, {
      onFailure: (error) => {
        // oxlint-disable-next-line scotty/no-try-catch-or-throw -- boundary: Effect failure must reject the Promise required by the Sandbox Durable Object host
        throw error;
      },
      onSuccess: (value) => value,
    });
  }

  private upstreamError(message: string, error: unknown, sessionId?: string): ScottyError {
    const stateError = decodeEvidenceStateError(error);
    console.error(message, {
      sessionId,
      error: errorName(error),
      ...(Option.isSome(stateError) ? { evidenceStateReason: stateError.value.reason } : {}),
    });
    return new ScottyError("upstream", message, {
      httpStatus: 502,
      exitCode: 1,
      hint: "Inspect Worker observability for the redacted upstream failure",
    });
  }
}

Sandbox.outboundByHost = makeOutboundByHost(fetch);
Sandbox.outbound = denyOutbound;

function credentialProxyGrant(
  authority: SessionAuthority,
  metadata: SessionActorMetadata,
  handle: ManagedHandle,
  repository?: string,
): SessionCredentialGrant["grants"][number] | undefined {
  const pinned = metadata.createObservations.credentialGrants;
  if (
    metadata.sessionId !== authority.session.id ||
    metadata.repository !== authority.session.repository ||
    pinned === null ||
    pinned.attempt !== metadata.createAttempt
  )
    return undefined;
  if (
    handle.provider === "github"
      ? repository !== authority.session.repository
      : repository !== undefined
  )
    return undefined;
  const kind = credentialKindForHandle(handle);
  return pinned.grants.find(
    (grant) => grant.kind === kind && credentialGrantHasHandle(grant, handle),
  );
}

function allowsCredentialProxyAccess(authority: SessionAuthority): boolean {
  if (AuthorityStateSchema.guards.Stable(authority.state))
    return !StableStateSchema.guards.Gone(authority.state.stable);
  return !TransitionSchema.guards.Vaporize(authority.state.transition);
}

function isHatchStateError(error: unknown): error is HatchStateError {
  return Predicate.isTagged("HatchStateError")(error);
}

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
