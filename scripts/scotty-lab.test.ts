import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Predicate, Result, Schema } from "effect";
import packageMetadata from "../package.json" with { type: "json" };
import { CanonicalConversationSnapshotSchema } from "../protocol/session/conversation.ts";
import {
  AuthorityStateSchema,
  SessionAuthoritySchema,
  StableStateSchema,
} from "../worker/src/session-actor/authority.ts";
import { uiSessionResponseFromActor } from "../worker/src/ui/session-view.ts";
import capturedFailureStates from "./fixtures/codex-failure-states.json" with { type: "json" };
import {
  LAB_VERSION,
  LabOperations,
  LabUsageError,
  codexCheckpointProof,
  codexTerminalProof,
  hatchObservationProof,
  internalPeerReadValidator,
  runLab,
  waitForCapturedChild,
} from "./scotty-lab.ts";

const RUN_ID = "lab-12345678-1234-4123-8123-123456789abc";

const CapturedFailureStatesSchema = Schema.Struct({
  fixtureVersion: Schema.Literal(1),
  cases: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["warm-host-dead", "failed-sleep-no-backup"]),
      source: Schema.Struct({
        snapshotFileCapturedAt: Schema.String,
        actorFileCapturedAt: Schema.String,
        nativeObservationAt: Schema.Null,
        snapshotAuthority: Schema.Literals(["captured-current", "last-observed"]),
        nativeEventCaptured: Schema.Literal(false),
      }),
      canonical: CanonicalConversationSnapshotSchema,
      actor: Schema.Struct({
        authority: SessionAuthoritySchema,
        revision: Schema.Int,
        journalSequence: Schema.Int,
        tail: Schema.Struct({ eventType: Schema.String, resultCode: Schema.NullOr(Schema.String) }),
      }),
    }),
  ),
});
const decodeCapturedFailureStates = Schema.decodeUnknownResult(CapturedFailureStatesSchema);
const capturedStates = decodeCapturedFailureStates(capturedFailureStates);

const run = (args: ReadonlyArray<string>, calls: string[]): Effect.Effect<void, unknown> =>
  runLab(args).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide(
      Layer.succeed(LabOperations, {
        start: Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
        setup: (runId, repo) =>
          Effect.sync(() => calls.push(`setup:${runId}:${repo}`)).pipe(Effect.asVoid),
        exec: (runId, argv) =>
          Effect.sync(() => calls.push(`exec:${runId}:${JSON.stringify(argv)}`)).pipe(
            Effect.asVoid,
          ),
        stop: (runId) => Effect.sync(() => calls.push(`stop:${runId}`)).pipe(Effect.asVoid),
        createAndReady: (repo, fault) =>
          Effect.sync(() => calls.push(`create-and-ready:${repo}:${fault ?? "none"}`)).pipe(
            Effect.asVoid,
          ),
        checkpoint: (sessionId, fault) =>
          Effect.sync(() => calls.push(`checkpoint:${sessionId}:${fault ?? "none"}`)).pipe(
            Effect.asVoid,
          ),
        sleepResume: (sessionId, fault) =>
          Effect.sync(() => calls.push(`sleep-resume:${sessionId}:${fault ?? "none"}`)).pipe(
            Effect.asVoid,
          ),
        hatchObserve: (sessionId, turnId, expectation) =>
          Effect.sync(() => calls.push(`hatch-observe:${sessionId}:${turnId}:${expectation}`)).pipe(
            Effect.asVoid,
          ),
        runtimeLoss: (sessionId, fault) =>
          Effect.sync(() => calls.push(`runtime-loss:${sessionId}:${fault ?? "none"}`)),
        hardCap: (sessionId, fault) =>
          Effect.sync(() => calls.push(`hard-cap:${sessionId}:${fault ?? "none"}`)),
        vaporize: (sessionId, fault) =>
          Effect.sync(() => calls.push(`vaporize:${sessionId}:${fault ?? "none"}`)).pipe(
            Effect.asVoid,
          ),
        codexWorkflow: (repo, fault) =>
          Effect.sync(() => calls.push(`codex-workflow:${repo}:${fault ?? "none"}`)).pipe(
            Effect.asVoid,
          ),
        full: (repo, fault) => Effect.sync(() => calls.push(`full:${repo}:${fault ?? "none"}`)),
      }),
    ),
  );

const assertUsageFailure = (result: Result.Result<void, unknown>): void => {
  assert.ok(Result.isFailure(result));
  assert.ok(Predicate.isTagged(result.failure, "LabUsageError"));
  assert.deepEqual(
    result.failure,
    new LabUsageError({
      message:
        "Usage: npm run lab -- start | setup RUN_ID --repo OWNER/REPO | exec RUN_ID -- <scotty argv> | stop RUN_ID | lifecycle <scenario>",
    }),
  );
};

describe("Effect Scotty lab command grammar", () => {
  it("validates full peer CLI responses and emits a bounded receipt", () => {
    const peerId = "a0b1c2d3e4f5";
    const directory = mkdtempSync(join(tmpdir(), "scotty-peer-read-"));
    const cliPath = join(directory, "scotty");
    const inspectPath = join(directory, "inspect.json");
    const readPath = join(directory, "read.json");
    const inspect = {
      id: peerId,
      transport: { epoch: "generation-1" },
      turns: [
        {
          id: "turn-1",
          user: "SCOTTY_LAB_PEER_INITIAL",
          state: "completed",
          assistant: "SCOTTY_LAB_PEER_READY",
        },
      ],
    };
    const read = {
      id: peerId,
      epoch: "generation-1",
      sequence: 3,
      messages: [{ role: "assistant", content: "SCOTTY_LAB_PEER_READY" }],
    };
    const validate = () =>
      spawnSync(process.execPath, ["-e", internalPeerReadValidator(peerId)], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          SCOTTY_TEST_INSPECT: inspectPath,
          SCOTTY_TEST_READ: readPath,
        },
      });
    try {
      writeFileSync(
        cliPath,
        [
          `#!${process.execPath}`,
          'const fs=require("fs")',
          `const expected="${peerId}"`,
          "const [command,id,format]=process.argv.slice(2)",
          'if(id!==expected||format!=="--json"||!(["inspect","read"].includes(command)))process.exit(2)',
          'process.stdout.write(fs.readFileSync(process.env[command==="inspect"?"SCOTTY_TEST_INSPECT":"SCOTTY_TEST_READ"],"utf8"))',
        ].join("\n"),
        { mode: 0o700 },
      );
      writeFileSync(inspectPath, JSON.stringify(inspect));
      writeFileSync(readPath, JSON.stringify(read));
      const valid = validate();
      assert.equal(valid.status, 0);
      assert.deepEqual(JSON.parse(valid.stdout), {
        id: peerId,
        epoch: "generation-1",
        initialTurnId: "turn-1",
        readSequence: 3,
      });
      assert.isBelow(Buffer.byteLength(valid.stdout), 1200);

      writeFileSync(readPath, JSON.stringify({ ...read, epoch: "wrong-generation" }));
      const invalid = validate();
      assert.notEqual(invalid.status, 0);
      assert.equal(invalid.stdout, "");

      writeFileSync(readPath, JSON.stringify({ ...read, messages: [] }));
      const missingInitialReply = validate();
      assert.notEqual(missingInitialReply.status, 0);
      assert.equal(missingInitialReply.stdout, "");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("requires a fresh confirmed checkpoint backup tied to a completed journal attempt", () => {
    assert.ok(Result.isSuccess(capturedStates));
    const captured = capturedStates.success.cases.find(({ kind }) => kind === "warm-host-dead");
    assert.isDefined(captured);
    const state = captured.actor.authority.state;
    assert.ok(AuthorityStateSchema.guards.Stable(state));
    assert.ok(StableStateSchema.guards.Warm(state.stable));
    const before = { authority: captured.actor.authority, journalSequence: 100, journal: [] };
    const backup = {
      backupId: "checkpoint-attempt",
      preparedAt: "2026-09-14T00:00:00.000Z",
      confirmedAt: "2026-09-14T00:00:01.000Z",
      sourceRuntimeGeneration: state.stable.readiness.runtime.runtimeGeneration,
      codex: {
        threadId: state.stable.readiness.supervisor.supervisorEpoch,
        initialTurnId: state.stable.readiness.transport.transportId,
      },
    };
    const completed = {
      sequence: 101,
      revision: captured.actor.authority.revision + 1,
      timestamp: "2026-09-14T00:00:02.000Z",
      correlationId: "checkpoint-test",
      transitionNonce: "checkpoint-nonce",
      eventType: "completed" as const,
      transitionKind: "Checkpoint" as const,
      transitionPhase: "TransportReady" as const,
      resultCode: "checkpoint_completed",
      causeSequence: 100,
      causeAttempt: backup.backupId,
    };
    const after = {
      authority: {
        ...captured.actor.authority,
        state: {
          ...state,
          stable: {
            ...state.stable,
            backups: {
              ownedBackupIds: [backup.backupId],
              prepared: backup,
              currentBackupId: backup.backupId,
              confirmed: backup,
            },
          },
        },
      },
      journalSequence: 101,
      journal: [completed],
    };
    assert.deepEqual(codexCheckpointProof(before, after), {
      backupId: backup.backupId,
      threadId: backup.codex.threadId,
    });
    assert.isUndefined(codexCheckpointProof(before, before));
    assert.isUndefined(codexCheckpointProof(after, after));
    assert.isUndefined(codexCheckpointProof(before, { ...after, journal: [] }));
    assert.isUndefined(
      codexCheckpointProof(before, {
        ...after,
        authority: {
          ...after.authority,
          state: {
            ...after.authority.state,
            stable: {
              ...after.authority.state.stable,
              readiness: {
                ...after.authority.state.stable.readiness,
                supervisor: {
                  ...after.authority.state.stable.readiness.supervisor,
                  supervisorEpoch: "wrong-thread",
                },
              },
            },
          },
        },
      }),
    );
  });

  it("projects captured Warm actor with a stopped Codex host", () => {
    assert.ok(Result.isSuccess(capturedStates));
    assert.equal(capturedStates.success.cases.length, 2);
    const observed = capturedStates.success.cases.find(({ kind }) => kind === "warm-host-dead");
    assert.isDefined(observed);
    assert.equal(observed.source.snapshotAuthority, "captured-current");
    assert.isNull(observed.source.nativeObservationAt);
    assert.isFalse(observed.source.nativeEventCaptured);
    assert.isTrue(observed.canonical.runtimeStopped);
    assert.isFalse(observed.canonical.followUpAvailable);
    assert.equal(
      observed.canonical.turns.at(-1)?.activitySummary,
      "Runtime failure: stale_notification",
    );
    const ui = uiSessionResponseFromActor(
      observed.actor.authority,
      undefined,
      Date.parse(observed.source.actorFileCapturedAt),
    );
    assert.deepEqual(ui.session.authority, {
      kind: "stable",
      lifecycle: "warm",
      failure: null,
    });
    assert.isTrue(ui.session.capabilities.vaporize);
  });

  it("projects captured Failed sleep without a backup from last-observed Codex state", () => {
    assert.ok(Result.isSuccess(capturedStates));
    const observed = capturedStates.success.cases.find(
      ({ kind }) => kind === "failed-sleep-no-backup",
    );
    assert.isDefined(observed);
    assert.equal(observed.source.snapshotAuthority, "last-observed");
    assert.isNull(observed.source.nativeObservationAt);
    assert.isFalse(observed.source.nativeEventCaptured);
    assert.isTrue(observed.canonical.runtimeStopped);
    assert.isFalse(observed.canonical.followUpAvailable);
    assert.equal(
      observed.canonical.turns.at(-1)?.activitySummary,
      "Runtime failure: stale_notification",
    );
    const ui = uiSessionResponseFromActor(
      observed.actor.authority,
      undefined,
      Date.parse(observed.source.actorFileCapturedAt),
    );
    assert.deepEqual(ui.session.authority, {
      kind: "stable",
      lifecycle: "failed",
      failure: { code: "reconciliation_outcome_unknown", recoverable: false },
    });
    assert.isFalse(ui.session.capabilities.resume);
    assert.isTrue(ui.session.capabilities.vaporize);
  });

  it("requires a healthy matching Codex command and reply", () => {
    const snapshot = {
      id: "a0b1c2d3e4f5",
      version: 1 as const,
      runtimeStopped: false,
      followUpAvailable: true,
      transport: { epoch: "epoch", baseSequence: 0, sequence: 1, sessionRevision: 1 },
      turns: [
        {
          id: "turn-1",
          state: "completed" as const,
          user: "Run the command",
          assistant: "SCOTTY_LAB_CODEX_READY",
          tools: [
            {
              id: "tool-1",
              state: "completed" as const,
              label: "Command",
              invocation: "printf SCOTTY_LAB_CODEX_INITIAL",
              output: "SCOTTY_LAB_CODEX_INITIAL",
            },
          ],
        },
      ],
      queue: { steer: [], followUp: [] },
      truncated: { turns: false, values: false },
    };
    assert.deepEqual(
      codexTerminalProof(snapshot, undefined, "SCOTTY_LAB_CODEX_INITIAL", "SCOTTY_LAB_CODEX_READY"),
      { status: "passed", turnId: "turn-1" },
    );
    assert.deepEqual(
      codexTerminalProof(
        snapshot,
        "other-turn",
        "SCOTTY_LAB_CODEX_INITIAL",
        "SCOTTY_LAB_CODEX_READY",
      ),
      { status: "pending" },
    );
    assert.deepEqual(
      codexTerminalProof(snapshot, "turn-1", "UNRUN_COMMAND", "SCOTTY_LAB_CODEX_READY"),
      { status: "failed", reason: "Codex terminal lacks the requested command or reply" },
    );
    assert.deepEqual(
      codexTerminalProof(
        {
          ...snapshot,
          turns: [
            {
              ...snapshot.turns[0],
              tools: [
                { ...snapshot.turns[0].tools[0], invocation: "echo SCOTTY_LAB_CODEX_INITIAL" },
              ],
            },
          ],
        },
        "turn-1",
        "SCOTTY_LAB_CODEX_INITIAL",
        "SCOTTY_LAB_CODEX_READY",
      ),
      { status: "failed", reason: "Codex terminal lacks the requested command or reply" },
    );
    assert.deepEqual(
      codexTerminalProof(
        {
          ...snapshot,
          turns: [
            { ...snapshot.turns[0], state: "aborted", assistant: "", tools: [] },
            {
              ...snapshot.turns[0],
              id: "queued-turn",
              user: "Run printf SCOTTY_LAB_CODEX_QUEUED once",
              assistant: "SCOTTY_LAB_CODEX_QUEUE_DONE",
              tools: [
                {
                  ...snapshot.turns[0].tools[0],
                  invocation: "printf SCOTTY_LAB_CODEX_QUEUED",
                  output: "SCOTTY_LAB_CODEX_QUEUED",
                },
              ],
            },
          ],
        },
        undefined,
        "SCOTTY_LAB_CODEX_QUEUED",
        "SCOTTY_LAB_CODEX_QUEUE_DONE",
        "SCOTTY_LAB_CODEX_QUEUED",
      ),
      { status: "passed", turnId: "queued-turn" },
    );
    assert.deepEqual(
      codexTerminalProof(
        { ...snapshot, runtimeStopped: true },
        "turn-1",
        "SCOTTY_LAB_CODEX_INITIAL",
        "SCOTTY_LAB_CODEX_READY",
      ),
      { status: "failed", reason: "Codex runtime stopped or health was unavailable" },
    );
    assert.deepEqual(
      codexTerminalProof(
        {
          ...snapshot,
          runtimeStopped: true,
          turns: [
            {
              ...snapshot.turns[0],
              state: "failed",
              activitySummary:
                "Runtime failure: stale_notification (item/started parent completed subAgentActivity)",
            },
          ],
        },
        "turn-1",
        "SCOTTY_LAB_CODEX_INITIAL",
        "SCOTTY_LAB_CODEX_READY",
      ),
      {
        status: "failed",
        reason:
          "Runtime failure: stale_notification (item/started parent completed subAgentActivity)",
      },
    );
  });

  it("requires an exact native Hatch receipt and matching public status", () => {
    const snapshot = {
      id: "a0b1c2d3e4f5",
      version: 1 as const,
      runtimeStopped: false,
      followUpAvailable: true,
      transport: { epoch: "epoch", baseSequence: 0, sequence: 1, sessionRevision: 1 },
      turns: [
        {
          id: "hatch-turn",
          state: "completed" as const,
          user: "Please check Hatch",
          assistant: "It is ready",
          tools: [
            {
              id: "hatch-tool",
              state: "completed" as const,
              label: "Hatch",
              invocation: "Hatch",
              output: "Hatch ensure: running.\nLocal process: running.\nscotty-hatch:hatch-1",
            },
          ],
        },
      ],
      queue: { steer: [], followUp: [] },
      truncated: { turns: false, values: false },
    };
    const ready = {
      status: "configured" as const,
      hatchId: "hatch-1",
      generation: 1,
      service: { name: "fixture", port: 4_321 },
      desiredStatus: "open" as const,
      observedStatus: "running" as const,
      exposure: "active" as const,
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:01.000Z",
      lastHealthyAt: "2026-09-13T00:00:01.000Z",
    };
    assert.deepEqual(hatchObservationProof(snapshot, ready, "hatch-turn", "ready"), {
      status: "passed",
      hatchId: "hatch-1",
    });
    const ensureThenStatus = {
      ...snapshot,
      turns: [
        {
          ...snapshot.turns[0],
          tools: [
            snapshot.turns[0].tools[0],
            {
              ...snapshot.turns[0].tools[0],
              id: "hatch-status-tool",
              output: "Hatch status: running.\nLocal process: running.\nscotty-hatch:hatch-1",
            },
          ],
        },
      ],
    };
    assert.deepEqual(hatchObservationProof(ensureThenStatus, ready, "hatch-turn", "ready"), {
      status: "passed",
      hatchId: "hatch-1",
    });
    assert.equal(
      hatchObservationProof(
        {
          ...ensureThenStatus,
          turns: [
            {
              ...ensureThenStatus.turns[0],
              tools: [
                ensureThenStatus.turns[0].tools[0],
                {
                  ...ensureThenStatus.turns[0].tools[1],
                  output: "Hatch status: running.\nLocal process: running.\nscotty-hatch:stale",
                },
              ],
            },
          ],
        },
        ready,
        "hatch-turn",
        "ready",
      ).status,
      "failed",
    );
    assert.deepEqual(hatchObservationProof(snapshot, ready, "other-turn", "ready"), {
      status: "failed",
      reason: "Hatch turn is missing or incomplete",
    });
    assert.equal(
      hatchObservationProof(snapshot, { ...ready, lastHealthyAt: undefined }, "hatch-turn", "ready")
        .status,
      "failed",
    );
    assert.equal(
      hatchObservationProof(
        { ...snapshot, turns: [{ ...snapshot.turns[0], tools: [] }] },
        ready,
        "hatch-turn",
        "ready",
      ).status,
      "failed",
    );
    assert.equal(
      hatchObservationProof(
        {
          ...snapshot,
          turns: [
            {
              ...snapshot.turns[0],
              tools: [{ ...snapshot.turns[0].tools[0], state: "failed" as const }],
            },
          ],
        },
        ready,
        "hatch-turn",
        "ready",
      ).status,
      "failed",
    );
    const failed = {
      ...snapshot,
      turns: [
        {
          ...snapshot.turns[0],
          tools: [
            {
              ...snapshot.turns[0].tools[0],
              state: "failed" as const,
              output: "Hatch failed (registration_unconfirmed): registration was not confirmed",
            },
          ],
        },
      ],
    };
    assert.deepEqual(
      hatchObservationProof(
        failed,
        { status: "not_configured", startupFailure: "registration_unconfirmed" },
        "hatch-turn",
        "startup-failed",
      ),
      {
        status: "passed",
        startupFailure: "registration_unconfirmed",
      },
    );
    assert.equal(
      hatchObservationProof(
        failed,
        { status: "not_configured", startupFailure: "invalid_config" },
        "hatch-turn",
        "startup-failed",
      ).status,
      "failed",
    );
  });

  it("uses the package version", () => {
    assert.strictEqual(LAB_VERSION, packageMetadata.version);
  });

  it.effect("runs exactly start, exec, and stop", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* run(["start"], calls);
      yield* run(["setup", RUN_ID, "--repo", "owner/repo"], calls);
      yield* run(["exec", RUN_ID, "--", "doctor", "--json"], calls);
      yield* run(["stop", RUN_ID], calls);
      assert.deepEqual(calls, [
        "start",
        `setup:${RUN_ID}:owner/repo`,
        `exec:${RUN_ID}:["doctor","--json"]`,
        `stop:${RUN_ID}`,
      ]);
    }),
  );

  it.effect("dispatches the explicit Codex workflow scenario", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* run(["lifecycle", "codex-workflow", "--repo", "owner/repo"], calls);
      assert.deepEqual(calls, ["codex-workflow:owner/repo:none"]);
    }),
  );

  it.effect("forwards the complete read invocation to the production CLI", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* run(
        [
          "exec",
          RUN_ID,
          "--",
          "read",
          "session-1",
          "--last",
          "5",
          "--role",
          "assistant",
          "--since",
          "12",
          "--follow",
          "--json",
        ],
        calls,
      );
      assert.deepEqual(calls, [
        `exec:${RUN_ID}:["read","session-1","--last","5","--role","assistant","--since","12","--follow","--json"]`,
      ]);
    }),
  );

  it.effect("requires the exec separator and at least one forwarded argument", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      assertUsageFailure(yield* Effect.result(run(["exec", RUN_ID, "doctor"], calls)));
      assertUsageFailure(yield* Effect.result(run(["exec", RUN_ID, "--"], calls)));
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("rejects the protected session before invoking any lab operation", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      for (const args of [
        ["exec", RUN_ID, "--", "resume", "6ffa0a512819", "--json"],
        ["lifecycle", "checkpoint", "--session", "6ffa0a512819"],
        [
          "lifecycle",
          "hatch-observe",
          "--session",
          "6ffa0a512819",
          "--turn",
          "turn-1",
          "--expect",
          "ready",
        ],
        ["lifecycle", "vaporize", "--session", "6ffa0a512819"],
      ]) {
        const result = yield* Effect.result(run(args, calls));
        assert.ok(Result.isFailure(result));
        assert.ok(Predicate.isTagged(result.failure, "LabFailure"));
        assert.match(JSON.stringify(result.failure), /protected/u);
      }
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("models every lifecycle scenario and the closed fault vocabulary", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* run(["lifecycle", "create-and-ready", "--repo", "owner/repo"], calls);
      yield* run(["lifecycle", "checkpoint", "--session", "a0b1c2d3e4f5"], calls);
      yield* run(
        ["lifecycle", "sleep-resume", "--session", "a0b1c2d3e4f5", "--fault", "runtime-stopped"],
        calls,
      );
      yield* run(["lifecycle", "runtime-loss", "--session", "a0b1c2d3e4f5"], calls);
      yield* run(["lifecycle", "hard-cap", "--session", "a0b1c2d3e4f5"], calls);
      yield* run(["lifecycle", "vaporize", "--session", "a0b1c2d3e4f5"], calls);
      yield* run(
        [
          "lifecycle",
          "hatch-observe",
          "--session",
          "a0b1c2d3e4f5",
          "--turn",
          "turn-1",
          "--expect",
          "ready",
        ],
        calls,
      );
      yield* run(["lifecycle", "full", "--repo", "owner/repo"], calls);
      assert.deepEqual(calls, [
        "create-and-ready:owner/repo:none",
        "checkpoint:a0b1c2d3e4f5:none",
        "sleep-resume:a0b1c2d3e4f5:runtime-stopped",
        "runtime-loss:a0b1c2d3e4f5:none",
        "hard-cap:a0b1c2d3e4f5:none",
        "vaporize:a0b1c2d3e4f5:none",
        "hatch-observe:a0b1c2d3e4f5:turn-1:ready",
        "full:owner/repo:none",
      ]);
      assertUsageFailure(
        yield* Effect.result(
          run(
            ["lifecycle", "checkpoint", "--session", "a0b1c2d3e4f5", "--fault", "invented"],
            calls,
          ),
        ),
      );
      assertUsageFailure(
        yield* Effect.result(
          run(
            [
              "lifecycle",
              "hatch-observe",
              "--session",
              "a0b1c2d3e4f5",
              "--turn",
              "turn-1",
              "--expect",
              "restored-ready",
            ],
            calls,
          ),
        ),
      );
    }),
  );

  it.effect("captures child stdout, stderr, and exit status", () =>
    Effect.gen(function* () {
      const child = spawn(
        process.execPath,
        ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const captured = yield* waitForCapturedChild(child);
      assert.deepEqual(captured, { stdout: "out", stderr: "err", code: 7 });
    }),
  );

  it.effect("rejects every command and trailing shape outside the public grammar", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      for (const args of [
        [],
        ["help"],
        ["--help"],
        ["start", "extra"],
        ["setup", RUN_ID, "--repo", "not-a-repo"],
        ["setup", RUN_ID, "--repo", "owner/repo", "extra"],
        ["lifecycle", "checkpoint", "a0b1c2d3e4f5"],
        ["stop", RUN_ID, "extra"],
        ["stop", "not-a-run"],
      ]) {
        assertUsageFailure(yield* Effect.result(run(args, calls)));
      }
      assert.deepEqual(calls, []);
    }),
  );
});
