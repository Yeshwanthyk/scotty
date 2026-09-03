import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { Effect, Layer, Predicate, Result } from "effect";
import packageMetadata from "../package.json" with { type: "json" };
import {
  LAB_VERSION,
  LabOperations,
  LabUsageError,
  runLab,
  waitForCapturedChild,
} from "./scotty-lab.ts";

const RUN_ID = "lab-12345678-1234-4123-8123-123456789abc";

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
        runtimeLoss: (sessionId, fault) =>
          Effect.sync(() => calls.push(`runtime-loss:${sessionId}:${fault ?? "none"}`)),
        hardCap: (sessionId, fault) =>
          Effect.sync(() => calls.push(`hard-cap:${sessionId}:${fault ?? "none"}`)),
        vaporize: (sessionId, fault) =>
          Effect.sync(() => calls.push(`vaporize:${sessionId}:${fault ?? "none"}`)).pipe(
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
      yield* run(["lifecycle", "full", "--repo", "owner/repo"], calls);
      assert.deepEqual(calls, [
        "create-and-ready:owner/repo:none",
        "checkpoint:a0b1c2d3e4f5:none",
        "sleep-resume:a0b1c2d3e4f5:runtime-stopped",
        "runtime-loss:a0b1c2d3e4f5:none",
        "hard-cap:a0b1c2d3e4f5:none",
        "vaporize:a0b1c2d3e4f5:none",
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
