import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Predicate, Result } from "effect";
import { LabOperations, LabUsageError, runLab } from "./scotty-lab.ts";

const RUN_ID = "lab-12345678-1234-4123-8123-123456789abc";

const run = (args: ReadonlyArray<string>, calls: string[]): Effect.Effect<void, unknown> =>
  runLab(args).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide(
      Layer.succeed(LabOperations, {
        start: Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
        exec: (runId, argv) =>
          Effect.sync(() => calls.push(`exec:${runId}:${JSON.stringify(argv)}`)).pipe(
            Effect.asVoid,
          ),
        stop: (runId) => Effect.sync(() => calls.push(`stop:${runId}`)).pipe(Effect.asVoid),
      }),
    ),
  );

const assertUsageFailure = (result: Result.Result<void, unknown>): void => {
  assert.ok(Result.isFailure(result));
  assert.ok(Predicate.isTagged(result.failure, "LabUsageError"));
  assert.deepEqual(
    result.failure,
    new LabUsageError({
      message: "Usage: npm run lab -- start | exec RUN_ID -- <scotty argv> | stop RUN_ID",
    }),
  );
};

describe("Effect Scotty lab command grammar", () => {
  it.effect("runs exactly start, exec, and stop", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* run(["start"], calls);
      yield* run(["exec", RUN_ID, "--", "doctor", "--json"], calls);
      yield* run(["stop", RUN_ID], calls);
      assert.deepEqual(calls, ["start", `exec:${RUN_ID}:["doctor","--json"]`, `stop:${RUN_ID}`]);
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

  it.effect("rejects every command and trailing shape outside the public grammar", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      for (const args of [
        [],
        ["help"],
        ["--help"],
        ["start", "extra"],
        ["stop", RUN_ID, "extra"],
        ["stop", "not-a-run"],
      ]) {
        assertUsageFailure(yield* Effect.result(run(args, calls)));
      }
      assert.deepEqual(calls, []);
    }),
  );
});
