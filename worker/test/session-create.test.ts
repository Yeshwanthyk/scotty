import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { createDeterministicTarGz } from "../../cli/src/sandbox-archive";
import { makeInstallationPiAuthRecord } from "../../protocol/pi-auth";
import { isSessionEnvironmentSnapshot } from "../src/environment-contracts";
import { ScottyError } from "../src/contracts";
import { InitialSessionStorageFailure } from "../src/session-store";
import { RepoVerifierFailure } from "../src/repo-verifier";
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

const EMPTY_ADDITIONS_DIGEST = createDeterministicTarGz([
  {
    path: "manifest.json",
    type: "file",
    modeClass: "regular",
    bytes: new TextEncoder().encode('{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
  },
]).digest;

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

const hostWriteFileEventIndex = (
  events: ReadonlyArray<string>,
  writtenFileIndex: number,
): number => {
  let writeEvents = 0;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index] === "host:writeFile") {
      if (writeEvents === writtenFileIndex) return index;
      writeEvents += 1;
    }
  }
  assert.fail("missing host:writeFile event");
};

describe("Sandbox create orchestration", () => {
  it("verifies the repository before any session authority or runtime mutation", async () => {
    const harness = await createSessionHarness({
      repoVerifier: {
        verify: () => Effect.fail(new RepoVerifierFailure({ reason: "forbidden", status: 403 })),
      },
    });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "upstream");
    assert.strictEqual(harness.readRecord(), undefined);
    assert.deepStrictEqual(harness.schedules, []);
    assert.strictEqual(harness.sandboxConfigStatusCallCount(), 0);
    assert.deepStrictEqual(harness.commands, []);
    assert.ok(!harness.events.some((event) => event.startsWith("projection:")));
    assert.ok(!harness.events.includes("credential:put"));
  });

  it("passes the SandboxConfig global GH_TOKEN authority to repository verification", async () => {
    let observedToken: string | undefined;
    const harness = await createSessionHarness({
      repoVerifier: {
        verify: (_repo, token) => {
          observedToken = token;
          return Effect.succeed({ exists: true, defaultBranch: "main" });
        },
      },
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    assert.strictEqual(observedToken, "authority-github-token");
  });

  it("fails closed before runtime mutation when the GH_TOKEN authority is unavailable", async () => {
    const harness = await createSessionHarness({
      sandboxConfigGithubTokenFailure: "rpc-error",
    });
    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "upstream");
    assert.strictEqual(harness.readRecord(), undefined);
    assert.deepStrictEqual(harness.schedules, []);
    assert.strictEqual(harness.sandboxConfigStatusCallCount(), 0);
    assert.deepStrictEqual(harness.commands, []);
    assert.ok(!harness.events.some((event) => event.startsWith("projection:")));
  });

  it("fails closed before workspace preparation when GH_TOKEN is absent from materialization", async () => {
    const harness = await createSessionHarness({ omitGithubEnvironmentSecret: true });
    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "upstream");
    assert.notInclude(harness.events, "host:exec:workspace");
    assert.notInclude(JSON.stringify(harness.events), "authority-github-token");
  });

  it("rejects an authenticated missing repository unless --new-repo is explicit", async () => {
    const harness = await createSessionHarness({
      repoVerifier: { verify: () => Effect.succeed({ exists: false }) },
    });
    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.code, "not_found");
    assert.include(error.message, "--new-repo");
    assert.strictEqual(harness.readRecord(), undefined);
    assert.deepStrictEqual(harness.schedules, []);
    assert.strictEqual(harness.sandboxConfigStatusCallCount(), 0);
    assert.deepStrictEqual(harness.commands, []);
  });

  it("initializes an intentional new repository with main as its verified branch", async () => {
    const harness = await createSessionHarness({
      repoVerifier: { verify: () => Effect.succeed({ exists: false }) },
    });
    const created = await harness.sandbox.createScottySession(
      { ...CREATE_INPUT, newRepo: true },
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(created.status, "warm");
    assert.deepStrictEqual(
      harness.readRecord() && {
        repoExistsAtCreate: harness.readRecord()?.repoExistsAtCreate,
        defaultBranch: harness.readRecord()?.defaultBranch,
      },
      { repoExistsAtCreate: false, defaultBranch: "main" },
    );
    assert.ok(harness.commands.some((command) => command.startsWith("git init -b main ")));
    assert.ok(!harness.commands.some((command) => command.startsWith("gh repo view")));
  });

  it("uses the verified non-main branch for both the record and clone", async () => {
    const harness = await createSessionHarness({
      repoVerifier: {
        verify: () => Effect.succeed({ exists: true, defaultBranch: "trunk" }),
      },
    });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    assert.strictEqual(harness.readRecord()?.repoExistsAtCreate, true);
    assert.strictEqual(harness.readRecord()?.defaultBranch, "trunk");
    assert.ok(harness.commands.some((command) => command.includes("clone --branch 'trunk'")));
  });

  it("rejects runner-backed session creation until native Pi transport is available", async () => {
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
    assert.strictEqual(harness.readRecord(), undefined);
    assert.deepStrictEqual(harness.runnerOperations, []);
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
    assert.match(record?.piSessionTransportToken ?? "", /^[0-9a-f]{64}$/u);
    assert.ok(!("piSessionTransportToken" in created));
    assert.notStrictEqual(record?.piSessionTransportToken, "stored-github-token");
    assert.deepStrictEqual(record?.sandboxBundle, { digest: null, manifestVersion: 1 });
    assert.deepStrictEqual(created.sandboxBundle, { digest: null, manifestVersion: 1 });
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
    assert.deepStrictEqual(
      harness.writtenFiles.find((file) => file.path.endsWith("/.pi-agent/initial-prompt")),
      {
        path: `/workspace/${SESSION_ID}/.pi-agent/initial-prompt`,
        content: CREATE_INPUT.prompt,
      },
    );
    assert.deepStrictEqual(harness.aborts, []);
  });

  it("materializes plain values directly and keeps secrets sentinel-only in session state and env", async () => {
    const secret = "session-secret";
    const harness = await createSessionHarness({
      environmentMaterialization: {
        revision: 7,
        repo: "owner/project",
        variables: {
          PUBLIC_URL: {
            value: "https://example.test",
            secret: false,
            updatedAt: "2026-07-24T11:00:00.000Z",
            sourceScope: "global",
          },
          API_TOKEN: {
            value: secret,
            secret: true,
            updatedAt: "2026-07-24T11:00:00.000Z",
            sourceScope: "global",
          },
        },
      },
    });

    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    assert.deepStrictEqual(harness.environmentSnapshotRepos, [CREATE_INPUT.repo]);

    const record = harness.readRecord();
    const environment = record?.environment;
    assert.ok(isSessionEnvironmentSnapshot(environment));
    const sentinel = environment.variables.API_TOKEN;
    assert.strictEqual(environment.version, 1);
    assert.strictEqual(environment.revision, 7);
    assert.strictEqual(environment.variables.PUBLIC_URL, "https://example.test");
    assert.ok(sentinel?.startsWith(`scotty-env-${SESSION_ID}-`));
    assert.notStrictEqual(sentinel, secret);
    assert.notInclude(JSON.stringify(record), secret);
    assert.strictEqual(harness.appliedEnvironments[0]?.PUBLIC_URL, "https://example.test");
    assert.strictEqual(harness.appliedEnvironments[0]?.API_TOKEN, sentinel);
    assert.notInclude(JSON.stringify(harness.appliedEnvironments[0]), secret);
    assert.strictEqual(harness.appliedEnvironments[0]?.SCOTTY_SESSION_ID, SESSION_ID);
    const shell = harness.writtenFiles.find((file) => file.path.endsWith("/scotty-shell"));
    assert.include(shell?.content ?? "", "export PUBLIC_URL='https://example.test'");
    assert.include(shell?.content ?? "", `export API_TOKEN='${sentinel}'`);
    assert.notInclude(shell?.content ?? "", secret);
  });

  it("seeds a new session from installation Pi authority", async () => {
    const installationPiAuthRecord = await makeInstallationPiAuthRecord(
      { openai: { type: "api_key", key: "installation-key" } },
      "2026-07-24T11:00:00.000Z",
      "sync",
    );
    const harness = await createSessionHarness({ installationPiAuthRecord });
    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);
    const stored = harness.read<ReturnType<typeof makeStoredCredential>>(
      sessionHarnessKeys.credential,
    );
    assert.strictEqual(stored?.updatedAt, installationPiAuthRecord.updatedAt);
    assert.deepInclude(stored?.providers.openai?.credential, {
      type: "api_key",
      key: "installation-key",
    });
    assert.strictEqual(stored?.providers["openai-codex"], undefined);
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
    let verifierCalls = 0;
    const existing = makeSessionRecord({
      id: SESSION_ID,
      branch: `scotty/${SESSION_ID}`,
    });
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: existing,
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
      },
      repoVerifier: {
        verify: () => {
          verifierCalls += 1;
          return Effect.fail(new RepoVerifierFailure({ reason: "transport" }));
        },
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
    assert.strictEqual(verifierCalls, 0);
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
        createPhase: "runtime",
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
    assert.ok(
      harness.events.indexOf("storage:put:scotty:environment-secrets:v1") <
        harness.events.indexOf("host:exec:workspace"),
    );
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
      harness.commands.filter((command) => command.startsWith("rm -rf ")).length,
      1,
    );
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("singleflights concurrent matching Pi-phase replays", async () => {
    const nonce = "concurrent-create-runtime";
    const harness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: makeSessionRecord({
          id: SESSION_ID,
          status: "booting",
          operation: {
            kind: "create",
            nonce,
            startedAt: "2026-07-24T12:00:00.000Z",
            createPhase: "runtime",
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
      harness.commands.filter((command) => command.startsWith("rm -rf ")).length,
      1,
    );
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
              createPhase: "runtime",
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
      assert.strictEqual(
        error.message,
        "Pi session creation is ambiguous (stage: seed) [transport] Sandbox directory transport failed",
      );
      assert.strictEqual(harness.readRecord()?.status, "booting");
      assert.deepInclude(harness.readRecord()?.operation, {
        kind: "create",
        nonce,
        createPhase: "runtime",
      });
      assert.deepStrictEqual(harness.readRecord()?.failure, {
        code: "create_ambiguous",
        message:
          "Pi session creation is ambiguous (stage: seed) [transport] Sandbox directory transport failed",
        recoverable: true,
        stage: "seed",
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
            createPhase: "runtime",
          },
          branch: `scotty/${SESSION_ID}`,
          codexThreadId: undefined,
        }),
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
      transactionFailureCountdown: 2,
    });

    const error = await rejection(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.ok(error instanceof ScottyError);
    assert.strictEqual(error.message, "Pi session creation is ambiguous (stage: warm_commit)");
    assert.strictEqual(harness.readRecord()?.status, "booting");
    assert.deepInclude(harness.readRecord()?.operation, {
      kind: "create",
      nonce,
      createPhase: "runtime",
    });
    assert.strictEqual(harness.readRecord()?.codexThreadId, undefined);
    assert.deepStrictEqual(harness.readRecord()?.failure, {
      code: "create_ambiguous",
      message: "Pi session creation is ambiguous (stage: warm_commit)",
      recoverable: true,
      stage: "warm_commit",
    });
    assert.ok(!harness.events.includes("record:failed"));
    assert.ok(!harness.events.includes("host:destroy"));
  });

  it("reconciles a matching booting create from its durable runtime phase", async () => {
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
            createPhase: "runtime",
          },
          branch: `scotty/${SESSION_ID}`,
          defaultBranch: "main",
          codexThreadId: undefined,
        }),
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
        [sessionHarnessKeys.credential]: makeStoredCredential(),
      },
    });

    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    assert.strictEqual(harness.readRecord()?.status, "warm");
    assert.strictEqual(harness.readRecord()?.failure, undefined);
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

  it("persists a null sandbox bundle pin on fresh create", async () => {
    const harness = await createSessionHarness();

    const created = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.deepStrictEqual(harness.readRecord()?.sandboxBundle, {
      digest: null,
      manifestVersion: 1,
    });
    assert.deepStrictEqual(created.sandboxBundle, {
      digest: null,
      manifestVersion: 1,
    });
    assert.strictEqual(harness.sandboxConfigStatusCallCount(), 1);
  });

  it("persists the active sandbox digest before workspace setup", async () => {
    const digest = EMPTY_ADDITIONS_DIGEST;
    const harness = await createSessionHarness({
      sandboxConfigStatus: { schemaVersion: 1, revision: 2, activeDigest: digest },
    });

    await harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY);

    const recordIndex = harness.events.indexOf("record:booting");
    const authIndex = harness.events.indexOf("host:mkdir");
    assert.ok(recordIndex >= 0);
    assert.ok(authIndex >= 0);
    assert.ok(recordIndex < authIndex);
    assert.deepStrictEqual(harness.readRecord()?.sandboxBundle, {
      digest,
      manifestVersion: 1,
    });
  });

  it("keeps the initial sandbox bundle pin across create replay after config changes", async () => {
    const digestA = EMPTY_ADDITIONS_DIGEST;
    const digestB = "b".repeat(64);
    const crashedHarness = await createSessionHarness({
      crashAfterInitialRecordCommit: true,
      sandboxConfigStatus: { schemaVersion: 1, revision: 1, activeDigest: digestA },
    });

    const crash = await rejection(
      crashedHarness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );
    assert.ok(crash instanceof InitialSessionStorageFailure);
    const committed = crashedHarness.readRecord();
    assert.ok(committed);
    assert.deepStrictEqual(committed.sandboxBundle, { digest: digestA, manifestVersion: 1 });
    assert.strictEqual(crashedHarness.sandboxConfigStatusCallCount(), 1);

    const replayHarness = await createSessionHarness({
      initialEntries: {
        [sessionHarnessKeys.record]: committed,
        [sessionHarnessKeys.createIdempotency]: CREATE_IDEMPOTENCY,
      },
      sandboxConfigStatus: { schemaVersion: 1, revision: 2, activeDigest: digestB },
    });

    const replayed = await replayHarness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.deepStrictEqual(replayHarness.readRecord()?.sandboxBundle, {
      digest: digestA,
      manifestVersion: 1,
    });
    assert.deepStrictEqual(replayed.sandboxBundle, {
      digest: digestA,
      manifestVersion: 1,
    });
    assert.strictEqual(replayHarness.sandboxConfigStatusCallCount(), 0);
  });

  it("materializes the pinned sandbox bundle during create", async () => {
    const digest = EMPTY_ADDITIONS_DIGEST;
    const harness = await createSessionHarness({
      sandboxConfigStatus: { schemaVersion: 1, revision: 2, activeDigest: digest },
    });

    const created = await harness.sandbox.createScottySession(
      CREATE_INPUT,
      SESSION_ID,
      CREATE_IDEMPOTENCY,
    );

    assert.strictEqual(created.status, "warm");
    const mkdirIndex = harness.events.indexOf("host:mkdir");
    assert.ok(mkdirIndex >= 0);
    const manifestIndex = harness.writtenFiles.findIndex(
      (file) => file.path.includes("/.scotty/sandbox/") && file.path.endsWith("/manifest.json"),
    );
    const verifiedIndex = harness.writtenFiles.findIndex(
      (file) => file.path.includes("/.scotty/sandbox/") && file.path.endsWith("/.verified"),
    );
    assert.ok(manifestIndex >= 0);
    assert.ok(verifiedIndex >= 0);
    assert.ok(hostWriteFileEventIndex(harness.events, manifestIndex) > mkdirIndex);
    assert.ok(hostWriteFileEventIndex(harness.events, verifiedIndex) > mkdirIndex);
    assert.ok(harness.events.some((event) => event.startsWith("host:pi:start:")));
    assert.deepStrictEqual(harness.readRecord()?.sandboxBundle, {
      digest,
      manifestVersion: 1,
    });
    assert.deepStrictEqual(created.sandboxBundle, {
      digest,
      manifestVersion: 1,
    });
  });

  it("does not reach warm when the pinned sandbox bundle is missing", async () => {
    const digest = "a".repeat(64);
    const harness = await createSessionHarness({
      sandboxConfigStatus: { schemaVersion: 1, revision: 2, activeDigest: digest },
      seedPinnedSandboxBundle: false,
    });

    await assertUpstreamFailure(
      harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
    );

    assert.notStrictEqual(harness.readRecord()?.status, "warm");
    assert.ok(!harness.events.some((event) => event.startsWith("host:pi:start:")));
  });

  it("does not commit a session record when sandbox config status fails", async () => {
    for (const sandboxConfigStatusFailure of ["rpc-error", "throw"] as const) {
      const harness = await createSessionHarness({ sandboxConfigStatusFailure });

      await assertUpstreamFailure(
        harness.sandbox.createScottySession(CREATE_INPUT, SESSION_ID, CREATE_IDEMPOTENCY),
      );

      assert.strictEqual(harness.readRecord(), undefined);
      assert.strictEqual(harness.sandboxConfigStatusCallCount(), 1);
    }
  });
});
