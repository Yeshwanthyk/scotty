import { Clock, Effect, Option, Predicate, Schema } from "effect";
import type { RunnerOperation } from "../../../protocol/runner.ts";

export const RunnerDesiredStateSchema = Schema.Literals(["accepting", "draining", "disabled"]);
export type RunnerDesiredState = typeof RunnerDesiredStateSchema.Type;

export const RunnerControlActionSchema = Schema.Literals([
  "enable",
  "drain",
  "disable",
  "disconnect",
]);
export type RunnerControlAction = typeof RunnerControlActionSchema.Type;

export type RunnerConnectionState = "connected" | "disconnected";

export interface RunnerControlStatus {
  readonly desired: RunnerDesiredState;
  readonly connection: RunnerConnectionState;
  readonly lastSeenAt: string | null;
}

export interface RunnerAdmissionFailure {
  readonly code: "runner_draining" | "runner_disabled";
  readonly message: string;
}

export interface RunnerControlStorage<R = never> {
  readonly load: () => Effect.Effect<
    {
      readonly desired: unknown;
      readonly lastSeenAtMillis: unknown;
    },
    never,
    R
  >;
  readonly saveDesired: (desired: RunnerDesiredState) => Effect.Effect<void, never, R>;
  readonly saveLastSeenAtMillis: (lastSeenAtMillis: number) => Effect.Effect<void, never, R>;
}

export interface RunnerControl<R = never> {
  readonly status: () => Effect.Effect<RunnerControlStatus, never, R>;
  readonly setDesired: (desired: RunnerDesiredState) => Effect.Effect<void, never, R>;
  readonly admission: (operation: RunnerOperation) => RunnerAdmissionFailure | null;
  readonly mountedHttpEnabled: () => boolean;
}

const decodeDesired = Schema.decodeUnknownOption(RunnerDesiredStateSchema);
const decodeLastSeenAtMillis = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
);

const admissionFor = (
  desired: RunnerDesiredState,
  operation: RunnerOperation,
): RunnerAdmissionFailure | null => {
  if (desired === "draining" && Predicate.isTagged("EnsureRuntime")(operation))
    return {
      code: "runner_draining",
      message: "Runner is draining and cannot accept new sessions",
    };
  if (
    desired === "disabled" &&
    (Predicate.isTagged("EnsureRuntime")(operation) || Predicate.isTagged("ExecRuntime")(operation))
  )
    return {
      code: "runner_disabled",
      message: "Runner is disabled for this operation",
    };
  return null;
};

export const makeRunnerControl = Effect.fnUntraced(function* <R>(
  storage: RunnerControlStorage<R>,
  observeConnection: () => Effect.Effect<RunnerConnectionState>,
) {
  const stored = yield* storage.load();
  const decodedDesired = decodeDesired(stored.desired);
  let desired: RunnerDesiredState = Option.match(decodedDesired, {
    onNone: () => (stored.desired === undefined ? "accepting" : "disabled"),
    onSome: (value) => value,
  });
  let lastSeenAtMillis = Option.getOrNull(decodeLastSeenAtMillis(stored.lastSeenAtMillis));

  return {
    status: Effect.fnUntraced(function* () {
      const connection = yield* observeConnection();
      if (connection === "connected") {
        lastSeenAtMillis = yield* Clock.currentTimeMillis;
        yield* storage.saveLastSeenAtMillis(lastSeenAtMillis);
      }
      return {
        desired,
        connection,
        lastSeenAt: lastSeenAtMillis === null ? null : new Date(lastSeenAtMillis).toISOString(),
      };
    }),
    setDesired: Effect.fnUntraced(function* (next: RunnerDesiredState) {
      yield* storage.saveDesired(next);
      desired = next;
    }),
    admission: (operation: RunnerOperation) => admissionFor(desired, operation),
    mountedHttpEnabled: () => desired !== "disabled",
  } satisfies RunnerControl<R>;
});
