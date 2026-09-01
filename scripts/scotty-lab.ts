#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { ChildProcess } from "node:child_process";
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
import { isRepositoryIdentity } from "../protocol/repository.ts";
import { SessionActorDiagnosticsSchema } from "../worker/src/session-actor/diagnostics.ts";
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

const VERSION = "0.3.3";
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
  | "full";

const SessionOperationOutput = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
});
const SessionIdentityOutput = Schema.Struct({ id: Schema.String });
const decodeSessionOperationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionOperationOutput),
);
const decodeSessionIdentityJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionIdentityOutput),
);
const decodeActorDiagnosticsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionActorDiagnosticsSchema),
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
    prepareCredentialSetup(manifest, repo),
  );
  const child = yield* attempt("Unable to start Scotty credential sync", () =>
    spawnCli(manifest, ["sync", "--json"], {
      PATH: `${setup.credentialBin}:${process.env.PATH ?? ""}`,
    }),
  );
  const result = yield* waitForChild(child);
  yield* Effect.sync(() => {
    if (result.signal) process.kill(process.pid, result.signal);
    else process.exitCode = result.code ?? 1;
  });
});

type ScenarioResult = Readonly<{
  scenario: LifecycleScenario;
  status: "succeeded" | "not-available" | "rejected" | "failed";
  startedAt: string;
  finishedAt: string;
  sessionId?: string;
  reason?: string;
  fault?: Fault;
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

const runRecordedCli = Effect.fnUntraced(function* (
  manifest: Manifest,
  scenario: LifecycleScenario,
  argv: ReadonlyArray<string>,
  sessionId?: string,
  recoverSessionId?: () => Effect.Effect<string, LabFailure>,
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
  yield* attempt("Unable to persist lifecycle command evidence", () =>
    appendEvidenceCommand(manifest, {
      scenario,
      argv,
      startedAt,
      finishedAt,
      stdout,
      stderr,
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
          stderr,
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
) {
  const result: ScenarioResult = {
    scenario,
    status: "succeeded",
    startedAt,
    finishedAt: yield* nowIso,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
  yield* persistScenarioResult(manifest, result);
  return result;
});

const createAndReady = Effect.fnUntraced(function* (
  manifest: Manifest,
  repo: string,
  fault?: Fault,
) {
  const startedAt = yield* nowIso;
  yield* requestedFaultUnavailable(manifest, "create-and-ready", fault, startedAt);
  const request = {
    title: "Scotty lifecycle lab",
    prompt: "Reply with exactly SCOTTY_LAB_READY.",
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
    yield* runRecordedCli(manifest, "checkpoint", ["snapshot", ownedId, "--json"], ownedId),
  );
  const diagnostics = yield* captureActorDiagnostics(manifest, "checkpoint", ownedId);
  if (operation.id !== ownedId || operation.status !== "warm")
    return yield* failScenario(manifest, {
      scenario: "checkpoint",
      status: "failed",
      startedAt,
      finishedAt: yield* nowIso,
      sessionId: ownedId,
      reason: "Snapshot did not return the owned session in warm state.",
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

const runtimeLossLab = (sessionId: string, fault?: Fault) =>
  lifecycleOperation((manifest) => unavailableScenario(manifest, "runtime-loss", sessionId, fault));

const hardCapLab = (sessionId: string, fault?: Fault) =>
  lifecycleOperation((manifest) => unavailableScenario(manifest, "hard-cap", sessionId, fault));

const vaporizeLab = (sessionId: string, fault?: Fault) =>
  lifecycleOperation((manifest) => vaporize(manifest, sessionId, fault)).pipe(
    Effect.flatMap(({ manifest, value }) => printLifecycleResult(manifest, value)),
  );

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
  readonly runtimeLoss: (sessionId: string, fault?: Fault) => Effect.Effect<unknown, LabFailure>;
  readonly hardCap: (sessionId: string, fault?: Fault) => Effect.Effect<unknown, LabFailure>;
  readonly vaporize: (sessionId: string, fault?: Fault) => Effect.Effect<void, LabFailure>;
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
  runtimeLoss: runtimeLossLab,
  hardCap: hardCapLab,
  vaporize: vaporizeLab,
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

const lifecycleCommand = Command.make("lifecycle").pipe(
  Command.withSubcommands([
    createAndReadyCommand,
    checkpointCommand,
    sleepResumeCommand,
    runtimeLossCommand,
    hardCapCommand,
    vaporizeCommand,
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
  yield* Command.runWith(labCommand, { version: VERSION, renderErrors: false })(args).pipe(
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
