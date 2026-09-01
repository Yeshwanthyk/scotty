import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Predicate, Result } from "effect";
import { TestClock } from "effect/testing";
import type { CredentialGrant } from "../../../protocol/credentials";
import { sessionRuntimeCredentials } from "../../src/credentials/managed";
import { ContainerAuth } from "../../src/sandbox/auth";
import { SandboxBundleMaterializer } from "../../src/sandbox/bundle-materializer";
import { sandboxRuntimeLayer, type SandboxRuntimeCapabilities } from "../../src/sandbox/runtime";
import type { SessionAuthority, SupervisorProof } from "../../src/session-actor/authority";
import { SessionActorMetadataStore } from "../../src/session-actor/metadata-store";
import type { SessionActorMetadata } from "../../src/session-actor/metadata";
import {
  CreateSandboxBoundary,
  createSandboxBoundaryLayer,
  createSandboxTransitionProviderLayer,
} from "../../src/session-actor/transitions/create-sandbox";
import {
  CreateProviderFailure,
  CreateTransitionProvider,
  type CreateProviderContext,
  type CreateTransition,
} from "../../src/session-actor/transitions/create";
import { sandboxRuntimeCapabilitiesFake } from "../support";

const T0 = "2026-08-31T20:00:00.000Z";
const DEADLINE = "2026-08-31T21:00:00.000Z";
const hardCap = { durationSeconds: 3_600, deadlineAt: DEADLINE, generation: "hard-cap-1" };
const runtimeProof = {
  providerRuntimeId: "runtime-session-create",
  runtimeGeneration: "scotty-runtime-generation-1",
  containerIncarnation: "placement-1",
};
const supervisorProof: SupervisorProof = {
  processId: "scotty-pi-session",
  supervisorEpoch: "epoch-1",
  runtimeGeneration: runtimeProof.runtimeGeneration,
  containerIncarnation: runtimeProof.containerIncarnation,
};
const grants: ReadonlyArray<CredentialGrant> = [
  {
    name: "github",
    kind: "github-cli",
    versionRef: "version-1",
    handleSlots: [{ provider: "github", slot: "git-https" }],
  },
];

const transition = (
  phase: CreateTransition["phase"],
  supervisor: SupervisorProof | null = null,
): CreateTransition => ({
  _tag: "Create",
  nonce: "create-nonce",
  origin: "Absent",
  attempt: "create-attempt",
  phase,
  startedAt: T0,
  lastProgressAt: T0,
  deadlineAt: DEADLINE,
  mode: "executing",
  proof: {
    workspaceId:
      phase === "IntentCommitted" || phase === "WorkspacePreparing" ? null : "workspace-1",
    readiness: {
      runtime:
        phase === "IntentCommitted" ||
        phase === "WorkspacePreparing" ||
        phase === "RuntimeMaterializing"
          ? null
          : runtimeProof,
      supervisor,
      transport: null,
    },
  },
});

const authority = (
  phase: CreateTransition["phase"],
  supervisor: SupervisorProof | null = null,
): SessionAuthority => ({
  session: {
    id: "session-create",
    title: "Create session",
    repository: "owner/disposable",
    execution: { provider: "cloudflare", runtimeName: runtimeProof.providerRuntimeId },
    createdAt: T0,
  },
  hardCap,
  revision: 4,
  state: { _tag: "Transitioning", transition: transition(phase, supervisor) },
});

const context = (
  phase: CreateTransition["phase"],
  supervisor: SupervisorProof | null = null,
): CreateProviderContext => {
  const current = authority(phase, supervisor);
  assert.ok(Predicate.isTagged(current.state, "Transitioning"));
  return {
    authority: current,
    transition: current.state.transition as CreateTransition,
    payload: { reference: "payload-1" },
  };
};

const metadata = (current: SessionAuthority): SessionActorMetadata => ({
  sessionId: current.session.id,
  repository: current.session.repository,
  branch: "scotty/session-create",
  createRepositoryIfMissing: false,
  hardCap: { durationSeconds: 3_600, deadlineAt: DEADLINE, generation: "hard-cap-1" },
  createIdempotency: null,
  createAttempt: "create-attempt",
  privateCreateInput: {
    attempt: "create-attempt",
    payload: { reference: "payload-1" },
    initialPrompt: "Implement the requested change",
  },
  createObservations: { workspace: null, bundle: null, credentialGrants: null },
});

const providerLayer = (
  capabilities: SandboxRuntimeCapabilities,
  authOverrides: Partial<ContainerAuth["Service"]> = {},
  boundaryOverrides: Partial<CreateSandboxBoundary["Service"]> = {},
) => {
  const runtime = sandboxRuntimeLayer(capabilities);
  const baseAuth: ContainerAuth["Service"] = ContainerAuth.of({
    seed: () => Effect.void,
    preflight: () => Effect.void,
    ensureTerminal: () => Effect.void,
    ensurePiSession: () => Effect.void,
    startPiSession: () => Effect.succeed("scotty-pi-session"),
    readPiSessionHealth: () => Effect.succeed({ processId: "scotty-pi-session", epoch: "epoch-1" }),
    verifyPiSessionSnapshot: () =>
      Effect.succeed({ processId: "scotty-pi-session", epoch: "epoch-1" }),
    quiescePiSession: () => Effect.void,
    stopPiSession: () => Effect.void,
    refreshPiAuth: () => Effect.void,
  });
  const auth = Layer.succeed(ContainerAuth)(ContainerAuth.of({ ...baseAuth, ...authOverrides }));
  const bundle = Layer.succeed(SandboxBundleMaterializer)(
    SandboxBundleMaterializer.of({
      materialize: () => Effect.succeed({ digest: null, items: [], bundleRoot: undefined }),
    }),
  );
  const metadataStore = Layer.succeed(SessionActorMetadataStore)(
    SessionActorMetadataStore.of({
      read: (current) => Effect.succeed(metadata(current)),
      inspectCreate: () => Effect.die("unused"),
      admitCreate: () => Effect.die("unused"),
      recordObservation: (_current, observation) =>
        Effect.succeed({
          _tag: "ObservationRecorded",
          metadata: metadata(authority("WorkspacePreparing")),
          observation,
        }),
      scrubSettledCreate: () => Effect.die("unused"),
      deleteForVaporize: () => Effect.die("unused"),
    }),
  );
  const boundary = createSandboxBoundaryLayer({
    resolve: (_current, _transition, payloadReference) =>
      Effect.succeed({
        payloadReference,
        runtimeGeneration: runtimeProof.runtimeGeneration,
        sandboxBundleDigest: null,
        credentials: sessionRuntimeCredentials(grants),
        grants,
      }),
    prepareWorkspace: () =>
      Effect.succeed({
        workspaceId: "workspace-1",
        defaultBranch: "main",
        repositoryExists: true,
      }),
    observeWorkspace: () =>
      Effect.succeed({
        workspaceId: "workspace-1",
        defaultBranch: "main",
        repositoryExists: true,
      }),
    ...boundaryOverrides,
  });
  return createSandboxTransitionProviderLayer.pipe(
    Layer.provide(Layer.mergeAll(runtime, auth, bundle, metadataStore, boundary)),
  );
};

const runProvider = <A, E>(
  capabilities: SandboxRuntimeCapabilities,
  use: (provider: CreateTransitionProvider["Service"]) => Effect.Effect<A, E>,
  authOverrides: Partial<ContainerAuth["Service"]> = {},
  boundaryOverrides: Partial<CreateSandboxBoundary["Service"]> = {},
): Effect.Effect<A, E | CreateProviderFailure> =>
  Effect.flatMap(CreateTransitionProvider, use).pipe(
    Effect.provide(providerLayer(capabilities, authOverrides, boundaryOverrides)),
  );

describe("Cloudflare create transition provider", () => {
  it.effect("uses public runtime state and placement with the Scotty-owned generation", () =>
    Effect.gen(function* () {
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        getState: () => Promise.resolve({ status: "running", lastChange: 1 }),
        getContainerPlacementId: () => Promise.resolve("placement-1"),
      };
      const result = yield* runProvider(capabilities, (provider) =>
        provider.confirmRuntimeReady(context("RuntimeReady")),
      );

      assert.ok(Predicate.isTagged(result, "RuntimeReadyConfirmed"));
      assert.deepStrictEqual(result.runtime, runtimeProof);
    }),
  );

  it.effect("splits supervisor admission from health and transport readiness", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        getState: () => Promise.resolve({ status: "running", lastChange: 1 }),
        getContainerPlacementId: () => Promise.resolve("placement-1"),
      };
      const authOverrides: Partial<ContainerAuth["Service"]> = {
        startPiSession: () => {
          calls.push("start");
          return Effect.succeed("scotty-pi-session");
        },
        readPiSessionHealth: () => {
          calls.push("health");
          return Effect.succeed({ processId: "scotty-pi-session", epoch: "epoch-1" });
        },
        verifyPiSessionSnapshot: (_id, expectedEpoch) => {
          calls.push(`snapshot:${expectedEpoch}`);
          return Effect.succeed({ processId: "scotty-pi-session", epoch: "epoch-1" });
        },
      };

      const started = yield* runProvider(
        capabilities,
        (provider) => provider.startSupervisor(context("SupervisorStarting")),
        authOverrides,
      );
      assert.deepStrictEqual(calls, ["start"]);
      assert.ok(Predicate.isTagged(started, "SupervisorStarted"));
      assert.strictEqual(started.processId, "scotty-pi-session");

      const ready = yield* runProvider(
        capabilities,
        (provider) => provider.confirmSupervisorReady(context("SupervisorReady")),
        authOverrides,
      );
      assert.deepStrictEqual(calls, ["start", "health"]);
      assert.ok(Predicate.isTagged(ready, "SupervisorReadyConfirmed"));
      assert.deepStrictEqual(ready.supervisor, supervisorProof);

      const transport = yield* runProvider(
        capabilities,
        (provider) => provider.verifyTransport(context("TransportVerifying", supervisorProof)),
        authOverrides,
      );
      assert.deepStrictEqual(calls, ["start", "health", "snapshot:epoch-1"]);
      assert.ok(Predicate.isTagged(transport, "TransportVerified"));
      assert.strictEqual(transport.transport.supervisorEpoch, "epoch-1");
      assert.strictEqual(transport.transport.runtimeGeneration, runtimeProof.runtimeGeneration);
      assert.strictEqual(transport.transport.containerIncarnation, "placement-1");
    }),
  );

  it.effect("reports a rejected state read as unknown without inventing readiness", () =>
    Effect.gen(function* () {
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        getState: () => Promise.reject(new Error("provider response lost")),
        getContainerPlacementId: () => Promise.resolve("placement-1"),
      };
      const result = yield* Effect.result(
        runProvider(capabilities, (provider) =>
          provider.confirmRuntimeReady(context("RuntimeReady")),
        ),
      );

      assert.ok(Result.isFailure(result));
      assert.strictEqual(result.failure.outcome, "unknown_after_admission");
      assert.strictEqual(result.failure.safeResultCode, "create_runtime_state_unknown");
    }),
  );

  it.effect("reconciles workspace by observation without redispatching preparation", () =>
    Effect.gen(function* () {
      let prepareCalls = 0;
      let observeCalls = 0;
      const capabilities = sandboxRuntimeCapabilitiesFake();
      const result = yield* runProvider(
        capabilities,
        (provider) => provider.reconcile(context("WorkspacePreparing")),
        {},
        {
          prepareWorkspace: () => {
            prepareCalls += 1;
            return Effect.die("must not redispatch");
          },
          observeWorkspace: () => {
            observeCalls += 1;
            return Effect.succeed({
              workspaceId: "workspace-1",
              defaultBranch: "main",
              repositoryExists: true,
            });
          },
        },
      );

      assert.ok(Predicate.isTagged(result, "WorkspacePrepared"));
      assert.strictEqual(prepareCalls, 0);
      assert.strictEqual(observeCalls, 1);
    }),
  );

  it.effect(
    "reconciles a lost materialization response only from the exact completion marker",
    () =>
      Effect.gen(function* () {
        let marker = "";
        let seedCalls = 0;
        let preflightCalls = 0;
        const capabilities: SandboxRuntimeCapabilities = {
          ...sandboxRuntimeCapabilitiesFake(),
          getState: () => Promise.resolve({ status: "running", lastChange: 1 }),
          getContainerPlacementId: () => Promise.resolve("placement-1"),
          writeFile: (_path, content) => {
            if (typeof content === "string") marker = content;
            return Promise.resolve();
          },
          readFileStream: () =>
            Promise.resolve(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(marker));
                  controller.close();
                },
              }),
            ),
        };
        const authOverrides: Partial<ContainerAuth["Service"]> = {
          seed: () => {
            seedCalls += 1;
            return Effect.void;
          },
          preflight: () => {
            preflightCalls += 1;
            return Effect.void;
          },
        };

        yield* runProvider(
          capabilities,
          (provider) => provider.materializeRuntime(context("RuntimeMaterializing")),
          authOverrides,
        );
        assert.strictEqual(seedCalls, 1);
        assert.strictEqual(preflightCalls, 1);
        assert.include(marker, '"attempt":"create-attempt"');
        assert.include(marker, '"containerIncarnation":"placement-1"');

        const reconciled = yield* runProvider(
          capabilities,
          (provider) => provider.reconcile(context("RuntimeMaterializing")),
          authOverrides,
        );
        assert.ok(Predicate.isTagged(reconciled, "RuntimeMaterialized"));
        assert.deepStrictEqual(reconciled.runtime, runtimeProof);
        assert.strictEqual(seedCalls, 1);
        assert.strictEqual(preflightCalls, 1);
      }),
  );

  it.effect("keeps materialization unknown when the marker belongs to another placement", () =>
    Effect.gen(function* () {
      const marker = `${JSON.stringify({
        attempt: "create-attempt",
        payloadReference: "payload-1",
        bundleDigest: null,
        runtimeGeneration: runtimeProof.runtimeGeneration,
        providerRuntimeId: runtimeProof.providerRuntimeId,
        containerIncarnation: "replaced-placement",
      })}\n`;
      const capabilities: SandboxRuntimeCapabilities = {
        ...sandboxRuntimeCapabilitiesFake(),
        getState: () => Promise.resolve({ status: "running", lastChange: 1 }),
        getContainerPlacementId: () => Promise.resolve("placement-1"),
        readFileStream: () =>
          Promise.resolve(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(marker));
                controller.close();
              },
            }),
          ),
      };
      const result = yield* Effect.result(
        runProvider(capabilities, (provider) =>
          provider.reconcile(context("RuntimeMaterializing")),
        ),
      );

      assert.ok(Result.isFailure(result));
      assert.strictEqual(result.failure.outcome, "unknown_after_admission");
      assert.strictEqual(
        result.failure.safeResultCode,
        "create_runtime_materialization_runtime_mismatch",
      );
    }),
  );

  it.effect("maps a local post-admission timeout to an unknown provider outcome", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(T0));
      const capabilities = sandboxRuntimeCapabilitiesFake();
      const fiber = yield* runProvider(
        capabilities,
        (provider) => provider.startSupervisor(context("SupervisorStarting")),
        { startPiSession: () => Effect.never },
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 hour");
      const result = yield* Effect.result(Fiber.join(fiber));

      assert.ok(Result.isFailure(result));
      assert.strictEqual(result.failure.outcome, "unknown_after_admission");
      assert.strictEqual(result.failure.safeResultCode, "create_supervisor_start_timeout");
    }),
  );
});
