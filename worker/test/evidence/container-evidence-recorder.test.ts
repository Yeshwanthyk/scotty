import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Layer, Result } from "effect";
import {
  ContainerEvidenceRecorder,
  ContainerEvidenceRecorderError,
  containerEvidenceRecorderLayer,
} from "../../src/evidence/recorder";
import type { BrowserEvidenceJob } from "../../src/evidence/contracts";
import { sandboxRuntimeLayer, type SandboxRuntimeCapabilities } from "../../src/sandbox/runtime";

const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00]);

const job: BrowserEvidenceJob = {
  port: 4_173,
  viewport: { width: 1_280, height: 720 },
  capture: { screenshots: "after-each-step", video: true },
  steps: [
    {
      name: "Open app",
      action: { kind: "goto", path: "/ready" },
      expect: [{ kind: "visible", locator: { kind: "testId", value: "ready" } }],
    },
  ],
};

const execResult = (command: string, stdout = ""): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout,
  stderr: "",
  command,
  duration: 5,
  timestamp: "2026-08-09T12:00:00.000Z",
});

const byteStream = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

interface RecorderFakeOptions {
  readonly manifest?: (outputDirectory: string) => unknown;
  readonly runnerFails?: boolean;
  readonly cleanupFails?: boolean;
  readonly frameBytes?: Uint8Array;
  readonly videoBytes?: Uint8Array;
}

const makeCapabilities = (events: string[], options: RecorderFakeOptions = {}) => {
  let outputDirectory = "";
  const capabilities: SandboxRuntimeCapabilities = {
    mkdir: (path) => {
      outputDirectory = path;
      events.push("mkdir");
      return Promise.resolve(undefined);
    },
    writeFile: () => {
      events.push("write-job");
      return Promise.resolve(undefined);
    },
    setEnvVars: () => Promise.resolve(),
    exec: (command) => {
      if (command.startsWith("rm -rf --")) {
        events.push("cleanup");
        return Promise.resolve({
          ...execResult(command),
          ...(options.cleanupFails === true
            ? { success: false, exitCode: 1, stderr: "cleanup failed" }
            : {}),
        });
      }
      events.push("run");
      if (options.runnerFails === true)
        return Promise.resolve({
          ...execResult(command),
          success: false,
          exitCode: 1,
          stderr: "runner failed",
        });
      const manifest =
        options.manifest?.(outputDirectory) ??
        ({
          status: "succeeded",
          completedSteps: 1,
          steps: [
            {
              index: 0,
              startedAt: "2026-08-09T12:00:00.000Z",
              completedAt: "2026-08-09T12:00:01.000Z",
              offsetMillis: 1_000,
              assertions: [{ kind: "visible", passed: true }],
              frame: {
                path: `${outputDirectory}/frame-1.png`,
                capturedAt: "2026-08-09T12:00:01.000Z",
                offsetMillis: 1_000,
              },
            },
          ],
          video: {
            path: `${outputDirectory}/video.webm`,
            capturedAt: "2026-08-09T12:00:01.000Z",
            offsetMillis: 1_000,
          },
        } as const);
      return Promise.resolve(execResult(command, `${JSON.stringify(manifest)}\n`));
    },
    readFileStream: (path) => {
      events.push(path.endsWith(".png") ? "read-frame" : "read-video");
      return Promise.resolve(
        byteStream(
          path.endsWith(".png") ? (options.frameBytes ?? PNG) : (options.videoBytes ?? WEBM),
        ),
      );
    },
  };
  return capabilities;
};

const record = (capabilities: SandboxRuntimeCapabilities) =>
  Effect.flatMap(ContainerEvidenceRecorder, (recorder) => recorder.record(job)).pipe(
    Effect.provide(
      containerEvidenceRecorderLayer.pipe(Layer.provide(sandboxRuntimeLayer(capabilities))),
    ),
  );

const failure = <A>(
  result: Result.Result<A, ContainerEvidenceRecorderError>,
): ContainerEvidenceRecorderError => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

describe("ContainerEvidenceRecorder", () => {
  it.effect("reads coherent PNG and WebM output before definitive cleanup", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const result = yield* record(makeCapabilities(events));

      assert.strictEqual(result.status, "succeeded");
      assert.deepStrictEqual(result.steps[0]?.frame.bytes, PNG);
      assert.deepStrictEqual(result.video?.bytes, WEBM);
      assert.deepStrictEqual(events, [
        "mkdir",
        "write-job",
        "run",
        "read-frame",
        "read-video",
        "cleanup",
      ]);
    }),
  );

  it.effect("rejects a manifest path outside the Worker-generated directory before reading", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const result = yield* Effect.result(
        record(
          makeCapabilities(events, {
            manifest: (outputDirectory) => ({
              status: "succeeded",
              completedSteps: 1,
              steps: [
                {
                  index: 0,
                  startedAt: "2026-08-09T12:00:00.000Z",
                  completedAt: "2026-08-09T12:00:01.000Z",
                  offsetMillis: 1_000,
                  assertions: [{ kind: "visible", passed: true }],
                  frame: {
                    path: "/tmp/stolen.png",
                    capturedAt: "2026-08-09T12:00:01.000Z",
                    offsetMillis: 1_000,
                  },
                },
              ],
              video: {
                path: `${outputDirectory}/video.webm`,
                capturedAt: "2026-08-09T12:00:01.000Z",
                offsetMillis: 1_000,
              },
            }),
          }),
        ),
      );

      assert.deepStrictEqual(
        failure(result),
        new ContainerEvidenceRecorderError({ operation: "manifest", reason: "ambiguous" }),
      );
      assert.deepStrictEqual(events, ["mkdir", "write-job", "run", "cleanup"]);
    }),
  );

  it.effect("rejects malformed output and still cleans the generated directory", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const result = yield* Effect.result(
        record(makeCapabilities(events, { manifest: () => ({ version: 999 }) })),
      );

      assert.deepStrictEqual(
        failure(result),
        new ContainerEvidenceRecorderError({ operation: "manifest", reason: "ambiguous" }),
      );
      assert.deepStrictEqual(events, ["mkdir", "write-job", "run", "cleanup"]);
    }),
  );

  it.effect("does not report success when final cleanup fails", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const result = yield* Effect.result(record(makeCapabilities(events, { cleanupFails: true })));

      assert.deepStrictEqual(
        failure(result),
        new ContainerEvidenceRecorderError({ operation: "cleanup", reason: "cleanup" }),
      );
      assert.deepStrictEqual(events.at(-1), "cleanup");
    }),
  );
});
