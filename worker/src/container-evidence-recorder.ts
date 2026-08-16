import { Context, Effect, Exit, Layer, Schema } from "effect";
import {
  EVIDENCE_MAX_ASSERTIONS_PER_STEP,
  EVIDENCE_MAX_FRAME_BYTES,
  EVIDENCE_MAX_STEPS,
  EVIDENCE_MAX_VIDEO_BYTES,
  EvidenceAssertionResultSchema,
  type BrowserEvidenceJobV2,
  type EvidenceAssertionResult,
  type EvidenceFailure,
} from "./evidence-contracts";
import { SandboxRuntime, shellQuote } from "./sandbox-runtime";

const RECORDER_PATH = "/opt/scotty/pi-packages/sources/scotty-browser-test/runner.ts" as const;
const RECORDER_TIMEOUT_MILLIS = 5 * 60 * 1_000;
const RECORDER_PROTOCOL_VERSION = 1 as const;
const RecorderPathSchema = Schema.String.check(
  Schema.isPattern(
    /^\/tmp\/scotty-evidence-[0-9a-f]{32}\/(?:frame-[1-9][0-9]*\.png|video\.webm)$/u,
  ),
);
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const RecorderFrameSchema = Schema.Struct({
  path: RecorderPathSchema,
  capturedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
});

const RecorderStepSchema = Schema.Struct({
  index: NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(EVIDENCE_MAX_STEPS - 1)),
  startedAt: Schema.String,
  completedAt: Schema.String,
  offsetMillis: NonNegativeIntSchema,
  assertions: Schema.NonEmptyArray(EvidenceAssertionResultSchema).check(
    Schema.isMaxLength(EVIDENCE_MAX_ASSERTIONS_PER_STEP),
  ),
  frame: RecorderFrameSchema,
});

const RecorderFailureSchema = Schema.Struct({
  code: Schema.Literals([
    "assertion_mismatch",
    "artifact_invalid",
    "artifact_over_budget",
    "deadline",
    "interrupted",
    "unsupported",
  ]),
  step: Schema.optionalKey(
    NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(EVIDENCE_MAX_STEPS - 1)),
  ),
});

const RecorderManifestSchema = Schema.Struct({
  version: Schema.Literal(RECORDER_PROTOCOL_VERSION),
  status: Schema.Literals(["succeeded", "failed", "interrupted", "unsupported"]),
  completedSteps: NonNegativeIntSchema.check(Schema.isLessThanOrEqualTo(EVIDENCE_MAX_STEPS)),
  steps: Schema.Array(RecorderStepSchema).check(Schema.isMaxLength(EVIDENCE_MAX_STEPS)),
  video: Schema.optionalKey(RecorderFrameSchema),
  failure: Schema.optionalKey(RecorderFailureSchema),
});

type RecorderManifest = typeof RecorderManifestSchema.Type;
const decodeRecorderManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecorderManifestSchema),
  { onExcessProperty: "error" },
);

export class ContainerEvidenceRecorderError extends Schema.TaggedError<ContainerEvidenceRecorderError>()(
  "ContainerEvidenceRecorderError",
  {
    operation: Schema.Literals(["run", "manifest", "read", "cleanup"]),
    reason: Schema.Literals(["unsupported", "ambiguous", "cleanup"]),
  },
) {}

export interface ContainerEvidenceRecordedStep {
  readonly index: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly offsetMillis: number;
  readonly assertions: readonly [EvidenceAssertionResult, ...EvidenceAssertionResult[]];
  readonly frame: {
    readonly bytes: Uint8Array;
    readonly capturedAt: string;
    readonly offsetMillis: number;
  };
}

export interface ContainerEvidenceRecording {
  readonly status: RecorderManifest["status"];
  readonly completedSteps: number;
  readonly steps: readonly ContainerEvidenceRecordedStep[];
  readonly video?: {
    readonly bytes: Uint8Array;
    readonly capturedAt: string;
    readonly offsetMillis: number;
  };
  readonly failure?: EvidenceFailure;
}

interface ContainerEvidenceRecorderShape {
  readonly record: (
    job: BrowserEvidenceJobV2,
  ) => Effect.Effect<ContainerEvidenceRecording, ContainerEvidenceRecorderError>;
}

export class ContainerEvidenceRecorder extends Context.Service<
  ContainerEvidenceRecorder,
  ContainerEvidenceRecorderShape
>()("scotty/ContainerEvidenceRecorder") {}

const manifestIsCoherent = (
  manifest: RecorderManifest,
  job: BrowserEvidenceJobV2,
  outputDirectory: string,
): boolean => {
  if (
    manifest.completedSteps !== manifest.steps.length ||
    manifest.steps.length > job.steps.length ||
    manifest.steps.some(
      (step, index) =>
        step.index !== index || step.frame.path !== `${outputDirectory}/frame-${index + 1}.png`,
    )
  )
    return false;
  const allStepsPassed = manifest.steps.length === job.steps.length;
  if (manifest.status === "succeeded")
    return (
      allStepsPassed &&
      manifest.failure === undefined &&
      (job.capture.video
        ? manifest.video?.path === `${outputDirectory}/video.webm`
        : manifest.video === undefined)
    );
  if (manifest.failure === undefined || manifest.video !== undefined) return false;
  if (manifest.failure.step !== undefined && manifest.failure.step >= job.steps.length)
    return false;
  return manifest.status === "unsupported"
    ? manifest.failure.code === "unsupported"
    : manifest.status === "interrupted"
      ? manifest.failure.code === "interrupted" || manifest.failure.code === "deadline"
      : manifest.failure.code !== "unsupported";
};

const readRecording = Effect.fnUntraced(function* (
  runtime: SandboxRuntime["Service"],
  manifest: RecorderManifest,
) {
  const steps: ContainerEvidenceRecordedStep[] = [];
  for (const step of manifest.steps) {
    const bytes = yield* runtime
      .readFile(step.frame.path, EVIDENCE_MAX_FRAME_BYTES)
      .pipe(
        Effect.mapError(
          () => new ContainerEvidenceRecorderError({ operation: "read", reason: "ambiguous" }),
        ),
      );
    steps.push({
      index: step.index,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      offsetMillis: step.offsetMillis,
      assertions: step.assertions,
      frame: {
        bytes,
        capturedAt: step.frame.capturedAt,
        offsetMillis: step.frame.offsetMillis,
      },
    });
  }
  const video =
    manifest.video === undefined
      ? undefined
      : {
          bytes: yield* runtime
            .readFile(manifest.video.path, EVIDENCE_MAX_VIDEO_BYTES)
            .pipe(
              Effect.mapError(
                () =>
                  new ContainerEvidenceRecorderError({ operation: "read", reason: "ambiguous" }),
              ),
            ),
          capturedAt: manifest.video.capturedAt,
          offsetMillis: manifest.video.offsetMillis,
        };
  return {
    status: manifest.status,
    completedSteps: manifest.completedSteps,
    steps,
    ...(video === undefined ? {} : { video }),
    ...(manifest.failure === undefined ? {} : { failure: manifest.failure }),
  } satisfies ContainerEvidenceRecording;
});

export const makeContainerEvidenceRecorder = (
  runtime: SandboxRuntime["Service"],
): ContainerEvidenceRecorderShape => ({
  record: (job) => {
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const outputDirectory = `/tmp/scotty-evidence-${nonce}`;
    const jobPath = `${outputDirectory}/job.json`;
    const cleanup = runtime
      .execChecked(`rm -rf -- ${shellQuote(outputDirectory)}`, { timeout: 30_000 })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          () => new ContainerEvidenceRecorderError({ operation: "cleanup", reason: "cleanup" }),
        ),
      );
    return Effect.acquireUseRelease(
      runtime.mkdir(outputDirectory).pipe(
        Effect.andThen(runtime.writeFile(jobPath, JSON.stringify(job))),
        Effect.as(outputDirectory),
        Effect.mapError(
          () => new ContainerEvidenceRecorderError({ operation: "run", reason: "ambiguous" }),
        ),
      ),
      () =>
        Effect.gen(function* () {
          const command = [
            "node",
            "--experimental-strip-types",
            shellQuote(RECORDER_PATH),
            shellQuote(jobPath),
            shellQuote(outputDirectory),
          ].join(" ");
          const executed = yield* runtime.exec(command, { timeout: RECORDER_TIMEOUT_MILLIS }).pipe(
            Effect.mapError(
              () =>
                new ContainerEvidenceRecorderError({
                  operation: "run",
                  reason: "ambiguous",
                }),
            ),
          );
          if (!executed.success)
            return yield* new ContainerEvidenceRecorderError({
              operation: "run",
              reason: "ambiguous",
            });
          const manifest = yield* decodeRecorderManifest(executed.stdout.trim()).pipe(
            Effect.mapError(
              () =>
                new ContainerEvidenceRecorderError({
                  operation: "manifest",
                  reason: "ambiguous",
                }),
            ),
          );
          if (!manifestIsCoherent(manifest, job, outputDirectory))
            return yield* new ContainerEvidenceRecorderError({
              operation: "manifest",
              reason: "ambiguous",
            });
          return yield* readRecording(runtime, manifest);
        }),
      (_directory, exit) =>
        Exit.isSuccess(exit)
          ? cleanup
          : cleanup.pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  console.error("Container evidence cleanup failed after an earlier failure", {
                    operation: error.operation,
                    reason: error.reason,
                  }),
                ),
              ),
            ),
    );
  },
});

export const containerEvidenceRecorderLayer: Layer.Layer<
  ContainerEvidenceRecorder,
  never,
  SandboxRuntime
> = Layer.effect(
  ContainerEvidenceRecorder,
  Effect.map(SandboxRuntime, (runtime) =>
    ContainerEvidenceRecorder.of(makeContainerEvidenceRecorder(runtime)),
  ),
);
