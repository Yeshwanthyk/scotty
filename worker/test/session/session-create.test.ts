import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";
import {
  commandIntentDigest,
  decodePiConsoleCommandPromise,
  type PiConsoleRelaySnapshot,
} from "../../../protocol/pi-console";
import type { SessionAuthority } from "../../src/session-actor/authority";
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

    const hardCapIndex = harness.events.indexOf("schedule:sessionActorHardCap");
    const firstProviderIndex = harness.events.findIndex((event) =>
      event.startsWith("host:exec:workspace"),
    );
    assert.ok(hardCapIndex >= 0);
    assert.ok(firstProviderIndex >= 0);
    assert.ok(hardCapIndex < firstProviderIndex);
    assert.ok(harness.schedules.some((schedule) => schedule.callback === "sessionActorDeadline"));
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
    assert.strictEqual(read.id, created.id);
    assert.strictEqual(read.repo, created.repo);
    assert.strictEqual(read.status, "warm");

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
