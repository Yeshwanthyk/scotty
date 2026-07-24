import { assert, describe, it } from "@effect/vitest";
import { ScottyError } from "../src/contracts";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
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
    assert.deepStrictEqual(harness.read(sessionHarnessKeys.createIdempotency), CREATE_IDEMPOTENCY);

    const recordIndex = harness.events.indexOf("record:booting");
    const projectionIndex = harness.events.indexOf("projection:booting");
    const hardCapIndex = harness.events.indexOf("schedule:enforceHardCap");
    const warmIndex = harness.events.lastIndexOf("record:warm");
    const warmProjectionIndex = harness.events.lastIndexOf("projection:warm");
    const captureIndex = harness.events.indexOf("schedule:captureThreadId");
    assert.ok(hardCapIndex >= 0);
    assert.ok(recordIndex >= 0);
    assert.ok(hardCapIndex < recordIndex);
    assert.ok(recordIndex < projectionIndex);
    assert.ok(projectionIndex < warmIndex);
    assert.ok(warmIndex < warmProjectionIndex);
    assert.ok(warmProjectionIndex < captureIndex);
    assert.deepStrictEqual(
      harness.schedules.map((schedule) => schedule.callback),
      ["enforceHardCap", "captureThreadId"],
    );
    assert.deepStrictEqual(harness.aborts, []);
  });

  it("recovers a committed booting record through the pre-armed hard-cap schedule after a crash", async () => {
    const crashedHarness = await createSessionHarness({
      crashAfterInitialRecordCommit: true,
    });

    const crash = await rejection(
      crashedHarness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(crash instanceof Error);
    assert.strictEqual(crash.message, "simulated DO crash after initial record commit");
    const committed = crashedHarness.readRecord();
    assert.ok(committed);
    assert.strictEqual(committed.status, "booting");
    assert.ok(committed.operation);
    assert.strictEqual(committed.operation.kind, "create");
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
      name: "container auth seed",
      options: { failureStage: "containerAuthSeed" satisfies HarnessFailureStage },
    },
    {
      name: "agent launch",
      options: { failureStage: "agentLaunch" satisfies HarnessFailureStage },
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
