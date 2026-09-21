#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { ChildProcess } from "node:child_process";
import packageMetadata from "../package.json" with { type: "json" };
import {
  Console,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";
import {
  Argument,
  CliConfig,
  CliError as EffectCliError,
  CliOutput,
  Command,
  Flag,
} from "effect/unstable/cli";
import { isRepositoryIdentity } from "../protocol/settings/repository.ts";
import { CanonicalConversationSnapshotSchema } from "../protocol/session/conversation.ts";
import { PublicHatchStatusSchema } from "../worker/src/hatch/contracts.ts";
import { SessionSteerResponseSchema } from "../protocol/session/session-steer.ts";
import { SessionInterruptResponseSchema } from "../protocol/session/session-interrupt.ts";
import { SessionActorDiagnosticsSchema } from "../worker/src/session-actor/diagnostics.ts";
import { AuthorityStateSchema, StableStateSchema } from "../worker/src/session-actor/authority.ts";
import { UiSessionResponseSchema } from "../worker/src/ui/session-view.ts";
import {
  acquireLifecycleLock,
  activeRunManifest,
  appendEvidenceCommand,
  assertStableActorObservation,
  assertLifecycleSessionId,
  awaitWrangler,
  cleanupOwnedFiles,
  completeStart,
  createStartReservation,
  execManifest,
  isOwnedSession,
  launchWrangler,
  markCleanupPending,
  prepareCredentialSetup,
  prepareStart,
  preserveWorkerLog,
  PROTECTED_SESSION_ID,
  readActorDiagnostics,
  readHatchStatus,
  readSessionView,
  recoverPendingCreateSessionId,
  recordCleanupResult,
  recordActorDiagnostics,
  recordOwnedSession,
  recordScenarioResult,
  releaseLifecycleLock,
  removeOwnedTempRoot,
  removeWorkerContainers,
  sanitizeEvidenceText,
  sleepSession,
  spawnCli,
  startupFailureDetails,
  stopManifest,
  terminateStartedWrangler,
  terminateManifestProcess,
} from "./scotty-lab.mjs";

export const LAB_VERSION = packageMetadata.version;
const USAGE =
  "Usage: npm run lab -- start | setup RUN_ID --repo OWNER/REPO | exec RUN_ID -- <scotty argv> | stop RUN_ID | lifecycle <scenario>";
const RUN_ID_PATTERN = /^lab-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Manifest = ReturnType<typeof createStartReservation>;
type Started = Awaited<ReturnType<typeof launchWrangler>>["started"];
type Prepared = Awaited<ReturnType<typeof prepareStart>>;
const FAULTS = [
  "after-intent-commit",
  "before-provider-dispatch",
  "after-provider-dispatch",
  "before-observation-commit",
  "after-observation-commit",
  "runtime-stopped",
  "supervisor-lost",
  "provider-response-lost",
  "alarm-duplicated",
] as const;
type Fault = (typeof FAULTS)[number];
type LifecycleScenario =
  | "create-and-ready"
  | "checkpoint"
  | "sleep-resume"
  | "runtime-loss"
  | "hard-cap"
  | "vaporize"
  | "codex-workflow"
  | "hatch-observe"
  | "full";

const SessionOperationOutput = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
});
const SessionIdentityOutput = Schema.Struct({ id: Schema.String });
const CodexInspectOutput = Schema.Struct({
  id: Schema.String,
  ...CanonicalConversationSnapshotSchema.fields,
});
const InternalPeerReadReceipt = Schema.Struct({
  id: Schema.String,
  epoch: Schema.String,
  initialTurnId: Schema.String,
  readSequence: Schema.Int,
});
const decodeSessionOperationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionOperationOutput),
);
const decodeSessionIdentityJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionIdentityOutput),
);
const decodeActorDiagnosticsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionActorDiagnosticsSchema),
);
const decodeCodexInspectJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CodexInspectOutput),
);
const decodeInternalPeerReadReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(InternalPeerReadReceipt),
);
const decodeHatchStatusJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PublicHatchStatusSchema),
);
const decodeSteerJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionSteerResponseSchema),
);
const decodeInterruptJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionInterruptResponseSchema),
);

const acceptedCodexTurnId = (
  receipt: typeof SessionSteerResponseSchema.Type,
  sessionId: string,
  mode: "message" | "steer",
): string | undefined =>
  receipt.id === sessionId &&
  receipt.status === "accepted" &&
  "mode" in receipt &&
  receipt.mode === mode &&
  "turnId" in receipt
    ? receipt.turnId
    : undefined;

const acceptedCodexQueueId = (
  receipt: typeof SessionSteerResponseSchema.Type,
  sessionId: string,
): string | undefined =>
  receipt.id === sessionId &&
  receipt.status === "accepted" &&
  "mode" in receipt &&
  receipt.mode === "followUp" &&
  "clientUserMessageId" in receipt
    ? receipt.clientUserMessageId
    : undefined;

const acceptedCodexInterrupt = (
  receipt: typeof SessionInterruptResponseSchema.Type,
  sessionId: string,
  turnId: string,
): boolean =>
  receipt.id === sessionId &&
  receipt.status === "accepted" &&
  "turnId" in receipt &&
  receipt.turnId === turnId;
const decodeUiSessionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(UiSessionResponseSchema),
);

export class LabFailure extends Data.TaggedError("LabFailure")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly sessionId?: string;
}> {}

export class LabUsageError extends Data.TaggedError("LabUsageError")<{
  readonly message: string;
}> {}

const failure = (cause: unknown, fallback: string): LabFailure => {
  // oxlint-disable-next-line scotty/no-unknown-error-message -- boundary: native Node/Wrangler adapter failures retain their established redacted CLI message
  const message = Predicate.isError(cause) && cause.message.length > 0 ? cause.message : fallback;
  return new LabFailure({ message, cause });
};

const attempt = <A>(fallback: string, evaluate: () => A): Effect.Effect<A, LabFailure> =>
  Effect.try({ try: evaluate, catch: (cause) => failure(cause, fallback) });

const attemptPromise = <A>(
  fallback: string,
  evaluate: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, LabFailure> =>
  Effect.tryPromise({
    try: (signal) => evaluate(signal),
    catch: (cause) => failure(cause, fallback),
  });

const appendFailure = Effect.fnUntraced(function* <A>(
  errors: string[],
  operation: Effect.Effect<A, LabFailure>,
) {
  const result = yield* Effect.result(operation);
  if (Result.isFailure(result)) errors.push(result.failure.message);
  return result;
});

const cleanupResources = Effect.fnUntraced(function* (manifest: Manifest, started?: Started) {
  const errors: string[] = [];
  let processStopped = false;
  if (started) {
    const result = yield* appendFailure(
      errors,
      attemptPromise("Unable to stop the lab Wrangler process", () =>
        terminateStartedWrangler(started),
      ),
    );
    processStopped = Result.isSuccess(result);
  } else {
    const result = yield* appendFailure(
      errors,
      attemptPromise("Unable to stop the lab Wrangler process", () =>
        terminateManifestProcess(manifest),
      ),
    );
    processStopped = Result.isSuccess(result) && result.success.stopped;
    if (Result.isSuccess(result) && result.success.error) errors.push(result.success.error);
  }

  yield* appendFailure(
    errors,
    attempt("Unable to preserve the lab Worker log", () => preserveWorkerLog(manifest)),
  );

  if (processStopped)
    yield* appendFailure(
      errors,
      attempt("Unable to remove the lab Sandbox containers", () =>
        removeWorkerContainers(manifest),
      ),
    );

  if (processStopped && errors.length === 0) {
    const ownedFileErrors = yield* attempt("Unable to remove the lab files", () =>
      cleanupOwnedFiles(manifest),
    );
    errors.push(...ownedFileErrors);
  } else if (processStopped) {
    yield* appendFailure(
      errors,
      attempt("Unable to remove the lab temporary root", () => removeOwnedTempRoot(manifest)),
    );
  }

  if (errors.length > 0)
    yield* appendFailure(
      errors,
      attempt("Unable to persist cleanup-pending state", () => markCleanupPending(manifest)),
    );
  return errors;
});

const withLifecycleLock = <A, E>(
  operation: Effect.Effect<A, E>,
): Effect.Effect<A, E | LabFailure> =>
  Effect.acquireUseRelease(
    attempt("Unable to acquire the lab lifecycle lock", acquireLifecycleLock),
    () => operation,
    (descriptor) =>
      attempt("Unable to release the lab lifecycle lock", () => releaseLifecycleLock(descriptor)),
  );

const startLab = Effect.fnUntraced(function* () {
  let manifest: Manifest | undefined;
  let prepared: Prepared | undefined;
  let started: Started | undefined;
  const cleanupErrors: string[] = [];

  const start = Effect.gen(function* () {
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const reservation = yield* attempt("Unable to reserve the lab", () =>
      createStartReservation(new Date(now).toISOString()),
    );
    manifest = reservation;
    const startInputs = yield* attemptPromise("Unable to prepare local Scotty", () =>
      prepareStart(reservation),
    );
    prepared = startInputs;
    const launched = yield* attemptPromise("Unable to start Wrangler", () =>
      launchWrangler(reservation, startInputs),
    );
    manifest = launched.manifest;
    started = launched.started;
    yield* attemptPromise("Unable to wait for Wrangler", (signal) =>
      awaitWrangler(launched.manifest, launched.started, signal),
    );
    const running = yield* attempt("Unable to mark the lab running", () =>
      completeStart(launched.manifest, launched.started),
    );
    manifest = running;
    yield* Effect.sync(() =>
      process.stdout.write(
        `${JSON.stringify({ runId: running.runId, host: running.host, pid: running.pid, status: "running" })}\n`,
      ),
    );
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) || manifest === undefined
        ? Effect.void
        : Effect.sync(() => started?.flushLog()).pipe(
            Effect.andThen(
              Effect.flatMap(cleanupResources(manifest, started), (errors) =>
                Effect.sync(() => cleanupErrors.push(...errors)),
              ),
            ),
          ),
    ),
    Effect.catch((error) =>
      attempt("Lab start failed", () =>
        startupFailureDetails(error, prepared?.secrets ?? [], started, cleanupErrors),
      ).pipe(Effect.flatMap((message) => Effect.fail(new LabFailure({ message, cause: error })))),
    ),
  );

  return yield* withLifecycleLock(start);
});

interface ChildResult {
  readonly code?: number;
  readonly signal?: NodeJS.Signals;
}

export interface CapturedChildResult extends ChildResult {
  readonly stdout: string;
  readonly stderr: string;
}

const waitForChild = (child: ChildProcess): Effect.Effect<ChildResult, LabFailure> =>
  Effect.callback<ChildResult, LabFailure>((resume) => {
    const onError = (cause: Error) =>
      resume(Effect.fail(failure(cause, "Unable to run the Scotty CLI")));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      resume(Effect.succeed(signal === null ? { code: code ?? 1 } : { signal }));
    child.once("error", onError);
    child.once("exit", onExit);
    return Effect.sync(() => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
  });

export const waitForCapturedChild = (
  child: ChildProcess,
): Effect.Effect<CapturedChildResult, LabFailure> =>
  Effect.callback<CapturedChildResult, LabFailure>((resume) => {
    let stdout = "";
    let stderr = "";
    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString();
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };
    const onError = (cause: Error) =>
      resume(Effect.fail(failure(cause, "Unable to run the Scotty CLI")));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
      resume(
        Effect.succeed({
          stdout,
          stderr,
          ...(signal === null ? { code: code ?? 1 } : { signal }),
        }),
      );
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    return Effect.sync(() => {
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
  });

const nowIso = Effect.map(
  Effect.clockWith((clock) => clock.currentTimeMillis),
  (millis) => new Date(millis).toISOString(),
);

const executeLab = Effect.fnUntraced(function* (runId: string, argv: ReadonlyArray<string>) {
  if (argv.includes(PROTECTED_SESSION_ID))
    return yield* Effect.fail(
      new LabFailure({
        message: `Session ${PROTECTED_SESSION_ID} is protected and must never be targeted`,
      }),
    );
  const manifest = yield* attempt("Unable to read the running lab", () => execManifest(runId));
  const child = yield* attempt("Unable to start the Scotty CLI", () => spawnCli(manifest, argv));
  const result = yield* waitForChild(child);
  yield* Effect.sync(() => {
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code ?? 1;
  });
});

const setupLab = Effect.fnUntraced(function* (runId: string, repo: string) {
  const manifest = yield* attempt("Unable to read the running lab", () => execManifest(runId));
  const setup = yield* attempt("Unable to prepare the lab credential sources", () =>
    prepareCredentialSetup(manifest),
  );
  for (const argv of [
    ["sync", "--pi-auth", setup.piAuthPath, "--github", "--json"],
    ["repo", "add", repo, "--json"],
  ]) {
    const child = yield* attempt("Unable to start Scotty credential setup", () =>
      spawnCli(manifest, argv, {
        PATH: `${setup.credentialBin}:${process.env.PATH ?? ""}`,
      }),
    );
    const result = yield* waitForChild(child);
    if (result.signal) {
      yield* Effect.sync(() => process.kill(process.pid, result.signal));
      return;
    }
    if (result.code !== 0) {
      yield* Effect.sync(() => {
        process.exitCode = result.code ?? 1;
      });
      return;
    }
  }
});

type ScenarioResult = Readonly<{
  scenario: LifecycleScenario;
  status: "succeeded" | "not-available" | "rejected" | "failed";
  startedAt: string;
  finishedAt: string;
  sessionId?: string;
  reason?: string;
  fault?: Fault;
  proof?: {
    readonly initialTurnId: string;
    readonly followUpTurnId: string;
    readonly interruptedTurnId: string;
    readonly queuedTurnId: string;
    readonly queuedMessageId: string;
    readonly resumedTurnId: string;
    readonly checkpointTurnId: string;
    readonly checkpointBackupId: string;
    readonly peerId: string;
    readonly peerInitialTurnId: string;
    readonly peerFollowUpTurnId: string;
    readonly completedCommands: 9;
    readonly internalPeerControl: true;
    readonly activeSteer: true;
    readonly interruptAccepted: true;
    readonly sleepResumeContinuity: true;
    readonly runtimeStopped: false;
    readonly model: "gpt-5.6-sol";
    readonly effort: "medium";
  };
  hatchProof?: {
    readonly turnId: string;
    readonly expectation: "startup-failed" | "ready";
    readonly hatchId?: string;
    readonly startupFailure?: string;
  };
}>;

const persistScenarioResult = (manifest: Manifest, result: ScenarioResult) =>
  attempt("Unable to persist the lifecycle scenario result", () =>
    recordScenarioResult(manifest, result),
  );

const failScenario = Effect.fnUntraced(function* (manifest: Manifest, result: ScenarioResult) {
  yield* persistScenarioResult(manifest, result);
  return yield* Effect.fail(
    new LabFailure({ message: JSON.stringify({ runId: manifest.runId, ...result }) }),
  );
});

const requestedFaultUnavailable = Effect.fnUntraced(function* (
  manifest: Manifest,
  scenario: LifecycleScenario,
  fault: Fault | undefined,
  startedAt: string,
  sessionId?: string,
) {
  if (fault === undefined) return;
  const finishedAt = yield* nowIso;
  return yield* failScenario(manifest, {
    scenario,
    status: "not-available",
    startedAt,
    finishedAt,
    ...(sessionId === undefined ? {} : { sessionId }),
    fault,
    reason:
      "Fault injection is not available until the actor runner exposes a guarded public control.",
  });
});

const requireOwnedSession = Effect.fnUntraced(function* (
  manifest: Manifest,
  scenario: LifecycleScenario,
  sessionId: string,
  startedAt: string,
) {
  const validated = yield* Effect.result(
    attempt("Session ID is invalid", () => assertLifecycleSessionId(sessionId)),
  );
  if (Result.isFailure(validated)) {
    const finishedAt = yield* nowIso;
    return yield* failScenario(manifest, {
      scenario,
      status: "rejected",
      startedAt,
      finishedAt,
      sessionId,
      reason: validated.failure.message,
    });
  }
  const owned = yield* attempt("Unable to read lifecycle session ownership", () =>
    isOwnedSession(manifest, validated.success),
  );
  if (!owned) {
    const finishedAt = yield* nowIso;
    return yield* failScenario(manifest, {
      scenario,
      status: "rejected",
      startedAt,
      finishedAt,
      sessionId,
      reason: `Session ${sessionId} is not recorded as owned by lab run ${manifest.runId}.`,
    });
  }
  return validated.success;
});

const recordedCliOutput = (stdout: string, stderr: string, omitOutput: boolean) =>
  omitOutput
    ? {
        stdout: "<canonical runtime snapshot omitted>",
        stderr: "<canonical runtime error omitted>",
      }
    : { stdout, stderr };

const runRecordedCli = Effect.fnUntraced(function* (
  manifest: Manifest,
  scenario: LifecycleScenario,
  argv: ReadonlyArray<string>,
  sessionId?: string,
  recoverSessionId?: () => Effect.Effect<string, LabFailure>,
  omitOutput = false,
) {
  const startedAt = yield* nowIso;
  const child = yield* attempt("Unable to start the Scotty CLI", () =>
    spawnCli(manifest, argv, {}, "pipe"),
  );
  const captured = yield* waitForCapturedChild(child);
  const finishedAt = yield* nowIso;
  let evidenceSessionId = sessionId;
  let recoveryFailure: LabFailure | undefined;
  if (
    (captured.signal !== undefined || captured.code !== 0) &&
    evidenceSessionId === undefined &&
    recoverSessionId !== undefined
  ) {
    const recovered = yield* Effect.result(recoverSessionId());
    if (Result.isFailure(recovered)) recoveryFailure = recovered.failure;
    else {
      const recorded = yield* Effect.result(
        attempt("Unable to record failed create ownership", () =>
          recordOwnedSession(manifest, recovered.success, finishedAt),
        ),
      );
      if (Result.isFailure(recorded)) recoveryFailure = recorded.failure;
      else evidenceSessionId = recovered.success;
    }
  }
  const stdout = yield* attempt("Unable to sanitize lifecycle stdout", () =>
    sanitizeEvidenceText(manifest, captured.stdout),
  );
  const stderr = yield* attempt("Unable to sanitize lifecycle stderr", () =>
    sanitizeEvidenceText(manifest, captured.stderr),
  );
  const { stdout: evidenceStdout, stderr: evidenceStderr } = recordedCliOutput(
    stdout,
    stderr,
    omitOutput,
  );
  yield* attempt("Unable to persist lifecycle command evidence", () =>
    appendEvidenceCommand(manifest, {
      scenario,
      argv,
      startedAt,
      finishedAt,
      stdout: evidenceStdout,
      stderr: evidenceStderr,
      exitCode: captured.code ?? null,
      signal: captured.signal ?? null,
      sessionId: evidenceSessionId ?? null,
      sessionOwned: evidenceSessionId === undefined ? "pending-create" : true,
    }),
  );
  if (captured.signal !== undefined || captured.code !== 0) {
    const reason = `CLI exited with ${captured.signal ?? captured.code ?? "an unknown status"}.${
      recoveryFailure === undefined ? "" : ` ${recoveryFailure.message}`
    }`;
    yield* persistScenarioResult(manifest, {
      scenario,
      status: "failed",
      startedAt,
      finishedAt,
      ...(evidenceSessionId === undefined ? {} : { sessionId: evidenceSessionId }),
      reason,
    });
    return yield* Effect.fail(
      new LabFailure({
        message: JSON.stringify({
          scenario,
          status: "failed",
          exitCode: captured.code ?? null,
          signal: captured.signal ?? null,
          stderr: evidenceStderr,
          ...(evidenceSessionId === undefined ? {} : { sessionId: evidenceSessionId }),
          ...(recoveryFailure === undefined ? {} : { recoveryError: recoveryFailure.message }),
        }),
        ...(evidenceSessionId === undefined ? {} : { sessionId: evidenceSessionId }),
      }),
    );
  }
  return stdout.trim();
});

const runRecordedSleep = Effect.fnUntraced(function* (manifest: Manifest, sessionId: string) {
  const startedAt = yield* nowIso;
  const response = yield* attemptPromise("Unable to sleep the lifecycle session", (signal) =>
    sleepSession(manifest, sessionId, signal),
  );
  const finishedAt = yield* nowIso;
  yield* attempt("Unable to persist sleep command evidence", () =>
    appendEvidenceCommand(manifest, {
      scenario: "sleep-resume",
      argv: ["POST", `/api/sessions/${sessionId}/sleep`],
      startedAt,
      finishedAt,
      stdout: response.body,
      stderr: "",
      exitCode: response.status >= 200 && response.status < 300 ? 0 : 1,
      signal: null,
      httpStatus: response.status,
      sessionId,
      sessionOwned: true,
    }),
  );
  return response;
});

const captureActorDiagnostics = Effect.fnUntraced(function* (
  manifest: Manifest,
  scenario: LifecycleScenario,
  sessionId: string,
) {
  const response = yield* attemptPromise("Unable to read actor diagnostics", (signal) =>
    readActorDiagnostics(manifest, sessionId, signal),
  );
  if (response.status < 200 || response.status >= 300)
    return yield* new LabFailure({
      message: `Actor diagnostics returned HTTP ${response.status}: ${response.body}`,
    });
  const diagnostics = yield* decodeActorDiagnosticsJson(response.body).pipe(
    Effect.mapError((cause) => failure(cause, "Actor diagnostics returned invalid JSON")),
  );
  const observedAt = yield* nowIso;
  yield* attempt("Unable to persist actor diagnostics", () =>
    recordActorDiagnostics(manifest, { scenario, sessionId, observedAt, diagnostics }),
  );
  return diagnostics;
});

const awaitStableActorDiagnostics = Effect.fnUntraced(function* (
  manifest: Manifest,
  scenario: LifecycleScenario,
  sessionId: string,
  expected: "Sleeping" | "Warm",
) {
  let attemptIndex = 0;
  while (true) {
    const diagnostics = yield* captureActorDiagnostics(manifest, scenario, sessionId);
    const stable = yield* Effect.result(
      attempt(`Actor authority did not settle ${expected.toLowerCase()}`, () =>
        assertStableActorObservation(diagnostics, expected),
      ),
    );
    if (Result.isSuccess(stable)) return diagnostics;
    if (attemptIndex >= 19) return yield* stable.failure;
    attemptIndex += 1;
    yield* Effect.sleep("500 millis");
  }
});

const decodeOperation = (json: string) =>
  decodeSessionOperationJson(json).pipe(
    Effect.mapError((cause) => failure(cause, "Scotty CLI returned invalid lifecycle JSON")),
  );

const finishScenario = Effect.fnUntraced(function* (
  manifest: Manifest,
  scenario: LifecycleScenario,
  startedAt: string,
  sessionId?: string,
  proof?: ScenarioResult["proof"],
) {
  const result: ScenarioResult = {
    scenario,
    status: "succeeded",
    startedAt,
    finishedAt: yield* nowIso,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(proof === undefined ? {} : { proof }),
  };
  yield* persistScenarioResult(manifest, result);
  return result;
});

const createAndReady = Effect.fnUntraced(function* (
  manifest: Manifest,
  repo: string,
  fault?: Fault,
  codexWorkflow = false,
) {
  const startedAt = yield* nowIso;
  yield* requestedFaultUnavailable(manifest, "create-and-ready", fault, startedAt);
  const request = {
    ...(codexWorkflow ? { agent: "codex", model: "gpt-5.6-sol", effort: "medium" } : {}),
    title: codexWorkflow ? "Scotty Codex workflow lab" : "Scotty lifecycle lab",
    prompt: codexWorkflow
      ? "Run one shell command: printf SCOTTY_LAB_CODEX_INITIAL; head -c 300000 /dev/zero | tr '\\0' x. Then reply SCOTTY_LAB_CODEX_READY. Do not change files."
      : "Reply with exactly SCOTTY_LAB_READY.",
    provider: "cloudflare",
    repo,
    cap: "30m",
    hardCapSeconds: 1_800,
  } as const;
  const output = yield* Effect.result(
    runRecordedCli(
      manifest,
      "create-and-ready",
      [
        "beam",
        request.prompt,
        "--title",
        request.title,
        "--repo",
        request.repo,
        "--provider",
        request.provider,
        ...(codexWorkflow
          ? ["--agent", "codex", "--model", "gpt-5.6-sol", "--effort", "medium"]
          : []),
        "--cap",
        request.cap,
        "--detach",
        "--json",
      ],
      undefined,
      () =>
        attempt("Unable to recover failed create ownership", () =>
          recoverPendingCreateSessionId(manifest, request),
        ),
    ),
  );
  if (Result.isFailure(output)) {
    if (output.failure.sessionId !== undefined) {
      const diagnostics = yield* Effect.result(
        captureActorDiagnostics(manifest, "create-and-ready", output.failure.sessionId),
      );
      if (Result.isFailure(diagnostics))
        return yield* new LabFailure({
          message: `${output.failure.message}; ${diagnostics.failure.message}`,
          sessionId: output.failure.sessionId,
        });
    }
    return yield* output.failure;
  }
  const stdout = output.success;
  const identity = yield* decodeSessionIdentityJson(stdout).pipe(
    Effect.mapError((cause) => failure(cause, "Scotty CLI returned invalid session identity JSON")),
  );
  if (identity.id === PROTECTED_SESSION_ID)
    return yield* failScenario(manifest, {
      scenario: "create-and-ready",
      status: "rejected",
      startedAt,
      finishedAt: yield* nowIso,
      sessionId: identity.id,
      reason: `Session ${PROTECTED_SESSION_ID} is protected and must never be targeted.`,
    });
  const ownershipRecordedAt = yield* nowIso;
  yield* attempt("Unable to record lifecycle session ownership", () =>
    recordOwnedSession(manifest, identity.id, ownershipRecordedAt),
  );
  const diagnostics = yield* captureActorDiagnostics(manifest, "create-and-ready", identity.id);
  const created = yield* decodeOperation(stdout);
  if (created.status !== "warm")
    return yield* failScenario(manifest, {
      scenario: "create-and-ready",
      status: "failed",
      startedAt,
      finishedAt: yield* nowIso,
      sessionId: created.id,
      reason: `Expected a warm session, received ${created.status}.`,
    });
  yield* attempt("Create actor authority did not settle warm", () =>
    assertStableActorObservation(diagnostics, "Warm"),
  );
  return {
    sessionId: created.id,
    result: yield* finishScenario(manifest, "create-and-ready", startedAt, created.id),
  };
});

const checkpoint = Effect.fnUntraced(function* (
  manifest: Manifest,
  sessionId: string,
  fault?: Fault,
) {
  const startedAt = yield* nowIso;
  const ownedId = yield* requireOwnedSession(manifest, "checkpoint", sessionId, startedAt);
  yield* requestedFaultUnavailable(manifest, "checkpoint", fault, startedAt, ownedId);
  const operation = yield* decodeOperation(
    yield* runRecordedCli(manifest, "checkpoint", ["checkpoint", ownedId, "--json"], ownedId),
  );
  const diagnostics = yield* captureActorDiagnostics(manifest, "checkpoint", ownedId);
  if (operation.id !== ownedId || operation.status !== "warm")
    return yield* failScenario(manifest, {
      scenario: "checkpoint",
      status: "failed",
      startedAt,
      finishedAt: yield* nowIso,
      sessionId: ownedId,
      reason: "Checkpoint did not return the owned session in warm state.",
    });
  yield* attempt("Checkpoint actor authority did not settle warm", () =>
    assertStableActorObservation(diagnostics, "Warm"),
  );
  return yield* finishScenario(manifest, "checkpoint", startedAt, ownedId);
});

const sleepResume = Effect.fnUntraced(function* (
  manifest: Manifest,
  sessionId: string,
  fault?: Fault,
) {
  const startedAt = yield* nowIso;
  const ownedId = yield* requireOwnedSession(manifest, "sleep-resume", sessionId, startedAt);
  yield* requestedFaultUnavailable(manifest, "sleep-resume", fault, startedAt, ownedId);
  const sleepResponse = yield* runRecordedSleep(manifest, ownedId);
  const sleeping = yield* Effect.result(
    awaitStableActorDiagnostics(manifest, "sleep-resume", ownedId, "Sleeping"),
  );
  if (Result.isFailure(sleeping))
    return yield* failScenario(manifest, {
      scenario: "sleep-resume",
      status: "failed",
      startedAt,
      finishedAt: yield* nowIso,
      sessionId: ownedId,
      reason: `Sleep returned HTTP ${sleepResponse.status} and authority did not settle sleeping: ${sleeping.failure.message}`,
    });
  if (sleepResponse.status >= 200 && sleepResponse.status < 300) {
    const slept = yield* decodeOperation(sleepResponse.body);
    if (slept.id !== ownedId || slept.status !== "sleeping")
      return yield* failScenario(manifest, {
        scenario: "sleep-resume",
        status: "failed",
        startedAt,
        finishedAt: yield* nowIso,
        sessionId: ownedId,
        reason: "Sleep did not return the owned session in sleeping state.",
      });
  }
  const resumed = yield* decodeOperation(
    yield* runRecordedCli(manifest, "sleep-resume", ["resume", ownedId, "--json"], ownedId),
  );
  const warmDiagnostics = yield* awaitStableActorDiagnostics(
    manifest,
    "sleep-resume",
    ownedId,
    "Warm",
  );
  if (resumed.id !== ownedId || resumed.status !== "warm")
    return yield* failScenario(manifest, {
      scenario: "sleep-resume",
      status: "failed",
      startedAt,
      finishedAt: yield* nowIso,
      sessionId: ownedId,
      reason: "Resume did not return the owned session in warm state.",
    });
  yield* attempt("Resume actor authority did not settle warm", () =>
    assertStableActorObservation(warmDiagnostics, "Warm"),
  );
  return yield* finishScenario(manifest, "sleep-resume", startedAt, ownedId);
});

const unavailableScenario = Effect.fnUntraced(function* (
  manifest: Manifest,
  scenario: "runtime-loss" | "hard-cap",
  sessionId: string,
  fault?: Fault,
) {
  const startedAt = yield* nowIso;
  const ownedId = yield* requireOwnedSession(manifest, scenario, sessionId, startedAt);
  yield* requestedFaultUnavailable(manifest, scenario, fault, startedAt, ownedId);
  return yield* failScenario(manifest, {
    scenario,
    status: "not-available",
    startedAt,
    finishedAt: yield* nowIso,
    sessionId: ownedId,
    reason: `${scenario} has no complete public observation path yet.`,
  });
});

export const codexTerminalProof = (
  snapshot: typeof CodexInspectOutput.Type,
  expectedTurnId: string | undefined,
  commandMarker: string,
  replyMarker: string,
  expectedUserMarker?: string,
):
  | { readonly status: "pending" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "passed"; readonly turnId: string } => {
  if (snapshot.runtimeStopped !== false) {
    const summary = snapshot.turns.find(({ state }) => state === "failed")?.activitySummary;
    const stale =
      summary !== undefined &&
      /^Runtime failure: stale_notification(?: \([A-Za-z/]+ (?:parent|known_child|foreign) (?:active|completed|other|none) (?:subAgentActivity|commandExecution|agentMessage|other|none)\))?$/u.test(
        summary,
      );
    return {
      status: "failed",
      reason: stale ? summary : "Codex runtime stopped or health was unavailable",
    };
  }
  const turn = expectedTurnId
    ? snapshot.turns.find(({ id }) => id === expectedTurnId)
    : expectedUserMarker
      ? snapshot.turns.find(({ user }) => user.includes(expectedUserMarker))
      : snapshot.turns.at(-1);
  if (turn === undefined) return { status: "pending" };
  if (turn.state === "failed" || turn.state === "aborted")
    return { status: "failed", reason: `Codex turn ${turn.state}` };
  if (turn.state !== "completed") return { status: "pending" };
  if (
    snapshot.followUpAvailable !== true ||
    !turn.assistant.includes(replyMarker) ||
    !turn.tools.some(
      (tool) =>
        tool.state === "completed" &&
        tool.invocation.includes("printf") &&
        tool.invocation.includes(commandMarker) &&
        tool.output?.includes(commandMarker) === true,
    )
  )
    return { status: "failed", reason: "Codex terminal lacks the requested command or reply" };
  return { status: "passed", turnId: turn.id };
};

type HatchExpectation = "startup-failed" | "ready";

export const hatchObservationProof = (
  snapshot: typeof CodexInspectOutput.Type,
  status: typeof PublicHatchStatusSchema.Type,
  turnId: string,
  expectation: HatchExpectation,
):
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "passed"; readonly hatchId?: string; readonly startupFailure?: string } => {
  const turn = snapshot.turns.find(({ id }) => id === turnId);
  if (turn === undefined || turn.state !== "completed")
    return { status: "failed", reason: "Hatch turn is missing or incomplete" };
  const tool = turn.tools.filter(({ invocation }) => invocation === "Hatch").at(-1);
  if (tool === undefined)
    return { status: "failed", reason: "Expected a native Hatch tool receipt in the turn" };
  if (expectation === "startup-failed") {
    const code = status.startupFailure;
    if (
      code === undefined ||
      tool.state !== "failed" ||
      !tool.output?.startsWith(`Hatch failed (${code}):`)
    )
      return { status: "failed", reason: "Hatch failure receipt and durable status disagree" };
    return { status: "passed", startupFailure: code };
  }
  if (
    snapshot.runtimeStopped !== false ||
    tool.state !== "completed" ||
    status.status !== "configured" ||
    status.startupFailure !== undefined ||
    status.desiredStatus !== "open" ||
    status.observedStatus !== "running" ||
    status.exposure !== "active" ||
    status.lastHealthyAt === undefined ||
    !["ensure", "status"].some(
      (operation) =>
        tool.output ===
        `Hatch ${operation}: running.\nLocal process: running.\nscotty-hatch:${status.hatchId}`,
    )
  )
    return { status: "failed", reason: "Hatch receipt does not match a healthy public status" };
  return { status: "passed", hatchId: status.hatchId };
};

const readCodexSnapshot = Effect.fnUntraced(function* (
  manifest: Manifest,
  sessionId: string,
  scenario: LifecycleScenario = "codex-workflow",
) {
  const raw = yield* runRecordedCli(
    manifest,
    scenario,
    ["inspect", sessionId, "--json"],
    sessionId,
    undefined,
    true,
  );
  const snapshot = yield* decodeCodexInspectJson(raw).pipe(
    Effect.mapError((cause) => failure(cause, "Scotty CLI returned invalid Codex conversation")),
  );
  if (snapshot.id !== sessionId)
    return yield* new LabFailure({ message: "Codex inspect returned a different session" });
  return snapshot;
});

const awaitCodexTerminal = Effect.fnUntraced(function* (
  manifest: Manifest,
  sessionId: string,
  expectedTurnId: string | undefined,
  commandMarker: string,
  replyMarker: string,
  expectedUserMarker?: string,
) {
  const deadline = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) + 120_000;
  while (true) {
    const snapshot = yield* readCodexSnapshot(manifest, sessionId);
    const proof = codexTerminalProof(
      snapshot,
      expectedTurnId,
      commandMarker,
      replyMarker,
      expectedUserMarker,
    );
    if (proof.status === "passed") return proof.turnId;
    if (proof.status === "failed") return yield* new LabFailure({ message: proof.reason });
    if ((yield* Effect.clockWith((clock) => clock.currentTimeMillis)) >= deadline)
      return yield* new LabFailure({ message: "Codex terminal deadline exceeded" });
    yield* Effect.sleep("1 second");
  }
});

const awaitCodexRunningCommand = Effect.fnUntraced(function* (
  manifest: Manifest,
  sessionId: string,
  turnId: string,
  commandMarker: string,
) {
  const deadline = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) + 120_000;
  while (true) {
    const snapshot = yield* readCodexSnapshot(manifest, sessionId);
    if (snapshot.runtimeStopped !== false)
      return yield* new LabFailure({ message: "Codex runtime stopped during active command" });
    const turn = snapshot.turns.find(({ id }) => id === turnId);
    if (turn?.state === "streaming") {
      if (
        turn.tools.some(
          (tool) =>
            tool.state === "running" &&
            tool.invocation.includes("sleep") &&
            tool.invocation.includes(commandMarker),
        )
      )
        return;
    } else if (turn?.state === "completed" || turn?.state === "aborted" || turn?.state === "failed")
      return yield* new LabFailure({ message: "Codex active command ended before controls" });
    if ((yield* Effect.clockWith((clock) => clock.currentTimeMillis)) >= deadline)
      return yield* new LabFailure({ message: "Codex active command deadline exceeded" });
    yield* Effect.sleep("1 second");
  }
});

const awaitCodexInterrupted = Effect.fnUntraced(function* (
  manifest: Manifest,
  sessionId: string,
  turnId: string,
) {
  const deadline = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) + 120_000;
  while (true) {
    const snapshot = yield* readCodexSnapshot(manifest, sessionId);
    if (snapshot.runtimeStopped !== false)
      return yield* new LabFailure({ message: "Codex runtime stopped after interrupt" });
    const turn = snapshot.turns.find(({ id }) => id === turnId);
    if (turn?.state === "aborted") return;
    if (turn?.state === "completed" || turn?.state === "failed")
      return yield* new LabFailure({ message: "Codex active turn did not abort" });
    if ((yield* Effect.clockWith((clock) => clock.currentTimeMillis)) >= deadline)
      return yield* new LabFailure({ message: "Codex interrupted turn deadline exceeded" });
    yield* Effect.sleep("1 second");
  }
});

const vaporize = Effect.fnUntraced(function* (
  manifest: Manifest,
  sessionId: string,
  fault?: Fault,
) {
  const startedAt = yield* nowIso;
  const ownedId = yield* requireOwnedSession(manifest, "vaporize", sessionId, startedAt);
  yield* requestedFaultUnavailable(manifest, "vaporize", fault, startedAt, ownedId);
  const operation = yield* decodeOperation(
    yield* runRecordedCli(manifest, "vaporize", ["vaporize", ownedId, "--yes", "--json"], ownedId),
  );
  const diagnostics = yield* captureActorDiagnostics(manifest, "vaporize", ownedId);
  if (operation.id !== ownedId || operation.status !== "gone")
    return yield* failScenario(manifest, {
      scenario: "vaporize",
      status: "failed",
      startedAt,
      finishedAt: yield* nowIso,
      sessionId: ownedId,
      reason: "Vaporize did not return the owned session as gone.",
    });
  yield* attempt("Vaporize actor authority did not settle gone", () =>
    assertStableActorObservation(diagnostics, "Gone"),
  );
  return yield* finishScenario(manifest, "vaporize", startedAt, ownedId);
});

const printLifecycleResult = (manifest: Manifest, result: ScenarioResult) =>
  Effect.sync(() =>
    process.stdout.write(`${JSON.stringify({ runId: manifest.runId, ...result })}\n`),
  );

const lifecycleOperation = <A>(operation: (manifest: Manifest) => Effect.Effect<A, LabFailure>) =>
  withLifecycleLock(
    Effect.gen(function* () {
      const manifest = yield* attempt("Unable to resolve the active lab run", activeRunManifest);
      return { manifest, value: yield* operation(manifest) };
    }),
  );

const createAndReadyLab = (repo: string, fault?: Fault) =>
  lifecycleOperation((manifest) => createAndReady(manifest, repo, fault)).pipe(
    Effect.flatMap(({ manifest, value }) => printLifecycleResult(manifest, value.result)),
  );

const checkpointLab = (sessionId: string, fault?: Fault) =>
  lifecycleOperation((manifest) => checkpoint(manifest, sessionId, fault)).pipe(
    Effect.flatMap(({ manifest, value }) => printLifecycleResult(manifest, value)),
  );

const sleepResumeLab = (sessionId: string, fault?: Fault) =>
  lifecycleOperation((manifest) => sleepResume(manifest, sessionId, fault)).pipe(
    Effect.flatMap(({ manifest, value }) => printLifecycleResult(manifest, value)),
  );

const hatchObserve = Effect.fnUntraced(function* (
  manifest: Manifest,
  sessionId: string,
  turnId: string,
  expectation: HatchExpectation,
) {
  const startedAt = yield* nowIso;
  const ownedId = yield* requireOwnedSession(manifest, "hatch-observe", sessionId, startedAt);
  const snapshot = yield* readCodexSnapshot(manifest, ownedId, "hatch-observe");
  const requestStartedAt = yield* nowIso;
  const response = yield* attemptPromise("Unable to read public Hatch status", (signal) =>
    readHatchStatus(manifest, ownedId, signal),
  );
  const requestFinishedAt = yield* nowIso;
  yield* attempt("Unable to persist Hatch status evidence", () =>
    appendEvidenceCommand(manifest, {
      scenario: "hatch-observe",
      argv: ["GET", `/api/sessions/${ownedId}/hatch`],
      startedAt: requestStartedAt,
      finishedAt: requestFinishedAt,
      stdout: response.body,
      stderr: "",
      exitCode: response.status === 200 ? 0 : 1,
      signal: null,
      sessionId: ownedId,
      sessionOwned: true,
    }),
  );
  if (response.status !== 200)
    return yield* failScenario(manifest, {
      scenario: "hatch-observe",
      status: "failed",
      startedAt,
      finishedAt: yield* nowIso,
      sessionId: ownedId,
      reason: `Public Hatch status returned HTTP ${response.status}`,
    });
  const status = yield* decodeHatchStatusJson(response.body).pipe(
    Effect.mapError((cause) => failure(cause, "Public Hatch status was invalid")),
  );
  const proof = hatchObservationProof(snapshot, status, turnId, expectation);
  if (proof.status === "failed")
    return yield* failScenario(manifest, {
      scenario: "hatch-observe",
      status: "failed",
      startedAt,
      finishedAt: yield* nowIso,
      sessionId: ownedId,
      reason: proof.reason,
    });
  const result: ScenarioResult = {
    scenario: "hatch-observe",
    status: "succeeded",
    startedAt,
    finishedAt: yield* nowIso,
    sessionId: ownedId,
    hatchProof: {
      turnId,
      expectation,
      ...(proof.hatchId === undefined ? {} : { hatchId: proof.hatchId }),
      ...(proof.startupFailure === undefined ? {} : { startupFailure: proof.startupFailure }),
    },
  };
  yield* persistScenarioResult(manifest, result);
  return result;
});

const hatchObserveLab = (sessionId: string, turnId: string, expectation: HatchExpectation) =>
  lifecycleOperation((manifest) => hatchObserve(manifest, sessionId, turnId, expectation)).pipe(
    Effect.flatMap(({ manifest, value }) => printLifecycleResult(manifest, value)),
  );

const runtimeLossLab = (sessionId: string, fault?: Fault) =>
  lifecycleOperation((manifest) => unavailableScenario(manifest, "runtime-loss", sessionId, fault));

const hardCapLab = (sessionId: string, fault?: Fault) =>
  lifecycleOperation((manifest) => unavailableScenario(manifest, "hard-cap", sessionId, fault));

const vaporizeLab = (sessionId: string, fault?: Fault) =>
  lifecycleOperation((manifest) => vaporize(manifest, sessionId, fault)).pipe(
    Effect.flatMap(({ manifest, value }) => printLifecycleResult(manifest, value)),
  );

type CodexCheckpointDiagnostics = Pick<
  typeof SessionActorDiagnosticsSchema.Type,
  "authority" | "journalSequence" | "journal"
>;

const warmCodexReadiness = (diagnostics: Pick<CodexCheckpointDiagnostics, "authority">) => {
  const state = diagnostics.authority.state;
  return AuthorityStateSchema.guards.Stable(state) && StableStateSchema.guards.Warm(state.stable)
    ? state.stable.readiness
    : undefined;
};

// oxlint-disable-next-line eslint/complexity -- checkpoint proof must jointly fence backup identity, native thread, and matching journal completion
export const codexCheckpointProof = (
  before: CodexCheckpointDiagnostics,
  after: CodexCheckpointDiagnostics,
) => {
  const prior = warmCodexReadiness(before);
  const restored = warmCodexReadiness(after);
  const state = after.authority.state;
  if (
    prior === undefined ||
    restored === undefined ||
    !AuthorityStateSchema.guards.Stable(state) ||
    !StableStateSchema.guards.Warm(state.stable)
  )
    return undefined;
  const backup = state.stable.backups.confirmed;
  const priorState = before.authority.state;
  const previousBackup =
    AuthorityStateSchema.guards.Stable(priorState) &&
    StableStateSchema.guards.Warm(priorState.stable)
      ? priorState.stable.backups.confirmed
      : null;
  if (
    backup === null ||
    backup === undefined ||
    backup.confirmedAt === null ||
    backup.backupId === previousBackup?.backupId ||
    backup.sourceRuntimeGeneration !== prior.runtime.runtimeGeneration ||
    backup.codex?.threadId !== prior.supervisor.supervisorEpoch ||
    backup.codex?.initialTurnId !== prior.transport.transportId ||
    restored.supervisor.supervisorEpoch !== prior.supervisor.supervisorEpoch ||
    restored.runtime.runtimeGeneration !== prior.runtime.runtimeGeneration ||
    state.stable.backups.currentBackupId !== backup.backupId ||
    !state.stable.backups.ownedBackupIds.includes(backup.backupId) ||
    after.journalSequence <= before.journalSequence ||
    !after.journal.some(
      (event) =>
        event.sequence > before.journalSequence &&
        event.eventType === "completed" &&
        event.transitionKind === "Checkpoint" &&
        event.causeAttempt === backup.backupId,
    )
  )
    return undefined;
  return { backupId: backup.backupId, threadId: restored.supervisor.supervisorEpoch };
};

const codexResumeContinuity = (
  before: typeof CodexInspectOutput.Type,
  after: typeof CodexInspectOutput.Type,
  beforeAuthority: typeof SessionActorDiagnosticsSchema.Type,
  afterAuthority: typeof SessionActorDiagnosticsSchema.Type,
  queuedTurnId: string,
) => {
  const prior = warmCodexReadiness(beforeAuthority);
  const resumed = warmCodexReadiness(afterAuthority);
  return (
    prior !== undefined &&
    resumed !== undefined &&
    prior.supervisor.supervisorEpoch === resumed.supervisor.supervisorEpoch &&
    prior.runtime.runtimeGeneration !== resumed.runtime.runtimeGeneration &&
    before.transport.epoch !== after.transport.epoch &&
    after.turns.some(
      ({ id, tools }) =>
        id === queuedTurnId &&
        tools.some(
          ({ output, state }) =>
            state === "completed" && output?.includes("SCOTTY_LAB_CODEX_QUEUED") === true,
        ),
    )
  );
};

const proveCodexSleepResume = Effect.fnUntraced(function* (
  manifest: Manifest,
  sessionId: string,
  queuedTurnId: string,
) {
  const beforeCheckpoint = yield* captureActorDiagnostics(manifest, "codex-workflow", sessionId);
  const beforeCheckpointSnapshot = yield* readCodexSnapshot(manifest, sessionId);
  yield* checkpoint(manifest, sessionId);
  const afterCheckpoint = yield* captureActorDiagnostics(manifest, "codex-workflow", sessionId);
  const afterCheckpointSnapshot = yield* readCodexSnapshot(manifest, sessionId);
  const checkpointProof = codexCheckpointProof(beforeCheckpoint, afterCheckpoint);
  const queuedBefore = beforeCheckpointSnapshot.turns.find(({ id }) => id === queuedTurnId);
  const queuedAfter = afterCheckpointSnapshot.turns.find(({ id }) => id === queuedTurnId);
  if (
    checkpointProof === undefined ||
    queuedBefore?.state !== "completed" ||
    queuedAfter?.state !== "completed" ||
    !queuedAfter.tools.some(
      ({ state, output }) =>
        state === "completed" && output?.includes("SCOTTY_LAB_CODEX_QUEUED") === true,
    )
  )
    return yield* new LabFailure({
      message: "Codex checkpoint lacked a fresh confirmed backup or prior native turn",
    });
  const checkpointRaw = yield* runRecordedCli(
    manifest,
    "codex-workflow",
    [
      "steer",
      sessionId,
      "Run printf SCOTTY_LAB_CODEX_CHECKPOINTED once, then reply SCOTTY_LAB_CODEX_CHECKPOINT_DONE. Do not change files.",
      "--json",
    ],
    sessionId,
  );
  const checkpointReceipt = yield* decodeSteerJson(checkpointRaw).pipe(
    Effect.mapError((cause) => failure(cause, "Codex post-checkpoint admission was invalid")),
  );
  const checkpointTurnId = acceptedCodexTurnId(checkpointReceipt, sessionId, "message");
  if (checkpointTurnId === undefined || checkpointTurnId === queuedTurnId)
    return yield* new LabFailure({ message: "Codex post-checkpoint turn was not admitted" });
  yield* awaitCodexTerminal(
    manifest,
    sessionId,
    checkpointTurnId,
    "SCOTTY_LAB_CODEX_CHECKPOINTED",
    "SCOTTY_LAB_CODEX_CHECKPOINT_DONE",
  );
  const before = yield* readCodexSnapshot(manifest, sessionId);
  const beforeAuthority = yield* captureActorDiagnostics(manifest, "codex-workflow", sessionId);
  if (warmCodexReadiness(beforeAuthority) === undefined)
    return yield* new LabFailure({ message: "Codex was not warm before sleep" });
  yield* sleepResume(manifest, sessionId);
  const afterAuthority = yield* captureActorDiagnostics(manifest, "codex-workflow", sessionId);
  const after = yield* readCodexSnapshot(manifest, sessionId);
  if (!codexResumeContinuity(before, after, beforeAuthority, afterAuthority, queuedTurnId))
    return yield* new LabFailure({
      message: "Codex resume did not preserve the thread and prior command",
    });
  const raw = yield* runRecordedCli(
    manifest,
    "codex-workflow",
    [
      "steer",
      sessionId,
      "Run printf SCOTTY_LAB_CODEX_RESUMED once, then reply SCOTTY_LAB_CODEX_RESUME_DONE and mention the earlier SCOTTY_LAB_CODEX_QUEUED marker. Do not change files.",
      "--json",
    ],
    sessionId,
  );
  const receipt = yield* decodeSteerJson(raw).pipe(
    Effect.mapError((cause) => failure(cause, "Codex resumed turn receipt was invalid")),
  );
  const resumedTurnId = acceptedCodexTurnId(receipt, sessionId, "message");
  if (resumedTurnId === undefined || resumedTurnId === queuedTurnId)
    return yield* new LabFailure({ message: "Codex resumed turn was not admitted" });
  yield* awaitCodexTerminal(
    manifest,
    sessionId,
    resumedTurnId,
    "SCOTTY_LAB_CODEX_RESUMED",
    "SCOTTY_LAB_CODEX_RESUME_DONE",
  );
  return { resumedTurnId, checkpointTurnId, checkpointBackupId: checkpointProof.backupId };
});

export const internalPeerReadValidator = (peerId: string): string =>
  [
    'const cp=require("child_process")',
    `const i=JSON.parse(cp.execFileSync("scotty",["inspect","${peerId}","--json"],{encoding:"utf8"}))`,
    `const r=JSON.parse(cp.execFileSync("scotty",["read","${peerId}","--json"],{encoding:"utf8"}))`,
    'const t=i.turns?.find(x=>x.user?.includes("SCOTTY_LAB_PEER_INITIAL"))',
    `if(i.id!=="${peerId}"||r.id!==i.id||r.epoch!==i.transport?.epoch||!Number.isInteger(r.sequence)||t?.state!=="completed"||!t.assistant?.includes("SCOTTY_LAB_PEER_READY")||!r.messages?.some(x=>x.role==="assistant"&&x.content?.includes("SCOTTY_LAB_PEER_READY")))process.exit(1)`,
    "console.log(JSON.stringify({id:i.id,epoch:r.epoch,initialTurnId:t.id,readSequence:r.sequence}))",
  ].join(";");

// oxlint-disable-next-line eslint/complexity -- lab host correlates source CLI receipts with peer native turn and actor observations
const proveInternalPeerControl = Effect.fnUntraced(function* (
  manifest: Manifest,
  sourceId: string,
  repo: string,
) {
  const createPrompt = `Run one shell command exactly: scotty beam 'Run printf SCOTTY_LAB_PEER_INITIAL once, then reply SCOTTY_LAB_PEER_READY. Do not change files.' --title 'Scotty peer lab' --repo ${repo} --provider cloudflare --agent codex --model gpt-5.6-sol --effort medium --cap 30m --detach --json && printf SCOTTY_LAB_PEER_CREATE. Then reply SCOTTY_LAB_PEER_CREATED. Do not change files.`;
  const raw = yield* runRecordedCli(
    manifest,
    "codex-workflow",
    ["steer", sourceId, createPrompt, "--json"],
    sourceId,
  );
  const admitted = yield* decodeSteerJson(raw).pipe(
    Effect.mapError((cause) => failure(cause, "Internal peer command admission was invalid")),
  );
  const turnId = acceptedCodexTurnId(admitted, sourceId, "message");
  if (turnId === undefined)
    return yield* new LabFailure({ message: "Internal peer command was not admitted" });
  yield* awaitCodexTerminal(
    manifest,
    sourceId,
    turnId,
    "SCOTTY_LAB_PEER_CREATE",
    "SCOTTY_LAB_PEER_CREATED",
  );
  const snapshot = yield* readCodexSnapshot(manifest, sourceId);
  const turn = snapshot.turns.find(({ id }) => id === turnId);
  const output = turn?.tools.find(({ invocation }) => invocation.includes("scotty beam"))?.output;
  const identityLine = output?.split("\n").find((line) => line.startsWith('{"id":'));
  if (identityLine === undefined)
    return yield* new LabFailure({ message: "Internal peer creation receipt was not observable" });
  const peer = yield* decodeSessionIdentityJson(identityLine).pipe(
    Effect.mapError((cause) => failure(cause, "Internal peer creation receipt was invalid")),
  );
  const peerId = yield* attempt("Internal peer ID was invalid", () =>
    assertLifecycleSessionId(peer.id),
  );
  if (peerId === sourceId)
    return yield* new LabFailure({ message: "Internal peer creation returned the source ID" });
  const ownershipRecordedAt = yield* nowIso;
  yield* attempt("Unable to record peer ownership", () =>
    recordOwnedSession(manifest, peerId, ownershipRecordedAt),
  );
  const peerInitialTurnId = yield* awaitCodexTerminal(
    manifest,
    peerId,
    undefined,
    "SCOTTY_LAB_PEER_INITIAL",
    "SCOTTY_LAB_PEER_READY",
    "SCOTTY_LAB_PEER_INITIAL",
  );
  const peerDiagnostics = yield* captureActorDiagnostics(manifest, "codex-workflow", peerId);
  const peerReadiness = warmCodexReadiness(peerDiagnostics);
  const sourceDiagnostics = yield* captureActorDiagnostics(manifest, "codex-workflow", sourceId);
  const sourceReadiness = warmCodexReadiness(sourceDiagnostics);
  if (
    peerReadiness === undefined ||
    sourceReadiness === undefined ||
    peerDiagnostics.authority.session.selection?.agent !== "codex" ||
    peerReadiness.runtime.providerRuntimeId === sourceReadiness.runtime.providerRuntimeId
  )
    return yield* new LabFailure({
      message: "Internal peer did not have distinct warm Codex authority",
    });
  const validateRead = internalPeerReadValidator(peerId);
  const readPrompt = `Run one shell command exactly: node -e '${validateRead}' && scotty steer ${peerId} 'Run printf SCOTTY_LAB_PEER_FOLLOWUP once, then reply SCOTTY_LAB_PEER_DONE. Do not change files.' --json && printf SCOTTY_LAB_PEER_READ. Then reply SCOTTY_LAB_PEER_VISIBLE. Do not change files.`;
  const readRaw = yield* runRecordedCli(
    manifest,
    "codex-workflow",
    ["steer", sourceId, readPrompt, "--json"],
    sourceId,
  );
  const readReceipt = yield* decodeSteerJson(readRaw).pipe(
    Effect.mapError((cause) => failure(cause, "Internal peer read admission was invalid")),
  );
  const readTurnId = acceptedCodexTurnId(readReceipt, sourceId, "message");
  if (readTurnId === undefined)
    return yield* new LabFailure({ message: "Internal peer read was not admitted" });
  yield* awaitCodexTerminal(
    manifest,
    sourceId,
    readTurnId,
    "SCOTTY_LAB_PEER_READ",
    "SCOTTY_LAB_PEER_VISIBLE",
  );
  const readSnapshot = yield* readCodexSnapshot(manifest, sourceId);
  const readTurn = readSnapshot.turns.find(({ id }) => id === readTurnId);
  const readTool = readTurn?.tools.find(({ invocation }) => invocation.includes("node -e"));
  const lines = readTool?.output?.split("\n").filter((line) => line.startsWith('{"id":'));
  if (
    lines?.length !== 2 ||
    !readTool?.invocation.includes(`scotty steer ${peerId}`) ||
    !readTool?.invocation.includes(`"inspect","${peerId}"`) ||
    !readTool?.invocation.includes(`"read","${peerId}"`)
  )
    return yield* new LabFailure({
      message: "Internal peer inspect/read/steer receipts were not observable",
    });
  const read = yield* decodeInternalPeerReadReceipt(lines[0]).pipe(
    Effect.mapError((cause) => failure(cause, "Internal peer inspect/read receipt was invalid")),
  );
  const steered = yield* decodeSteerJson(lines[1]).pipe(
    Effect.mapError((cause) => failure(cause, "Internal peer steer was invalid")),
  );
  if (
    read.id !== peerId ||
    read.initialTurnId !== peerInitialTurnId ||
    read.epoch !== peerReadiness.runtime.runtimeGeneration ||
    read.readSequence < 1 ||
    steered.id !== peerId ||
    steered.status !== "accepted" ||
    acceptedCodexTurnId(steered, peerId, "message") === undefined
  )
    return yield* new LabFailure({ message: "Internal peer control receipts missed the peer" });
  const peerFollowUpTurnId = acceptedCodexTurnId(steered, peerId, "message");
  if (peerFollowUpTurnId === undefined || peerFollowUpTurnId === peerInitialTurnId)
    return yield* new LabFailure({ message: "Internal peer follow-up was not a new native turn" });
  yield* awaitCodexTerminal(
    manifest,
    peerId,
    peerFollowUpTurnId,
    "SCOTTY_LAB_PEER_FOLLOWUP",
    "SCOTTY_LAB_PEER_DONE",
  );
  const peerAfter = yield* captureActorDiagnostics(manifest, "codex-workflow", peerId);
  if (
    warmCodexReadiness(peerAfter)?.supervisor.supervisorEpoch !==
    peerReadiness.supervisor.supervisorEpoch
  )
    return yield* new LabFailure({
      message: "Internal peer native thread changed after follow-up",
    });
  return { peerId, peerInitialTurnId, peerFollowUpTurnId };
});

const codexWorkflowLab = (repo: string, fault?: Fault) =>
  lifecycleOperation((manifest) =>
    Effect.gen(function* () {
      const startedAt = yield* nowIso;
      yield* requestedFaultUnavailable(manifest, "codex-workflow", fault, startedAt);
      const created = yield* Effect.result(createAndReady(manifest, repo, undefined, true));
      if (Result.isFailure(created))
        return yield* failScenario(manifest, {
          scenario: "codex-workflow",
          status: "failed",
          startedAt,
          finishedAt: yield* nowIso,
          ...(created.failure.sessionId === undefined
            ? {}
            : { sessionId: created.failure.sessionId }),
          reason: created.failure.message,
        });
      const sessionId = created.success.sessionId;
      const driven = yield* Effect.result(
        Effect.gen(function* () {
          const viewResponse = yield* attemptPromise(
            "Unable to read Codex session selection",
            (signal) => readSessionView(manifest, sessionId, signal),
          );
          if (viewResponse.status !== 200)
            return yield* new LabFailure({ message: "Codex session view was unavailable" });
          const view = yield* decodeUiSessionJson(viewResponse.body).pipe(
            Effect.mapError((cause) => failure(cause, "Codex session view was invalid")),
          );
          if (
            view.session.identity.id !== sessionId ||
            view.session.selection?.agent !== "codex" ||
            view.session.selection.model !== "gpt-5.6-sol" ||
            view.session.selection.effort !== "medium"
          )
            return yield* new LabFailure({
              message: "Codex selection did not match the requested profile",
            });
          const initialTurnId = yield* awaitCodexTerminal(
            manifest,
            sessionId,
            undefined,
            "SCOTTY_LAB_CODEX_INITIAL",
            "SCOTTY_LAB_CODEX_READY",
          );
          const peer = yield* proveInternalPeerControl(manifest, sessionId, repo);
          const receiptJson = yield* runRecordedCli(
            manifest,
            "codex-workflow",
            [
              "steer",
              sessionId,
              "Run printf SCOTTY_LAB_CODEX_FOLLOWUP once, then reply SCOTTY_LAB_CODEX_DONE. Do not change files.",
              "--json",
            ],
            sessionId,
          );
          const receipt = yield* decodeSteerJson(receiptJson).pipe(
            Effect.mapError((cause) =>
              failure(cause, "Scotty CLI returned invalid Codex steer receipt"),
            ),
          );
          const admittedTurnId = acceptedCodexTurnId(receipt, sessionId, "message");
          if (admittedTurnId === undefined || admittedTurnId === initialTurnId)
            return yield* new LabFailure({
              message: "Codex follow-up was not admitted as a new turn",
            });
          const followUpTurnId = yield* awaitCodexTerminal(
            manifest,
            sessionId,
            admittedTurnId,
            "SCOTTY_LAB_CODEX_FOLLOWUP",
            "SCOTTY_LAB_CODEX_DONE",
          );
          const activeJson = yield* runRecordedCli(
            manifest,
            "codex-workflow",
            [
              "steer",
              sessionId,
              "Run sleep 20; printf SCOTTY_LAB_CODEX_INTERRUPTED as one shell command, then reply SCOTTY_LAB_CODEX_LATE. Do not change files.",
              "--json",
            ],
            sessionId,
          );
          const active = yield* decodeSteerJson(activeJson).pipe(
            Effect.mapError((cause) => failure(cause, "Codex active turn receipt was invalid")),
          );
          const activeTurnId = acceptedCodexTurnId(active, sessionId, "message");
          if (activeTurnId === undefined || activeTurnId === followUpTurnId)
            return yield* new LabFailure({ message: "Codex active turn was not admitted" });
          const interruptedTurnId = activeTurnId;
          yield* awaitCodexRunningCommand(
            manifest,
            sessionId,
            interruptedTurnId,
            "SCOTTY_LAB_CODEX_INTERRUPTED",
          );
          const steerJson = yield* runRecordedCli(
            manifest,
            "codex-workflow",
            ["steer", sessionId, "After the command, reply SCOTTY_LAB_CODEX_STEER_SEEN.", "--json"],
            sessionId,
          );
          const steered = yield* decodeSteerJson(steerJson).pipe(
            Effect.mapError((cause) => failure(cause, "Codex active steer receipt was invalid")),
          );
          if (acceptedCodexTurnId(steered, sessionId, "steer") !== interruptedTurnId)
            return yield* new LabFailure({ message: "Codex active steer missed the running turn" });
          const queuedMessageId = `scotty-lab-${manifest.runId}`;
          const queuedJson = yield* runRecordedCli(
            manifest,
            "codex-workflow",
            [
              "steer",
              sessionId,
              "Run printf SCOTTY_LAB_CODEX_QUEUED once, then reply SCOTTY_LAB_CODEX_QUEUE_DONE. Do not change files.",
              "--follow-up",
              "--idempotency-key",
              queuedMessageId,
              "--json",
            ],
            sessionId,
          );
          const queued = yield* decodeSteerJson(queuedJson).pipe(
            Effect.mapError((cause) =>
              failure(cause, "Codex queued follow-up receipt was invalid"),
            ),
          );
          if (acceptedCodexQueueId(queued, sessionId) !== queuedMessageId)
            return yield* new LabFailure({ message: "Codex queued follow-up was not admitted" });
          const pending = yield* readCodexSnapshot(manifest, sessionId);
          if (!pending.queue.followUp.some(({ id }) => id === queuedMessageId))
            return yield* new LabFailure({ message: "Codex queued follow-up was not observable" });
          const interruptJson = yield* runRecordedCli(
            manifest,
            "codex-workflow",
            ["interrupt", sessionId, "--json"],
            sessionId,
          );
          const interrupted = yield* decodeInterruptJson(interruptJson).pipe(
            Effect.mapError((cause) => failure(cause, "Codex interrupt receipt was invalid")),
          );
          if (!acceptedCodexInterrupt(interrupted, sessionId, interruptedTurnId))
            return yield* new LabFailure({ message: "Codex interrupt missed the running turn" });
          yield* awaitCodexInterrupted(manifest, sessionId, interruptedTurnId);
          const queuedTurnId = yield* awaitCodexTerminal(
            manifest,
            sessionId,
            undefined,
            "SCOTTY_LAB_CODEX_QUEUED",
            "SCOTTY_LAB_CODEX_QUEUE_DONE",
            "SCOTTY_LAB_CODEX_QUEUED",
          );
          if (queuedTurnId === interruptedTurnId)
            return yield* new LabFailure({ message: "Codex queued work reused interrupted turn" });
          const resumed = yield* proveCodexSleepResume(manifest, sessionId, queuedTurnId);
          return {
            ...peer,
            initialTurnId,
            followUpTurnId,
            interruptedTurnId,
            queuedTurnId,
            queuedMessageId,
            ...resumed,
          };
        }),
      );
      if (Result.isFailure(driven))
        return yield* failScenario(manifest, {
          scenario: "codex-workflow",
          status: "failed",
          startedAt,
          finishedAt: yield* nowIso,
          sessionId,
          reason: driven.failure.message,
        });
      const peerCleanup = yield* Effect.result(vaporize(manifest, driven.success.peerId));
      if (Result.isFailure(peerCleanup))
        return yield* failScenario(manifest, {
          scenario: "codex-workflow",
          status: "failed",
          startedAt,
          finishedAt: yield* nowIso,
          sessionId,
          reason: `Owned peer cleanup failed: ${peerCleanup.failure.message}`,
        });
      const cleanup = yield* Effect.result(vaporize(manifest, sessionId));
      if (Result.isFailure(cleanup))
        return yield* failScenario(manifest, {
          scenario: "codex-workflow",
          status: "failed",
          startedAt,
          finishedAt: yield* nowIso,
          sessionId,
          reason: `Owned cleanup failed: ${cleanup.failure.message}`,
        });
      return yield* finishScenario(manifest, "codex-workflow", startedAt, sessionId, {
        ...driven.success,
        completedCommands: 9,
        internalPeerControl: true,
        activeSteer: true,
        interruptAccepted: true,
        sleepResumeContinuity: true,
        runtimeStopped: false,
        model: "gpt-5.6-sol",
        effort: "medium",
      });
    }),
  ).pipe(Effect.flatMap(({ manifest, value }) => printLifecycleResult(manifest, value)));

const fullLifecycleLab = (repo: string, fault?: Fault) =>
  lifecycleOperation((manifest) =>
    Effect.gen(function* () {
      const startedAt = yield* nowIso;
      yield* requestedFaultUnavailable(manifest, "full", fault, startedAt);
      const created = yield* createAndReady(manifest, repo);
      yield* checkpoint(manifest, created.sessionId);
      yield* sleepResume(manifest, created.sessionId);
      yield* vaporize(manifest, created.sessionId);
      return yield* finishScenario(manifest, "full", startedAt, created.sessionId);
    }),
  ).pipe(Effect.flatMap(({ manifest, value }) => printLifecycleResult(manifest, value)));

const stopLab = Effect.fnUntraced(function* (runId: string) {
  const stop = Effect.gen(function* () {
    const manifest = yield* attempt("Unable to read the lab", () => stopManifest(runId));
    const processResult = yield* attemptPromise("Unable to stop the lab process", () =>
      terminateManifestProcess(manifest),
    );
    const errors = processResult.error ? [processResult.error] : [];
    yield* appendFailure(
      errors,
      attempt("Unable to preserve the lab Worker log", () => preserveWorkerLog(manifest)),
    );
    if (processResult.stopped)
      yield* appendFailure(
        errors,
        attempt("Unable to remove the lab Sandbox containers", () =>
          removeWorkerContainers(manifest),
        ),
      );
    if (processResult.stopped && errors.length === 0) {
      errors.push(
        ...(yield* attempt("Unable to remove the lab files", () => cleanupOwnedFiles(manifest))),
      );
    } else if (processResult.stopped) {
      yield* appendFailure(
        errors,
        attempt("Unable to remove the lab temporary root", () => removeOwnedTempRoot(manifest)),
      );
    }
    const cleanupFinishedAt = yield* nowIso;
    yield* appendFailure(
      errors,
      attempt("Unable to persist lab cleanup evidence", () =>
        recordCleanupResult(manifest, {
          status: errors.length === 0 ? "succeeded" : "cleanup-pending",
          finishedAt: cleanupFinishedAt,
          process: processResult.validation.status,
          processStopped: processResult.stopped,
          errors: [...errors],
        }),
      ),
    );
    if (errors.length > 0)
      yield* appendFailure(
        errors,
        attempt("Unable to persist cleanup-pending state", () => markCleanupPending(manifest)),
      );

    yield* Effect.sync(() => {
      process.stdout.write(
        `${JSON.stringify({
          runId,
          status: errors.length === 0 ? "stopped" : "cleanup-pending",
          process: processResult.validation.status,
          errors,
        })}\n`,
      );
      if (errors.length > 0) process.exitCode = 1;
    });
  });
  return yield* withLifecycleLock(stop);
});

export interface LabOperationsShape {
  readonly start: Effect.Effect<void, LabFailure>;
  readonly setup: (runId: string, repo: string) => Effect.Effect<void, LabFailure>;
  readonly exec: (runId: string, argv: ReadonlyArray<string>) => Effect.Effect<void, LabFailure>;
  readonly stop: (runId: string) => Effect.Effect<void, LabFailure>;
  readonly createAndReady: (repo: string, fault?: Fault) => Effect.Effect<void, LabFailure>;
  readonly checkpoint: (sessionId: string, fault?: Fault) => Effect.Effect<void, LabFailure>;
  readonly sleepResume: (sessionId: string, fault?: Fault) => Effect.Effect<void, LabFailure>;
  readonly hatchObserve: (
    sessionId: string,
    turnId: string,
    expectation: HatchExpectation,
  ) => Effect.Effect<void, LabFailure>;
  readonly runtimeLoss: (sessionId: string, fault?: Fault) => Effect.Effect<unknown, LabFailure>;
  readonly hardCap: (sessionId: string, fault?: Fault) => Effect.Effect<unknown, LabFailure>;
  readonly vaporize: (sessionId: string, fault?: Fault) => Effect.Effect<void, LabFailure>;
  readonly codexWorkflow: (repo: string, fault?: Fault) => Effect.Effect<void, LabFailure>;
  readonly full: (repo: string, fault?: Fault) => Effect.Effect<unknown, LabFailure>;
}

export class LabOperations extends Context.Service<LabOperations, LabOperationsShape>()(
  "scotty-lab/LabOperations",
) {}

const productionOperations = Layer.succeed(LabOperations, {
  start: startLab(),
  setup: setupLab,
  exec: executeLab,
  stop: stopLab,
  createAndReady: createAndReadyLab,
  checkpoint: checkpointLab,
  sleepResume: sleepResumeLab,
  hatchObserve: hatchObserveLab,
  runtimeLoss: runtimeLossLab,
  hardCap: hardCapLab,
  vaporize: vaporizeLab,
  codexWorkflow: codexWorkflowLab,
  full: fullLifecycleLab,
});

const runIdArgument = Argument.string("RUN_ID").pipe(
  Argument.filter(
    (value) => RUN_ID_PATTERN.test(value),
    () => "Lab run ID is invalid",
  ),
);
const extrasArgument = Argument.string("extra").pipe(Argument.variadic());
const sessionIdFlag = Flag.string("session");
const faultFlag = Flag.choice("fault", FAULTS).pipe(Flag.optional);

const rejectExtras = (extras: ReadonlyArray<string>): Effect.Effect<void, LabUsageError> =>
  extras.length === 0 ? Effect.void : Effect.fail(new LabUsageError({ message: USAGE }));

const rejectProtectedSession = (values: ReadonlyArray<string>): Effect.Effect<void, LabFailure> =>
  values.includes(PROTECTED_SESSION_ID)
    ? Effect.fail(
        new LabFailure({
          message: `Session ${PROTECTED_SESSION_ID} is protected and must never be targeted`,
        }),
      )
    : Effect.void;

const startCommand = Command.make("start", { extras: extrasArgument }, ({ extras }) =>
  Effect.gen(function* () {
    yield* rejectExtras(extras);
    const operations = yield* LabOperations;
    yield* operations.start;
  }),
);

const execCommand = Command.make(
  "exec",
  {
    runId: runIdArgument,
    argv: Argument.string("scotty argv").pipe(Argument.variadic({ min: 1 })),
  },
  ({ argv, runId }) =>
    Effect.andThen(
      rejectProtectedSession(argv),
      Effect.flatMap(LabOperations, (operations) => operations.exec(runId, argv)),
    ),
);

const setupCommand = Command.make(
  "setup",
  {
    runId: runIdArgument,
    repo: Flag.string("repo"),
    extras: extrasArgument,
  },
  ({ extras, repo, runId }) =>
    Effect.gen(function* () {
      yield* rejectExtras(extras);
      if (!isRepositoryIdentity(repo))
        return yield* Effect.fail(new LabUsageError({ message: USAGE }));
      const operations = yield* LabOperations;
      yield* operations.setup(runId, repo);
    }),
);

const stopCommand = Command.make(
  "stop",
  { runId: runIdArgument, extras: extrasArgument },
  ({ extras, runId }) =>
    Effect.andThen(
      rejectExtras(extras),
      Effect.flatMap(LabOperations, (operations) => operations.stop(runId)),
    ),
);

const optionalFault = (fault: Option.Option<Fault>): Fault | undefined =>
  Option.getOrUndefined(fault);

const createAndReadyCommand = Command.make(
  "create-and-ready",
  { repo: Flag.string("repo"), fault: faultFlag, extras: extrasArgument },
  ({ extras, fault, repo }) =>
    Effect.gen(function* () {
      yield* rejectExtras(extras);
      if (!isRepositoryIdentity(repo))
        return yield* Effect.fail(new LabUsageError({ message: USAGE }));
      const operations = yield* LabOperations;
      yield* operations.createAndReady(repo, optionalFault(fault));
    }),
);

const lifecycleSessionCommand = (
  name: "checkpoint" | "sleep-resume" | "runtime-loss" | "hard-cap" | "vaporize",
  select: (
    operations: LabOperationsShape,
  ) => (sessionId: string, fault?: Fault) => Effect.Effect<unknown, LabFailure>,
) =>
  Command.make(
    name,
    { sessionId: sessionIdFlag, fault: faultFlag, extras: extrasArgument },
    ({ extras, fault, sessionId }) =>
      Effect.gen(function* () {
        yield* rejectExtras(extras);
        yield* rejectProtectedSession([sessionId]);
        const operations = yield* LabOperations;
        yield* select(operations)(sessionId, optionalFault(fault));
      }),
  );

const checkpointCommand = lifecycleSessionCommand(
  "checkpoint",
  (operations) => operations.checkpoint,
);
const sleepResumeCommand = lifecycleSessionCommand(
  "sleep-resume",
  (operations) => operations.sleepResume,
);
const hatchObserveCommand = Command.make(
  "hatch-observe",
  {
    sessionId: sessionIdFlag,
    turnId: Flag.string("turn"),
    expectation: Flag.choice("expect", ["startup-failed", "ready"]),
    extras: extrasArgument,
  },
  ({ extras, expectation, sessionId, turnId }) =>
    Effect.gen(function* () {
      yield* rejectExtras(extras);
      yield* rejectProtectedSession([sessionId]);
      const operations = yield* LabOperations;
      yield* operations.hatchObserve(sessionId, turnId, expectation);
    }),
);
const runtimeLossCommand = lifecycleSessionCommand(
  "runtime-loss",
  (operations) => operations.runtimeLoss,
);
const hardCapCommand = lifecycleSessionCommand("hard-cap", (operations) => operations.hardCap);
const vaporizeCommand = lifecycleSessionCommand("vaporize", (operations) => operations.vaporize);

const fullCommand = Command.make(
  "full",
  { repo: Flag.string("repo"), fault: faultFlag, extras: extrasArgument },
  ({ extras, fault, repo }) =>
    Effect.gen(function* () {
      yield* rejectExtras(extras);
      if (!isRepositoryIdentity(repo))
        return yield* Effect.fail(new LabUsageError({ message: USAGE }));
      const operations = yield* LabOperations;
      yield* operations.full(repo, optionalFault(fault));
    }),
);

const codexWorkflowCommand = Command.make(
  "codex-workflow",
  { repo: Flag.string("repo"), fault: faultFlag, extras: extrasArgument },
  ({ extras, fault, repo }) =>
    Effect.gen(function* () {
      yield* rejectExtras(extras);
      if (!isRepositoryIdentity(repo))
        return yield* Effect.fail(new LabUsageError({ message: USAGE }));
      const operations = yield* LabOperations;
      yield* operations.codexWorkflow(repo, optionalFault(fault));
    }),
);

const lifecycleCommand = Command.make("lifecycle").pipe(
  Command.withSubcommands([
    createAndReadyCommand,
    checkpointCommand,
    sleepResumeCommand,
    hatchObserveCommand,
    runtimeLossCommand,
    hardCapCommand,
    vaporizeCommand,
    codexWorkflowCommand,
    fullCommand,
  ]),
);

export const labCommand = Command.make("scotty-lab").pipe(
  Command.withSubcommands([startCommand, setupCommand, execCommand, stopCommand, lifecycleCommand]),
);

const requireExecSeparator = (args: ReadonlyArray<string>): Effect.Effect<void, LabUsageError> =>
  args[0] !== "exec" || (args[2] === "--" && args.length > 3)
    ? Effect.void
    : Effect.fail(new LabUsageError({ message: USAGE }));

const silentConsole: Console.Console = Object.assign(Object.create(console), {
  log: () => undefined,
  error: () => undefined,
});

export const runLab = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  yield* requireExecSeparator(args);
  yield* Command.runWith(labCommand, { version: LAB_VERSION, renderErrors: false })(args).pipe(
    Effect.provide(CliConfig.layer({ builtIns: [] })),
    Effect.provideService(CliOutput.Formatter, CliOutput.defaultFormatter({ colors: false })),
    Effect.provideService(Console.Console, silentConsole),
    Effect.catchIf(EffectCliError.isCliError, () =>
      Effect.fail(new LabUsageError({ message: USAGE })),
    ),
  );
});

const reportFailure = (error: LabFailure | LabUsageError): Effect.Effect<void> =>
  Effect.sync(() => {
    // oxlint-disable-next-line scotty/no-unknown-error-message -- boundary: the process adapter renders only Scotty's typed lab error union
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });

if (import.meta.main) {
  runLab(process.argv.slice(2)).pipe(
    Effect.catchTags({ LabFailure: reportFailure, LabUsageError: reportFailure }),
    Effect.provide(NodeServices.layer),
    Effect.provide(productionOperations),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  );
}
