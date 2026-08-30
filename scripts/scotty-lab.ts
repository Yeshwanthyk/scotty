#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import type { ChildProcess } from "node:child_process";
import { Console, Context, Data, Effect, Exit, Layer, Predicate, Result } from "effect";
import {
  Argument,
  CliConfig,
  CliError as EffectCliError,
  CliOutput,
  Command,
  Flag,
} from "effect/unstable/cli";
import { isRepositoryIdentity } from "../protocol/repository.ts";
import {
  acquireLifecycleLock,
  awaitWrangler,
  cleanupOwnedFiles,
  completeStart,
  createStartReservation,
  execManifest,
  launchWrangler,
  markCleanupPending,
  prepareCredentialSetup,
  prepareStart,
  releaseLifecycleLock,
  removeOwnedTempRoot,
  removeWorkerContainers,
  spawnCli,
  startupFailureDetails,
  stopManifest,
  terminateStartedWrangler,
  terminateManifestProcess,
} from "./scotty-lab.mjs";

const VERSION = "0.3.3";
const USAGE =
  "Usage: npm run lab -- start | setup RUN_ID --repo OWNER/REPO | exec RUN_ID -- <scotty argv> | stop RUN_ID";
const RUN_ID_PATTERN = /^lab-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type Manifest = ReturnType<typeof createStartReservation>;
type Started = Awaited<ReturnType<typeof launchWrangler>>["started"];
type Prepared = Awaited<ReturnType<typeof prepareStart>>;

export class LabFailure extends Data.TaggedError("LabFailure")<{
  readonly message: string;
  readonly cause?: unknown;
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

const executeLab = Effect.fnUntraced(function* (runId: string, argv: ReadonlyArray<string>) {
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

const stopLab = Effect.fnUntraced(function* (runId: string) {
  const stop = Effect.gen(function* () {
    const manifest = yield* attempt("Unable to read the lab", () => stopManifest(runId));
    const processResult = yield* attemptPromise("Unable to stop the lab process", () =>
      terminateManifestProcess(manifest),
    );
    const errors = processResult.error ? [processResult.error] : [];
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

export class LabOperations extends Context.Service<
  LabOperations,
  {
    readonly start: Effect.Effect<void, LabFailure>;
    readonly setup: (runId: string, repo: string) => Effect.Effect<void, LabFailure>;
    readonly exec: (runId: string, argv: ReadonlyArray<string>) => Effect.Effect<void, LabFailure>;
    readonly stop: (runId: string) => Effect.Effect<void, LabFailure>;
  }
>()("scotty-lab/LabOperations") {}

const productionOperations = Layer.succeed(LabOperations, {
  start: startLab(),
  setup: setupLab,
  exec: executeLab,
  stop: stopLab,
});

const runIdArgument = Argument.string("RUN_ID").pipe(
  Argument.filter(
    (value) => RUN_ID_PATTERN.test(value),
    () => "Lab run ID is invalid",
  ),
);
const extrasArgument = Argument.string("extra").pipe(Argument.variadic());

const rejectExtras = (extras: ReadonlyArray<string>): Effect.Effect<void, LabUsageError> =>
  extras.length === 0 ? Effect.void : Effect.fail(new LabUsageError({ message: USAGE }));

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
  ({ argv, runId }) => Effect.flatMap(LabOperations, (operations) => operations.exec(runId, argv)),
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

export const labCommand = Command.make("scotty-lab").pipe(
  Command.withSubcommands([startCommand, setupCommand, execCommand, stopCommand]),
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
