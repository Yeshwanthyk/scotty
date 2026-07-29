import { Clock, Context, Data, Effect, Layer, Result, Schema } from "effect";
import { sha256Hex } from "./digest";

const RUNNER_AUTHORITY_KEY = "scotty:runner-authority:1";
const RUNNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const RUNNER_CREDENTIAL_PATTERN = /^scotty_runner_[A-Za-z0-9_-]{32,}$/u;

const RunnerRegistrationRecordSchema = Schema.Struct({
  name: Schema.String,
  credentialDigest: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RunnerRegistrationRecord = typeof RunnerRegistrationRecordSchema.Type;

export const RunnerRegistrationViewSchema = Schema.Struct({
  name: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RunnerRegistrationView = typeof RunnerRegistrationViewSchema.Type;

export const RunnerAuthoritySchema = Schema.Struct({
  version: Schema.Literal(1),
  runners: Schema.Array(RunnerRegistrationRecordSchema),
});
export type RunnerAuthority = typeof RunnerAuthoritySchema.Type;

const RunnerRegistrationCandidateSchema = Schema.Struct({
  name: Schema.String,
  credential: Schema.String,
  replace: Schema.Boolean,
});

const RunnerAuthenticationCandidateSchema = Schema.Struct({
  name: Schema.String,
  credential: Schema.String,
});

export interface IssuedRunnerCredential {
  readonly credential: string;
  readonly replaced: boolean;
  readonly runner: RunnerRegistrationView;
}

export type RunnerRegistryFailureReason =
  | "credential_invalid"
  | "invalid_authority"
  | "invalid_input"
  | "runner_exists"
  | "runner_missing"
  | "storage";

export class RunnerRegistryFailure extends Data.TaggedError("RunnerRegistryFailure")<{
  readonly reason: RunnerRegistryFailureReason;
  readonly message: string;
}> {}

export interface RunnerAuthorityTransaction {
  readonly get: () => Promise<unknown | undefined>;
  readonly put: (authority: RunnerAuthority) => Promise<void>;
}

export interface RunnerAuthorityStorage {
  readonly transaction: <A>(
    operation: (transaction: RunnerAuthorityTransaction) => Promise<A>,
  ) => Promise<A>;
}

interface RunnerRegistryShape {
  readonly authenticate: (
    candidate: unknown,
  ) => Effect.Effect<RunnerRegistrationView, RunnerRegistryFailure>;
  readonly get: (name: unknown) => Effect.Effect<RunnerRegistrationView, RunnerRegistryFailure>;
  readonly list: () => Effect.Effect<ReadonlyArray<RunnerRegistrationView>, RunnerRegistryFailure>;
  readonly register: (
    candidate: unknown,
  ) => Effect.Effect<IssuedRunnerCredential, RunnerRegistryFailure>;
  readonly remove: (name: unknown) => Effect.Effect<void, RunnerRegistryFailure>;
}

export class RunnerRegistry extends Context.Service<RunnerRegistry, RunnerRegistryShape>()(
  "scotty/RunnerRegistry",
) {}

export const durableObjectRunnerAuthorityStorage = (
  storage: DurableObjectStorage,
): RunnerAuthorityStorage => ({
  transaction: (operation) =>
    storage.transaction((transaction) =>
      operation({
        get: () => transaction.get(RUNNER_AUTHORITY_KEY),
        put: (authority) => transaction.put(RUNNER_AUTHORITY_KEY, authority),
      }),
    ),
});

export const runnerRegistryLayer = (storage: RunnerAuthorityStorage): Layer.Layer<RunnerRegistry> =>
  Layer.succeed(RunnerRegistry)(makeRunnerRegistry(storage));

const decodeAuthority = Schema.decodeUnknownResult(RunnerAuthoritySchema, {
  onExcessProperty: "error",
});
const decodeRegistrationCandidate = Schema.decodeUnknownResult(RunnerRegistrationCandidateSchema, {
  onExcessProperty: "error",
});
const decodeAuthenticationCandidate = Schema.decodeUnknownResult(
  RunnerAuthenticationCandidateSchema,
  { onExcessProperty: "error" },
);
const decodeRunnerName = Schema.decodeUnknownResult(Schema.String);

const emptyAuthority = (): RunnerAuthority => ({ version: 1, runners: [] });

const makeRunnerRegistry = (storage: RunnerAuthorityStorage): RunnerRegistryShape => {
  const failure = (reason: RunnerRegistryFailureReason, message: string): RunnerRegistryFailure =>
    new RunnerRegistryFailure({ reason, message });
  const invalidAuthority = (): RunnerRegistryFailure =>
    failure("invalid_authority", "Stored runner authority is invalid");
  const invalidInput = (): RunnerRegistryFailure =>
    failure("invalid_input", "Runner registration input is invalid");
  const storageFailure = (): RunnerRegistryFailure =>
    failure("storage", "Runner authority storage operation failed");

  const parseAuthority = (
    value: unknown | undefined,
  ): Result.Result<RunnerAuthority, RunnerRegistryFailure> => {
    if (value === undefined) return Result.succeed(emptyAuthority());
    const decoded = decodeAuthority(value);
    return Result.isSuccess(decoded) && validAuthority(decoded.success)
      ? Result.succeed(decoded.success)
      : Result.fail(invalidAuthority());
  };

  const transact = <A>(
    operation: (
      authority: RunnerAuthority,
      nowMillis: number,
    ) => Promise<
      Result.Result<
        { readonly value: A; readonly authority: RunnerAuthority },
        RunnerRegistryFailure
      >
    >,
  ): Effect.Effect<A, RunnerRegistryFailure> =>
    Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      return yield* Effect.tryPromise({
        try: () =>
          storage.transaction(async (transaction) => {
            const authority = parseAuthority(await transaction.get());
            if (Result.isFailure(authority)) return Result.fail(authority.failure);
            const result = await operation(authority.success, nowMillis);
            if (Result.isFailure(result)) return Result.fail(result.failure);
            if (!validAuthority(result.success.authority)) return Result.fail(invalidAuthority());
            await transaction.put(result.success.authority);
            return Result.succeed(result.success.value);
          }),
        catch: storageFailure,
      }).pipe(Effect.flatMap(Effect.fromResult));
    });

  const requireName = (value: unknown): Result.Result<string, RunnerRegistryFailure> => {
    const decoded = Result.mapError(decodeRunnerName(value), invalidInput);
    if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
    return RUNNER_NAME_PATTERN.test(decoded.success)
      ? Result.succeed(decoded.success)
      : Result.fail(invalidInput());
  };

  return RunnerRegistry.of({
    authenticate: (candidateValue) =>
      transact(async (authority) => {
        const decoded = Result.mapError(
          decodeAuthenticationCandidate(candidateValue),
          invalidInput,
        );
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const candidate = decoded.success;
        if (
          !RUNNER_NAME_PATTERN.test(candidate.name) ||
          !RUNNER_CREDENTIAL_PATTERN.test(candidate.credential)
        )
          return Result.fail(failure("credential_invalid", "Runner authorization failed"));
        const runner = authority.runners.find(({ name }) => name === candidate.name);
        if (!runner) return Result.fail(failure("runner_missing", "Runner not found"));
        const digest = await sha256Hex(candidate.credential);
        if (!safeDigestEqual(digest, runner.credentialDigest))
          return Result.fail(failure("credential_invalid", "Runner authorization failed"));
        return Result.succeed({
          value: toView(runner),
          authority,
        });
      }),

    get: (nameValue) =>
      transact(async (authority) => {
        const name = requireName(nameValue);
        if (Result.isFailure(name)) return Result.fail(name.failure);
        const runner = authority.runners.find((candidate) => candidate.name === name.success);
        if (!runner) return Result.fail(failure("runner_missing", "Runner not found"));
        return Result.succeed({ value: toView(runner), authority });
      }),

    list: () =>
      transact(async (authority) =>
        Result.succeed({
          value: authority.runners
            .map(toView)
            .toSorted((left, right) => left.name.localeCompare(right.name)),
          authority,
        }),
      ),

    register: (candidateValue) =>
      transact(async (authority, nowMillis) => {
        const decoded = Result.mapError(decodeRegistrationCandidate(candidateValue), invalidInput);
        if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
        const candidate = decoded.success;
        if (
          !RUNNER_NAME_PATTERN.test(candidate.name) ||
          !RUNNER_CREDENTIAL_PATTERN.test(candidate.credential)
        )
          return Result.fail(invalidInput());
        const existing = authority.runners.find(({ name }) => name === candidate.name);
        if (existing && !candidate.replace)
          return Result.fail(
            failure("runner_exists", `Runner ${candidate.name} is already registered`),
          );
        const now = new Date(nowMillis).toISOString();
        const record: RunnerRegistrationRecord = {
          name: candidate.name,
          credentialDigest: await sha256Hex(candidate.credential),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const runners = existing
          ? authority.runners.map((runner) => (runner.name === candidate.name ? record : runner))
          : [...authority.runners, record];
        return Result.succeed({
          value: {
            credential: candidate.credential,
            replaced: existing !== undefined,
            runner: toView(record),
          },
          authority: { version: 1, runners },
        });
      }),

    remove: (nameValue) =>
      transact(async (authority) => {
        const name = requireName(nameValue);
        if (Result.isFailure(name)) return Result.fail(name.failure);
        if (!authority.runners.some((runner) => runner.name === name.success))
          return Result.fail(failure("runner_missing", "Runner not found"));
        return Result.succeed({
          value: undefined,
          authority: {
            version: 1,
            runners: authority.runners.filter((runner) => runner.name !== name.success),
          },
        });
      }),
  });
};

function validAuthority(authority: RunnerAuthority): boolean {
  const names = new Set<string>();
  for (const runner of authority.runners) {
    if (
      !RUNNER_NAME_PATTERN.test(runner.name) ||
      !/^[a-f0-9]{64}$/u.test(runner.credentialDigest) ||
      !validIso(runner.createdAt) ||
      !validIso(runner.updatedAt) ||
      names.has(runner.name)
    )
      return false;
    names.add(runner.name);
  }
  return true;
}

function validIso(value: string): boolean {
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function toView(record: RunnerRegistrationRecord): RunnerRegistrationView {
  return {
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function safeDigestEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
