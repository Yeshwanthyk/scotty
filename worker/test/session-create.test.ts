import { assert, describe, it } from "@effect/vitest";
import { Predicate } from "effect";
import { vi } from "vitest";
import type { ExecRuntime, RunnerOperation } from "../../protocol/runner";
import { ScottyError } from "../src/contracts";
import { InitialSessionStorageFailure } from "../src/session-store";
import {
  CREATE_IDEMPOTENCY,
  CREATE_INPUT,
  createSessionHarness,
  injectedHarnessFailure,
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

const isExecRuntime = (operation: RunnerOperation): operation is ExecRuntime =>
  Predicate.isTagged("ExecRuntime")(operation);

describe("Sandbox create orchestration", () => {
  it("boots runner Pican and persists its native session before marking warm", async () => {
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
    const bootstrapIndex = harness.events.findIndex((event) =>
      event.startsWith("runner:dispatch:ExecRuntime:create-bootstrap-"),
    );
    const launchIndex = harness.events.findIndex((event) =>
      event.startsWith("runner:dispatch:ExecRuntime:create-pican-"),
    );
    const readyIndex = harness.events.findIndex((event) => event.endsWith("/api/settings"));
    const nativeCreateIndex = harness.events.findIndex((event) =>
      event.endsWith("/api/new-session"),
    );
    const warmIndex = harness.events.lastIndexOf("record:warm");
    assert.ok(recordIndex >= 0 && ensureIndex > recordIndex);
    assert.ok(ensureIndex < bootstrapIndex);
    assert.ok(bootstrapIndex < launchIndex);
    assert.ok(launchIndex < readyIndex);
    assert.ok(readyIndex < nativeCreateIndex);
    assert.ok(nativeCreateIndex < warmIndex);
    const execs = harness.runnerOperations.filter(isExecRuntime);
    const bootstrap = execs.find((operation) => operation.operationId.includes("bootstrap"));
    assert.ok(bootstrap);
    assert.deepStrictEqual(bootstrap.argv, [
      "/usr/local/bin/scotty-runner-bootstrap",
      SESSION_ID,
      "owner/project",
      `scotty/${SESSION_ID}`,
    ]);
    assert.match(bootstrap.operationId, /^create-bootstrap-/u);
    const launch = execs.find((operation) => operation.operationId.includes("pican"));
    assert.ok(launch);
    assert.deepStrictEqual(launch.argv, [
      "/usr/local/bin/scotty-runner-pican",
      "-host",
      "0.0.0.0",
      "-p",
      "31415",
      "-runtime",
      "codex",
      "-codex-command",
      "/usr/local/bin/codex",
    ]);
    assert.strictEqual(launch.detach, true);
    assert.match(launch.operationId, /^create-pican-/u);
    assert.strictEqual(harness.runnerRequests.length, 2);
    assert.strictEqual(
      harness.runnerRequests[0]?.url,
      `https://runner.internal/_scotty/runner-http/${SESSION_ID}/${encodeURIComponent(
        `runner-v1:${SESSION_ID}`,
      )}/s/${SESSION_ID}/api/settings`,
    );
    assert.strictEqual(harness.runnerRequests[1]?.headers.get("idempotency-key"), SESSION_ID);
    assert.deepStrictEqual(JSON.parse((await harness.runnerRequests[1]?.text()) ?? ""), {
      path: `/workspace/${SESSION_ID}`,
      runtime: "codex",
      initialPrompt: CREATE_INPUT.prompt,
    });
    assert.strictEqual(harness.readRecord()?.codexThreadId, "019d0f55-8d43-7b8c-b63f-f3875b66d03b");
    assert.isFalse(harness.events.some((event) => event.startsWith("host:pican")));
    assert.isFalse(harness.events.some((event) => event.startsWith("credential:")));
    assert.isFalse(harness.events.some((event) => event.startsWith("host:exec")));

    const dispatchCount = harness.runnerOperations.length;
    const replay = await harness.sandbox.createScottySession(
      { ...CREATE_INPUT, provider: "runner", runner: "slumbers" },
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );
    assert.strictEqual(replay.status, "warm");
    assert.strictEqual(harness.runnerOperations.length, dispatchCount);
  });

  it("replays a booting runner create with the same deterministic operation IDs", async () => {
    const nonce = "persisted-runner-create";
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          status: "booting",
          operation: {
            kind: "create",
            nonce,
            startedAt: "2026-01-01T00:00:00.000Z",
            createPhase: "setup",
          },
          provider: "runner",
          runner: "slumbers",
          execution: {
            provider: "runner",
            runner: "slumbers",
            runtimeId: `runner-v1:${SESSION_ID}`,
          },
        }),
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
      },
    });

    const replay = await harness.sandbox.createScottySession(
      { ...CREATE_INPUT, provider: "runner", runner: "slumbers" },
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(replay.status, "warm");
    assert.deepStrictEqual(
      harness.runnerOperations.map((operation) => operation.operationId),
      [`create-${nonce}`, `create-bootstrap-${nonce}`, `create-pican-${nonce}`],
    );
    assert.strictEqual(harness.readRecord()?.codexThreadId, "019d0f55-8d43-7b8c-b63f-f3875b66d03b");
  });

  it("retries runner Pican readiness through the mounted HTTP tunnel", async () => {
    vi.useFakeTimers();
    try {
      let readinessAttempts = 0;
      const harness = await createSessionHarness({
        runnerFetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/api/settings")) {
            readinessAttempts += 1;
            return readinessAttempts === 1
              ? new Response("starting", { status: 503 })
              : Response.json({ ready: true });
          }
          return Response.json({
            id: "pican-session-1",
            nativeId: "codex-thread-1",
            runtime: "codex",
            createState: "created",
            promptDispatchState: "accepted",
          });
        },
      });

      const creating = harness.sandbox.createScottySession(
        { ...CREATE_INPUT, provider: "runner", runner: "slumbers" },
        SESSION_ID,
        CREATE_IDEMPOTENCY,
      );
      await vi.advanceTimersByTimeAsync(0);
      assert.strictEqual(readinessAttempts, 1);
      await vi.advanceTimersByTimeAsync(500);

      assert.strictEqual((await creating).status, "warm");
      assert.strictEqual(readinessAttempts, 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient runner HTTP responses without deleting the runtime", async () => {
    vi.useFakeTimers();
    try {
      let createAttempts = 0;
      const harness = await createSessionHarness({
        runnerFetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/api/settings")) return Response.json({ ready: true });
          createAttempts += 1;
          return createAttempts === 1
            ? new Response("Runner HTTP upstream failed", { status: 502 })
            : Response.json({
                id: "pican-session-1",
                nativeId: "codex-thread-1",
                runtime: "codex",
                createState: "created",
                promptDispatchState: "accepted",
              });
        },
      });

      const creating = harness.sandbox.createScottySession(
        { ...CREATE_INPUT, provider: "runner", runner: "slumbers" },
        SESSION_ID,
        CREATE_IDEMPOTENCY,
      );
      await vi.advanceTimersByTimeAsync(0);
      assert.strictEqual(createAttempts, 1);
      await vi.advanceTimersByTimeAsync(250);

      assert.strictEqual((await creating).status, "warm");
      assert.strictEqual(createAttempts, 2);
      assert.isFalse(
        harness.runnerOperations.some((operation) =>
          Predicate.isTagged("RemoveRuntime")(operation),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
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
    assert.strictEqual(record?.codexThreadId, `pi-${SESSION_ID}`);
    assert.deepStrictEqual(harness.read(sessionHarnessKeys.createIdempotency), CREATE_IDEMPOTENCY);

    const recordIndex = harness.events.indexOf("record:booting");
    const projectionIndex = harness.events.indexOf("projection:booting");
    const hardCapIndex = harness.events.indexOf("schedule:enforceHardCap");
    const warmIndex = harness.events.lastIndexOf("record:warm");
    const warmProjectionIndex = harness.events.lastIndexOf("projection:warm");
    const authIndex = harness.events.indexOf("host:mkdir");
    assert.ok(hardCapIndex >= 0);
    assert.ok(recordIndex >= 0);
    assert.ok(hardCapIndex < recordIndex);
    assert.ok(recordIndex < projectionIndex);
    assert.ok(projectionIndex < authIndex);
    assert.ok(authIndex < warmIndex);
    assert.ok(projectionIndex < warmIndex);
    assert.ok(warmIndex < warmProjectionIndex);
    assert.deepStrictEqual(
      harness.schedules.map((schedule) => schedule.callback),
      ["enforceHardCap"],
    );
    assert.strictEqual(harness.picanStarts.length, 0);
    assert.strictEqual(harness.picanRequests.length, 0);
    assert.deepStrictEqual(
      harness.writtenFiles.find((file) => file.path.endsWith("/.pi-agent/initial-prompt")),
      {
        path: `/workspace/${SESSION_ID}/.pi-agent/initial-prompt`,
        content: CREATE_INPUT.prompt,
      },
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

  it("reconciles a matching booting create through Pi with the same identity and payload", async () => {
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
    assert.strictEqual(replayed.codexThreadId, `pi-${SESSION_ID}`);
    assert.strictEqual(harness.readRecord()?.operation, null);
    assert.strictEqual(harness.picanStarts.length, 0);
    assert.strictEqual(harness.picanRequests.length, 0);
    assert.deepStrictEqual(harness.schedules, []);
    assert.deepStrictEqual(
      harness.writtenFiles.find((file) => file.path.endsWith("/.pi-agent/initial-prompt")),
      {
        path: `/workspace/${SESSION_ID}/.pi-agent/initial-prompt`,
        content: CREATE_INPUT.prompt,
      },
    );
    assert.ok(!harness.commands.some((command) => command.startsWith("gh repo view")));
    assert.ok(!harness.events.includes("credential:put"));
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("replays setup only before advancing durably to the Pi phase", async () => {
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
    assert.strictEqual(harness.picanStarts.length, 0);
    assert.strictEqual(harness.picanRequests.length, 0);
    assert.ok(
      harness.events.lastIndexOf("record:booting") < harness.events.lastIndexOf("record:warm"),
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
    assert.strictEqual(harness.picanStarts.length, 0);
    assert.strictEqual(harness.picanRequests.length, 0);
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("singleflights concurrent matching Pi-phase replays", async () => {
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
    assert.strictEqual(harness.picanStarts.length, 0);
    assert.strictEqual(harness.picanRequests.length, 0);
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
        if (count === 1) throw injectedHarnessFailure("first create failed before authority");
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
    assert.strictEqual(harness.picanStarts.length, 0);
    assert.strictEqual(harness.picanRequests.length, 0);
    assert.ok(!harness.events.includes("host:destroy"));
  });

  for (const failureStage of ["containerAuthSeed"] as const) {
    it(`preserves Pi phase after ${failureStage} uncertainty`, async () => {
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
      assert.strictEqual(error.message, "Pi session creation is ambiguous");
      assert.strictEqual(harness.readRecord()?.status, "booting");
      assert.deepInclude(harness.readRecord()?.operation, {
        kind: "create",
        nonce,
        createPhase: "pican",
      });
      assert.deepStrictEqual(harness.readRecord()?.failure, {
        code: "create_ambiguous",
        message: "Pi session creation is ambiguous",
        recoverable: true,
      });
      assert.ok(!harness.events.includes("host:destroy"));
    });
  }

  it("preserves Pi phase when ready state cannot be persisted", async () => {
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
      transactionFailureCountdown: 1,
    });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.message, "Pi session creation is ambiguous");
    assert.strictEqual(harness.picanRequests.length, 0);
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

  it("does not call the legacy Pican create endpoint", async () => {
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

    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    assert.strictEqual(harness.readRecord()?.status, "warm");
    assert.strictEqual(harness.readRecord()?.operation, null);
    assert.strictEqual(harness.readRecord()?.failure, undefined);
    assert.strictEqual(harness.picanRequests.length, 0);
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("reconciles a matching booting create without consulting Pican state", async () => {
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

    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    assert.strictEqual(harness.readRecord()?.status, "warm");
    assert.strictEqual(harness.readRecord()?.failure, undefined);
    assert.strictEqual(harness.picanRequests.length, 0);
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

  it("does not exercise Pican retries during Pi create", async () => {
    const harness = await createSessionHarness({ failureStage: "picanCreate" });

    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    assert.strictEqual(harness.readRecord()?.status, "warm");
    assert.strictEqual(harness.readRecord()?.failure, undefined);
    assert.strictEqual(harness.picanRequests.length, 0);
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
