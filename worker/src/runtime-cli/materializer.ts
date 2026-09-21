import { Context, Data, Effect, Layer, Schema } from "effect";
import type { RuntimeCliPin } from "../../../protocol/runtime/runtime-cli-pin";
import { sameRuntimeCompatibility } from "./selection";
import { readRuntimeCliArtifact, type RuntimeCliArtifactBucket } from "./artifact";
import { SandboxRuntime, shellQuote } from "../sandbox/runtime";
import { runtimeCliBin, runtimeCliExecutable } from "./paths";
import { verifyRuntimeImageCompatibility } from "../../../protocol/runtime/runtime-image-compatibility";

export class RuntimeCliMaterializationFailure extends Data.TaggedError(
  "RuntimeCliMaterializationFailure",
)<{
  readonly reason:
    | "missing_pin"
    | "unsupported_image"
    | "missing_artifact"
    | "artifact_integrity"
    | "storage"
    | "runtime"
    | "runtime_unknown";
}> {}
export class RuntimeCliMaterializer extends Context.Service<
  RuntimeCliMaterializer,
  {
    readonly materialize: (
      sessionId: string,
      pin: RuntimeCliPin | undefined,
    ) => Effect.Effect<void, RuntimeCliMaterializationFailure>;
  }
>()("scotty/RuntimeCliMaterializer") {}
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Recheck exact bytes even on replay/restore. Never replace an existing executable. */
export const runtimeCliVerificationCommand = (path: string, pin: RuntimeCliPin): string => {
  const file = shellQuote(path);
  return `test -f ${file} && test ! -L ${file} && test "$(stat -c %a ${file})" = 755 && test "$(wc -c < ${file})" -eq ${pin.descriptor.artifact.byteSize} && printf '%s  %s\\n' ${shellQuote(pin.descriptor.artifact.sha256)} ${file} | sha256sum --check --strict`;
};
export const runtimeCliMaterializerLayer = (
  bucket: RuntimeCliArtifactBucket,
  evidenceJson: string | undefined,
  imageDigest: string | undefined,
) =>
  Layer.effect(
    RuntimeCliMaterializer,
    Effect.gen(function* () {
      const runtime = yield* SandboxRuntime;
      return RuntimeCliMaterializer.of({
        materialize: Effect.fnUntraced(function* (sessionId, pin) {
          if (pin === undefined)
            return yield* new RuntimeCliMaterializationFailure({ reason: "missing_pin" });
          const evidence = yield* decodeJson(evidenceJson ?? "null").pipe(
            Effect.flatMap((raw) => verifyRuntimeImageCompatibility(raw, imageDigest ?? "")),
            Effect.mapError(
              () => new RuntimeCliMaterializationFailure({ reason: "unsupported_image" }),
            ),
          );
          if (!sameRuntimeCompatibility(evidence.compatibility, pin.descriptor.compatibility))
            return yield* new RuntimeCliMaterializationFailure({ reason: "unsupported_image" });
          const body = yield* readRuntimeCliArtifact(bucket, pin.descriptor).pipe(
            Effect.mapError(
              (error) => new RuntimeCliMaterializationFailure({ reason: error.reason }),
            ),
          );
          const bin = runtimeCliBin(sessionId);
          const final = runtimeCliExecutable(sessionId);
          const stage = `${bin}/.staging-${crypto.randomUUID()}`;
          const install = Effect.gen(function* () {
            yield* runtime.mkdir(bin, { recursive: true });
            const exists = yield* runtime.exec(
              `test -e ${shellQuote(final)} || test -L ${shellQuote(final)}`,
            );
            if (!exists.success) {
              // SDK native RPC writeFileStream is authenticated and scoped to this Session DO.
              // No owner token, R2 key, presigned URL, or network download authority enters the image.
              yield* runtime.writeFile(stage, body);
              yield* runtime.execChecked(`chmod 755 ${shellQuote(stage)}`);
              yield* runtime.execChecked(runtimeCliVerificationCommand(stage, pin));
              // Hard-link publication is create-only; a racing installer cannot overwrite live bytes.
              yield* runtime.execChecked(`ln ${shellQuote(stage)} ${shellQuote(final)}`);
            }
            yield* runtime.execChecked(runtimeCliVerificationCommand(final, pin));
            // Absolute executable, not PATH lookup: a user tool named scotty cannot pass readiness.
            yield* runtime.execChecked(`${shellQuote(final)} --version`, { timeout: 30_000 });
          });
          yield* install.pipe(
            Effect.mapError(
              (error) =>
                new RuntimeCliMaterializationFailure({
                  reason: error.reason === "transport" ? "runtime_unknown" : "runtime",
                }),
            ),
            Effect.timeoutOrElse({
              duration: "5 minutes",
              orElse: () =>
                Effect.fail(new RuntimeCliMaterializationFailure({ reason: "runtime_unknown" })),
            }),
            Effect.ensuring(
              Effect.all(
                [
                  runtime.exec(`rm -f ${shellQuote(stage)}`).pipe(Effect.ignore),
                  Effect.tryPromise({
                    try: () => body.cancel(),
                    catch: () => new RuntimeCliMaterializationFailure({ reason: "runtime" }),
                  }).pipe(Effect.ignore),
                ],
                { concurrency: "unbounded" },
              ),
            ),
          );
        }),
      });
    }),
  );
