import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  commandIntentDigest,
  decodePiConsoleCommandPromise,
  type PiConsoleRelaySnapshot,
} from "../../../protocol/pi-console";
import { AuthorityStateSchema, type SessionAuthority } from "../../src/session-actor/authority";
import type { LifecycleJournalEvent } from "../../src/session-actor/journal";
import type { SessionActorMetadata } from "../../src/session-actor/metadata";
import { ScottyError } from "../../src/session/contracts";
import { steerPassiveSession } from "../../src/session/passive";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
  SESSION_ID,
  sessionHarnessKeys,
} from "../support/session-harness";

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

const decodeSteerResult = Schema.decodeUnknownPromise(
  Schema.Struct({ id: Schema.String, status: Schema.String }),
);

interface DeadlineSchedulePayload {
  readonly expectedPhase?: unknown;
  readonly revision?: unknown;
}

const relaySnapshot = (): PiConsoleRelaySnapshot => ({
  epoch: `pi-${SESSION_ID}`,
  baseSequence: 0,
  sequence: 0,
  state: { isStreaming: false },
  messages: [],
  overlapEvents: [],
  activeTools: [],
  queue: { steer: [], followUp: [] },
  pendingUi: [],
  pendingUiAuthority: {
    status: "partial",
    reason: "pi_0_83_signal_cancellation_unobservable",
  },
  extensionSurface: { statuses: {}, widgets: [] },
  capabilities: { models: [], thinkingLevels: [], commands: [] },
  truncated: { messages: false, values: false },
});

const createWarmHarness = () =>
  createSessionHarness({
    passivePiConsoleRelay: {
      fetch: async ({ request }) => {
        if (new URL(request.url).pathname.endsWith("/snapshot"))
          return Response.json(relaySnapshot());
        const command = await decodePiConsoleCommandPromise(await request.json());
        return Response.json(
          {
            epoch: command.epoch,
            commandId: command.commandId,
            commandDigest: await commandIntentDigest(command.intent),
            status: "accepted",
            response: { success: true },
          },
          { status: 202 },
        );
      },
    },
  });

describe("Sandbox actor create boundary", () => {
  it("arms the hard cap before provider work and reaches public Warm through actor authority", async () => {
    const harness = await createWarmHarness();

    const created = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(created.id, SESSION_ID);
    assert.strictEqual(created.repo, CREATE_INPUT.repo);
    assert.strictEqual(created.status, "warm");
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(authority);
    assert.strictEqual(authority?.session.id, SESSION_ID);
    assert.isTrue(
      Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Warm"),
    );
    assert.strictEqual(
      harness.read<number>(sessionHarnessKeys.actorRevision),
      harness.read<number>(sessionHarnessKeys.actorJournalSequence),
    );

    const tail = harness.read<LifecycleJournalEvent>(sessionHarnessKeys.actorJournalTail);
    assert.strictEqual(tail?.eventType, "completed");
    assert.strictEqual(tail?.resultCode, "create_transport_verified");
    assert.strictEqual(tail?.revision, authority.revision);

    const diagnostics = await harness.sandbox.getScottyActorDiagnostics();
    assert.strictEqual(diagnostics.authority.revision, authority.revision);
    assert.strictEqual(diagnostics.journalSequence, authority.revision);
    assert.strictEqual(diagnostics.journal.length, diagnostics.journalSequence);
    assert.deepStrictEqual(diagnostics.journal.at(-1), diagnostics.journalTail);
    assert.isFalse(diagnostics.journalTruncated);

    harness.memory.values.set(sessionHarnessKeys.actorJournalTail, {
      ...diagnostics.journalTail,
      resultCode: "mismatched_tail",
    });
    const invalidDiagnostics = await rejection(harness.sandbox.getScottyActorDiagnostics());
    assert.ok(invalidDiagnostics instanceof ScottyError);
    assert.strictEqual(invalidDiagnostics.code, "upstream");

    const hardCapIndex = harness.events.indexOf("schedule:sessionActorHardCap");
    const firstProviderIndex = harness.events.findIndex((event) =>
      event.startsWith("host:exec:workspace"),
    );
    assert.ok(hardCapIndex >= 0);
    assert.ok(firstProviderIndex >= 0);
    assert.ok(hardCapIndex < firstProviderIndex);
    const deadlineSchedules = harness.schedules.filter(
      (schedule) => schedule.callback === "sessionActorDeadline",
    );
    assert.deepStrictEqual(
      deadlineSchedules.map((schedule) => {
        const payload = schedule.payload as DeadlineSchedulePayload;
        return payload.expectedPhase;
      }),
      [
        "IntentCommitted",
        "WorkspacePreparing",
        "RuntimeMaterializing",
        "RuntimeReady",
        "SupervisorStarting",
        "SupervisorReady",
        "TransportVerifying",
      ],
    );
    assert.deepStrictEqual(
      deadlineSchedules.map((schedule) => {
        const payload = schedule.payload as DeadlineSchedulePayload;
        return payload.revision;
      }),
      [1, 2, 3, 4, 5, 6, 7],
    );
    const cloneCommand = harness.commands.find(
      (command) => command.startsWith("rm -rf ") && command.includes(" git -c http.extraHeader="),
    );
    assert.isDefined(cloneCommand);
    assert.include(cloneCommand, btoa("x-access-token:scotty-managed://github/github/git-https"));
    assert.notInclude(cloneCommand, "test-github-token");
    assert.notInclude(cloneCommand, btoa("x-access-token:test-github-token"));
  });

  it("scrubs the private prompt after settlement and journals only safe causal fields", async () => {
    const harness = await createWarmHarness();

    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    const metadata = harness.read<SessionActorMetadata>(sessionHarnessKeys.actorMetadata);
    assert.strictEqual(metadata?.privateCreateInput, null);
    assert.ok(metadata?.createObservations.workspace !== null);
    assert.ok(metadata?.createObservations.credentialGrants !== null);
    assert.notInclude(JSON.stringify(metadata), CREATE_INPUT.prompt);
    assert.notInclude(
      JSON.stringify(harness.read(sessionHarnessKeys.actorJournalTail)),
      CREATE_INPUT.prompt,
    );
  });

  it("serves actor-derived read and steer for a new Warm session", async () => {
    const harness = await createWarmHarness();
    const created = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    const read = await harness.sandbox.getScottySession();
    assert.strictEqual(read.session.identity.id, created.id);
    assert.strictEqual(read.session.display.repository, created.repo);
    assert.deepInclude(read.session.authority, { kind: "stable", lifecycle: "warm" });

    const response = await steerPassiveSession(harness.sandbox, SESSION_ID, "continue");
    assert.strictEqual(response.status, 200);
    const body = await decodeSteerResult(await response.json());
    assert.deepStrictEqual(body, { id: SESSION_ID, status: "accepted" });
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined &&
        Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Warm"),
    );
    assert.deepInclude(authority.state.stable.activity, {
      supervisorEpoch: `pi-${SESSION_ID}`,
      piSequence: 0,
      state: "waiting",
    });
  });

  it("replays matching idempotency without dispatching provider work again", async () => {
    const harness = await createWarmHarness();
    const first = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );
    const providerCalls = harness.events.filter((event) => event.startsWith("host:exec:")).length;
    const scheduleCalls = harness.events.filter((event) => event.startsWith("schedule:")).length;

    const replay = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(replay.id, first.id);
    assert.strictEqual(replay.repo, first.repo);
    assert.strictEqual(replay.status, first.status);
    assert.strictEqual(
      harness.events.filter((event) => event.startsWith("host:exec:")).length,
      providerCalls,
    );
    assert.strictEqual(
      harness.events.filter((event) => event.startsWith("schedule:")).length,
      scheduleCalls,
    );
  });

  it("rejects conflicting idempotency without changing actor authority", async () => {
    const harness = await createWarmHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, {
        ...CREATE_IDEMPOTENCY,
        inputDigest: "c".repeat(64),
      }),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "conflict");
    assert.deepStrictEqual(
      harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority),
      authority,
    );
  });

  it("retains an ambiguous workspace create as reconciling across idempotent replay", async () => {
    const harness = await createSessionHarness({ failureStage: "workspacePrepare" });

    const first = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(first instanceof ScottyError);
    assert.strictEqual(first.code, "upstream");
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined && AuthorityStateSchema.guards.Transitioning(authority.state),
    );
    assert.strictEqual(authority.state.transition.phase, "WorkspacePreparing");
    assert.strictEqual(authority.state.transition.mode, "reconciling");
    const workspaceCalls = harness.events.filter((event) =>
      event.startsWith("host:exec:workspace"),
    ).length;

    const replay = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(replay instanceof ScottyError);
    assert.strictEqual(replay.code, "upstream");
    assert.strictEqual(
      harness.events.filter((event) => event.startsWith("host:exec:workspace")).length,
      workspaceCalls,
    );
  });

  it("rearms reconciliation on create request retry after ambiguous deadline scheduling", async () => {
    const harness = await createSessionHarness({ failureStage: "actorAlarmScheduleOnce" });

    const first = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(first instanceof ScottyError);
    assert.strictEqual(first.code, "upstream");
    const committed = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      committed !== undefined && AuthorityStateSchema.guards.Transitioning(committed.state),
    );
    assert.strictEqual(committed.state.transition.mode, "executing");
    assert.strictEqual(committed.revision, 1);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:exec:workspace")));

    const replay = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(replay instanceof ScottyError);
    assert.strictEqual(replay.code, "upstream");
    const recovering = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      recovering !== undefined && AuthorityStateSchema.guards.Transitioning(recovering.state),
    );
    assert.strictEqual(recovering.state.transition.mode, "reconciling");
    assert.strictEqual(recovering.revision, 2);
    const recoveryAlarm = harness.schedules
      .filter((schedule) => schedule.callback === "sessionActorDeadline")
      .at(-1);
    assert.deepInclude(recoveryAlarm?.payload, { kind: "reconcile", revision: 2 });
    assert.isFalse(harness.events.some((event) => event.startsWith("host:exec:workspace")));
  });

  it("does not recover a lifecycle transition from a create replay", async () => {
    const harness = await createWarmHarness();
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    harness.injectFailure("actorAlarmScheduleOnce");
    await rejection(harness.sandbox.checkpointScottySession());
    const checkpoint = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      checkpoint !== undefined && AuthorityStateSchema.guards.Transitioning(checkpoint.state),
    );
    assert.ok(Predicate.isTagged(checkpoint.state.transition, "Checkpoint"));
    const scheduleCalls = harness.events.filter(
      (event) => event === "schedule:sessionActorDeadline",
    ).length;

    const replay = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(replay instanceof ScottyError);
    assert.strictEqual(replay.code, "upstream");
    const retained = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(retained !== undefined && AuthorityStateSchema.guards.Transitioning(retained.state));
    assert.ok(Predicate.isTagged(retained.state.transition, "Checkpoint"));
    assert.strictEqual(retained.revision, checkpoint.revision);
    assert.strictEqual(
      harness.events.filter((event) => event === "schedule:sessionActorDeadline").length,
      scheduleCalls,
    );
  });

  it.effect("settles an expired reconciling create without reconciling provider success", () =>
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(Date.parse("2026-09-03T00:00:00.000Z"));
      const harness = yield* Effect.promise(() =>
        createSessionHarness({ clock, failureStage: "workspacePrepare" }),
      );
      const first = yield* Effect.promise(() =>
        rejection(
          harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
        ),
      );
      assert.ok(first instanceof ScottyError);
      const reconciling = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(
        reconciling !== undefined && AuthorityStateSchema.guards.Transitioning(reconciling.state),
      );
      assert.strictEqual(reconciling.state.transition.mode, "reconciling");
      const workspaceCalls = harness.events.filter((event) =>
        event.startsWith("host:exec:workspace"),
      ).length;
      yield* clock.setTime(Date.parse(reconciling.state.transition.deadlineAt));

      const replay = yield* Effect.promise(() =>
        rejection(
          harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
        ),
      );

      assert.ok(replay instanceof ScottyError);
      assert.strictEqual(replay.code, "upstream");
      const expired = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
      assert.ok(expired !== undefined && AuthorityStateSchema.guards.Stable(expired.state));
      assert.ok(Predicate.isTagged(expired.state.stable, "Failed"));
      assert.strictEqual(expired.state.stable.code, "transition_deadline_elapsed");
      assert.strictEqual(
        harness.events.filter((event) => event.startsWith("host:exec:workspace")).length,
        workspaceCalls,
      );
    }),
  );

  it("resolves a committed GitHub grant while Create is preparing the workspace", async () => {
    const harness = await createSessionHarness({ failureStage: "workspacePrepare" });

    await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(
      authority !== undefined && AuthorityStateSchema.guards.Transitioning(authority.state),
    );
    assert.strictEqual(authority.state.transition.phase, "WorkspacePreparing");
    assert.strictEqual(
      await harness.sandbox.resolveCredentialForProxy({
        handle: "scotty-managed://github/github/git-https",
        repository: CREATE_INPUT.repo,
      }),
      "test-github-token",
    );
    assert.strictEqual(
      await harness.sandbox.resolveCredentialForProxy({
        handle: "scotty-managed://github/github/git-https",
        repository: "other/project",
      }),
      null,
    );
  });

  it("settles a confirmed workspace failure as Failed", async () => {
    const harness = await createSessionHarness({ failureStage: "workspaceNonzero" });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "upstream");
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.ok(authority !== undefined && AuthorityStateSchema.guards.Stable(authority.state));
    assert.ok(Predicate.isTagged(authority.state.stable, "Failed"));
    assert.strictEqual(authority.state.stable.code, "create_workspace_failed");
  });

  it("preserves the missing-repository public not_found contract and points to --new-repo", async () => {
    const harness = await createSessionHarness({
      repoVerifier: { verify: () => Effect.succeed({ exists: false }) },
    });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "not_found");
    assert.include(error.message, "--new-repo");
    const authority = harness.read<SessionAuthority>(sessionHarnessKeys.actorAuthority);
    assert.isDefined(authority);
    assert.isTrue(
      Predicate.isTagged(authority.state, "Stable") &&
        Predicate.isTagged(authority.state.stable, "Failed"),
    );
    assert.strictEqual(harness.readRecord(), undefined);
  });

  it("uses main for an explicitly created repository", async () => {
    const harness = await createSessionHarness({
      repoVerifier: { verify: () => Effect.succeed({ exists: false }) },
    });

    const created = await harness.sandbox.createScottySession(
      { ...CREATE_INPUT, newRepo: true },
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(created.status, "warm");
    const metadata = harness.read<SessionActorMetadata>(sessionHarnessKeys.actorMetadata);
    assert.strictEqual(metadata?.createObservations.workspace?.repositoryExists, false);
    assert.strictEqual(metadata?.createObservations.workspace?.defaultBranch, "main");
    assert.ok(harness.commands.some((command) => command.startsWith("git init -b main ")));
  });

  it("rejects runner create before reserving actor authority or metadata", async () => {
    const harness = await createSessionHarness();

    const error = await rejection(
      harness.sandbox.createScottySession(
        { ...CREATE_INPUT, provider: "runner", runner: "example-runner" },
        SESSION_ID,
        CREATE_IDEMPOTENCY,
      ),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "bad_request");
    assert.strictEqual(harness.read(sessionHarnessKeys.actorAuthority), undefined);
    assert.strictEqual(harness.read(sessionHarnessKeys.actorMetadata), undefined);
    assert.deepStrictEqual(harness.schedules, []);
  });

  it("does not persist metadata or dispatch provider work when hard-cap arming fails", async () => {
    const harness = await createSessionHarness({ failureStage: "hardCapSchedule" });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "upstream");
    assert.strictEqual(harness.read(sessionHarnessKeys.actorAuthority), undefined);
    assert.strictEqual(harness.read(sessionHarnessKeys.actorMetadata), undefined);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:exec:workspace")));
  });
});
