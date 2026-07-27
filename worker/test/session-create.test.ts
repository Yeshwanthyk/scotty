import { assert, describe, it } from "@effect/vitest";
import { ScottyError } from "../src/contracts";
import { InitialSessionStorageFailure } from "../src/session-store";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
  makeStoredCredential,
  type HarnessFailureStage,
  type HarnessOptions,
  SESSION_ID,
  sessionHarnessKeys,
} from "./session-harness";
import { makeSessionRecord } from "./support";

const rejection = (operation: Promise<unknown>): Promise<unknown> =>
  operation.then(
    () => undefined,
    (error: unknown) => error,
  );

const assertUpstreamFailure = async (operation: Promise<unknown>): Promise<void> => {
  const error = await rejection(operation);
  assert.ok(error instanceof ScottyError);
  assert.strictEqual(error.code, "upstream");
};

describe("Sandbox create orchestration", () => {
  it("commits the runner binding before ensuring the deterministic runtime", async () => {
    const harness = await createSessionHarness();
    const created = await harness.sandbox.createScottySession(
      { ...CREATE_INPUT, provider: "runner", runner: "slumbers" },
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(created.status, "warm");
    assert.deepStrictEqual(harness.readRecord()?.execution, {
      provider: "runner",
      runner: "slumbers",
      runtimeId: `runner-v1:${SESSION_ID}`,
    });
    const recordIndex = harness.events.indexOf("record:booting");
    const ensureIndex = harness.events.findIndex((event) =>
      event.startsWith("runner:dispatch:EnsureRuntime:create-"),
    );
    assert.ok(recordIndex >= 0 && ensureIndex > recordIndex);
    assert.isFalse(harness.events.some((event) => event.startsWith("host:pican")));
    assert.isFalse(harness.events.some((event) => event.startsWith("credential:")));
    assert.isFalse(harness.events.some((event) => event.startsWith("host:exec")));
  });

  it("arms the hard cap before committing authority, then projects and reaches warm", async () => {
    const harness = await createSessionHarness();

    const created = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(created.status, "warm");
    const record = harness.readRecord();
    assert.strictEqual(record?.status, "warm");
    assert.strictEqual(record?.operation, null);
    assert.strictEqual(record?.repoExistsAtCreate, true);
    assert.strictEqual(record?.defaultBranch, "main");
    assert.strictEqual(record?.codexThreadId, "019d0f55-8d43-7b8c-b63f-f3875b66d03b");
    assert.deepStrictEqual(harness.read(sessionHarnessKeys.createIdempotency), CREATE_IDEMPOTENCY);

    const recordIndex = harness.events.indexOf("record:booting");
    const projectionIndex = harness.events.indexOf("projection:booting");
    const hardCapIndex = harness.events.indexOf("schedule:enforceHardCap");
    const warmIndex = harness.events.lastIndexOf("record:warm");
    const warmProjectionIndex = harness.events.lastIndexOf("projection:warm");
    const picanStartIndex = harness.events.indexOf("host:pican:start");
    const picanReadyIndex = harness.events.indexOf("host:pican:ready");
    const picanCreateIndex = harness.events.indexOf("host:pican:fetch:31415");
    assert.ok(hardCapIndex >= 0);
    assert.ok(recordIndex >= 0);
    assert.ok(hardCapIndex < recordIndex);
    assert.ok(recordIndex < projectionIndex);
    assert.ok(projectionIndex < picanStartIndex);
    assert.ok(picanStartIndex < picanReadyIndex);
    assert.ok(picanReadyIndex < picanCreateIndex);
    assert.ok(picanCreateIndex < warmIndex);
    assert.ok(projectionIndex < warmIndex);
    assert.ok(warmIndex < warmProjectionIndex);
    assert.deepStrictEqual(
      harness.schedules.map((schedule) => schedule.callback),
      ["enforceHardCap"],
    );
    assert.strictEqual(harness.picanStarts.length, 1);
    assert.strictEqual(harness.picanStarts[0]?.options?.processId, "scotty-pican");
    assert.strictEqual(harness.picanStarts[0]?.options?.env?.PICAN_BASE_PATH, `/s/${SESSION_ID}`);
    assert.strictEqual(harness.picanRequests.length, 1);
    assert.strictEqual(
      harness.picanRequests[0]?.url,
      `http://pican.internal/s/${SESSION_ID}/api/new-session`,
    );
    assert.strictEqual(harness.picanRequests[0]?.headers.get("idempotency-key"), SESSION_ID);
    assert.deepStrictEqual(harness.picanRequests[0]?.body, {
      path: `/workspace/${SESSION_ID}`,
      runtime: "codex",
      initialPrompt: CREATE_INPUT.prompt,
    });
    assert.deepStrictEqual(harness.aborts, []);
  });

  it("recovers a committed booting record through the pre-armed hard-cap schedule after a crash", async () => {
    const crashedHarness = await createSessionHarness({
      crashAfterInitialRecordCommit: true,
    });

    const crash = await rejection(
      crashedHarness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(crash instanceof InitialSessionStorageFailure);
    assert.ok(crash.cause instanceof Error);
    assert.strictEqual(crash.cause.message, "simulated DO crash after initial record commit");
    const committed = crashedHarness.readRecord();
    assert.ok(committed);
    assert.strictEqual(committed.status, "booting");
    assert.ok(committed.operation);
    assert.strictEqual(committed.operation.kind, "create");
    assert.strictEqual(committed.operation.createPhase, "setup");
    const hardCap = crashedHarness.schedules.find(
      (schedule) => schedule.callback === "enforceHardCap",
    );
    assert.ok(hardCap, "hard-cap schedule must be armed before initial record commit");
    assert.ok(
      typeof hardCap.payload === "object" &&
        hardCap.payload !== null &&
        "hardCapAt" in hardCap.payload &&
        typeof hardCap.payload.hardCapAt === "string",
    );
    assert.strictEqual(hardCap.payload.hardCapAt, committed.hardCapAt);

    const reconstructed = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: {
          ...committed,
          operation: {
            ...committed.operation,
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    await reconstructed.sandbox.enforceHardCap({ hardCapAt: hardCap.payload.hardCapAt });

    const failed = reconstructed.readRecord();
    assert.strictEqual(failed?.status, "failed");
    assert.strictEqual(failed?.operation, null);
    assert.deepStrictEqual(failed?.failure, {
      code: "hard_cap_checkpoint_failed",
      message: "A session operation exceeded the hard-cap grace period",
      recoverable: false,
    });
    assert.ok(reconstructed.events.includes("projection:failed"));
    assert.ok(reconstructed.events.includes("host:destroy"));
  });

  it("replays the matching idempotency tuple without touching runtime or schedules", async () => {
    const existing = makeSessionRecord({
      id: SESSION_ID,
      branch: `scotty/${SESSION_ID}`,
    });
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: existing,
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
      },
    });

    const replayed = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(replayed.id, existing.id);
    assert.strictEqual(replayed.status, existing.status);
    assert.deepStrictEqual(harness.readRecord(), existing);
    assert.deepStrictEqual(harness.events, []);
    assert.deepStrictEqual(harness.schedules, []);
  });

  it("reconciles a matching booting create through Pican with the same identity and payload", async () => {
    const nonce = "create-before-do-restart";
    const existing = makeSessionRecord({
      id: SESSION_ID,
      status: "booting",
      operation: {
        kind: "create",
        nonce,
        startedAt: "2026-07-24T12:00:00.000Z",
        createPhase: "pican",
      },
      branch: `scotty/${SESSION_ID}`,
      repoExistsAtCreate: true,
      defaultBranch: "main",
      codexThreadId: undefined,
    });
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: existing,
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      initialPicanRunning: true,
    });

    const replayed = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(replayed.status, "warm");
    assert.strictEqual(replayed.defaultBranch, "main");
    assert.strictEqual(replayed.codexThreadId, "019d0f55-8d43-7b8c-b63f-f3875b66d03b");
    assert.strictEqual(harness.readRecord()?.operation, null);
    assert.strictEqual(harness.picanStarts.length, 0);
    assert.strictEqual(harness.picanRequests.length, 1);
    assert.strictEqual(harness.picanRequests[0]?.headers.get("idempotency-key"), SESSION_ID);
    assert.deepStrictEqual(harness.picanRequests[0]?.body, {
      path: `/workspace/${SESSION_ID}`,
      runtime: "codex",
      initialPrompt: CREATE_INPUT.prompt,
    });
    assert.deepStrictEqual(harness.schedules, []);
    assert.ok(!harness.commands.some((command) => command.startsWith("gh repo view")));
    assert.ok(!harness.events.includes("credential:put"));
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("replays setup only before advancing durably to the Pican phase", async () => {
    const nonce = "create-before-workspace-setup";
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "booting",
          operation: {
            kind: "create",
            nonce,
            startedAt: "2026-07-24T12:00:00.000Z",
            createPhase: "setup",
          },
          branch: `scotty/${SESSION_ID}`,
          codexThreadId: undefined,
        }),
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
      },
    });

    const replayed = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(replayed.status, "warm");
    assert.ok(harness.events.includes("credential:put"));
    assert.ok(harness.events.includes("host:exec:workspace"));
    assert.strictEqual(harness.picanStarts.length, 1);
    assert.strictEqual(harness.picanRequests.length, 1);
    assert.strictEqual(harness.picanRequests[0]?.headers.get("idempotency-key"), SESSION_ID);
    assert.ok(
      harness.events.lastIndexOf("record:booting") <
        harness.events.indexOf("host:pican:fetch:31415"),
    );
  });

  it("singleflights concurrent matching setup replays", async () => {
    const nonce = "concurrent-create-setup";
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "booting",
          operation: {
            kind: "create",
            nonce,
            startedAt: "2026-07-24T12:00:00.000Z",
            createPhase: "setup",
          },
          branch: `scotty/${SESSION_ID}`,
          codexThreadId: undefined,
        }),
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
      },
    });

    const [first, second] = await Promise.all([
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    ]);

    assert.deepStrictEqual(first, second);
    assert.strictEqual(
      harness.commands.filter((command) => command.startsWith("gh repo view")).length,
      1,
    );
    assert.strictEqual(harness.picanStarts.length, 1);
    assert.strictEqual(harness.picanRequests.length, 1);
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("singleflights concurrent matching Pican-phase replays", async () => {
    const nonce = "concurrent-create-pican";
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "booting",
          operation: {
            kind: "create",
            nonce,
            startedAt: "2026-07-24T12:00:00.000Z",
            createPhase: "pican",
          },
          branch: `scotty/${SESSION_ID}`,
          codexThreadId: undefined,
        }),
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });

    const [first, second] = await Promise.all([
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    ]);

    assert.deepStrictEqual(first, second);
    assert.strictEqual(harness.picanStarts.length, 1);
    assert.strictEqual(harness.picanRequests.length, 1);
    assert.ok(!harness.commands.some((command) => command.startsWith("gh repo view")));
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("re-enters the create gate when handing off queued callers", async () => {
    let releaseInspection = (): void => undefined;
    const inspectionRelease = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    let announceInspection = (): void => undefined;
    const inspectionReached = new Promise<void>((resolve) => {
      announceInspection = resolve;
    });
    const harness = await createSessionHarness({
      onStorageGet: async (key, count) => {
        if (key !== sessionHarnessKeys.record) return;
        if (count === 1) throw new Error("first create failed before authority");
        if (count === 2) {
          announceInspection();
          await inspectionRelease;
        }
      },
    });
    const firstIdempotency = {
      keyDigest: "c".repeat(64),
      inputDigest: "d".repeat(64),
    };
    const conflictingIdempotency = {
      keyDigest: CREATE_IDEMPOTENCY.keyDigest,
      inputDigest: "e".repeat(64),
    };

    const first = rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, firstIdempotency),
    );
    const queued = harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );
    await inspectionReached;

    const matching = harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );
    const nonmatching = rejection(
      harness.sandbox.createScottySession(
        { ...CREATE_INPUT, prompt: "Conflicting queued prompt" },
        SESSION_ID,
        conflictingIdempotency,
      ),
    );
    releaseInspection();

    const [firstError, queuedResult, matchingResult, conflictError] = await Promise.all([
      first,
      queued,
      matching,
      nonmatching,
    ]);

    assert.ok(firstError instanceof Error);
    assert.deepStrictEqual(queuedResult, matchingResult);
    assert.ok(conflictError instanceof ScottyError);
    assert.strictEqual(conflictError.code, "conflict");
    assert.deepStrictEqual(
      harness.schedules.map((schedule) => schedule.callback),
      ["enforceHardCap"],
    );
    assert.strictEqual(
      harness.commands.filter((command) => command.startsWith("gh repo view")).length,
      1,
    );
    assert.strictEqual(harness.picanStarts.length, 1);
    assert.strictEqual(harness.picanRequests.length, 1);
    assert.ok(!harness.events.includes("host:destroy"));
  });

  for (const failureStage of ["containerAuthSeed", "picanLaunch"] as const) {
    it(`preserves Pican phase after ${failureStage} uncertainty`, async () => {
      const nonce = `uncertain-${failureStage}`;
      const harness = await createSessionHarness({
        failureStage,
        initialEntries: {
          [sessionHarnessKeys.record]: makeSessionRecord({
            id: SESSION_ID,
            status: "booting",
            operation: {
              kind: "create",
              nonce,
              startedAt: "2026-07-24T12:00:00.000Z",
              createPhase: "pican",
            },
            branch: `scotty/${SESSION_ID}`,
            codexThreadId: undefined,
          }),
          [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
          [sessionHarnessKeys.credential]: makeStoredCredential(),
        },
      });

      const error = await rejection(
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );

      assert.ok(error instanceof ScottyError);
      assert.strictEqual(error.message, "Pican session creation is ambiguous");
      assert.strictEqual(harness.readRecord()?.status, "booting");
      assert.deepInclude(harness.readRecord()?.operation, {
        kind: "create",
        nonce,
        createPhase: "pican",
      });
      assert.deepStrictEqual(harness.readRecord()?.failure, {
        code: "create_ambiguous",
        message: "Pican session creation is ambiguous",
        recoverable: true,
      });
      assert.ok(!harness.events.includes("host:destroy"));
    });
  }

  it("preserves Pican phase when stable native identity cannot be persisted", async () => {
    const nonce = "stable-before-storage-failure";
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "booting",
          operation: {
            kind: "create",
            nonce,
            startedAt: "2026-07-24T12:00:00.000Z",
            createPhase: "pican",
          },
          branch: `scotty/${SESSION_ID}`,
          codexThreadId: undefined,
        }),
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      transactionFailureCountdown: 3,
    });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.message, "Pican session creation is ambiguous");
    assert.strictEqual(harness.picanRequests.length, 1);
    assert.strictEqual(harness.readRecord()?.status, "booting");
    assert.deepInclude(harness.readRecord()?.operation, {
      kind: "create",
      nonce,
      createPhase: "pican",
    });
    assert.strictEqual(harness.readRecord()?.codexThreadId, undefined);
    assert.ok(!harness.events.includes("record:failed"));
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("terminates only an explicit Pican create rejection", async () => {
    const nonce = "explicit-pican-rejection";
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "booting",
          operation: {
            kind: "create",
            nonce,
            startedAt: "2026-07-24T12:00:00.000Z",
            createPhase: "pican",
          },
          branch: `scotty/${SESSION_ID}`,
          codexThreadId: undefined,
        }),
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      initialPicanRunning: true,
      picanCreateResponse: () => new Response(null, { status: 409 }),
    });

    await assertUpstreamFailure(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.strictEqual(harness.readRecord()?.status, "failed");
    assert.strictEqual(harness.readRecord()?.operation, null);
    assert.deepStrictEqual(harness.readRecord()?.failure, {
      code: "create_failed",
      message: "Session setup failed",
      recoverable: false,
    });
    assert.ok(harness.events.includes("host:destroy"));
  });

  it("preserves a matching booting create as recoverable when Pican reports unknown", async () => {
    const nonce = "create-before-unknown-replay";
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "booting",
          operation: {
            kind: "create",
            nonce,
            startedAt: "2026-07-24T12:00:00.000Z",
            createPhase: "pican",
          },
          branch: `scotty/${SESSION_ID}`,
          defaultBranch: "main",
          codexThreadId: undefined,
        }),
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      initialPicanRunning: true,
      picanCreateResponse: () =>
        Response.json(
          {
            id: "pican-session-1",
            nativeId: "019d0f55-8d43-7b8c-b63f-f3875b66d03b",
            runtime: "codex",
            createState: "unknown",
            promptDispatchState: "unknown",
          },
          { status: 503 },
        ),
    });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.message, "Pican session creation is ambiguous");
    assert.deepStrictEqual(harness.readRecord()?.failure, {
      code: "create_ambiguous",
      message: "Pican session creation is ambiguous",
      recoverable: true,
    });
    assert.strictEqual(harness.picanRequests.length, 1);
    assert.strictEqual(harness.picanRequests[0]?.headers.get("idempotency-key"), SESSION_ID);
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("rejects a conflicting existing session before projection or runtime work", async () => {
    const existing = makeSessionRecord({
      id: SESSION_ID,
      branch: `scotty/${SESSION_ID}`,
    });
    const harness = await createSessionHarness({
      initialEntries: { [sessionHarnessKeys.record]: existing },
    });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );
    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "conflict");
    assert.deepStrictEqual(harness.readRecord(), existing);
    assert.deepStrictEqual(harness.events, []);
  });

  it("retries an ambiguous Pican create with the same key and preserves the runtime", async () => {
    const harness = await createSessionHarness({ failureStage: "picanCreate" });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "upstream");
    assert.strictEqual(error.message, "Pican session creation is ambiguous");
    assert.match(error.hint ?? "", /runtime was preserved/u);
    assert.deepStrictEqual(harness.readRecord()?.failure, {
      code: "create_ambiguous",
      message: "Pican session creation is ambiguous",
      recoverable: true,
    });
    assert.strictEqual(harness.picanRequests.length, 3);
    assert.deepStrictEqual(
      harness.picanRequests.map((request) => request.headers.get("idempotency-key")),
      [SESSION_ID, SESSION_ID, SESSION_ID],
    );
    assert.ok(!harness.events.includes("host:destroy"));
  });

  const failureCases = [
    {
      name: "credential seed",
      options: { transactionFailureCountdown: 1 },
    },
    {
      name: "workspace prepare",
      options: { failureStage: "workspacePrepare" satisfies HarnessFailureStage },
    },
    {
      name: "hard-cap schedule",
      options: { failureStage: "hardCapSchedule" satisfies HarnessFailureStage },
    },
  ] satisfies ReadonlyArray<{ readonly name: string; readonly options: HarnessOptions }>;

  for (const testCase of failureCases) {
    it(`persists non-recoverable failed state and destroys after ${testCase.name} failure`, async () => {
      const harness = await createSessionHarness(testCase.options);

      await assertUpstreamFailure(
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );

      const failed = harness.readRecord();
      assert.strictEqual(failed?.status, "failed");
      assert.strictEqual(failed?.operation, null);
      assert.deepStrictEqual(failed?.failure, {
        code: "create_failed",
        message: "Session setup failed",
        recoverable: false,
      });
      assert.ok(harness.events.includes("projection:failed"));
      assert.ok(harness.events.includes("host:destroy"));
      assert.ok(harness.events.indexOf("record:failed") < harness.events.indexOf("host:destroy"));
    });
  }
});
